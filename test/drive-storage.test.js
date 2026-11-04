import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDriveStorage } from '../src/storage/drive.js';
import { loadConfig } from '../src/config.js';

function fakeDriveClient(permissions = []) {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push({ name, args });
    return result;
  };
  return {
    calls,
    files: {
      create: record('files.create', { data: { id: 'drive-file-1' } }),
      get: record('files.get', { data: new TextEncoder().encode('bytes').buffer }),
      delete: record('files.delete', {}),
    },
    permissions: {
      list: record('permissions.list', { data: { permissions } }),
      create: record('permissions.create', {}),
    },
  };
}

test('uploads go to the private folder, with no sharing and no public links requested', async () => {
  const client = fakeDriveClient();
  const storage = createDriveStorage({ client, folderId: 'folder-1' });

  assert.equal(await storage.put('a.jpg', Buffer.from('x'), 'image/jpeg'), 'drive-file-1');
  const [{ args: [request] }] = client.calls;
  assert.deepEqual(request.requestBody.parents, ['folder-1']);
  assert.equal(request.fields, 'id', 'must not request webViewLink, webContentLink or thumbnailLink');
  assert.equal(client.calls.some(({ name }) => name === 'permissions.create'), false);
});

test('reads return bytes through the server credentials', async () => {
  const client = fakeDriveClient();
  const storage = createDriveStorage({ client, folderId: 'folder-1' });
  assert.equal((await storage.get('drive-file-1')).toString(), 'bytes');
  assert.equal(client.calls[0].args[0].alt, 'media');
});

test('startup is refused when the folder is exposed by link or domain sharing', async () => {
  for (const type of ['anyone', 'domain']) {
    const storage = createDriveStorage({ client: fakeDriveClient([{ type, role: 'reader' }]), folderId: 'f' });
    await assert.rejects(storage.assertPrivate(), /shared via link or domain/);
  }
  const ok = createDriveStorage({ client: fakeDriveClient([{ type: 'user', role: 'owner' }]), folderId: 'f' });
  await ok.assertPrivate();
});

test('configuration fails closed', () => {
  const organizers = `a@example.org=scrypt:${'ab'.repeat(16)}:${'cd'.repeat(32)}`;
  assert.throws(() => loadConfig({ ORGANIZERS: organizers }), /GOOGLE_DRIVE_FOLDER_ID/);
  assert.throws(() => loadConfig({ GOOGLE_DRIVE_FOLDER_ID: 'f' }), /ORGANIZERS/);
  assert.throws(() => loadConfig({ GOOGLE_DRIVE_FOLDER_ID: 'f', ORGANIZERS: 'a@example.org=plaintext' }), /ORGANIZERS entries/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', STORAGE_DRIVER: 'local', ORGANIZERS: organizers }), /development only/);
  assert.equal(loadConfig({ NODE_ENV: 'production', GOOGLE_DRIVE_FOLDER_ID: 'f', ORGANIZERS: organizers }).cookieSecure, true);
});
