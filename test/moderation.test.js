import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from './helpers.js';

const list = async (s, cookie, status) =>
  (await fetch(`${s.base}/api/organizer/photos?status=${status}`, { headers: { cookie } })).json();

test('organizers see each photo in the right tab, with counts and a working preview', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const [a, b, c] = [await s.upload(), await s.upload(), await s.upload()];
  await s.moderate(cookie, b, 'approve');
  await s.moderate(cookie, c, 'reject', { reason: '  not event related  ' });

  const pending = await list(s, cookie, 'pending');
  assert.deepEqual(pending.counts, { pending: 1, approved: 1, rejected: 1 });
  assert.deepEqual(pending.photos.map((p) => p.id), [a]);
  assert.deepEqual((await list(s, cookie, 'approved')).photos.map((p) => p.id), [b]);

  const [rejected] = (await list(s, cookie, 'rejected')).photos;
  assert.equal(rejected.id, c);
  assert.equal(rejected.rejectionReason, 'not event related');
  assert.equal(rejected.moderatedBy, 'organizer@example.org');

  const preview = await fetch(`${s.base}${pending.photos[0].imageUrl}`, { headers: { cookie } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('cache-control'), 'no-store');
});

test('a rejection reason is optional and is length-limited', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const none = await s.upload();
  const long = await s.upload();
  assert.equal((await s.moderate(cookie, none, 'reject')).status, 200);
  assert.equal(s.photos.findById(none).rejection_reason, null);
  await s.moderate(cookie, long, 'reject', { reason: 'x'.repeat(5000) });
  assert.equal(s.photos.findById(long).rejection_reason.length, 500);
});

test('bulk approval approves only photos that are still pending', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const [a, b, rejected] = [await s.upload(), await s.upload(), await s.upload()];
  await s.moderate(cookie, rejected, 'reject');

  const response = await s.post(
    '/api/organizer/photos/bulk-approve',
    { ids: [a, b, rejected, 'does-not-exist'] },
    { cookie },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.approved, [a, b]);
  assert.deepEqual(body.skipped, [rejected, 'does-not-exist']);
  assert.equal(s.status(rejected), 'rejected');
  assert.deepEqual(body.counts, { pending: 0, approved: 2, rejected: 1 });
});

test('bulk approval rejects malformed requests', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  for (const ids of [undefined, [], 'abc', [1], Array(501).fill('x')]) {
    assert.equal((await s.post('/api/organizer/photos/bulk-approve', { ids }, { cookie })).status, 400);
  }
});

test('stale actions conflict rather than overriding another organizer', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const id = await s.upload();
  await s.moderate(cookie, id, 'reject');

  // A second organizer's tab still showed this as pending.
  assert.equal((await s.moderate(cookie, id, 'approve', { expectedStatus: 'pending' })).status, 409);
  assert.equal(s.status(id), 'rejected');
  assert.equal((await s.moderate(cookie, id, 'revoke')).status, 409);
  assert.equal((await s.moderate(cookie, 'missing', 'approve')).status, 404);

  // Re-approving from the Rejected tab is an explicit choice.
  assert.equal((await s.moderate(cookie, id, 'approve', { expectedStatus: 'rejected' })).status, 200);
  assert.equal(s.status(id), 'approved');
});

test('a client cannot pick an arbitrary status through a moderation route', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const id = await s.upload();
  await s.moderate(cookie, id, 'reject', { moderationStatus: 'approved', consentToDisplay: true });
  assert.equal(s.status(id), 'rejected');
  assert.equal((await fetch(`${s.base}/api/public/photos/${id}/image`)).status, 404);
});

test('revoked photos land in the Rejected tab, flagged, with an audit trail', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const id = await s.upload();
  await s.moderate(cookie, id, 'approve');
  s.clock.now += 1000;
  await s.moderate(cookie, id, 'revoke');

  const [photo] = (await list(s, cookie, 'rejected')).photos;
  assert.equal(photo.id, id);
  assert.equal(photo.revokedAt, s.clock.now);
  assert.deepEqual(
    s.photos.events(id).map(({ action, actor }) => [action, actor]),
    [['approve', 'organizer@example.org'], ['revoke', 'organizer@example.org']],
  );
});

test('the public stream delivers approvals and revocations without a page refresh', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const stream = await s.openStream(t, '/api/public/events');
  const has = (id) => ({ event, data }) => event === 'playlist' && data.photos.some((photo) => photo.id === id);
  const lacks = (id, afterIndex) => (entry) =>
    entry.event === 'playlist' && stream.events.indexOf(entry) > afterIndex && !entry.data.photos.some((photo) => photo.id === id);

  const id = await s.upload();
  await s.moderate(cookie, id, 'approve');
  const added = await stream.waitFor(has(id));

  await s.moderate(cookie, id, 'revoke');
  await stream.waitFor(lacks(id, stream.events.indexOf(added)));
});

test('the public stream reveals nothing about pending or rejected photos', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const stream = await s.openStream(t, '/api/public/events');
  await stream.waitFor(({ event }) => event === 'playlist');

  const pending = await s.upload();
  const rejected = await s.upload();
  await s.moderate(cookie, rejected, 'reject');

  // A marker approval proves the stream is flowing and that the earlier actions sent nothing.
  const marker = await s.upload();
  await s.moderate(cookie, marker, 'approve');
  await stream.waitFor(({ data }) => data.photos?.some((photo) => photo.id === marker));

  const playlists = stream.events.filter(({ event }) => event === 'playlist');
  assert.equal(playlists.length, 2);
  const seen = JSON.stringify(stream.events);
  assert.equal(seen.includes(pending), false);
  assert.equal(seen.includes(rejected), false);
});

test('organizers get live updates as new uploads arrive', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const stream = await s.openStream(t, '/api/organizer/events', { cookie });
  await stream.waitFor(({ data }) => data.counts?.pending === 0);
  await s.upload();
  await stream.waitFor(({ data }) => data.counts?.pending === 1);
});
