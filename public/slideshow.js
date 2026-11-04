import { followPlaylist } from '/live-playlist.js';

const SLIDE_MS = 8000;
const slide = document.querySelector('#slide');
const idle = document.querySelector('#idle');
const IDLE_MESSAGE = idle.textContent;

let playlist = [];        // Approved ids, always replaced wholesale by the server's latest list.
let upNext = [];          // Newly approved ids, shown ahead of the normal rotation.
let cursor = -1;
let currentId = null;
let loadingId = null;
let loadGeneration = 0;
let seenFirstList = false;
let stale = false;
let timer;

function clearSlide(message = IDLE_MESSAGE) {
  currentId = null;
  slide.removeAttribute('src');
  slide.classList.remove('visible');
  idle.textContent = message;
  idle.hidden = false;
}

function pickNext() {
  if (upNext.length > 0) {
    const id = upNext.shift();
    cursor = playlist.indexOf(id);
    return id;
  }
  if (playlist.length === 0) return null;
  cursor = (cursor + 1) % playlist.length;
  return playlist[cursor];
}

/**
 * Loads the next photo and swaps it in. Queued photos are only ever ids: bytes are fetched fresh
 * from the access-checked endpoint right before display, and the id is checked against the latest
 * list once they arrive, so a photo revoked while queued or mid-load never reaches the screen.
 */
function advance() {
  clearTimeout(timer);
  const generation = ++loadGeneration;
  loadingId = null;
  if (stale) return;

  const id = pickNext();
  if (!id) return clearSlide();

  loadingId = id;
  // The unique query stops the browser's in-page image cache from skipping the server check.
  const url = `/api/public/photos/${id}/image?t=${Date.now()}`;
  const next = new Image();
  next.onload = () => {
    if (generation !== loadGeneration) return;
    loadingId = null;
    if (!playlist.includes(id)) return advance();
    slide.src = url;
    slide.classList.add('visible');
    idle.hidden = true;
    currentId = id;
    timer = setTimeout(advance, SLIDE_MS);
  };
  next.onerror = () => {
    if (generation !== loadGeneration) return;
    loadingId = null;
    playlist = playlist.filter((other) => other !== id);
    upNext = upNext.filter((other) => other !== id);
    if (id === currentId || !currentId) clearSlide();
    // Pause briefly so an outage doesn't become a tight retry loop. The next poll restores anything transient.
    timer = setTimeout(advance, playlist.length > 0 ? 250 : SLIDE_MS);
  };
  next.src = url;
}

followPlaylist({
  onPlaylist(photos) {
    const ids = photos.map((photo) => photo.id);
    const known = new Set(playlist);
    const allowed = new Set(ids);
    playlist = ids;
    upNext = upNext.filter((id) => allowed.has(id));
    if (seenFirstList) upNext.push(...ids.filter((id) => !known.has(id) && !upNext.includes(id)));
    seenFirstList = true;

    const wasStale = stale;
    stale = false;
    if (currentId && !allowed.has(currentId)) {
      // Revoked while on screen: take it down now, before anything else happens.
      clearSlide();
      advance();
    } else if (wasStale || (!currentId && !loadingId)) {
      advance();
    }
  },
  onStale() {
    stale = true;
    clearTimeout(timer);
    loadGeneration += 1;
    loadingId = null;
    clearSlide('Reconnecting…');
  },
});
