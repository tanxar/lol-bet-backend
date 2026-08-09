const crypto = require('crypto');
const { timingSafeEqualStrings, validateSummonerName } = require('./security');

const SIGNATURE_SKEW_MS = 5 * 60 * 1000;

async function ensureClientSchema(db) {
  if (db.mode === 'postgres') {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS registered_clients (
        client_id TEXT PRIMARY KEY,
        client_secret TEXT NOT NULL,
        machine_fingerprint TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_registered_clients_fingerprint
        ON registered_clients (machine_fingerprint)
        WHERE revoked = FALSE;

      CREATE TABLE IF NOT EXISTS client_summoner_bindings (
        summoner TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_client_summoner_bindings_client
        ON client_summoner_bindings (client_id);
    `);
    return;
  }

  const store = db.readStore();
  store.registeredClients = store.registeredClients ?? {};
  store.clientSummonerBindings = store.clientSummonerBindings ?? {};
}

function readJsonStore(db) {
  const store = db.readStore();
  store.registeredClients = store.registeredClients ?? {};
  store.clientSummonerBindings = store.clientSummonerBindings ?? {};
  return store;
}

function hashBody(buffer) {
  return crypto.createHash('sha256').update(buffer ?? Buffer.alloc(0)).digest('hex');
}

function buildSignaturePayload({ timestamp, method, pathname, bodyHash }) {
  return `${timestamp}\n${method.toUpperCase()}\n${pathname}\n${bodyHash}`;
}

function signPayload(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function mapClientRow(row) {
  if (!row) return null;
  return {
    clientId: row.client_id ?? row.clientId,
    clientSecret: row.client_secret ?? row.clientSecret ?? row._plainSecret,
    machineFingerprint: row.machine_fingerprint ?? row.machineFingerprint,
    revoked: Boolean(row.revoked)
  };
}

async function getClientById(db, clientId) {
  if (!clientId) return null;

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT client_id, client_secret, machine_fingerprint, revoked
      FROM registered_clients
      WHERE client_id = $1
      `,
      [clientId]
    );
    return mapClientRow(result.rows[0]);
  }

  const store = readJsonStore(db);
  return mapClientRow(store.registeredClients[clientId]);
}

async function findActiveClientByFingerprint(db, fingerprint) {
  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT client_id, client_secret, machine_fingerprint, revoked
      FROM registered_clients
      WHERE machine_fingerprint = $1 AND revoked = FALSE
      LIMIT 1
      `,
      [fingerprint]
    );
    return mapClientRow(result.rows[0]);
  }

  const store = readJsonStore(db);
  return mapClientRow(
    Object.values(store.registeredClients).find(
      (row) => row.machineFingerprint === fingerprint && !row.revoked
    )
  );
}

async function saveClient(db, { clientId, clientSecret, machineFingerprint, createdAt }) {
  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      INSERT INTO registered_clients (client_id, client_secret, machine_fingerprint, created_at, last_seen_at)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (client_id) DO UPDATE
      SET client_secret = EXCLUDED.client_secret,
          last_seen_at = EXCLUDED.last_seen_at,
          revoked = FALSE
      `,
      [clientId, clientSecret, machineFingerprint, createdAt]
    );
    return;
  }

  const store = readJsonStore(db);
  store.registeredClients[clientId] = {
    clientId,
    clientSecret,
    _plainSecret: clientSecret,
    machineFingerprint,
    createdAt,
    lastSeenAt: createdAt,
    revoked: false
  };
  db.writeStore(store);
}

async function registerClient(db, { machineFingerprint }) {
  await ensureClientSchema(db);

  const fingerprint = String(machineFingerprint ?? '').trim().slice(0, 128);
  if (fingerprint.length < 8) {
    const err = new Error('machineFingerprint is required');
    err.code = 'VALIDATION';
    throw err;
  }

  const existing = await findActiveClientByFingerprint(db, fingerprint);
  const clientSecret = crypto.randomBytes(32).toString('hex');
  const createdAt = new Date().toISOString();

  if (existing) {
    await saveClient(db, {
      clientId: existing.clientId,
      clientSecret,
      machineFingerprint: fingerprint,
      createdAt
    });
    return { clientId: existing.clientId, clientSecret, existing: true };
  }

  const clientId = `cli_${crypto.randomBytes(12).toString('hex')}`;
  await saveClient(db, { clientId, clientSecret, machineFingerprint: fingerprint, createdAt });
  return { clientId, clientSecret, existing: false };
}

async function touchClient(db, clientId) {
  const now = new Date().toISOString();
  if (db.mode === 'postgres') {
    await db.pool.query(`UPDATE registered_clients SET last_seen_at = $2 WHERE client_id = $1`, [clientId, now]);
    return;
  }

  const store = readJsonStore(db);
  if (store.registeredClients[clientId]) {
    store.registeredClients[clientId].lastSeenAt = now;
    db.writeStore(store);
  }
}

async function verifyClientRequest(db, req, pathname, rawBody, config) {
  if (!config.requireClientSignature) {
    return { ok: true, skipped: true, clientId: null };
  }

  const clientId = req.headers['x-client-id'];
  const timestamp = req.headers['x-client-timestamp'];
  const signature = req.headers['x-client-signature'];

  if (!clientId || !timestamp || !signature) {
    const err = new Error('Client signature headers are required');
    err.code = 'CLIENT_AUTH_REQUIRED';
    throw err;
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > (config.clientSignatureSkewMs ?? SIGNATURE_SKEW_MS)) {
    const err = new Error('Client timestamp is invalid or expired');
    err.code = 'CLIENT_AUTH_EXPIRED';
    throw err;
  }

  const client = await getClientById(db, String(clientId));
  if (!client || client.revoked || !client.clientSecret) {
    const err = new Error('Unknown or revoked client');
    err.code = 'CLIENT_AUTH_INVALID';
    throw err;
  }

  const payload = buildSignaturePayload({
    timestamp: String(timestamp),
    method: req.method,
    pathname,
    bodyHash: hashBody(rawBody)
  });

  const expected = signPayload(client.clientSecret, payload);
  if (!timingSafeEqualStrings(String(signature).toLowerCase(), expected.toLowerCase())) {
    const err = new Error('Invalid client signature');
    err.code = 'CLIENT_AUTH_INVALID';
    throw err;
  }

  await touchClient(db, client.clientId);
  return { ok: true, clientId: client.clientId };
}

async function getSummonerBinding(db, summoner) {
  const key = validateSummonerName(summoner);
  if (!key) return null;

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `SELECT summoner, client_id, bound_at FROM client_summoner_bindings WHERE summoner = $1`,
      [key]
    );
    return result.rows[0]
      ? { summoner: result.rows[0].summoner, clientId: result.rows[0].client_id, boundAt: result.rows[0].bound_at }
      : null;
  }

  const store = readJsonStore(db);
  return store.clientSummonerBindings[key] ?? null;
}

async function bindSummoner(db, clientId, summoner) {
  await ensureClientSchema(db);
  const key = validateSummonerName(summoner);
  if (!key || !clientId) return;

  const boundAt = new Date().toISOString();
  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      INSERT INTO client_summoner_bindings (summoner, client_id, bound_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (summoner) DO NOTHING
      `,
      [key, clientId, boundAt]
    );
    return;
  }

  const store = readJsonStore(db);
  if (!store.clientSummonerBindings[key]) {
    store.clientSummonerBindings[key] = { summoner: key, clientId, boundAt };
    db.writeStore(store);
  }
}

async function assertSummonerAccess(_db, _clientId, summoner) {
  const key = validateSummonerName(summoner);
  if (!key) {
    const err = new Error('Invalid summoner');
    err.code = 'VALIDATION';
    throw err;
  }
  // Wallet and bets are keyed by Riot summoner name — not by device/installation.
  // The same account must work from any PC running the app with that LoL login.
}

module.exports = {
  ensureClientSchema,
  registerClient,
  verifyClientRequest,
  assertSummonerAccess,
  buildSignaturePayload,
  signPayload,
  hashBody
};
