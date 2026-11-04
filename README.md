# Community Photo Wall

Photo wall for DevFest Toronto. Attendees upload photos, organizers review them, and only approved photos reach the projector.

| Page | Who | What |
| --- | --- | --- |
| `/` | Attendees | Upload a photo |
| `/slideshow` | Projector | Full-screen rotation of approved photos |
| `/gallery` | Anyone | Grid of approved photos |
| `/organizer` | Organizers | Moderation dashboard (sign-in required) |

## How moderation is enforced

- **Every upload starts `pending`.** The upload route reads only the file and the consent flag, and a database trigger refuses any other starting status.
- **Public means `moderationStatus = approved` and `consentToDisplay = true`.** That condition is defined once, in `PUBLIC_WHERE` in `src/db.js`, and every public read uses it.
- **Photos only reach browsers through the app.** Files sit in a private Drive folder and the app holds the credentials. It never creates Drive permissions or stores Drive links. `/api/public/photos/:id/image` checks status on every request, and again after fetching from Drive, so revocation applies to the next request.
- **Responses are `Cache-Control: no-store`**, so browsers and CDNs can't keep serving a revoked photo. Hidden photos return the same 404 as unknown ids.
- **Moderation requires an organizer session.** Sessions are checked server-side, cookies are `HttpOnly; SameSite=Strict`, and cross-origin writes are refused. Attendees have no accounts and no route that changes status.
- **Screens update live over server-sent events, with polling as a fallback.** The slideshow queues ids rather than images, and re-checks each photo right before showing it. If a screen can't confirm the approved list for 30 seconds, it blanks until it reconnects, because it can't learn about revocations while offline.

Revoking moves a photo to the Rejected tab, marked "Revoked". Every action is recorded with the organizer's email in the `moderation_events` table.

## Setup

Requires Node 22.13 or later.

```sh
npm install
cp .env.example .env
npm run hash-password -- you@example.org   # paste the output into ORGANIZERS
npm start
```

### Google Drive

Create a folder, keep it private, and put its id in `GOOGLE_DRIVE_FOLDER_ID`. The app won't start if the folder is shared by link or with a whole domain. It checks this only at startup, so don't turn sharing on later. Then choose one credential type:

- **Personal Google account: OAuth refresh token.** Service accounts have no storage quota, so they can't upload to a personal Drive. The token needs the `https://www.googleapis.com/auth/drive` scope, which covers that account's whole Drive, so use an account dedicated to the event. Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and `GOOGLE_OAUTH_REFRESH_TOKEN`.
- **Google Workspace: service account.** Add it as a Content Manager on a Shared Drive folder and set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`.

### Running without Drive

For local development, set `STORAGE_DRIVER=local` to save files under `data/photos`. Production mode (`NODE_ENV=production`) refuses this setting.

## Deployment

- Serve it over HTTPS. In production, session cookies are `Secure`, so organizers can't sign in over plain HTTP.
- Run **one process with a persistent disk**. Moderation data is in SQLite and live updates are in memory, so multiple instances or an ephemeral filesystem won't work.
- If there is a reverse proxy in front, set `TRUST_PROXY` to the number of proxies, and make sure it doesn't buffer `text/event-stream` responses.

## Tests

```sh
npm test
```

`test/public-access.test.js` covers the core guarantee: pending, rejected, revoked and no-consent photos can't be reached through any public endpoint. Tests use in-memory storage and a fake Drive client, so they don't touch a real Drive account.
