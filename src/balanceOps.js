const { tryAdjustBalance, normalizeSummoner, getBalance, roundUsdt } = require('./ledger');

const MAX_STAKE_USDT = 10_000;

async function sumRefBalance(db, summoner, refId, entryTypes = null) {
  const key = normalizeSummoner(summoner);
  if (!key || !refId) return 0;

  if (db.mode === 'postgres') {
    const params = [key, refId];
    let sql = `
      SELECT COALESCE(SUM(amount), 0)::float AS total
      FROM ledger_entries
      WHERE summoner = $1 AND ref_id = $2
    `;
    if (entryTypes?.length) {
      params.push(entryTypes);
      sql += ` AND entry_type = ANY($3)`;
    }
    const result = await db.pool.query(sql, params);
    return roundUsdt(result.rows[0]?.total ?? 0);
  }

  const store = db.readStore();
  const entries = store.ledger?.entries ?? [];
  return roundUsdt(
    entries
      .filter((entry) => entry.summoner === key && entry.refId === refId)
      .filter((entry) => !entryTypes || entryTypes.includes(entry.entryType))
      .reduce((sum, entry) => sum + Number(entry.amount), 0)
  );
}

function validateStakeAmount(amount) {
  const stake = roundUsdt(amount);
  if (!(stake > 0) || stake > MAX_STAKE_USDT) {
    const err = new Error(`Stake must be between 0 and ${MAX_STAKE_USDT} USDT`);
    err.code = 'VALIDATION';
    throw err;
  }
  return stake;
}

function validateRefId(refId) {
  if (!refId || typeof refId !== 'string' || refId.length > 128 || !/^[a-zA-Z0-9:_-]+$/.test(refId)) {
    const err = new Error('refId is required and must be alphanumeric');
    err.code = 'VALIDATION';
    throw err;
  }
  return refId;
}

async function reserveStake(db, { summoner, amount, refId }) {
  const key = normalizeSummoner(summoner);
  const stake = validateStakeAmount(amount);
  const safeRefId = validateRefId(refId);

  const net = await sumRefBalance(db, key, safeRefId);
  if (net < -0.000001) {
    const err = new Error('Stake already reserved for this refId');
    err.code = 'ALREADY_RESERVED';
    throw err;
  }

  return tryAdjustBalance(db, {
    summoner: key,
    delta: -stake,
    entryType: 'stake_reserve',
    refId: safeRefId
  });
}

async function refundStake(db, { summoner, amount, refId }) {
  const key = normalizeSummoner(summoner);
  const stake = validateStakeAmount(amount);
  const safeRefId = validateRefId(refId);

  const net = await sumRefBalance(db, key, safeRefId);
  const reserved = roundUsdt(-net);
  if (reserved <= 0) {
    const err = new Error('No reserved stake found for this refId');
    err.code = 'NOT_RESERVED';
    throw err;
  }
  if (stake > reserved + 0.000001) {
    const err = new Error('Refund amount exceeds reserved stake');
    err.code = 'VALIDATION';
    throw err;
  }

  return tryAdjustBalance(db, {
    summoner: key,
    delta: stake,
    entryType: 'stake_refund',
    refId: safeRefId
  });
}

async function payoutBetWin(db, { summoner, stakeAmount, refId }) {
  const key = normalizeSummoner(summoner);
  const stake = validateStakeAmount(stakeAmount);
  const safeRefId = validateRefId(refId);

  const net = await sumRefBalance(db, key, safeRefId);
  const reserved = roundUsdt(-net);
  if (Math.abs(reserved - stake) > 0.000001) {
    const err = new Error('Reserved stake does not match payout request');
    err.code = 'NOT_RESERVED';
    throw err;
  }

  const winTypes = ['bet_win'];
  const priorWin = await sumRefBalance(db, key, safeRefId, winTypes);
  if (priorWin > 0) {
    const err = new Error('Bet payout already applied for this refId');
    err.code = 'ALREADY_PAID';
    throw err;
  }

  return tryAdjustBalance(db, {
    summoner: key,
    delta: stake * 2,
    entryType: 'bet_win',
    refId: safeRefId
  });
}

async function reverseBetWin(db, { summoner, stakeAmount, refId }) {
  const key = normalizeSummoner(summoner);
  const stake = validateStakeAmount(stakeAmount);
  const safeRefId = validateRefId(refId);

  const winTotal = await sumRefBalance(db, key, safeRefId, ['bet_win']);
  if (winTotal <= 0) {
    const err = new Error('No bet payout found to reverse for this refId');
    err.code = 'NOT_PAID';
    throw err;
  }
  if (Math.abs(winTotal - stake * 2) > 0.000001) {
    const err = new Error('Payout amount does not match correction request');
    err.code = 'VALIDATION';
    throw err;
  }

  return tryAdjustBalance(db, {
    summoner: key,
    delta: -(stake * 2),
    entryType: 'bet_correction',
    refId: safeRefId
  });
}

module.exports = {
  MAX_STAKE_USDT,
  reserveStake,
  refundStake,
  payoutBetWin,
  reverseBetWin,
  sumRefBalance
};
