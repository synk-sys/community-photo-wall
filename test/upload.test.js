import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UPLOAD_CONFIRMATION } from '../src/app.js';
import { JPEG, startServer } from './helpers.js';

test('uploads start pending and attendees see the review message', async (t) => {
  const s = await startServer(t);
  const response = await s.postUpload();
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    message: 'Photo uploaded! Our team will review it before it appears on the big screen.',
  });
  assert.equal(UPLOAD_CONFIRMATION, 'Photo uploaded! Our team will review it before it appears on the big screen.');

  const [photo] = s.db.prepare('SELECT * FROM photos').all();
  assert.equal(photo.moderation_status, 'pending');
  assert.equal(photo.consent_to_display, 1);
  assert.equal(s.storage.files.size, 1);
});

test('an upload cannot set its own moderation status or any moderation field', async (t) => {
  const s = await startServer(t);
  const id = await s.upload({
    extraFields: {
      moderationStatus: 'approved',
      moderation_status: 'approved',
      moderated_by: 'attendee',
      approved_at: '1',
    },
  });
  const photo = s.photos.findById(id);
  assert.equal(photo.moderation_status, 'pending');
  assert.equal(photo.moderated_by, null);
  assert.equal(photo.approved_at, null);
  assert.equal((await fetch(`${s.base}/api/public/photos/${id}/image`)).status, 404);
});

test('the database itself refuses to insert a photo that is not pending', async (t) => {
  const s = await startServer(t);
  assert.throws(
    () =>
      s.db
        .prepare(`INSERT INTO photos (id, storage_key, mime_type, size_bytes, consent_to_display, moderation_status, uploaded_at)
                  VALUES ('x', 'x', 'image/jpeg', 1, 1, 'approved', 1)`)
        .run(),
    /must start pending/,
  );
});

test('consent is only recorded for the exact value "true"', async (t) => {
  const s = await startServer(t);
  assert.equal(s.photos.findById(await s.upload({ consent: false })).consent_to_display, 0);
  const on = await s.upload({ consent: false, extraFields: { consentToDisplay: 'on' } });
  assert.equal(s.photos.findById(on).consent_to_display, 0);
});

test('files are identified by content, not by what the client declares', async (t) => {
  const s = await startServer(t);
  const html = Buffer.from('<script>alert(1)</script>');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  assert.equal((await s.postUpload({ bytes: html, type: 'image/jpeg' })).status, 415);
  assert.equal((await s.postUpload({ bytes: svg, type: 'image/svg+xml' })).status, 415);
  assert.equal(s.storage.files.size, 0);

  const id = await s.upload();
  assert.equal(s.photos.findById(id).mime_type, 'image/jpeg');
});

test('oversized and missing files are rejected', async (t) => {
  const s = await startServer(t);
  const huge = Buffer.concat([JPEG, Buffer.alloc(15 * 1024 * 1024 + 1)]);
  assert.equal((await s.postUpload({ bytes: huge })).status, 413);
  assert.equal((await fetch(`${s.base}/api/photos`, { method: 'POST', body: new FormData() })).status, 400);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 0);
});

test('a failed storage write creates no photo record and reports an error', async (t) => {
  const s = await startServer(t);
  s.storage.put = async () => {
    throw new Error('Drive is down');
  };
  t.mock.method(console, 'error', () => {});
  assert.equal((await s.postUpload()).status, 502);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 0);
});
