const fs = require('fs');
const http = require('http');
const path = require('path');
const config = require('./config');
const {
  openDatabase,
  saveMatch,
  listMatches,
  getMatch,
  getMatchDetails,
  checkDatabaseHealth
} = require('./db');
const {
  createProposal,
  getProposal,
  respondToProposal,
  getActiveProposalForMatch,
  getPendingInvitationForSummoner,
  cancelProposal,
  expireProposalsForMatch
} = require('./betProposals');
const {
  resolveLobby,
  upsertLobby,
  getLobby,
  deleteLobby,
  validateLobbySync
} = require('./lobbies');
const { readJsonBody, readRawBody, sendJson, parseUrl, sendFile } = require('./http');
const { initEventBus, subscribeMatchStream, publishMatchEvent } = require('./events');
const { checkRateLimit } = require('./rateLimit');
const { initAudit, auditLog } = require('./audit');
const {
  timingSafeEqualStrings,
  validateSummonerName,
  applySecurityHeaders,
  isProduction
} = require('./security');
const {
  initLedgerSchema,
  getBalance,
  createDeposit,
  getDeposit,
  getActiveDepositForSummoner,
  normalizeSummoner
} = require('./ledger');
const { ensureWalletSchema, ensureUserWallet, getWalletBySummoner } = require('./wallets');
const { reserveStake, refundStake, payoutBetWin, reverseBetWin } = require('./balanceOps');
const { startDepositMonitor } = require('./tronMonitor');
const {
  ensureClientSchema,
  registerClient,
  verifyClientRequest,
  assertSummonerAccess
} = require('./clients');
const {
  ensureStakeLockSchema,
  lockStake,
  unlockStake,
  unlockAllForProposal,
  unlockAllForMatch,
  getStakeLock
} = require('./stakeLocks');
const { requireLobbyTrusted } = require('./lobbyValidation');

const updatesDir = path.join(__dirname, '..', 'updates');

let db;

function checkClientApiKey(req, res) {
  const expected = config.clientApiKey;
  if (!expected) {
    if (config.isProduction) {
      sendJson(res, 503, { error: 'Server misconfigured: CLIENT_API_KEY is required in production' });
      return false;
    }
    return true;
  }

  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && timingSafeEqualStrings(headerKey, expected)) {
    return true;
  }

  sendJson(res, 401, { error: 'Invalid or missing client API key' });
  return false;
}

function checkAdminApiKey(req, res) {
  const expected = config.adminApiKey || config.clientApiKey;
  if (!expected) {
    if (config.isProduction) {
      sendJson(res, 503, { error: 'Server misconfigured: ADMIN_API_KEY is required in production' });
      return false;
    }
    return true;
  }

  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && timingSafeEqualStrings(headerKey, expected)) {
    return true;
  }

  sendJson(res, 401, { error: 'Invalid or missing admin API key' });
  return false;
}

async function ensureClientAuth(req, res, pathname) {
  if (!checkClientApiKey(req, res)) return null;

  try {
    if (req._rawBody === undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      req._rawBody = await readRawBody(req);
    }
    if (req._rawBody === undefined) {
      req._rawBody = Buffer.alloc(0);
    }

    const auth = await verifyClientRequest(db, req, pathname, req._rawBody, config);
    req.clientAuth = auth;
    return auth;
  } catch (err) {
    const status = err.code === 'CLIENT_AUTH_EXPIRED' ? 401 : 403;
    sendJson(res, status, { error: err.message, code: err.code ?? 'CLIENT_AUTH_FAILED' });
    return null;
  }
}

async function enforceSummonerAccess(_clientId, summoner, res) {
  if (!summoner) return true;

  try {
    await assertSummonerAccess(db, null, summoner);
    return true;
  } catch (err) {
    sendJson(res, 400, { error: err.message, code: err.code ?? 'VALIDATION' });
    return false;
  }
}

function validateMatchReport(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Body must be a JSON object'];
  if (!body.matchSessionId || typeof body.matchSessionId !== 'string') errors.push('matchSessionId is required');
  if (!body.gameMode || typeof body.gameMode !== 'string') errors.push('gameMode is required');
  if (!body.startTime || typeof body.startTime !== 'string') errors.push('startTime is required');
  if (!body.clientVersion || typeof body.clientVersion !== 'string') errors.push('clientVersion is required');
  if (!Array.isArray(body.blueTeam) || !Array.isArray(body.redTeam)) {
    errors.push('blueTeam and redTeam must be arrays');
  }
  return errors;
}

function clientRateLimitKey(req) {
  return req.headers['x-api-key'] || req.socket.remoteAddress || 'unknown';
}

function enforceRateLimit(req, res, scope, options) {
  try {
    checkRateLimit(`${clientRateLimitKey(req)}:${scope}`, options);
    return true;
  } catch (err) {
    if (err.code === 'RATE_LIMIT') {
      sendJson(res, 429, { error: err.message, retryAfterMs: err.retryAfterMs });
      return false;
    }
    throw err;
  }
}

function notifyProposalChange(proposal, eventType = 'proposal_updated') {
  if (!proposal?.matchSessionId) return;
  publishMatchEvent(proposal.matchSessionId, eventType, {
    proposalId: proposal.proposalId,
    status: proposal.status,
    matchSessionId: proposal.matchSessionId
  });
}

function logRequest(req, pathname, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}${suffix}`);
}

function validateDepositCreate(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Body must be a JSON object'];
  if (!body.summoner || typeof body.summoner !== 'string') errors.push('summoner is required');
  const amount = Number(body.amountUsdt);
  if (!Number.isFinite(amount) || amount <= 0) errors.push('amountUsdt must be a positive number');
  return errors;
}

function validateBalanceStakeBody(body, requireRefId = true) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Body must be a JSON object'];
  if (!validateSummonerName(body.summoner)) errors.push('summoner is required');
  const amount = Number(body.amount ?? body.stakeAmount);
  if (!Number.isFinite(amount) || amount <= 0) errors.push('amount must be a positive number');
  if (requireRefId && (!body.refId || typeof body.refId !== 'string')) errors.push('refId is required');
  return errors;
}

async function handleBalanceAndDeposits(req, res, pathname, url, clientId = null) {
  if (req.method === 'GET' && pathname === '/api/balance') {
    if (!enforceRateLimit(req, res, 'balance-get', { maxRequests: 120, windowMs: 60_000 })) return true;

    const summoner = url.searchParams.get('summoner');
    if (!validateSummonerName(summoner)) {
      sendJson(res, 400, { error: 'summoner query parameter is required' });
      return true;
    }

    if (!(await enforceSummonerAccess(clientId, summoner, res))) return true;

    try {
      const balance = await getBalance(db, summoner);
      sendJson(res, 200, { summoner: validateSummonerName(summoner), balance, currency: 'USDT' });
    } catch (err) {
      console.error('Failed to get balance:', err);
      sendJson(res, 500, { error: 'Failed to get balance' });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/balance/stake-reserve') {
    if (!enforceRateLimit(req, res, 'balance-stake-reserve', { maxRequests: 60, windowMs: 60_000 })) return true;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body' });
      return true;
    }

    const errors = validateBalanceStakeBody(body);
    if (errors.length > 0) {
      sendJson(res, 400, { error: 'Validation failed', details: errors });
      return true;
    }

    if (!(await enforceSummonerAccess(clientId, body.summoner, res))) return true;

    try {
      const result = await reserveStake(db, {
        summoner: body.summoner,
        amount: Number(body.amount ?? body.stakeAmount),
        refId: body.refId
      });
      if (!result.ok) {
        sendJson(res, 409, { error: 'Insufficient balance', balance: result.balance });
        return true;
      }
      sendJson(res, 200, { ok: true, summoner: validateSummonerName(body.summoner), balance: result.balance });
    } catch (err) {
      if (err.code === 'VALIDATION' || err.code === 'ALREADY_RESERVED') {
        sendJson(res, 400, { error: err.message, code: err.code });
        return true;
      }
      console.error('Failed to reserve stake:', err);
      sendJson(res, 500, { error: 'Failed to reserve stake' });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/balance/stake-refund') {
    if (!enforceRateLimit(req, res, 'balance-stake-refund', { maxRequests: 60, windowMs: 60_000 })) return true;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body' });
      return true;
    }

    const errors = validateBalanceStakeBody(body);
    if (errors.length > 0) {
      sendJson(res, 400, { error: 'Validation failed', details: errors });
      return true;
    }

    if (!(await enforceSummonerAccess(clientId, body.summoner, res))) return true;

    try {
      const result = await refundStake(db, {
        summoner: body.summoner,
        amount: Number(body.amount ?? body.stakeAmount),
        refId: body.refId
      });
      if (!result.ok) {
        sendJson(res, 409, { error: 'Refund failed', balance: result.balance });
        return true;
      }
      sendJson(res, 200, { ok: true, summoner: validateSummonerName(body.summoner), balance: result.balance });
    } catch (err) {
      if (err.code === 'VALIDATION' || err.code === 'NOT_RESERVED') {
        sendJson(res, 400, { error: err.message, code: err.code });
        return true;
      }
      console.error('Failed to refund stake:', err);
      sendJson(res, 500, { error: 'Failed to refund stake' });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/balance/bet-payout') {
    if (!enforceRateLimit(req, res, 'balance-bet-payout', { maxRequests: 30, windowMs: 60_000 })) return true;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body' });
      return true;
    }

    const errors = validateBalanceStakeBody(body);
    if (errors.length > 0) {
      sendJson(res, 400, { error: 'Validation failed', details: errors });
      return true;
    }

    if (!(await enforceSummonerAccess(clientId, body.summoner, res))) return true;

    try {
      const result = await payoutBetWin(db, {
        summoner: body.summoner,
        stakeAmount: Number(body.amount ?? body.stakeAmount),
        refId: body.refId
      });
      if (!result.ok) {
        sendJson(res, 409, { error: 'Payout failed', balance: result.balance });
        return true;
      }
      sendJson(res, 200, { ok: true, summoner: validateSummonerName(body.summoner), balance: result.balance });
    } catch (err) {
      if (err.code === 'VALIDATION' || err.code === 'NOT_RESERVED' || err.code === 'ALREADY_PAID') {
        sendJson(res, 400, { error: err.message, code: err.code });
        return true;
      }
      console.error('Failed to payout bet win:', err);
      sendJson(res, 500, { error: 'Failed to payout bet win' });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/balance/bet-correction') {
    if (!enforceRateLimit(req, res, 'balance-bet-correction', { maxRequests: 20, windowMs: 60_000 })) return true;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body' });
      return true;
    }

    const errors = validateBalanceStakeBody(body);
    if (errors.length > 0) {
      sendJson(res, 400, { error: 'Validation failed', details: errors });
      return true;
    }

    const action = body.action;
    if (action !== 'reverse_win' && action !== 'apply_win') {
      sendJson(res, 400, { error: 'action must be reverse_win or apply_win' });
      return true;
    }

    if (!(await enforceSummonerAccess(clientId, body.summoner, res))) return true;

    try {
      const payload = {
        summoner: body.summoner,
        stakeAmount: Number(body.amount ?? body.stakeAmount),
        refId: body.refId
      };
      const result = action === 'reverse_win'
        ? await reverseBetWin(db, payload)
        : await payoutBetWin(db, payload);

      if (!result.ok) {
        sendJson(res, 409, { error: 'Correction failed', balance: result.balance });
        return true;
      }
      sendJson(res, 200, { ok: true, summoner: validateSummonerName(body.summoner), balance: result.balance });
    } catch (err) {
      if (['VALIDATION', 'NOT_RESERVED', 'NOT_PAID', 'ALREADY_PAID'].includes(err.code)) {
        sendJson(res, 400, { error: err.message, code: err.code });
        return true;
      }
      console.error('Failed to correct bet outcome:', err);
      sendJson(res, 500, { error: 'Failed to correct bet outcome' });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/balance/adjust') {
    sendJson(res, 403, { error: 'Balance adjust is disabled. Use stake-reserve, stake-refund, or bet-payout.' });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/wallet') {
    if (!enforceRateLimit(req, res, 'wallet-get', { maxRequests: 120, windowMs: 60_000 })) return true;

    const summoner = url.searchParams.get('summoner');
    if (!validateSummonerName(summoner)) {
      sendJson(res, 400, { error: 'summoner query parameter is required' });
      return true;
    }

    if (!(await enforceSummonerAccess(clientId, summoner, res))) return true;

    try {
      const wallet = await getWalletBySummoner(db, summoner);
      const balance = await getBalance(db, summoner);
      const activeDeposit = await getActiveDepositForSummoner(db, summoner);
      sendJson(res, 200, {
        summoner: validateSummonerName(summoner),
        balance,
        currency: 'USDT',
        depositAddress: wallet?.depositAddress ?? null,
        activeDeposit
      });
    } catch (err) {
      console.error('Failed to get wallet:', err);
      sendJson(res, 500, { error: 'Failed to get wallet' });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/wallet/ensure') {
    if (!enforceRateLimit(req, res, 'wallet-ensure', { maxRequests: 30, windowMs: 60_000 })) return true;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body' });
      return true;
    }

    if (!body?.summoner || !validateSummonerName(body.summoner)) {
      sendJson(res, 400, { error: 'summoner is required' });
      return true;
    }

    if (!(await enforceSummonerAccess(clientId, body.summoner, res))) return true;

    try {
      const userWallet = await ensureUserWallet(db, config, body.summoner);
      const balance = await getBalance(db, body.summoner);
      const activeDeposit = await getActiveDepositForSummoner(db, body.summoner);
      sendJson(res, 200, {
        summoner: validateSummonerName(body.summoner),
        balance,
        currency: 'USDT',
        depositAddress: userWallet.depositAddress,
        walletCreated: userWallet.created,
        activeDeposit
      });
    } catch (err) {
      if (err.code === 'VALIDATION') {
        sendJson(res, 400, { error: err.message });
        return true;
      }
      if (err.code === 'NOT_CONFIGURED') {
        sendJson(res, 503, { error: err.message });
        return true;
      }
      console.error('Failed to ensure wallet:', err);
      sendJson(res, 500, { error: 'Failed to ensure wallet' });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/deposits') {
    if (!enforceRateLimit(req, res, 'deposits-create', { maxRequests: 30, windowMs: 60_000 })) return true;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body' });
      return true;
    }

    const errors = validateDepositCreate(body);
    if (errors.length > 0) {
      sendJson(res, 400, { error: 'Validation failed', details: errors });
      return true;
    }

    if (!(await enforceSummonerAccess(clientId, body.summoner, res))) return true;

    try {
      const deposit = await createDeposit(db, config, {
        summoner: body.summoner,
        amountUsdt: Number(body.amountUsdt)
      });
      auditLog('deposit_created', {
        depositId: deposit.id,
        summoner: deposit.summoner,
        expectedAmountUsdt: deposit.expectedAmountUsdt
      });
      sendJson(res, 201, deposit);
    } catch (err) {
      if (err.code === 'VALIDATION') {
        sendJson(res, 400, { error: err.message });
        return true;
      }
      if (err.code === 'NOT_CONFIGURED') {
        sendJson(res, 503, { error: err.message });
        return true;
      }
      console.error('Failed to create deposit:', err);
      sendJson(res, 500, { error: 'Failed to create deposit' });
    }
    return true;
  }

  const depositDetailMatch = pathname.match(/^\/api\/deposits\/([^/]+)$/);
  if (req.method === 'GET' && depositDetailMatch) {
    if (!enforceRateLimit(req, res, 'deposits-get', { maxRequests: 240, windowMs: 60_000 })) return true;

    const depositId = decodeURIComponent(depositDetailMatch[1]);
    const requester = url.searchParams.get('summoner');
    if (!validateSummonerName(requester)) {
      sendJson(res, 400, { error: 'summoner query parameter is required' });
      return true;
    }

    if (!(await enforceSummonerAccess(clientId, requester, res))) return true;

    try {
      const deposit = await getDeposit(db, depositId);
      if (!deposit) {
        sendJson(res, 404, { error: 'Deposit not found' });
        return true;
      }
      sendJson(res, 200, deposit);
    } catch (err) {
      console.error('Failed to get deposit:', err);
      sendJson(res, 500, { error: 'Failed to get deposit' });
    }
    return true;
  }

  return false;
}

async function handleRequest(req, res) {
  applySecurityHeaders(res);
  const url = parseUrl(req);
  const pathname = url.pathname;
  logRequest(req, pathname);

  if (req.method === 'GET' && pathname === '/updates/version.json') {
    const versionPath = path.join(updatesDir, 'version.json');
    if (!fs.existsSync(versionPath)) {
      sendJson(res, 404, { error: 'version.json not deployed' });
      return;
    }

    sendFile(res, 200, versionPath, 'application/json; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/updates/LolBetTracker.exe') {
    const exePath = path.join(updatesDir, 'LolBetTracker.exe');
    if (!fs.existsSync(exePath)) {
      sendJson(res, 404, { error: 'LolBetTracker.exe not deployed' });
      return;
    }

    sendFile(res, 200, exePath, 'application/octet-stream');
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    try {
      const dbHealth = await checkDatabaseHealth(db);
      sendJson(res, 200, {
        ok: true,
        service: 'lol-bet-tracker-server',
        database: { ok: dbHealth?.ok ?? true }
      });
    } catch (err) {
      console.error('Health check failed:', err);
      sendJson(res, 503, { ok: false, service: 'lol-bet-tracker-server', error: 'Database unavailable' });
    }
    return;
  }

  if (pathname.startsWith('/api/matches')) {
    const auth = await ensureClientAuth(req, res, pathname);
    if (!auth) return;

    if (req.method === 'POST' && pathname === '/api/matches') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const message = err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body';
        sendJson(res, 400, { error: message });
        return;
      }

      const errors = validateMatchReport(body);
      if (errors.length > 0) {
        sendJson(res, 400, { error: 'Validation failed', details: errors });
        return;
      }

      try {
        const outcomeValidation = await saveMatch(db, body);
        const betInfo = body.bet
          ? `bet=${body.bet.ruleType} pick=${body.bet.pickedTeam} status=${body.bet.status}`
          : 'no-bet';
        console.log(
          `Match saved: ${body.matchSessionId} mode=${body.gameMode} outcome=${body.playerOutcome ?? 'in-progress'} ${betInfo}`
        );
        sendJson(res, 201, {
          ok: true,
          matchSessionId: body.matchSessionId,
          outcomeValidation: outcomeValidation ?? body.outcomeValidation ?? null
        });
      } catch (err) {
        console.error('Failed to save match:', err);
        sendJson(res, 500, { error: 'Failed to save match' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/matches') {
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 50, 200);
      const offset = Math.max(parseInt(url.searchParams.get('offset'), 10) || 0, 0);
      const completedOnly = url.searchParams.get('completed') === 'true';
      const summoner = url.searchParams.get('summoner') || null;

      try {
        const matches = await listMatches(db, { limit, offset, completedOnly, summoner });
        sendJson(res, 200, { matches, limit, offset, completedOnly });
      } catch (err) {
        console.error('Failed to list matches:', err);
        sendJson(res, 500, { error: 'Failed to list matches' });
      }
      return;
    }

    const matchDetailMatch = pathname.match(/^\/api\/matches\/([^/]+)$/);
    if (req.method === 'GET' && matchDetailMatch) {
      const matchSessionId = decodeURIComponent(matchDetailMatch[1]);
      const format = url.searchParams.get('format');

      try {
        if (format === 'raw') {
          const match = await getMatch(db, matchSessionId);
          if (!match) {
            sendJson(res, 404, { error: 'Match not found' });
            return;
          }
          sendJson(res, 200, match);
          return;
        }

        const details = await getMatchDetails(db, matchSessionId);
        if (!details) {
          sendJson(res, 404, { error: 'Match not found' });
          return;
        }
        sendJson(res, 200, details);
      } catch (err) {
        console.error('Failed to get match:', err);
        sendJson(res, 500, { error: 'Failed to get match' });
      }
      return;
    }
  }

  if (pathname.startsWith('/api/bet-proposals')) {
    const auth = await ensureClientAuth(req, res, pathname);
    if (!auth) return;

    if (req.method === 'GET' && pathname === '/api/bet-proposals/stream') {
      if (!enforceRateLimit(req, res, 'bet-proposals-stream', { maxRequests: 30, windowMs: 60_000 })) return;

      const matchSessionId = url.searchParams.get('matchSessionId');
      if (!matchSessionId) {
        sendJson(res, 400, { error: 'matchSessionId is required' });
        return;
      }

      subscribeMatchStream(matchSessionId, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/bet-proposals') {
      if (!enforceRateLimit(req, res, 'bet-proposals-create', { maxRequests: 20, windowMs: 60_000 })) return;

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body' });
        return;
      }

      if (body?.creatorSummoner && !(await enforceSummonerAccess(auth.clientId, body.creatorSummoner, res))) return;

      try {
        const proposal = await createProposal(db, body, { getLobby });
        auditLog('proposal_created', {
          proposalId: proposal.proposalId,
          matchSessionId: proposal.matchSessionId,
          summoner: proposal.creatorSummoner
        });
        notifyProposalChange(proposal, 'proposal_created');
        sendJson(res, 201, proposal);
      } catch (err) {
        if (err.code === 'NOT_LOBBY_OWNER') {
          sendJson(res, 403, { error: err.message });
          return;
        }
        if (err.code === 'VALIDATION') {
          sendJson(res, 400, { error: err.message });
          return;
        }
        console.error('Failed to create bet proposal:', err);
        sendJson(res, 500, { error: 'Failed to create bet proposal' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/bet-proposals/active') {
      if (!enforceRateLimit(req, res, 'bet-proposals-active', { maxRequests: 120, windowMs: 60_000 })) return;

      const matchSessionId = url.searchParams.get('matchSessionId');
      if (!matchSessionId) {
        sendJson(res, 400, { error: 'matchSessionId is required' });
        return;
      }

      try {
        const proposal = await getActiveProposalForMatch(db, matchSessionId);
        if (!proposal) {
          sendJson(res, 404, { error: 'No active proposal' });
          return;
        }
        sendJson(res, 200, proposal);
      } catch (err) {
        console.error('Failed to get active proposal:', err);
        sendJson(res, 500, { error: 'Failed to get active proposal' });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/bet-proposals/expire') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      if (!body?.matchSessionId) {
        sendJson(res, 400, { error: 'matchSessionId is required' });
        return;
      }

      try {
        const expired = await expireProposalsForMatch(db, body.matchSessionId);
        await unlockAllForMatch(db, body.matchSessionId);
        if (expired.length > 0) {
          publishMatchEvent(body.matchSessionId, 'proposal_expired', {
            matchSessionId: body.matchSessionId,
            expired
          });
        }
        sendJson(res, 200, { expired });
      } catch (err) {
        console.error('Failed to expire proposals:', err);
        sendJson(res, 500, { error: 'Failed to expire proposals' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/bet-proposals/invitation') {
      const matchSessionId = url.searchParams.get('matchSessionId');
      const invitationScope = matchSessionId ? 'bet-proposals-invitation-scoped' : 'bet-proposals-invitation-global';
      const invitationLimit = matchSessionId
        ? { maxRequests: 120, windowMs: 60_000 }
        : { maxRequests: 12, windowMs: 60_000 };
      if (!enforceRateLimit(req, res, invitationScope, invitationLimit)) return;

      const summoner = url.searchParams.get('summoner');
      if (!summoner) {
        sendJson(res, 400, { error: 'summoner is required' });
        return;
      }

      try {
        const proposal = await getPendingInvitationForSummoner(db, summoner, matchSessionId);
        if (!proposal) {
          sendJson(res, 404, { error: 'No pending invitation' });
          return;
        }
        sendJson(res, 200, proposal);
      } catch (err) {
        console.error('Failed to get invitation:', err);
        sendJson(res, 500, { error: 'Failed to get invitation' });
      }
      return;
    }

    const proposalActionMatch = pathname.match(/^\/api\/bet-proposals\/([^/]+)\/(accept|decline|cancel)$/);
    if (req.method === 'POST' && proposalActionMatch) {
      if (!enforceRateLimit(req, res, 'bet-proposals-action', { maxRequests: 60, windowMs: 60_000 })) return;

      const proposalId = decodeURIComponent(proposalActionMatch[1]);
      const action = proposalActionMatch[2];
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      if (!body?.summoner) {
        sendJson(res, 400, { error: 'summoner is required' });
        return;
      }

      if (!(await enforceSummonerAccess(auth.clientId, body.summoner, res))) return;

      try {
        let proposal;
        const existingProposal = await getProposal(db, proposalId);

        if (action === 'cancel') {
          proposal = await cancelProposal(db, proposalId, body.summoner);
          if (proposal) await unlockAllForProposal(db, proposal.matchSessionId, proposal.proposalId);
        } else if (action === 'accept') {
          if (!existingProposal) {
            sendJson(res, 404, { error: 'Proposal not found' });
            return;
          }

          const lock = await getStakeLock(
            db,
            existingProposal.matchSessionId,
            body.summoner,
            proposalId
          );
          if (!lock) {
            sendJson(res, 409, {
              error: 'Stake must be locked before accepting the bet',
              code: 'STAKE_NOT_LOCKED'
            });
            return;
          }

          const acceptLobby = await getLobby(db, existingProposal.matchSessionId);
          const acceptLobbyErr = requireLobbyTrusted(acceptLobby);
          if (acceptLobbyErr) {
            sendJson(res, 409, { error: acceptLobbyErr, code: 'LOBBY_NOT_TRUSTED' });
            return;
          }

          proposal = await respondToProposal(db, proposalId, body.summoner, 'accept');
        } else {
          proposal = await respondToProposal(db, proposalId, body.summoner, 'decline');
          if (proposal) {
            await unlockStake(db, {
              matchSessionId: proposal.matchSessionId,
              summoner: body.summoner,
              proposalId: proposal.proposalId
            });
          }
        }

        if (!proposal) {
          sendJson(res, 404, { error: 'Proposal not found' });
          return;
        }

        auditLog(`proposal_${action}`, {
          proposalId: proposal.proposalId,
          matchSessionId: proposal.matchSessionId,
          summoner: body.summoner,
          status: proposal.status
        });
        notifyProposalChange(
          proposal,
          action === 'cancel' ? 'proposal_cancelled' : 'proposal_updated'
        );
        sendJson(res, 200, proposal);
      } catch (err) {
        if (err.code === 'NOT_PARTICIPANT' || err.code === 'NOT_CREATOR') {
          sendJson(res, 403, { error: err.message });
          return;
        }
        if (err.code === 'PROPOSAL_NOT_PENDING') {
          sendJson(res, 409, { error: err.message });
          return;
        }
        console.error('Failed to respond to proposal:', err);
        sendJson(res, 500, { error: 'Failed to respond to proposal' });
      }
      return;
    }

    const proposalDetailMatch = pathname.match(/^\/api\/bet-proposals\/([^/]+)$/);
    if (req.method === 'GET' && proposalDetailMatch) {
      if (!enforceRateLimit(req, res, 'bet-proposals-detail', { maxRequests: 120, windowMs: 60_000 })) return;

      const proposalId = decodeURIComponent(proposalDetailMatch[1]);
      try {
        const proposal = await getProposal(db, proposalId);
        if (!proposal) {
          sendJson(res, 404, { error: 'Proposal not found' });
          return;
        }
        sendJson(res, 200, proposal);
      } catch (err) {
        console.error('Failed to get proposal:', err);
        sendJson(res, 500, { error: 'Failed to get proposal' });
      }
      return;
    }
  }

  if (pathname.startsWith('/api/lobbies')) {
    const auth = await ensureClientAuth(req, res, pathname);
    if (!auth) return;

    if (req.method === 'POST' && pathname === '/api/lobbies/resolve') {
      if (!enforceRateLimit(req, res, 'lobbies-resolve', { maxRequests: 120, windowMs: 60_000 })) return;

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body' });
        return;
      }

      const errors = validateLobbySync(body);
      if (errors.length > 0) {
        sendJson(res, 400, { error: 'Validation failed', details: errors });
        return;
      }

      try {
        const lobby = await resolveLobby(db, body);
        sendJson(res, 200, lobby);
      } catch (err) {
        if (err.code === 'VALIDATION') {
          sendJson(res, 400, { error: err.message });
          return;
        }
        console.error('Failed to resolve lobby:', err);
        sendJson(res, 500, { error: 'Failed to resolve lobby' });
      }
      return;
    }

    const lobbyStakeLockMatch = pathname.match(/^\/api\/lobbies\/([^/]+)\/stake-lock$/);
    if (req.method === 'POST' && lobbyStakeLockMatch) {
      if (!enforceRateLimit(req, res, 'lobby-stake-lock', { maxRequests: 60, windowMs: 60_000 })) return;

      const matchSessionId = decodeURIComponent(lobbyStakeLockMatch[1]);
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body' });
        return;
      }

      if (!body?.summoner || !body?.proposalId || !(Number(body.amount) > 0)) {
        sendJson(res, 400, { error: 'summoner, proposalId and positive amount are required' });
        return;
      }

      if (!(await enforceSummonerAccess(auth.clientId, body.summoner, res))) return;

      const stakeLobby = await getLobby(db, matchSessionId);
      const stakeLobbyErr = requireLobbyTrusted(stakeLobby);
      if (stakeLobbyErr) {
        sendJson(res, 409, { error: stakeLobbyErr, code: 'LOBBY_NOT_TRUSTED' });
        return;
      }

      try {
        const result = await lockStake(db, {
          matchSessionId,
          summoner: body.summoner,
          amount: Number(body.amount),
          proposalId: body.proposalId
        });
        sendJson(res, 200, result);
      } catch (err) {
        if (err.code === 'INSUFFICIENT_BALANCE') {
          sendJson(res, 409, { error: err.message, balance: err.balance, code: err.code });
          return;
        }
        if (err.code === 'VALIDATION' || err.code === 'NOT_PARTICIPANT') {
          sendJson(res, 400, { error: err.message, code: err.code });
          return;
        }
        console.error('Failed to lock stake:', err);
        sendJson(res, 500, { error: 'Failed to lock stake' });
      }
      return;
    }

    const lobbyDetailMatch = pathname.match(/^\/api\/lobbies\/([^/]+)$/);
    if (lobbyDetailMatch) {
      const matchSessionId = decodeURIComponent(lobbyDetailMatch[1]);

      if (req.method === 'GET') {
        try {
          const lobby = await getLobby(db, matchSessionId);
          if (!lobby) {
            sendJson(res, 404, { error: 'Lobby not found' });
            return;
          }
          sendJson(res, 200, lobby);
        } catch (err) {
          console.error('Failed to get lobby:', err);
          sendJson(res, 500, { error: 'Failed to get lobby' });
        }
        return;
      }

      if (req.method === 'PUT') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }

        const errors = validateLobbySync(body);
        if (errors.length > 0) {
          sendJson(res, 400, { error: 'Validation failed', details: errors });
          return;
        }

        try {
          const lobby = await upsertLobby(db, { ...body, matchSessionId });
          sendJson(res, 200, lobby);
        } catch (err) {
          console.error('Failed to upsert lobby:', err);
          sendJson(res, 500, { error: 'Failed to upsert lobby' });
        }
        return;
      }

      if (req.method === 'DELETE') {
        try {
          const deleted = await deleteLobby(db, matchSessionId);
          if (!deleted) {
            sendJson(res, 404, { error: 'Lobby not found' });
            return;
          }
          res.writeHead(204);
          res.end();
        } catch (err) {
          console.error('Failed to delete lobby:', err);
          sendJson(res, 500, { error: 'Failed to delete lobby' });
        }
        return;
      }
    }
  }

  if (req.method === 'POST' && pathname === '/api/clients/register') {
    if (!checkClientApiKey(req, res)) return;
    if (!enforceRateLimit(req, res, 'clients-register', { maxRequests: 10, windowMs: 60_000 })) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message === 'Body too large' ? 'Body too large' : 'Invalid JSON body' });
      return;
    }

    if (!body?.machineFingerprint) {
      sendJson(res, 400, { error: 'machineFingerprint is required' });
      return;
    }

    try {
      const result = await registerClient(db, { machineFingerprint: body.machineFingerprint });
      sendJson(res, 201, {
        clientId: result.clientId,
        clientSecret: result.clientSecret,
        existing: result.existing
      });
    } catch (err) {
      if (err.code === 'VALIDATION') {
        sendJson(res, 400, { error: err.message });
        return;
      }
      console.error('Failed to register client:', err);
      sendJson(res, 500, { error: 'Failed to register client' });
    }
    return;
  }

  if (pathname.startsWith('/api/balance') || pathname.startsWith('/api/deposits') || pathname.startsWith('/api/wallet')) {
    const auth = await ensureClientAuth(req, res, pathname);
    if (!auth) return;
    if (await handleBalanceAndDeposits(req, res, pathname, url, auth.clientId)) return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function main() {
  db = await openDatabase(config);
  await initLedgerSchema(db);
  await ensureWalletSchema(db);
  await ensureStakeLockSchema(db);
  await ensureClientSchema(db);
  initAudit(config);
  await initEventBus(config);
  startDepositMonitor(db, config);

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`Lol Bet Tracker server listening on http://${config.host}:${config.port}`);
    if (config.clientApiKey) {
      console.log('Client API key enabled (X-Api-Key header)');
    } else if (isProduction()) {
      console.error('FATAL: CLIENT_API_KEY must be set when NODE_ENV=production');
      process.exit(1);
    } else {
      console.log('Warning: CLIENT_API_KEY not set — client endpoints are open (development only)');
    }

    if (config.adminApiKey && config.adminApiKey !== config.clientApiKey) {
      console.log('Separate admin API key configured');
    }

    console.log(
      config.requireClientSignature
        ? 'Client HMAC signatures required (X-Client-Id / X-Client-Signature)'
        : 'Client HMAC signatures disabled (development mode)'
    );
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
