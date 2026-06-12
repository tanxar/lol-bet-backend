function normalizeSummoner(value) {
  return String(value ?? '').trim().toUpperCase();
}

function evaluateStatus(requiredParticipants, responses) {
  const required = (requiredParticipants ?? []).map(normalizeSummoner);
  if (required.length === 0) return 'completed';

  const responseList = responses ?? [];
  if (responseList.some((r) => r.decision === 'decline')) return 'declined';

  const accepted = new Set(
    responseList
      .filter((r) => r.decision === 'accept')
      .map((r) => normalizeSummoner(r.summoner))
  );

  if (required.every((name) => accepted.has(name))) return 'completed';
  return 'pending';
}

function mapProposalRow(row) {
  if (!row) return null;
  return {
    proposalId: row.proposal_id ?? row.proposalId,
    matchSessionId: row.match_session_id ?? row.matchSessionId,
    creatorSummoner: row.creator_summoner ?? row.creatorSummoner,
    stakeAmount: Number(row.stake_amount ?? row.stakeAmount ?? 0),
    ruleType: row.rule_type ?? row.ruleType,
    pickedTeam: row.picked_team ?? row.pickedTeam,
    targetValue: Number(row.target_value ?? row.targetValue ?? 0),
    stakeDescription: row.stake_description ?? row.stakeDescription ?? null,
    requiredParticipants: row.required_participants ?? row.requiredParticipants ?? [],
    responses: row.responses ?? [],
    status: row.status,
    createdAt: row.created_at?.toISOString?.() ?? row.createdAt,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updatedAt
  };
}

async function ensureProposalSchema(db) {
  if (db.mode === 'postgres') {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS bet_proposals (
        proposal_id TEXT PRIMARY KEY,
        match_session_id TEXT NOT NULL,
        creator_summoner TEXT NOT NULL,
        stake_amount REAL NOT NULL,
        rule_type TEXT NOT NULL,
        picked_team TEXT NOT NULL,
        target_value INTEGER NOT NULL DEFAULT 0,
        stake_description TEXT,
        required_participants JSONB NOT NULL,
        responses JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_bet_proposals_match_session ON bet_proposals (match_session_id);
      CREATE INDEX IF NOT EXISTS idx_bet_proposals_status ON bet_proposals (status);
    `);
    return;
  }

  const store = db.readStore();
  if (!store.betProposals) store.betProposals = {};
  db.writeStore(store);
}

async function createProposal(db, body, options = {}) {
  await ensureProposalSchema(db);

  if (options.getLobby) {
    const lobby = await options.getLobby(db, body.matchSessionId);
    if (lobby?.lobbyOwnerSummoner &&
      normalizeSummoner(lobby.lobbyOwnerSummoner) !== normalizeSummoner(body.creatorSummoner)) {
      const err = new Error('Only the lobby owner can create bet proposals');
      err.code = 'NOT_LOBBY_OWNER';
      throw err;
    }
  }

  const proposalId = body.proposalId || `bp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const requiredParticipants = (body.requiredParticipants ?? []).map((p) => String(p).trim());
  const creator = String(body.creatorSummoner).trim();
  const responses = [
    {
      summoner: creator,
      decision: 'accept',
      respondedAt: new Date().toISOString()
    }
  ];
  const status = evaluateStatus(requiredParticipants, responses);
  const now = new Date().toISOString();

  const record = {
    proposalId,
    matchSessionId: body.matchSessionId,
    creatorSummoner: creator,
    stakeAmount: Number(body.stakeAmount),
    ruleType: body.ruleType,
    pickedTeam: body.pickedTeam,
    targetValue: Number(body.targetValue ?? 0),
    stakeDescription: body.stakeDescription ?? null,
    requiredParticipants,
    responses,
    status,
    createdAt: now,
    updatedAt: now
  };

  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      INSERT INTO bet_proposals (
        proposal_id, match_session_id, creator_summoner, stake_amount, rule_type,
        picked_team, target_value, stake_description, required_participants,
        responses, status, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `,
      [
        record.proposalId,
        record.matchSessionId,
        record.creatorSummoner,
        record.stakeAmount,
        record.ruleType,
        record.pickedTeam,
        record.targetValue,
        record.stakeDescription,
        JSON.stringify(record.requiredParticipants),
        JSON.stringify(record.responses),
        record.status,
        record.createdAt,
        record.updatedAt
      ]
    );
    return record;
  }

  const store = db.readStore();
  store.betProposals = store.betProposals ?? {};
  store.betProposals[proposalId] = record;
  db.writeStore(store);
  return record;
}

async function getProposal(db, proposalId) {
  await ensureProposalSchema(db);

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT proposal_id, match_session_id, creator_summoner, stake_amount, rule_type,
             picked_team, target_value, stake_description, required_participants,
             responses, status, created_at, updated_at
      FROM bet_proposals WHERE proposal_id = $1
      `,
      [proposalId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapProposalRow({
      ...row,
      required_participants: row.required_participants,
      responses: row.responses
    });
  }

  const store = db.readStore();
  return store.betProposals?.[proposalId] ?? null;
}

async function saveProposalRecord(db, record, options = {}) {
  record.updatedAt = new Date().toISOString();
  if (!options.forceStatus) {
    record.status = evaluateStatus(record.requiredParticipants, record.responses);
  }

  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      UPDATE bet_proposals
      SET responses = $2, status = $3, updated_at = $4
      WHERE proposal_id = $1
      `,
      [record.proposalId, JSON.stringify(record.responses), record.status, record.updatedAt]
    );
    return record;
  }

  const store = db.readStore();
  store.betProposals = store.betProposals ?? {};
  store.betProposals[record.proposalId] = record;
  db.writeStore(store);
  return record;
}

async function respondToProposal(db, proposalId, summoner, decision) {
  const proposal = await getProposal(db, proposalId);
  if (!proposal) return null;
  if (proposal.status !== 'pending') {
    const err = new Error('Proposal is no longer pending');
    err.code = 'PROPOSAL_NOT_PENDING';
    throw err;
  }

  const normalized = normalizeSummoner(summoner);
  const required = new Set((proposal.requiredParticipants ?? []).map(normalizeSummoner));
  if (!required.has(normalized)) {
    const err = new Error('Summoner is not a participant in this proposal');
    err.code = 'NOT_PARTICIPANT';
    throw err;
  }

  const responses = [...(proposal.responses ?? [])];
  const existingIndex = responses.findIndex((r) => normalizeSummoner(r.summoner) === normalized);
  const entry = {
    summoner: String(summoner).trim(),
    decision,
    respondedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) responses[existingIndex] = entry;
  else responses.push(entry);

  proposal.responses = responses;
  return saveProposalRecord(db, proposal);
}

async function getActiveProposalForMatch(db, matchSessionId) {
  await ensureProposalSchema(db);

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT proposal_id, match_session_id, creator_summoner, stake_amount, rule_type,
             picked_team, target_value, stake_description, required_participants,
             responses, status, created_at, updated_at
      FROM bet_proposals
      WHERE match_session_id = $1 AND status IN ('pending', 'completed')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [matchSessionId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapProposalRow(row);
  }

  const store = db.readStore();
  const all = Object.values(store.betProposals ?? {});
  return all
    .filter((p) => p.matchSessionId === matchSessionId && (p.status === 'pending' || p.status === 'completed'))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
}

async function listPendingProposalsForMatch(db, matchSessionId) {
  await ensureProposalSchema(db);

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT proposal_id, match_session_id, creator_summoner, stake_amount, rule_type,
             picked_team, target_value, stake_description, required_participants,
             responses, status, created_at, updated_at
      FROM bet_proposals
      WHERE match_session_id = $1 AND status = 'pending'
      ORDER BY created_at DESC
      `,
      [matchSessionId]
    );
    return result.rows.map(mapProposalRow);
  }

  const store = db.readStore();
  return Object.values(store.betProposals ?? {})
    .filter((p) => p.matchSessionId === matchSessionId && p.status === 'pending');
}

async function cancelProposal(db, proposalId, summoner) {
  const proposal = await getProposal(db, proposalId);
  if (!proposal) return null;

  if (proposal.status !== 'pending') {
    const err = new Error('Proposal is no longer pending');
    err.code = 'PROPOSAL_NOT_PENDING';
    throw err;
  }

  if (normalizeSummoner(proposal.creatorSummoner) !== normalizeSummoner(summoner)) {
    const err = new Error('Only the creator can cancel this proposal');
    err.code = 'NOT_CREATOR';
    throw err;
  }

  proposal.status = 'cancelled';
  return saveProposalRecord(db, proposal, { forceStatus: true });
}

async function expireProposalsForMatch(db, matchSessionId) {
  if (!matchSessionId) return [];

  const pending = await listPendingProposalsForMatch(db, matchSessionId);
  const expired = [];

  for (const proposal of pending) {
    proposal.status = 'expired';
    expired.push(await saveProposalRecord(db, proposal, { forceStatus: true }));
  }

  return expired;
}

async function getPendingInvitationForSummoner(db, summoner, matchSessionId = null) {
  await ensureProposalSchema(db);
  const normalized = normalizeSummoner(summoner);

  let proposals = [];
  if (db.mode === 'postgres') {
    const result = matchSessionId
      ? await db.pool.query(
        `
        SELECT proposal_id, match_session_id, creator_summoner, stake_amount, rule_type,
               picked_team, target_value, stake_description, required_participants,
               responses, status, created_at, updated_at
        FROM bet_proposals
        WHERE status = 'pending' AND match_session_id = $1
        ORDER BY created_at DESC
        `,
        [matchSessionId]
      )
      : await db.pool.query(
        `
        SELECT proposal_id, match_session_id, creator_summoner, stake_amount, rule_type,
               picked_team, target_value, stake_description, required_participants,
               responses, status, created_at, updated_at
        FROM bet_proposals
        WHERE status = 'pending'
        ORDER BY created_at DESC
        `
      );
    proposals = result.rows.map(mapProposalRow);
  } else {
    const store = db.readStore();
    proposals = Object.values(store.betProposals ?? {}).filter((p) => {
      if (p.status !== 'pending') return false;
      if (matchSessionId && p.matchSessionId !== matchSessionId) return false;
      return true;
    });
  }

  return proposals.find((proposal) => {
    const required = (proposal.requiredParticipants ?? []).map(normalizeSummoner);
    if (!required.includes(normalized)) return false;
    const response = (proposal.responses ?? []).find((r) => normalizeSummoner(r.summoner) === normalized);
    return !response;
  }) ?? null;
}

function validateProposalCreate(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Body must be a JSON object'];
  if (!body.matchSessionId) errors.push('matchSessionId is required');
  if (!body.creatorSummoner) errors.push('creatorSummoner is required');
  if (!body.ruleType) errors.push('ruleType is required');
  if (!body.pickedTeam) errors.push('pickedTeam is required');
  if (body.stakeAmount == null || Number(body.stakeAmount) <= 0) errors.push('stakeAmount must be > 0');
  if (!Array.isArray(body.requiredParticipants) || body.requiredParticipants.length === 0) {
    errors.push('requiredParticipants must be a non-empty array');
  }
  return errors;
}

module.exports = {
  createProposal,
  getProposal,
  respondToProposal,
  getActiveProposalForMatch,
  getPendingInvitationForSummoner,
  cancelProposal,
  expireProposalsForMatch,
  validateProposalCreate
};
