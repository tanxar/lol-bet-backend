const crypto = require('crypto');

const SUMMONER_MAX_LENGTH = 64;
const SUMMONER_PATTERN = /^[A-Z0-9#_\-. ]+$/;

function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;

  return crypto.timingSafeEqual(left, right);
}

function validateSummonerName(value) {
  if (!value || typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > SUMMONER_MAX_LENGTH) return null;

  const normalized = trimmed.toUpperCase();
  if (!SUMMONER_PATTERN.test(normalized)) return null;

  return normalized;
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

module.exports = {
  timingSafeEqualStrings,
  validateSummonerName,
  applySecurityHeaders,
  isProduction,
  SUMMONER_MAX_LENGTH
};
