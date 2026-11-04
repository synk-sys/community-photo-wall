import { Readable } from 'node:stream';
import { auth, drive } from '@googleapis/drive';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** Builds an authenticated Drive client from a service account key or an OAuth refresh token. */
export function createDriveClient(config) {
  if (config.oauthRefreshToken) {
    const client = new auth.OAuth2(config.oauthClientId, config.oauthClientSecret);
    client.setCredentials({ refresh_token: config.oauthRefreshToken });
    return drive({ version: 'v3', auth: client });
  }
  if (config.serviceAccountKeyFile) {
    const client = new auth.GoogleAuth({ keyFile: config.serviceAccountKeyFile, scopes: [DRIVE_SCOPE] });
    return drive({ version: 'v3', auth: client });
  }
  throw new Error('Set GOOGLE_OAUTH_REFRESH_TOKEN or GOOGLE_SERVICE_ACCOUNT_KEY_FILE to use Google Drive');
}

/**
 * Stores photos in a private Drive folder. This adapter never creates a permission and never
 * requests or stores Drive links: bytes only ever reach browsers through the application proxy.
 */
export function createDriveStorage({ client, folderId }) {
  return {
    /** Refuses to run against a folder that link or domain sharing would expose. */
    async assertPrivate() {
      const { data } = await client.permissions.list({
        fileId: folderId,
        supportsAllDrives: true,
        fields: 'permissions(type,role)',
      });
      const exposed = (data.permissions ?? []).filter(({ type }) => type === 'anyone' || type === 'domain');
      if (exposed.length > 0) {
        throw new Error(`Drive folder ${folderId} is shared via link or domain; make it private before starting`);
      }
    },
    async put(name, bytes, mimeType) {
      const { data } = await client.files.create({
        requestBody: { name, parents: [folderId], mimeType },
        media: { mimeType, body: Readable.from(bytes) },
        fields: 'id',
        supportsAllDrives: true,
      });
      return data.id;
    },
    async get(key) {
      const { data } = await client.files.get(
        { fileId: key, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      );
      return Buffer.from(data);
    },
    async delete(key) {
      await client.files.delete({ fileId: key, supportsAllDrives: true });
    },
  };
}
