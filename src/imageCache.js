/**
 * Byte-bounded LRU in front of Drive, so a busy gallery doesn't exhaust the Drive API quota.
 * It holds bytes only. Callers must authorize a photo before asking for them.
 */
export class ImageCache {
  #entries = new Map();
  #inFlight = new Map();
  #bytes = 0;

  constructor({ storage, maxBytes = 200 * 1024 * 1024 }) {
    this.storage = storage;
    this.maxBytes = maxBytes;
  }

  async load(photo) {
    const cached = this.#entries.get(photo.id);
    if (cached) {
      this.#entries.delete(photo.id);
      this.#entries.set(photo.id, cached);
      return cached;
    }
    let pending = this.#inFlight.get(photo.id);
    if (!pending) {
      pending = this.storage.get(photo.storage_key).finally(() => this.#inFlight.delete(photo.id));
      this.#inFlight.set(photo.id, pending);
    }
    return pending;
  }

  store(id, bytes) {
    if (bytes.length > this.maxBytes) return;
    this.purge(id);
    this.#entries.set(id, bytes);
    this.#bytes += bytes.length;
    for (const [oldestId] of this.#entries) {
      if (this.#bytes <= this.maxBytes) break;
      this.purge(oldestId);
    }
  }

  purge(id) {
    const existing = this.#entries.get(id);
    if (existing) {
      this.#bytes -= existing.length;
      this.#entries.delete(id);
    }
  }
}
