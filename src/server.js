import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createDriveClient, createDriveStorage } from './storage/drive.js';
import { createLocalStorage } from './storage/local.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const storage =
  config.storageDriver === 'local'
    ? createLocalStorage({ directory: config.localStorageDir })
    : createDriveStorage({ client: createDriveClient(config.drive), folderId: config.drive.folderId });

await storage.assertPrivate();

const { app, close } = createApp({ db, storage, config });
const server = app.listen(config.port, () => {
  console.log(`Photo wall listening on http://localhost:${config.port} (storage: ${config.storageDriver})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    close();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
