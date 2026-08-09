const { computeRosterSnapshotHash } = require('./events');

function normalizeSummoner(value) {
  return String(value ?? '').trim().toUpperCase();
}

/**
 * @param {object} existing
 * @param {object} body
 * @returns {{ clientReports: object, validation: object }}
 */
function recordClientReport(existing, body) {
  const reporter = normalizeSummoner(body.connectedSummoner ?? body.ConnectedSummoner);
  const clientReports = { ...(existing?.clientReports ?? {}) };

  if (!reporter) {
    return {
      clientReports,
      validation: evaluateQuorum(existing?.players ?? body.players ?? [], clientReports)
    };
  }

  const hash = body.rosterSnapshotHash
    ?? computeRosterSnapshotHash(body.players ?? existing?.players ?? []);

  clientReports[reporter] = {
    hash,
    phase: body.phase ?? existing?.phase ?? 'Lobby',
    at: new Date().toISOString(),
    clientVersion: body.clientVersion ?? null
  };

  return {
    clientReports,
    validation: evaluateQuorum(body.players ?? existing?.players ?? [], clientReports)
  };
}

function evaluateQuorum(players, clientReports) {
  const humans = (players ?? [])
    .filter((p) => !p.isBot)
    .map((p) => normalizeSummoner(p.summonerName))
    .filter(Boolean);

  const uniqueHumans = [...new Set(humans)];
  if (uniqueHumans.length === 0) {
    return { status: 'pending', quorumCount: 0, requiredQuorum: 1, conflict: false };
  }

  const requiredQuorum = Math.max(2, Math.ceil(uniqueHumans.length * 0.51));
  const hashVotes = new Map();

  for (const name of uniqueHumans) {
    const report = clientReports[name];
    if (!report?.hash) continue;
    hashVotes.set(report.hash, (hashVotes.get(report.hash) ?? 0) + 1);
  }

  let topHash = null;
  let topCount = 0;
  for (const [hash, count] of hashVotes.entries()) {
    if (count > topCount) {
      topCount = count;
      topHash = hash;
    }
  }

  const conflict = hashVotes.size > 1 && topCount < requiredQuorum;
  let status = 'pending';
  if (topCount >= requiredQuorum) status = 'trusted';
  else if (conflict) status = 'conflict';

  return {
    status,
    quorumCount: topCount,
    requiredQuorum,
    conflict,
    consensusHash: topHash
  };
}

function validateProposalAgainstLobby(lobby, body) {
  const errors = [];
  if (!lobby) {
    errors.push('Lobby not found for matchSessionId — sync lobby first');
    return errors;
  }

  const creator = normalizeSummoner(body.creatorSummoner);
  const owner = normalizeSummoner(lobby.lobbyOwnerSummoner);
  const humans = new Set(
    (lobby.players ?? [])
      .filter((p) => !p.isBot)
      .map((p) => normalizeSummoner(p.summonerName))
  );

  if (owner && creator !== owner) {
    errors.push('Only the lobby owner can create bet proposals');
  }

  for (const participant of body.requiredParticipants ?? []) {
    const key = normalizeSummoner(participant);
    if (!humans.has(key)) {
      errors.push(`Participant ${participant} is not in the lobby roster`);
    }
  }

  if (lobby.validation?.status !== 'trusted') {
    errors.push('Lobby session is not ready for betting');
  }

  const stake = Number(body.stakeAmount);
  if (!Number.isFinite(stake) || stake <= 0 || stake > 1_000_000_000) {
    errors.push('stakeAmount out of allowed range');
  }

  const allowedRules = new Set(['TeamWin', 'FirstTeamKills']);
  if (!allowedRules.has(String(body.ruleType))) {
    errors.push('Invalid ruleType');
  }

  if (body.stakeDescription && String(body.stakeDescription).length > 500) {
    errors.push('stakeDescription too long');
  }

  return errors;
}

function sanitizeProposalCreate(body) {
  return {
    ...body,
    matchSessionId: String(body.matchSessionId).trim().slice(0, 64),
    creatorSummoner: String(body.creatorSummoner).trim().slice(0, 128),
    ruleType: String(body.ruleType).trim(),
    pickedTeam: String(body.pickedTeam).trim().slice(0, 16),
    stakeAmount: Math.min(Number(body.stakeAmount), 1_000_000_000),
    targetValue: Math.max(0, Math.min(Number(body.targetValue ?? 0), 999)),
    stakeDescription: body.stakeDescription
      ? String(body.stakeDescription).trim().slice(0, 500)
      : null,
    requiredParticipants: (body.requiredParticipants ?? [])
      .map((p) => String(p).trim().slice(0, 128))
      .filter(Boolean)
  };
}

function requireLobbyTrusted(lobby) {
  if (!lobby) {
    return 'Lobby not found for matchSessionId — sync lobby first';
  }
  if (lobby.validation?.status === 'trusted') {
    return null;
  }
  return 'Lobby session is not ready for betting';
}

module.exports = {
  recordClientReport,
  evaluateQuorum,
  validateProposalAgainstLobby,
  sanitizeProposalCreate,
  requireLobbyTrusted
};
