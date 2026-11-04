const POLL_MS = 10_000;
const STALE_AFTER_MS = 30_000;

/**
 * Keeps a screen in step with the server's approved list: pushed instantly over SSE, with polling
 * as a fallback for venue proxies that break streaming.
 *
 * onStale fires when the list can't be confirmed for STALE_AFTER_MS. A disconnected screen can't
 * learn about revocations, so it must stop showing photos until it reconnects.
 */
export function followPlaylist({ onPlaylist, onStale }) {
  let lastConfirmed = Date.now();
  let stale = false;

  function receive(body) {
    lastConfirmed = Date.now();
    stale = false;
    onPlaylist(body.photos);
  }

  async function poll() {
    try {
      const response = await fetch('/api/public/photos');
      if (response.ok) receive(await response.json());
    } catch {
      // Staying silent lets the staleness check below take over.
    }
  }

  new EventSource('/api/public/events').addEventListener('playlist', (event) => {
    receive(JSON.parse(event.data));
  });
  setInterval(poll, POLL_MS);
  setInterval(() => {
    if (!stale && Date.now() - lastConfirmed > STALE_AFTER_MS) {
      stale = true;
      onStale();
    }
  }, 1000);
}
