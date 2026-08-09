const crypto = require('crypto');
const { getWalletBySummoner } = require('./wallets');

function normalizeSummoner(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function roundUsdt(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000;
}

async function initLedgerSchema(db) {
  if (db.mode === 'postgres') {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        summoner TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        amount NUMERIC(18, 6) NOT NULL,
        ref_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_summoner ON ledger_entries (summoner);
      CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_entries (ref_id);

      CREATE TABLE IF NOT EXISTS deposits (
        id TEXT PRIMARY KEY,
        summoner TEXT NOT NULL,
        amount_usdt NUMERIC(18, 6) NOT NULL,
        expected_amount_usdt NUMERIC(18, 6) NOT NULL,
        deposit_address TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        received_amount_usdt NUMERIC(18, 6),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits (status);
      CREATE INDEX IF NOT EXISTS idx_deposits_summoner ON deposits (summoner);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_tx_hash ON deposits (tx_hash) WHERE tx_hash IS NOT NULL;
    `);
    return;
  }

  const store = db.readStore();
  store.ledger = store.ledger ?? { entries: [] };
  store.deposits = store.deposits ?? {};
  db.writeStore(store);
}

function readJsonLedgerStore(db) {
  const store = db.readStore();
  store.ledger = store.ledger ?? { entries: [] };
  store.deposits = store.deposits ?? {};
  return store;
}

async function getBalance(db, summoner) {
  const key = normalizeSummoner(summoner);
  if (!key) return 0;

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS balance FROM ledger_entries WHERE summoner = $1`,
      [key]
    );
    return roundUsdt(result.rows[0]?.balance ?? 0);
  }

  const store = readJsonLedgerStore(db);
  const total = store.ledger.entries
    .filter((entry) => entry.summoner === key)
    .reduce((sum, entry) => sum + Number(entry.amount), 0);
  return roundUsdt(total);
}

async function addLedgerEntry(db, { summoner, entryType, amount, refId = null }) {
  const key = normalizeSummoner(summoner);
  if (!key) throw new Error('summoner is required');

  const id = newId('led');
  const createdAt = new Date().toISOString();
  const normalizedAmount = roundUsdt(amount);

  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      INSERT INTO ledger_entries (id, summoner, entry_type, amount, ref_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [id, key, entryType, normalizedAmount, refId, createdAt]
    );
    return { id, summoner: key, entryType, amount: normalizedAmount, refId, createdAt };
  }

  const store = readJsonLedgerStore(db);
  const entry = {
    id,
    summoner: key,
    entryType,
    amount: normalizedAmount,
    refId,
    createdAt
  };
  store.ledger.entries.push(entry);
  db.writeStore(store);
  return entry;
}

async function tryAdjustBalance(db, { summoner, delta, entryType, refId = null }) {
  const key = normalizeSummoner(summoner);
  if (!key) return { ok: false, balance: 0 };

  const change = roundUsdt(delta);
  if (change === 0) {
    const balance = await getBalance(db, key);
    return { ok: true, balance };
  }

  if (db.mode === 'postgres') {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const balanceResult = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS balance FROM ledger_entries WHERE summoner = $1`,
        [key]
      );
      const current = roundUsdt(balanceResult.rows[0]?.balance ?? 0);
      const next = roundUsdt(current + change);
      if (next < -0.000001) {
        await client.query('ROLLBACK');
        return { ok: false, balance: current };
      }

      const id = newId('led');
      const createdAt = new Date().toISOString();
      await client.query(
        `
        INSERT INTO ledger_entries (id, summoner, entry_type, amount, ref_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [id, key, entryType, change, refId, createdAt]
      );
      await client.query('COMMIT');
      return { ok: true, balance: next };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const store = readJsonLedgerStore(db);
  const current = store.ledger.entries
    .filter((entry) => entry.summoner === key)
    .reduce((sum, entry) => sum + Number(entry.amount), 0);
  const next = roundUsdt(current + change);
  if (next < -0.000001) {
    return { ok: false, balance: roundUsdt(current) };
  }

  store.ledger.entries.push({
    id: newId('led'),
    summoner: key,
    entryType,
    amount: change,
    refId,
    createdAt: new Date().toISOString()
  });
  db.writeStore(store);
  return { ok: true, balance: next };
}

async function listPendingDeposits(db) {
  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT
        id,
        summoner,
        amount_usdt AS "amountUsdt",
        expected_amount_usdt AS "expectedAmountUsdt",
        deposit_address AS "depositAddress",
        status,
        tx_hash AS "txHash",
        received_amount_usdt AS "receivedAmountUsdt",
        expires_at AS "expiresAt",
        created_at AS "createdAt",
        completed_at AS "completedAt"
      FROM deposits
      WHERE status IN ('pending', 'confirming')
      ORDER BY created_at ASC
      `
    );
    return result.rows.map(formatDepositRow);
  }

  const store = readJsonLedgerStore(db);
  return Object.values(store.deposits)
    .filter((deposit) => deposit.status === 'pending' || deposit.status === 'confirming')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function getDeposit(db, depositId) {
  if (!depositId) return null;

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT
        id,
        summoner,
        amount_usdt AS "amountUsdt",
        expected_amount_usdt AS "expectedAmountUsdt",
        deposit_address AS "depositAddress",
        status,
        tx_hash AS "txHash",
        received_amount_usdt AS "receivedAmountUsdt",
        expires_at AS "expiresAt",
        created_at AS "createdAt",
        completed_at AS "completedAt"
      FROM deposits
      WHERE id = $1
      `,
      [depositId]
    );
    return result.rows[0] ? formatDepositRow(result.rows[0]) : null;
  }

  const store = readJsonLedgerStore(db);
  return store.deposits[depositId] ?? null;
}

function formatDepositRow(row) {
  return {
    id: row.id,
    summoner: row.summoner,
    amountUsdt: roundUsdt(row.amountUsdt),
    expectedAmountUsdt: roundUsdt(row.expectedAmountUsdt),
    depositAddress: row.depositAddress,
    status: row.status,
    txHash: row.txHash ?? null,
    receivedAmountUsdt: row.receivedAmountUsdt != null ? roundUsdt(row.receivedAmountUsdt) : null,
    expiresAt: row.expiresAt?.toISOString?.() ?? row.expiresAt,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    completedAt: row.completedAt?.toISOString?.() ?? row.completedAt ?? null
  };
}

async function allocateExpectedAmount(db, baseAmount) {
  const pending = await listPendingDeposits(db);
  const used = new Set(pending.map((deposit) => deposit.expectedAmountUsdt));

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const suffix = (Math.floor(Math.random() * 9000) + 1000) / 1_000_000;
    const expected = roundUsdt(baseAmount + suffix);
    if (!used.has(expected)) return expected;
  }

  throw new Error('Unable to allocate unique deposit amount');
}

async function createDeposit(db, config, { summoner, amountUsdt }) {
  const key = normalizeSummoner(summoner);
  if (!key) throw new Error('summoner is required');

  const amount = roundUsdt(amountUsdt);
  if (amount < config.minDepositUsdt || amount > config.maxDepositUsdt) {
    const err = new Error(`Amount must be between ${config.minDepositUsdt} and ${config.maxDepositUsdt} USDT`);
    err.code = 'VALIDATION';
    throw err;
  }

  const wallet = await getWalletBySummoner(db, key);
  if (!wallet?.depositAddress) {
    const err = new Error('Wallet not found for summoner — sync wallet first');
    err.code = 'NO_WALLET';
    throw err;
  }

  const expectedAmountUsdt = roundUsdt(amount);
  const id = newId('dep');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + config.depositExpiryMinutes * 60_000);
  const deposit = {
    id,
    summoner: key,
    amountUsdt: amount,
    expectedAmountUsdt,
    depositAddress: wallet.depositAddress,
    status: 'pending',
    txHash: null,
    receivedAmountUsdt: null,
    expiresAt: expiresAt.toISOString(),
    createdAt: createdAt.toISOString(),
    completedAt: null
  };

  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      INSERT INTO deposits (
        id, summoner, amount_usdt, expected_amount_usdt, deposit_address,
        status, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
      `,
      [
        deposit.id,
        deposit.summoner,
        deposit.amountUsdt,
        deposit.expectedAmountUsdt,
        deposit.depositAddress,
        deposit.expiresAt,
        deposit.createdAt
      ]
    );
  } else {
    const store = readJsonLedgerStore(db);
    store.deposits[id] = deposit;
    db.writeStore(store);
  }

  return deposit;
}

async function markDepositStatus(db, depositId, patch) {
  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      UPDATE deposits
      SET
        status = COALESCE($2, status),
        tx_hash = COALESCE($3, tx_hash),
        received_amount_usdt = COALESCE($4, received_amount_usdt),
        completed_at = COALESCE($5, completed_at)
      WHERE id = $1
      `,
      [
        depositId,
        patch.status ?? null,
        patch.txHash ?? null,
        patch.receivedAmountUsdt ?? null,
        patch.completedAt ?? null
      ]
    );
    return getDeposit(db, depositId);
  }

  const store = readJsonLedgerStore(db);
  const existing = store.deposits[depositId];
  if (!existing) return null;

  store.deposits[depositId] = {
    ...existing,
    ...patch
  };
  db.writeStore(store);
  return store.deposits[depositId];
}

async function completeDeposit(db, deposit, { txHash, receivedAmountUsdt }) {
  const existing = await getDeposit(db, deposit.id);
  if (!existing || existing.status === 'completed') return existing;

  const creditAmount = roundUsdt(receivedAmountUsdt ?? existing.expectedAmountUsdt);
  await addLedgerEntry(db, {
    summoner: existing.summoner,
    entryType: 'deposit',
    amount: creditAmount,
    refId: existing.id
  });

  return markDepositStatus(db, existing.id, {
    status: 'completed',
    txHash,
    receivedAmountUsdt: creditAmount,
    completedAt: new Date().toISOString()
  });
}

async function expireStaleDeposits(db) {
  const now = Date.now();
  const pending = await listPendingDeposits(db);
  const expired = [];

  for (const deposit of pending) {
    if (new Date(deposit.expiresAt).getTime() > now) continue;

    await markDepositStatus(db, deposit.id, { status: 'expired' });
    expired.push(deposit.id);
  }

  return expired;
}

async function isTxHashUsed(db, txHash) {
  if (!txHash) return false;

  if (db.mode === 'postgres') {
    const result = await db.pool.query(`SELECT 1 FROM deposits WHERE tx_hash = $1 LIMIT 1`, [txHash]);
    return result.rowCount > 0;
  }

  const store = readJsonLedgerStore(db);
  return Object.values(store.deposits).some((deposit) => deposit.txHash === txHash);
}

async function getActiveDepositForSummoner(db, summoner) {
  const key = normalizeSummoner(summoner);
  if (!key) return null;

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT
        id,
        summoner,
        amount_usdt AS "amountUsdt",
        expected_amount_usdt AS "expectedAmountUsdt",
        deposit_address AS "depositAddress",
        status,
        tx_hash AS "txHash",
        received_amount_usdt AS "receivedAmountUsdt",
        expires_at AS "expiresAt",
        created_at AS "createdAt",
        completed_at AS "completedAt"
      FROM deposits
      WHERE summoner = $1 AND status IN ('pending', 'confirming')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [key]
    );
    return result.rows[0] ? formatDepositRow(result.rows[0]) : null;
  }

  const store = readJsonLedgerStore(db);
  const active = Object.values(store.deposits)
    .filter((deposit) => deposit.summoner === key && (deposit.status === 'pending' || deposit.status === 'confirming'))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return active[0] ? formatDepositRow(active[0]) : null;
}

async function creditWalletDeposit(db, config, { summoner, txHash, receivedAmountUsdt, depositAddress }) {
  if (!txHash) return { credited: false, reason: 'no_tx' };
  if (await isTxHashUsed(db, txHash)) return { credited: false, reason: 'duplicate' };

  const key = normalizeSummoner(summoner);
  if (!key) return { credited: false, reason: 'invalid_summoner' };

  const amount = roundUsdt(receivedAmountUsdt);
  if (amount < config.minDepositUsdt) return { credited: false, reason: 'below_min' };

  await addLedgerEntry(db, {
    summoner: key,
    entryType: 'deposit',
    amount,
    refId: txHash
  });

  const now = new Date().toISOString();
  const id = newId('dep');
  const deposit = {
    id,
    summoner: key,
    amountUsdt: amount,
    expectedAmountUsdt: amount,
    depositAddress,
    status: 'completed',
    txHash,
    receivedAmountUsdt: amount,
    expiresAt: now,
    createdAt: now,
    completedAt: now
  };

  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      INSERT INTO deposits (
        id, summoner, amount_usdt, expected_amount_usdt, deposit_address,
        status, tx_hash, received_amount_usdt, expires_at, created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8, $9, $9)
      `,
      [
        deposit.id,
        deposit.summoner,
        deposit.amountUsdt,
        deposit.expectedAmountUsdt,
        deposit.depositAddress,
        deposit.txHash,
        deposit.receivedAmountUsdt,
        deposit.expiresAt,
        deposit.createdAt
      ]
    );
  } else {
    const store = readJsonLedgerStore(db);
    store.deposits[id] = deposit;
    db.writeStore(store);
  }

  return { credited: true, amount, deposit };
}

module.exports = {
  initLedgerSchema,
  normalizeSummoner,
  getBalance,
  addLedgerEntry,
  tryAdjustBalance,
  createDeposit,
  getDeposit,
  getActiveDepositForSummoner,
  creditWalletDeposit,
  listPendingDeposits,
  markDepositStatus,
  completeDeposit,
  expireStaleDeposits,
  isTxHashUsed,
  roundUsdt
};
