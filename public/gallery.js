import { followPlaylist } from '/live-playlist.js';

const gallery = document.querySelector('#gallery');
const empty = document.querySelector('#gallery-empty');
const images = new Map();

function render(photos) {
  const allowed = new Set(photos.map((photo) => photo.id));
  for (const [id, image] of images) {
    if (!allowed.has(id)) {
      image.remove();
      images.delete(id);
    }
  }
  // Newest first; prepending in list order keeps that as new photos arrive.
  for (const photo of photos) {
    if (images.has(photo.id)) continue;
    const image = new Image();
    image.loading = 'lazy';
    image.alt = 'Photo shared by a DevFest attendee';
    image.src = photo.imageUrl;
    images.set(photo.id, image);
    gallery.prepend(image);
  }
  empty.hidden = images.size > 0;
}

followPlaylist({ onPlaylist: render, onStale: () => render([]) });
