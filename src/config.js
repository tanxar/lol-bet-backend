const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const isProduction = process.env.NODE_ENV === 'production';

module.exports = {
  port: parseInt(process.env.PORT, 10) || 5080,
  host: process.env.HOST || '0.0.0.0',
  apiKey: process.env.API_KEY || '',
  clientApiKey: process.env.CLIENT_API_KEY || process.env.API_KEY || '',
  adminApiKey: process.env.ADMIN_API_KEY || process.env.API_KEY || '',
  requireClientSignature: process.env.REQUIRE_CLIENT_SIGNATURE
    ? process.env.REQUIRE_CLIENT_SIGNATURE !== 'false'
    : isProduction,
  clientSignatureSkewMs: parseInt(process.env.CLIENT_SIGNATURE_SKEW_MS, 10) || 5 * 60 * 1000,
  isProduction,
  dataDir: process.env.DATA_DIR || './data',
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  auditLog: process.env.AUDIT_LOG || '',
  walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || '',
  usdtDepositAddress: process.env.USDT_TRC20_DEPOSIT_ADDRESS || '',
  usdtContract: process.env.USDT_TRC20_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  tronGridApiKey: process.env.TRONGRID_API_KEY || '',
  depositExpiryMinutes: parseInt(process.env.DEPOSIT_EXPIRY_MINUTES, 10) || 60,
  depositMonitorIntervalMs: parseInt(process.env.DEPOSIT_MONITOR_INTERVAL_MS, 10) || 30_000,
  depositMonitorActiveIntervalMs: parseInt(process.env.DEPOSIT_MONITOR_ACTIVE_INTERVAL_MS, 10) || 25_000,
  depositMonitorIdleIntervalMs: parseInt(process.env.DEPOSIT_MONITOR_IDLE_INTERVAL_MS, 10) || 90_000,
  tronGridRetryMaxAttempts: parseInt(process.env.TRONGRID_RETRY_MAX_ATTEMPTS, 10) || 3,
  tronGridRetryBaseMs: parseInt(process.env.TRONGRID_RETRY_BASE_MS, 10) || 4000,
  minDepositUsdt: Number(process.env.MIN_DEPOSIT_USDT) || 10,
  maxDepositUsdt: Number(process.env.MAX_DEPOSIT_USDT) || 10_000
};
