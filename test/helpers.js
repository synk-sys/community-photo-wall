import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { openDatabase } from '../src/db.js';

export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7)]);
export const ORGANIZER = { email: 'organizer@example.org', password: 'correct horse battery' };
const organizerHash = await hashPassword(ORGANIZER.password);

export function memoryStorage() {
  const files = new Map();
  return {
    files,
    gets: 0,
    async put(name, bytes) {
      files.set(name, bytes);
      return name;
    },
    async get(key) {
      this.gets += 1;
      if (this.beforeGet) await this.beforeGet();
      return files.get(key);
    },
    async delete(key) {
      files.delete(key);
    },
  };
}

/** Boots the real app on a real socket, so tests exercise the same HTTP surface a client sees. */
export async function startServer(t, overrides = {}) {
  const db = openDatabase(':memory:');
  const storage = memoryStorage();
  const clock = { now: 1_800_000_000_000 };
  const organizers = overrides.organizers ?? new Map([[ORGANIZER.email, organizerHash]]);
  const { app, photos, close, heartbeat } = createApp({
    db,
    storage,
    now: () => clock.now,
    config: { organizers, cookieSecure: false, trustProxy: 0, uploadsPerMinute: 1000 },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => {
    close();
    server.closeAllConnections();
    server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const context = {
    base,
    db,
    storage,
    photos,
    heartbeat,
    clock,
    organizers,

    /** Uploads as an anonymous attendee and returns the new photo's id, read from the database. */
    async upload({ consent = true, extraFields = {}, bytes = JPEG } = {}) {
      const before = new Set(db.prepare('SELECT id FROM photos').all().map((row) => row.id));
      const response = await context.postUpload({ consent, extraFields, bytes });
      if (response.status !== 201) throw new Error(`upload failed: ${response.status}`);
      return db.prepare('SELECT id FROM photos').all().map((row) => row.id).find((id) => !before.has(id));
    },
    postUpload({ consent = true, extraFields = {}, bytes = JPEG, type = 'image/jpeg' } = {}) {
      const form = new FormData();
      if (consent) form.set('consentToDisplay', 'true');
      for (const [key, value] of Object.entries(extraFields)) form.set(key, value);
      form.set('photo', new Blob([bytes], { type }), 'photo.jpg');
      return fetch(`${base}/api/photos`, { method: 'POST', body: form });
    },

    async login(email = ORGANIZER.email, password = ORGANIZER.password) {
      const response = await context.post('/api/organizer/login', { email, password });
      if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
      return response.headers.get('set-cookie').split(';')[0];
    },
    post(path, body = {}, headers = {}) {
      return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    },
    moderate(cookie, id, action, body = {}) {
      return context.post(`/api/organizer/photos/${id}/${action}`, body, { cookie });
    },
    status: (id) => db.prepare('SELECT moderation_status AS s FROM photos WHERE id = ?').get(id).s,

    /** Opens an SSE stream and returns helpers for waiting on its events. */
    async openStream(t2, path, headers = {}) {
      const controller = new AbortController();
      const response = await fetch(`${base}${path}`, { headers, signal: controller.signal });
      const events = [];
      const waiters = [];
      const pump = (async () => {
        let buffer = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = block.match(/^event: (.*)$/m)[1];
            const data = JSON.parse(block.match(/^data: (.*)$/m)[1]);
            events.push({ event, data });
            waiters.splice(0).forEach((check) => check());
          }
        }
      })().catch(() => {});
      t2.after(() => {
        controller.abort();
        return pump;
      });
      return {
        response,
        events,
        closed: pump,
        /** Resolves with the first event, past or future, that matches the predicate. */
        waitFor(predicate, timeoutMs = 2000) {
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(events)}`)), timeoutMs);
            const check = () => {
              const match = events.find(predicate);
              if (match) {
                clearTimeout(timeout);
                resolve(match);
              } else {
                waiters.push(check);
              }
            };
            check();
          });
        },
      };
    },
  };
  return context;
}
