const buckets = new Map();

function checkRateLimit(key, { maxRequests = 60, windowMs = 60_000 } = {}) {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart > windowMs) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  if (bucket.count > maxRequests) {
    const err = new Error('Rate limit exceeded');
    err.code = 'RATE_LIMIT';
    err.retryAfterMs = windowMs - (now - bucket.windowStart);
    throw err;
  }
}

function rateLimitMiddleware(getKey, options) {
  return (req, res, next) => {
    try {
      checkRateLimit(getKey(req), options);
      next();
    } catch (err) {
      if (err.code === 'RATE_LIMIT') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(err.retryAfterMs / 1000)) });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      throw err;
    }
  };
}

module.exports = { checkRateLimit, rateLimitMiddleware };
