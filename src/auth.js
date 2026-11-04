import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;
const COOKIE_NAME = 'organizer_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [, salt, expected] = stored.split(':');
  const key = await scrypt(password, Buffer.from(salt, 'hex'), KEY_LENGTH, SCRYPT_OPTIONS);
  return timingSafeEqual(key, Buffer.from(expected, 'hex'));
}

/** Parses "a@x.org=scrypt:salt:hash,b@x.org=scrypt:salt:hash" into a Map of email to hash. */
export function parseOrganizers(value) {
  const organizers = new Map();
  for (const entry of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf('=');
    const email = entry.slice(0, separator).toLowerCase();
    const hash = entry.slice(separator + 1);
    if (separator < 1 || !/^scrypt:[0-9a-f]+:[0-9a-f]+$/.test(hash)) {
      throw new Error('ORGANIZERS entries must look like email=scrypt:salt:hash');
    }
    organizers.set(email, hash);
  }
  return organizers;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

export function createAuth({ db, organizers, cookieSecure, now = Date.now }) {
  const insertSession = db.prepare(`INSERT INTO sessions (token_hash, email, expires_at) VALUES (?, ?, ?)`);
  const selectSession = db.prepare(`SELECT email, expires_at FROM sessions WHERE token_hash = ?`);
  const deleteSession = db.prepare(`DELETE FROM sessions WHERE token_hash = ?`);
  const deleteExpired = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);
  // Verified for unknown emails too, so response time doesn't reveal who is an organizer.
  const decoyHash = hashPassword(randomBytes(16).toString('hex'));

  const cookieAttributes = `Path=/; HttpOnly; SameSite=Strict${cookieSecure ? '; Secure' : ''}`;

  return {
    /** The organizer's email if this request carries a live session for a current organizer. */
    organizerFor(req) {
      const token = readCookie(req, COOKIE_NAME);
      if (!token) return null;
      const session = selectSession.get(sha256(token));
      if (!session || session.expires_at <= now()) return null;
      // Re-checked on every request so removing someone from ORGANIZERS takes effect on restart.
      return organizers.has(session.email) ? session.email : null;
    },
    async verifyCredentials(email, password) {
      const normalized = String(email ?? '').trim().toLowerCase();
      const stored = organizers.get(normalized);
      const valid = await verifyPassword(String(password ?? ''), stored ?? (await decoyHash));
      return valid && stored ? normalized : null;
    },
    startSession(res, email) {
      deleteExpired.run(now());
      const token = randomBytes(32).toString('base64url');
      insertSession.run(sha256(token), email, now() + SESSION_TTL_MS);
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Max-Age=${SESSION_TTL_MS / 1000}; ${cookieAttributes}`);
    },
    endSession(req, res) {
      const token = readCookie(req, COOKIE_NAME);
      if (token) deleteSession.run(sha256(token));
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; ${cookieAttributes}`);
    },
  };
}
