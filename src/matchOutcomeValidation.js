const { normalizeSummonerName } = require('./matchOutcomeValidationHelpers');

function normalizeTeam(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'ORDER' || normalized === '100') return 'BLUE';
  if (normalized === 'CHAOS' || normalized === '200') return 'RED';
  if (normalized === 'BLUE' || normalized === 'RED') return normalized;
  return null;
}

function buildPlayersFromReport(report) {
  return [
    ...(report.blueTeam ?? []),
    ...(report.redTeam ?? [])
  ];
}

function uniqueHumans(players) {
  return [...new Set(
    (players ?? [])
      .filter((player) => !player.isBot)
      .map((player) => normalizeSummonerName(player.summonerName))
      .filter(Boolean)
  )];
}

function evaluateOutcomeQuorum(players, outcomeReports, latestReport) {
  const humans = uniqueHumans(players);
  if (humans.length === 0) {
    return {
      status: 'pending',
      quorumCount: 0,
      requiredQuorum: 1,
      conflict: false,
      primaryMatchesHistory: true
    };
  }

  const requiredQuorum = Math.max(2, Math.ceil(humans.length * 0.51));
  const voteBuckets = new Map();

  for (const name of humans) {
    const report = outcomeReports[name];
    if (!report?.gameId || !report?.winnerTeam) continue;

    const winnerTeam = normalizeTeam(report.winnerTeam);
    if (!winnerTeam) continue;

    const key = `${report.gameId}|${winnerTeam}`;
    voteBuckets.set(key, (voteBuckets.get(key) ?? 0) + 1);
  }

  let topKey = null;
  let topCount = 0;
  for (const [key, count] of voteBuckets.entries()) {
    if (count > topCount) {
      topCount = count;
      topKey = key;
    }
  }

  const conflict = voteBuckets.size > 1 && topCount < requiredQuorum;
  let status = 'pending';
  if (topCount >= requiredQuorum) status = 'trusted';
  else if (conflict) status = 'conflict';

  const [consensusGameIdRaw, consensusWinnerTeam] = topKey ? topKey.split('|') : [null, null];
  const consensusGameId = consensusGameIdRaw ? Number(consensusGameIdRaw) : null;

  const primaryWinner = normalizeTeam(latestReport?.primaryWinnerTeam ?? latestReport?.winnerTeam);
  const primaryMatchesHistory = !consensusWinnerTeam ||
    !primaryWinner ||
    consensusWinnerTeam === primaryWinner;

  return {
    status,
    quorumCount: topCount,
    requiredQuorum,
    conflict,
    consensusGameId: Number.isFinite(consensusGameId) ? consensusGameId : null,
    consensusWinnerTeam: consensusWinnerTeam ?? null,
    primaryMatchesHistory
  };
}

function recordOutcomeReport(existingPayload, report) {
  const reporter = normalizeSummonerName(report.connectedSummoner ?? report.ConnectedSummoner);
  const outcomeReports = { ...(existingPayload?.outcomeReports ?? {}) };
  const players = buildPlayersFromReport(report);

  if (reporter && report.historyGameId) {
    outcomeReports[reporter] = {
      gameId: Number(report.historyGameId),
      playerOutcome: report.historyPlayerOutcome ?? null,
      winnerTeam: normalizeTeam(report.historyWinnerTeam),
      primaryPlayerOutcome: report.primaryPlayerOutcome ?? report.playerOutcome ?? null,
      primaryWinnerTeam: normalizeTeam(report.primaryWinnerTeam ?? report.winnerTeam),
      at: new Date().toISOString()
    };
  }

  const validation = evaluateOutcomeQuorum(players, outcomeReports, report);

  return {
    outcomeReports,
    outcomeValidation: validation
  };
}

function mergeMatchPayload(existingPayload, report) {
  const merged = {
    ...(existingPayload ?? {}),
    ...report,
    primaryPlayerOutcome: report.primaryPlayerOutcome ?? existingPayload?.primaryPlayerOutcome ?? report.playerOutcome ?? null,
    primaryWinnerTeam: report.primaryWinnerTeam ?? existingPayload?.primaryWinnerTeam ?? report.winnerTeam ?? null
  };

  const { outcomeReports, outcomeValidation } = recordOutcomeReport(existingPayload, report);
  merged.outcomeReports = outcomeReports;
  merged.outcomeValidation = outcomeValidation;

  return merged;
}

module.exports = {
  mergeMatchPayload,
  recordOutcomeReport,
  evaluateOutcomeQuorum,
  normalizeTeam
};
