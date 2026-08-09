const { tryAdjustBalance, normalizeSummoner, getBalance } = require('./ledger');
const { getProposal } = require('./betProposals');

async function ensureStakeLockSchema(db) {
  if (db.mode === 'postgres') {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS match_stake_locks (
        id TEXT PRIMARY KEY,
        match_session_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        summoner TEXT NOT NULL,
        amount NUMERIC(18, 6) NOT NULL,
        locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (match_session_id, proposal_id, summoner)
      );

      CREATE INDEX IF NOT EXISTS idx_match_stake_locks_match ON match_stake_locks (match_session_id);
      CREATE INDEX IF NOT EXISTS idx_match_stake_locks_proposal ON match_stake_locks (proposal_id);
    `);
    return;
  }

  const store = db.readStore();
  store.matchStakeLocks = store.matchStakeLocks ?? {};
}

function readJsonStore(db) {
  const store = db.readStore();
  store.matchStakeLocks = store.matchStakeLocks ?? {};
  return store;
}

function lockRefId(matchSessionId, proposalId) {
  return `${matchSessionId}:${proposalId}`;
}

async function getStakeLock(db, matchSessionId, summoner, proposalId) {
  const key = normalizeSummoner(summoner);
  if (!key || !matchSessionId || !proposalId) return null;

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT id, match_session_id, proposal_id, summoner, amount, locked_at
      FROM match_stake_locks
      WHERE match_session_id = $1 AND proposal_id = $2 AND summoner = $3
      `,
      [matchSessionId, proposalId, key]
    );
    return mapLockRow(result.rows[0]);
  }

  const store = readJsonStore(db);
  return Object.values(store.matchStakeLocks).find(
    (row) =>
      row.matchSessionId === matchSessionId &&
      row.proposalId === proposalId &&
      row.summoner === key
  ) ?? null;
}

async function listStakeLocks(db, matchSessionId, proposalId = null) {
  if (!matchSessionId) return [];

  if (db.mode === 'postgres') {
    const params = [matchSessionId];
    let sql = `
      SELECT id, match_session_id, proposal_id, summoner, amount, locked_at
      FROM match_stake_locks
      WHERE match_session_id = $1
    `;
    if (proposalId) {
      params.push(proposalId);
      sql += ` AND proposal_id = $2`;
    }
    sql += ' ORDER BY locked_at ASC';
    const result = await db.pool.query(sql, params);
    return result.rows.map(mapLockRow).filter(Boolean);
  }

  const store = readJsonStore(db);
  return Object.values(store.matchStakeLocks)
    .filter((row) => row.matchSessionId === matchSessionId && (!proposalId || row.proposalId === proposalId))
    .sort((a, b) => String(a.lockedAt).localeCompare(String(b.lockedAt)));
}

function mapLockRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    matchSessionId: row.match_session_id ?? row.matchSessionId,
    proposalId: row.proposal_id ?? row.proposalId,
    summoner: row.summoner,
    amount: Number(row.amount),
    lockedAt: row.locked_at?.toISOString?.() ?? row.lockedAt
  };
}

async function lockStake(db, { matchSessionId, summoner, amount, proposalId }) {
  await ensureStakeLockSchema(db);

  const key = normalizeSummoner(summoner);
  const stake = Number(amount);
  if (!matchSessionId || !proposalId || !key || !(stake > 0)) {
    const err = new Error('matchSessionId, proposalId, summoner and positive amount are required');
    err.code = 'VALIDATION';
    throw err;
  }

  const existing = await getStakeLock(db, matchSessionId, key, proposalId);
  if (existing) {
    return { ok: true, alreadyLocked: true, lock: existing, balance: await getBalance(db, key) };
  }

  const proposal = await getProposal(db, proposalId);
  if (!proposal || proposal.status !== 'pending') {
    const err = new Error('No pending bet proposal found for stake lock');
    err.code = 'VALIDATION';
    throw err;
  }
  if (proposal.matchSessionId !== matchSessionId) {
    const err = new Error('Proposal does not belong to this lobby session');
    err.code = 'VALIDATION';
    throw err;
  }

  const participants = (proposal.requiredParticipants ?? []).map((name) =>
    String(name ?? '').trim().toUpperCase()
  );
  if (!participants.includes(key)) {
    const err = new Error('Summoner is not a required participant for this proposal');
    err.code = 'NOT_PARTICIPANT';
    throw err;
  }

  const expectedStake = Number(proposal.stakeAmount);
  if (!(expectedStake > 0) || Math.abs(expectedStake - stake) > 0.000001) {
    const err = new Error('Stake amount must match the bet proposal');
    err.code = 'VALIDATION';
    throw err;
  }

  const refId = lockRefId(matchSessionId, proposalId);
  const adjusted = await tryAdjustBalance(db, {
    summoner: key,
    delta: -stake,
    entryType: 'match_stake_lock',
    refId
  });

  if (!adjusted.ok) {
    const err = new Error('Insufficient balance');
    err.code = 'INSUFFICIENT_BALANCE';
    err.balance = adjusted.balance;
    throw err;
  }

  const id = `msl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const lockedAt = new Date().toISOString();
  const lock = {
    id,
    matchSessionId,
    proposalId,
    summoner: key,
    amount: stake,
    lockedAt
  };

  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      INSERT INTO match_stake_locks (id, match_session_id, proposal_id, summoner, amount, locked_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [id, matchSessionId, proposalId, key, stake, lockedAt]
    );
  } else {
    const store = readJsonStore(db);
    store.matchStakeLocks[id] = lock;
    db.writeStore(store);
  }

  return { ok: true, alreadyLocked: false, lock, balance: adjusted.balance };
}

async function unlockStake(db, { matchSessionId, summoner, proposalId }) {
  await ensureStakeLockSchema(db);

  const key = normalizeSummoner(summoner);
  if (!matchSessionId || !proposalId || !key) return { ok: false, unlocked: false };

  const existing = await getStakeLock(db, matchSessionId, key, proposalId);
  if (!existing) return { ok: true, unlocked: false };

  const refId = lockRefId(matchSessionId, proposalId);
  await tryAdjustBalance(db, {
    summoner: key,
    delta: existing.amount,
    entryType: 'match_stake_unlock',
    refId
  });

  if (db.mode === 'postgres') {
    await db.pool.query(
      `DELETE FROM match_stake_locks WHERE match_session_id = $1 AND proposal_id = $2 AND summoner = $3`,
      [matchSessionId, proposalId, key]
    );
  } else {
    const store = readJsonStore(db);
    delete store.matchStakeLocks[existing.id];
    db.writeStore(store);
  }

  return { ok: true, unlocked: true, amount: existing.amount };
}

async function unlockAllForProposal(db, matchSessionId, proposalId) {
  const locks = await listStakeLocks(db, matchSessionId, proposalId);
  for (const lock of locks) {
    await unlockStake(db, {
      matchSessionId,
      summoner: lock.summoner,
      proposalId
    });
  }
  return locks.length;
}

async function unlockAllForMatch(db, matchSessionId) {
  const locks = await listStakeLocks(db, matchSessionId);
  for (const lock of locks) {
    await unlockStake(db, {
      matchSessionId,
      summoner: lock.summoner,
      proposalId: lock.proposalId
    });
  }
  return locks.length;
}

function toPublicStakeLocks(locks) {
  return (locks ?? []).map((lock) => ({
    summoner: lock.summoner,
    amount: lock.amount,
    proposalId: lock.proposalId,
    lockedAt: lock.lockedAt
  }));
}

module.exports = {
  ensureStakeLockSchema,
  getStakeLock,
  listStakeLocks,
  lockStake,
  unlockStake,
  unlockAllForProposal,
  unlockAllForMatch,
  toPublicStakeLocks
};
