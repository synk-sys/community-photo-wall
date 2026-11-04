import { resolve } from 'node:path';
import { parseOrganizers } from './auth.js';

/** Reads and validates configuration, failing fast rather than starting in an insecure state. */
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const storageDriver = env.STORAGE_DRIVER ?? 'drive';

  if (storageDriver === 'local' && production) {
    throw new Error('STORAGE_DRIVER=local is for development only; production photos must go to Google Drive');
  }
  if (storageDriver !== 'local' && storageDriver !== 'drive') {
    throw new Error(`Unknown STORAGE_DRIVER: ${storageDriver}`);
  }
  if (storageDriver === 'drive' && !env.GOOGLE_DRIVE_FOLDER_ID) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is required');
  }

  const organizers = parseOrganizers(env.ORGANIZERS ?? '');
  if (organizers.size === 0) {
    throw new Error('ORGANIZERS must list at least one organizer (see npm run hash-password)');
  }

  return {
    port: Number(env.PORT ?? 3000),
    databasePath: resolve(env.DATABASE_PATH ?? 'data/photo-wall.db'),
    storageDriver,
    localStorageDir: resolve(env.LOCAL_STORAGE_DIR ?? 'data/photos'),
    drive: {
      folderId: env.GOOGLE_DRIVE_FOLDER_ID,
      serviceAccountKeyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
      oauthClientId: env.GOOGLE_OAUTH_CLIENT_ID,
      oauthClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      oauthRefreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
    },
    organizers,
    cookieSecure: production,
    publicOrigin: env.PUBLIC_ORIGIN,
    trustProxy: Number(env.TRUST_PROXY ?? 0),
    // Venue wifi puts many attendees behind one IP, so this is deliberately generous.
    uploadsPerMinute: Number(env.UPLOAD_RATE_LIMIT_PER_MINUTE ?? 60),
  };
}
