import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { createAuth } from './auth.js';
import { createPhotoRepository } from './db.js';
import { EventHub } from './events.js';
import { ImageCache } from './imageCache.js';
import { sniffImage } from './images.js';
import { rateLimit } from './rateLimit.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_REASON_LENGTH = 500;
const MAX_BULK_IDS = 500;
const MAX_LIST_LIMIT = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const UPLOAD_CONFIRMATION = 'Photo uploaded! Our team will review it before it appears on the big screen.';

const notFound = (res) => res.status(404).json({ error: 'Not found' });

function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

function sendImage(res, photo, bytes) {
  res.setHeader('Content-Type', photo.mime_type);
  res.setHeader('Content-Length', bytes.length);
  // Never cacheable, so a browser or CDN can't keep serving a photo after it is revoked.
  res.setHeader('Cache-Control', 'no-store');
  res.end(bytes);
}

export function createApp({ db, storage, config, now = Date.now }) {
  const photos = createPhotoRepository(db, now);
  const auth = createAuth({ db, organizers: config.organizers, cookieSecure: config.cookieSecure, now });
  const images = new ImageCache({ storage });
  const publicHub = new EventHub({ maxClients: 1000 });
  const organizerHub = new EventHub();

  const playlistJson = () =>
    JSON.stringify({
      photos: photos.listPublicIds().map((id) => ({ id, imageUrl: `/api/public/photos/${id}/image` })),
    });
  let lastPlaylist = playlistJson();

  /** Pushes state to every open screen. The public stream only fires when the public list changed. */
  function publishChanges() {
    organizerHub.broadcast('change', JSON.stringify({ counts: photos.counts() }));
    const playlist = playlistJson();
    if (playlist !== lastPlaylist) {
      lastPlaylist = playlist;
      publicHub.broadcast('playlist', playlist);
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ---- Attendee upload ------------------------------------------------------------------------

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  });

  app.post(
    '/api/photos',
    rateLimit({ windowMs: 60_000, max: config.uploadsPerMinute, keyFor: (req) => req.ip, now }),
    upload.single('photo'),
    async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Please choose a photo to upload.' });
      const image = sniffImage(req.file.buffer);
      if (!image) return res.status(415).json({ error: 'Please upload a JPEG, PNG or WebP image.' });

      // Only these two inputs are read from the request. Anything else it sends,
      // moderationStatus included, is ignored.
      const consentToDisplay = req.body.consentToDisplay === 'true';
      const id = randomUUID();
      const storageKey = await storage.put(`${id}.${image.extension}`, req.file.buffer, image.mimeType);
      try {
        photos.insertPending({
          id,
          storageKey,
          mimeType: image.mimeType,
          sizeBytes: req.file.size,
          consentToDisplay,
        });
      } catch (error) {
        await storage.delete(storageKey).catch(() => {});
        throw error;
      }
      publishChanges();
      res.status(201).json({ message: UPLOAD_CONFIRMATION });
    },
  );

  // ---- Public read endpoints: approved and consented photos only ------------------------------

  app.get('/api/public/photos', (req, res) => {
    res.type('json').send(playlistJson());
  });

  app.get('/api/public/events', (req, res) => {
    if (publicHub.subscribe(req, res)) EventHub.send(res, 'playlist', playlistJson());
  });

  app.get('/api/public/photos/:id/image', async (req, res) => {
    const { id } = req.params;
    if (!UUID.test(id)) return notFound(res);
    const photo = photos.findPublic(id);
    // Same response as an unknown id, so the endpoint doesn't reveal that a hidden photo exists.
    if (!photo) return notFound(res);

    const bytes = await images.load(photo);
    // A Drive fetch can take seconds. If the photo was revoked meanwhile, don't send it.
    if (!photos.findPublic(id)) return notFound(res);
    images.store(id, bytes);
    sendImage(res, photo, bytes);
  });

  // ---- Organizer API ----------------------------------------------------------------------------

  const organizer = express.Router();

  // SameSite=Strict already stops cross-site cookies; this is the second CSRF layer.
  organizer.use((req, res, next) => {
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin) {
      const sameHost = URL.canParse(origin) && new URL(origin).host === req.headers.host;
      if (!sameHost && origin !== config.publicOrigin) return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  });
  organizer.use(express.json({ limit: '100kb' }));

  organizer.post(
    '/login',
    rateLimit({
      windowMs: 15 * 60_000,
      max: 10,
      keyFor: (req) => `${req.ip}|${String(req.body?.email ?? '').toLowerCase()}`,
      now,
    }),
    async (req, res) => {
      const email = await auth.verifyCredentials(req.body?.email, req.body?.password);
      if (!email) return res.status(401).json({ error: 'Incorrect email or password.' });
      auth.startSession(res, email);
      res.json({ email });
    },
  );

  // Everything below this line requires a current organizer's session.
  organizer.use((req, res, next) => {
    const email = auth.organizerFor(req);
    if (!email) return res.status(401).json({ error: 'Organizer sign-in required.' });
    req.organizerEmail = email;
    next();
  });

  organizer.post('/logout', (req, res) => {
    auth.endSession(req, res);
    res.status(204).end();
  });

  organizer.get('/me', (req, res) => res.json({ email: req.organizerEmail }));

  organizer.get('/photos', (req, res) => {
    const status = req.query.status ?? 'pending';
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Unknown status' });
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), MAX_LIST_LIMIT);
    res.json({
      counts: photos.counts(),
      photos: photos.list(status, limit).map((photo) => ({
        id: photo.id,
        moderationStatus: photo.moderation_status,
        consentToDisplay: photo.consent_to_display === 1,
        rejectionReason: photo.rejection_reason,
        moderatedBy: photo.moderated_by,
        moderatedAt: photo.moderated_at,
        revokedAt: photo.revoked_at,
        uploadedAt: photo.uploaded_at,
        imageUrl: `/api/organizer/photos/${photo.id}/image`,
      })),
    });
  });

  organizer.get('/photos/:id/image', async (req, res) => {
    const photo = UUID.test(req.params.id) ? photos.findById(req.params.id) : undefined;
    if (!photo) return notFound(res);
    sendImage(res, photo, await storage.get(photo.storage_key));
  });

  organizer.get('/events', (req, res) => {
    const opened = organizerHub.subscribe(req, res, { isValid: () => auth.organizerFor(req) !== null });
    if (opened) EventHub.send(res, 'change', JSON.stringify({ counts: photos.counts() }));
  });

  function moderationRoute(action) {
    return (req, res) => {
      const reason = String(req.body?.reason ?? '').trim().slice(0, MAX_REASON_LENGTH) || null;
      const result = photos.moderate(req.params.id, action, req.organizerEmail, {
        reason,
        expectedStatus: req.body?.expectedStatus,
      });
      if (result === 'not_found') return notFound(res);
      if (result === 'conflict') {
        return res.status(409).json({ error: 'Another organizer already changed this photo.' });
      }
      if (action !== 'approve') images.purge(req.params.id);
      publishChanges();
      res.json({ counts: photos.counts() });
    };
  }

  organizer.post('/photos/:id/approve', moderationRoute('approve'));
  organizer.post('/photos/:id/reject', moderationRoute('reject'));
  organizer.post('/photos/:id/revoke', moderationRoute('revoke'));

  organizer.post('/photos/bulk-approve', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_IDS || !ids.every((id) => typeof id === 'string')) {
      return res.status(400).json({ error: `Send between 1 and ${MAX_BULK_IDS} photo ids.` });
    }
    const result = photos.bulkApprove(ids, req.organizerEmail);
    publishChanges();
    res.json({ ...result, counts: photos.counts() });
  });

  app.use('/api/organizer', organizer);
  app.use('/api', (req, res) => notFound(res));

  // ---- Pages, which contain no photo data until their API calls are authorized --------------------

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  app.use((error, req, res, next) => {
    if (res.headersSent) return res.destroy();
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return res
        .status(tooLarge ? 413 : 400)
        .json({ error: tooLarge ? 'That photo is too large (15 MB maximum).' : 'Invalid upload.' });
    }
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return res.status(400).json({ error: 'Invalid request.' });
    }
    console.error(error);
    res.status(502).json({ error: 'Something went wrong. Please try again.' });
  });

  return {
    app,
    photos,
    heartbeat() {
      publicHub.heartbeat();
      organizerHub.heartbeat();
    },
    close() {
      publicHub.close();
      organizerHub.close();
    },
  };
}
