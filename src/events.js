const HEARTBEAT_MS = 15_000;

/** A set of server-sent-event streams. */
export class EventHub {
  #clients = new Set();
  #timer;

  constructor({ maxClients = Infinity } = {}) {
    this.maxClients = maxClients;
    this.#timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.#timer.unref();
  }

  /** Opens a stream. `isValid` is re-checked on each heartbeat, so long-lived streams can't outlive their authorization. */
  subscribe(req, res, { isValid = () => true } = {}) {
    if (this.#clients.size >= this.maxClients) {
      res.status(503).json({ error: 'Too many live connections' });
      return false;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const client = { res, isValid };
    this.#clients.add(client);
    req.on('close', () => this.#clients.delete(client));
    return true;
  }

  static send(res, event, json) {
    res.write(`event: ${event}\ndata: ${json}\n\n`);
  }

  broadcast(event, json) {
    for (const { res } of this.#clients) EventHub.send(res, event, json);
  }

  heartbeat() {
    for (const client of this.#clients) {
      if (client.isValid()) {
        EventHub.send(client.res, 'ping', '{}');
      } else {
        client.res.end();
        this.#clients.delete(client);
      }
    }
  }

  close() {
    clearInterval(this.#timer);
    for (const { res } of this.#clients) res.end();
    this.#clients.clear();
  }
}
