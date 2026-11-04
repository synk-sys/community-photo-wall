import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS photos (
    id                 TEXT PRIMARY KEY,
    storage_key        TEXT NOT NULL,
    mime_type          TEXT NOT NULL,
    size_bytes         INTEGER NOT NULL,
    consent_to_display INTEGER NOT NULL CHECK (consent_to_display IN (0, 1)),
    moderation_status  TEXT NOT NULL DEFAULT 'pending'
                       CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
    rejection_reason   TEXT,
    moderated_by       TEXT,
    moderated_at       INTEGER,
    approved_at        INTEGER,
    revoked_at         INTEGER,
    uploaded_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS photos_by_status ON photos (moderation_status, consent_to_display, approved_at);

  -- Backstop: no code path, present or future, can insert an already-moderated photo.
  CREATE TRIGGER IF NOT EXISTS photos_must_start_pending
  BEFORE INSERT ON photos WHEN NEW.moderation_status <> 'pending'
  BEGIN SELECT RAISE(ABORT, 'photos must start pending'); END;

  CREATE TABLE IF NOT EXISTS moderation_events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id TEXT NOT NULL REFERENCES photos (id),
    action   TEXT NOT NULL,
    actor    TEXT NOT NULL,
    reason   TEXT,
    at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Which statuses each moderation action may start from. */
const ALLOWED_FROM = {
  approve: ['pending', 'rejected'],
  // Rejecting always succeeds from an approved state too: when two organizers race,
  // the outcome must err towards hiding the photo.
  reject: ['pending', 'approved'],
  revoke: ['approved'],
};

export function createPhotoRepository(db, now = Date.now) {
  // The single definition of "publicly visible". Every public read goes through it.
  const PUBLIC_WHERE = `moderation_status = 'approved' AND consent_to_display = 1`;

  const insertPhoto = db.prepare(`
    INSERT INTO photos (id, storage_key, mime_type, size_bytes, consent_to_display, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const selectById = db.prepare(`SELECT * FROM photos WHERE id = ?`);
  const selectPublicById = db.prepare(`SELECT * FROM photos WHERE id = ? AND ${PUBLIC_WHERE}`);
  const selectPublic = db.prepare(`SELECT id FROM photos WHERE ${PUBLIC_WHERE} ORDER BY approved_at, id`);
  const selectCounts = db.prepare(`SELECT moderation_status AS status, COUNT(*) AS n FROM photos GROUP BY moderation_status`);
  const selectPendingList = db.prepare(`SELECT * FROM photos WHERE moderation_status = 'pending' ORDER BY uploaded_at, id LIMIT ?`);
  const selectModeratedList = db.prepare(`SELECT * FROM photos WHERE moderation_status = ? ORDER BY moderated_at DESC, id LIMIT ?`);
  const insertEvent = db.prepare(`INSERT INTO moderation_events (photo_id, action, actor, reason, at) VALUES (?, ?, ?, ?, ?)`);
  const setApproved = db.prepare(`
    UPDATE photos SET moderation_status = 'approved', rejection_reason = NULL, revoked_at = NULL,
      moderated_by = ?, moderated_at = ?, approved_at = ? WHERE id = ?`);
  const setRejected = db.prepare(`
    UPDATE photos SET moderation_status = 'rejected', rejection_reason = ?, revoked_at = ?,
      moderated_by = ?, moderated_at = ?, approved_at = NULL WHERE id = ?`);

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Applies one action; must run inside a transaction. Returns 'ok', 'not_found' or 'conflict'. */
  function applyAction(id, action, actor, { reason = null, expectedStatus } = {}) {
    const photo = selectById.get(id);
    if (!photo) return 'not_found';
    const from = photo.moderation_status;
    if (!ALLOWED_FROM[action].includes(from)) return 'conflict';
    if (expectedStatus && expectedStatus !== from) return 'conflict';

    const at = now();
    if (action === 'approve') {
      setApproved.run(actor, at, at, id);
      insertEvent.run(id, 'approve', actor, null, at);
    } else {
      const wasApproved = from === 'approved';
      setRejected.run(reason, wasApproved ? at : null, actor, at, id);
      insertEvent.run(id, wasApproved ? 'revoke' : 'reject', actor, reason, at);
    }
    return 'ok';
  }

  return {
    /** Deliberately takes no status: new photos are always pending. */
    insertPending({ id, storageKey, mimeType, sizeBytes, consentToDisplay }) {
      insertPhoto.run(id, storageKey, mimeType, sizeBytes, consentToDisplay ? 1 : 0, now());
    },
    findById: (id) => selectById.get(id),
    findPublic: (id) => selectPublicById.get(id),
    listPublicIds: () => selectPublic.all().map((row) => row.id),
    list(status, limit) {
      return status === 'pending' ? selectPendingList.all(limit) : selectModeratedList.all(status, limit);
    },
    counts() {
      const counts = { pending: 0, approved: 0, rejected: 0 };
      for (const { status, n } of selectCounts.all()) counts[status] = n;
      return counts;
    },
    moderate: (id, action, actor, options) => transaction(() => applyAction(id, action, actor, options)),
    /** Approves only photos still pending, so a stale selection can't undo another organizer's rejection. */
    bulkApprove(ids, actor) {
      return transaction(() => {
        const approved = [];
        const skipped = [];
        for (const id of ids) {
          const result = applyAction(id, 'approve', actor, { expectedStatus: 'pending' });
          (result === 'ok' ? approved : skipped).push(id);
        }
        return { approved, skipped };
      });
    },
    events: (id) => db.prepare(`SELECT * FROM moderation_events WHERE photo_id = ? ORDER BY id`).all(id),
  };
}
