const { TronWeb } = require('tronweb');
const { encryptPrivateKey, decryptPrivateKey } = require('./walletCrypto');

function normalizeSummoner(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function mapWalletRow(row) {
  if (!row) return null;
  return {
    summoner: row.summoner,
    depositAddress: row.deposit_address ?? row.depositAddress,
    encryptedPrivateKey: row.encrypted_private_key ?? row.encryptedPrivateKey,
    createdAt: row.created_at?.toISOString?.() ?? row.createdAt,
    lastSeenAt: row.last_seen_at?.toISOString?.() ?? row.lastSeenAt
  };
}

async function ensureWalletSchema(db) {
  if (db.mode === 'postgres') {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS user_wallets (
        summoner TEXT PRIMARY KEY,
        deposit_address TEXT NOT NULL UNIQUE,
        encrypted_private_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_address
        ON user_wallets (deposit_address);
    `);
    return;
  }

  const store = db.readStore();
  store.userWallets = store.userWallets ?? {};
  db.writeStore(store);
}

function readJsonWalletStore(db) {
  const store = db.readStore();
  store.userWallets = store.userWallets ?? {};
  return store;
}

async function generateTronWallet() {
  const account = await TronWeb.createAccount();
  const depositAddress = account.address?.base58 ?? account.address;
  const privateKey = account.privateKey;
  if (!depositAddress || !privateKey) {
    throw new Error('Failed to generate Tron wallet');
  }
  return { depositAddress, privateKey };
}

async function getWalletBySummoner(db, summoner) {
  await ensureWalletSchema(db);
  const key = normalizeSummoner(summoner);
  if (!key) return null;

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT summoner, deposit_address, encrypted_private_key, created_at, last_seen_at
      FROM user_wallets
      WHERE summoner = $1
      `,
      [key]
    );
    return mapWalletRow(result.rows[0]);
  }

  const store = readJsonWalletStore(db);
  return mapWalletRow(store.userWallets[key]);
}

async function getWalletByAddress(db, depositAddress) {
  await ensureWalletSchema(db);
  if (!depositAddress) return null;

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT summoner, deposit_address, encrypted_private_key, created_at, last_seen_at
      FROM user_wallets
      WHERE deposit_address = $1
      `,
      [depositAddress]
    );
    return mapWalletRow(result.rows[0]);
  }

  const store = readJsonWalletStore(db);
  return mapWalletRow(
    Object.values(store.userWallets).find((row) => row.depositAddress === depositAddress)
  );
}

async function saveWallet(db, { summoner, depositAddress, encryptedPrivateKey, createdAt }) {
  const now = createdAt ?? new Date().toISOString();

  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      INSERT INTO user_wallets (summoner, deposit_address, encrypted_private_key, created_at, last_seen_at)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (summoner) DO UPDATE
      SET last_seen_at = EXCLUDED.last_seen_at
      `,
      [summoner, depositAddress, encryptedPrivateKey, now]
    );
    return;
  }

  const store = readJsonWalletStore(db);
  store.userWallets[summoner] = {
    summoner,
    depositAddress,
    encryptedPrivateKey,
    createdAt: now,
    lastSeenAt: now
  };
  db.writeStore(store);
}

async function touchWallet(db, summoner) {
  const key = normalizeSummoner(summoner);
  if (!key) return;

  const now = new Date().toISOString();
  if (db.mode === 'postgres') {
    await db.pool.query(`UPDATE user_wallets SET last_seen_at = $2 WHERE summoner = $1`, [key, now]);
    return;
  }

  const store = readJsonWalletStore(db);
  if (store.userWallets[key]) {
    store.userWallets[key].lastSeenAt = now;
    db.writeStore(store);
  }
}

async function listAllWallets(db) {
  await ensureWalletSchema(db);

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT summoner, deposit_address, encrypted_private_key, created_at, last_seen_at
      FROM user_wallets
      ORDER BY created_at ASC
      `
    );
    return result.rows.map(mapWalletRow);
  }

  const store = readJsonWalletStore(db);
  return Object.values(store.userWallets).map(mapWalletRow);
}

async function ensureUserWallet(db, config, summoner) {
  const key = normalizeSummoner(summoner);
  if (!key) {
    const err = new Error('summoner is required');
    err.code = 'VALIDATION';
    throw err;
  }

  const existing = await getWalletBySummoner(db, key);
  if (existing) {
    await touchWallet(db, key);
    return {
      summoner: key,
      depositAddress: existing.depositAddress,
      created: false,
      createdAt: existing.createdAt
    };
  }

  const generated = await generateTronWallet();
  const encryptedPrivateKey = encryptPrivateKey(generated.privateKey, config);
  const createdAt = new Date().toISOString();

  await saveWallet(db, {
    summoner: key,
    depositAddress: generated.depositAddress,
    encryptedPrivateKey,
    createdAt
  });

  return {
    summoner: key,
    depositAddress: generated.depositAddress,
    created: true,
    createdAt
  };
}

async function getWalletPrivateKey(db, config, summoner) {
  const wallet = await getWalletBySummoner(db, summoner);
  if (!wallet?.encryptedPrivateKey) return null;
  return decryptPrivateKey(wallet.encryptedPrivateKey, config);
}

module.exports = {
  ensureWalletSchema,
  ensureUserWallet,
  getWalletBySummoner,
  getWalletByAddress,
  listAllWallets,
  getWalletPrivateKey,
  touchWallet
};
