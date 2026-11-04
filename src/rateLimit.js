/** Fixed-window, in-memory limiter. `keyFor` chooses what is being limited. */
export function rateLimit({ windowMs, max, keyFor, now = Date.now }) {
  const windows = new Map();
  return (req, res, next) => {
    const at = now();
    if (windows.size > 10_000) {
      for (const [key, entry] of windows) if (entry.resetAt <= at) windows.delete(key);
    }
    const key = keyFor(req);
    let entry = windows.get(key);
    if (!entry || entry.resetAt <= at) {
      entry = { count: 0, resetAt: at + windowMs };
      windows.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - at) / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    }
    next();
  };
}
