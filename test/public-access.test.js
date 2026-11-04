import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JPEG, startServer } from './helpers.js';

/** Every state that must be invisible to the public, each built through the real API. */
const HIDDEN_STATES = {
  pending: async (s) => s.upload(),
  rejected: async (s, cookie) => {
    const id = await s.upload();
    assert.equal((await s.moderate(cookie, id, 'reject', { reason: 'blurry' })).status, 200);
    return id;
  },
  revoked: async (s, cookie) => {
    const id = await s.upload();
    assert.equal((await s.moderate(cookie, id, 'approve')).status, 200);
    assert.equal((await fetch(`${s.base}/api/public/photos/${id}/image`)).status, 200, 'visible before revocation');
    assert.equal((await s.moderate(cookie, id, 'revoke')).status, 200);
    return id;
  },
  'approved without consent': async (s, cookie) => {
    const id = await s.upload({ consent: false });
    assert.equal((await s.moderate(cookie, id, 'approve')).status, 200);
    return id;
  },
};

for (const [name, makePhoto] of Object.entries(HIDDEN_STATES)) {
  test(`${name} photo cannot be reached through any public endpoint`, async (t) => {
    const s = await startServer(t);
    const cookie = await s.login();
    const id = await makePhoto(s, cookie);

    const image = await fetch(`${s.base}/api/public/photos/${id}/image`);
    assert.equal(image.status, 404);
    assert.notEqual(image.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await image.arrayBuffer()).includes(JPEG), false);

    const head = await fetch(`${s.base}/api/public/photos/${id}/image`, { method: 'HEAD' });
    assert.equal(head.status, 404);

    const list = await fetch(`${s.base}/api/public/photos`);
    assert.equal(list.status, 200);
    assert.equal((await list.text()).includes(id), false);

    const stream = await s.openStream(t, '/api/public/events');
    const snapshot = await stream.waitFor(({ event }) => event === 'playlist');
    assert.deepEqual(snapshot.data.photos, []);

    // A hidden photo must be indistinguishable from one that never existed.
    const unknown = await fetch(`${s.base}/api/public/photos/00000000-0000-4000-8000-000000000000/image`);
    const hidden = await fetch(`${s.base}/api/public/photos/${id}/image`);
    assert.equal(hidden.status, unknown.status);
    assert.equal(await hidden.text(), await unknown.text());

    // Query strings can't talk their way past the check.
    const forged = await fetch(`${s.base}/api/public/photos/${id}/image?moderationStatus=approved&consentToDisplay=true`);
    assert.equal(forged.status, 404);
  });
}

test('an approved photo with consent is served, uncacheable, and exposes no moderation data', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const id = await s.upload();
  await s.moderate(cookie, id, 'approve');

  const list = await (await fetch(`${s.base}/api/public/photos`)).json();
  assert.deepEqual(list, { photos: [{ id, imageUrl: `/api/public/photos/${id}/image` }] });

  const image = await fetch(`${s.base}${list.photos[0].imageUrl}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(image.headers.get('etag'), null);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), JPEG);
});

test('revocation takes effect immediately even when the bytes are already cached', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const id = await s.upload();
  await s.moderate(cookie, id, 'approve');

  const url = `${s.base}/api/public/photos/${id}/image`;
  await (await fetch(url)).arrayBuffer();
  await (await fetch(url)).arrayBuffer();
  assert.equal(s.storage.gets, 1, 'second read should come from the cache');

  await s.moderate(cookie, id, 'revoke');
  assert.equal((await fetch(url)).status, 404);

  // A later re-approval must re-read from storage: revocation purged the cached copy.
  await s.moderate(cookie, id, 'approve', { expectedStatus: 'rejected' });
  await (await fetch(url)).arrayBuffer();
  assert.equal(s.storage.gets, 2);
});

test('a photo revoked while its bytes are being fetched from Drive is not sent', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const id = await s.upload();
  await s.moderate(cookie, id, 'approve');

  s.storage.beforeGet = async () => {
    s.storage.beforeGet = null;
    assert.equal((await s.moderate(cookie, id, 'revoke')).status, 200);
  };
  const image = await fetch(`${s.base}/api/public/photos/${id}/image`);
  assert.equal(image.status, 404);
});

test('rejecting an approved photo also removes it from public access', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const id = await s.upload();
  await s.moderate(cookie, id, 'approve');
  await s.moderate(cookie, id, 'reject');
  assert.equal((await fetch(`${s.base}/api/public/photos/${id}/image`)).status, 404);
  assert.equal(s.photos.events(id).at(-1).action, 'revoke');
});

test('stored files, the database and source are not reachable as static files', async (t) => {
  const s = await startServer(t);
  const id = await s.upload();
  for (const path of [`/data/photos/${id}.jpg`, `/${id}.jpg`, '/data/photo-wall.db', '/.env', '/src/app.js', '/../.env', '/%2e%2e/.env']) {
    const response = await fetch(`${s.base}${path}`);
    assert.equal(response.status, 404, path);
  }
});
