const crypto = require('crypto');

function resolveEncryptionKey(config) {
  const key = config.walletEncryptionKey;
  if (key && key.length >= 32) return key;

  if (config.isProduction) {
    const err = new Error('WALLET_ENCRYPTION_KEY must be set (min 32 characters) in production');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  return 'dev-only-insecure-wallet-key-do-not-use-in-prod!!';
}

function encryptPrivateKey(plainText, config) {
  const secret = resolveEncryptionKey(config);
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptPrivateKey(payload, config) {
  const secret = resolveEncryptionKey(config);
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = {
  encryptPrivateKey,
  decryptPrivateKey,
  resolveEncryptionKey
};
