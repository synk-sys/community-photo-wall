import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SESSION_TTL_MS } from '../src/auth.js';
import { ORGANIZER, startServer } from './helpers.js';

const WRITE_ACTIONS = ['approve', 'reject', 'revoke'];

test('attendees cannot moderate: every organizer route refuses them', async (t) => {
  const s = await startServer(t);
  const id = await s.upload();
  const credentials = [
    {},
    { cookie: 'organizer_session=forged-token' },
    { cookie: 'organizer_session=' },
    { 'x-organizer': ORGANIZER.email, authorization: 'Bearer anything' },
  ];

  for (const headers of credentials) {
    for (const action of WRITE_ACTIONS) {
      const response = await s.post(`/api/organizer/photos/${id}/${action}`, { moderationStatus: 'approved' }, headers);
      assert.equal(response.status, 401, action);
    }
    assert.equal((await s.post('/api/organizer/photos/bulk-approve', { ids: [id] }, headers)).status, 401);
    for (const path of ['/photos?status=pending', `/photos/${id}/image`, '/events', '/me']) {
      const response = await fetch(`${s.base}/api/organizer${path}`, { headers });
      assert.equal(response.status, 401, path);
      await response.arrayBuffer();
    }
  }
  assert.equal(s.status(id), 'pending');
});

test('no public route accepts a status change', async (t) => {
  const s = await startServer(t);
  const id = await s.upload();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of [`/api/public/photos/${id}`, `/api/public/photos/${id}/image`, `/api/photos/${id}`]) {
      const response = await fetch(`${s.base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moderationStatus: 'approved' }),
      });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  }
  assert.equal(s.status(id), 'pending');
});

test('wrong credentials are refused, and repeated guessing is rate limited', async (t) => {
  const s = await startServer(t);
  const attempt = (email, password) => s.post('/api/organizer/login', { email, password });
  assert.equal((await attempt(ORGANIZER.email, 'wrong')).status, 401);
  assert.equal((await attempt('nobody@example.org', ORGANIZER.password)).status, 401);
  assert.equal((await attempt(undefined, undefined)).status, 401);

  for (let i = 0; i < 9; i += 1) await attempt(ORGANIZER.email, 'wrong');
  assert.equal((await attempt(ORGANIZER.email, ORGANIZER.password)).status, 429);
});

test('the session cookie cannot be read by scripts or sent cross-site', async (t) => {
  const s = await startServer(t);
  const response = await s.post('/api/organizer/login', ORGANIZER);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('sign-out, expiry and removal from the organizer list all end access', async (t) => {
  const s = await startServer(t);
  const id = await s.upload();
  const me = (cookie) => fetch(`${s.base}/api/organizer/me`, { headers: { cookie } });

  const signedOut = await s.login();
  assert.equal((await me(signedOut)).status, 200);
  assert.equal((await s.post('/api/organizer/logout', {}, { cookie: signedOut })).status, 204);
  assert.equal((await me(signedOut)).status, 401);
  assert.equal((await s.moderate(signedOut, id, 'approve')).status, 401);

  const expiring = await s.login();
  s.clock.now += SESSION_TTL_MS;
  assert.equal((await me(expiring)).status, 401);

  const removed = await s.login();
  s.organizers.delete(ORGANIZER.email);
  assert.equal((await me(removed)).status, 401);
  assert.equal((await s.moderate(removed, id, 'approve')).status, 401);
  assert.equal(s.status(id), 'pending');
});

test('session tokens are not stored in the database in usable form', async (t) => {
  const s = await startServer(t);
  const cookie = await s.login();
  const token = cookie.split('=')[1];
  const [row] = s.db.prepare('SELECT token_hash FROM sessions').all();
  assert.notEqual(row.token_hash, token);
});

test('cross-site requests are refused even with a valid session', async (t) => {
  const s = await startServer(t);
  const id = await s.upload();
  const cookie = await s.login();
  const response = await s.post(`/api/organizer/photos/${id}/approve`, {}, { cookie, origin: 'https://evil.example' });
  assert.equal(response.status, 403);
  assert.equal(s.status(id), 'pending');
});

test('a live organizer stream is closed once its session is no longer valid', async (t) => {
  const s = await startServer(t);
  const signedIn = await s.login();
  const signingOut = await s.login();
  const staying = await s.openStream(t, '/api/organizer/events', { cookie: signedIn });
  const leaving = await s.openStream(t, '/api/organizer/events', { cookie: signingOut });
  await staying.waitFor(({ event }) => event === 'change');
  await leaving.waitFor(({ event }) => event === 'change');

  await s.post('/api/organizer/logout', {}, { cookie: signingOut });
  s.heartbeat();
  await leaving.closed;

  // The other organizer's stream is unaffected and still receives updates.
  await staying.waitFor(({ event }) => event === 'ping');
  await s.upload();
  await staying.waitFor(({ data }) => data.counts?.pending === 1);
  assert.equal(leaving.events.some(({ data }) => data.counts?.pending === 1), false);
});
