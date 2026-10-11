'use strict';

/** Fixed-window limiter, keyed by client IP. Returns Express middleware with a stop() hook. */
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, Math.min(windowMs, 60_000));
  sweeper.unref();

  const middleware = (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(req.ip, entry);
    }
    if (++entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
  middleware.stop = () => clearInterval(sweeper);
  return middleware;
}

module.exports = { createRateLimiter };
