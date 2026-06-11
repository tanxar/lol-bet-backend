const fs = require('fs');
const path = require('path');

function openDatabase(dataDir) {
  const resolved = path.resolve(dataDir);
  fs.mkdirSync(resolved, { recursive: true });

  const storePath = path.join(resolved, 'store.json');

  function readStore() {
    if (!fs.existsSync(storePath)) {
      return { matches: {} };
    }

    try {
      return JSON.parse(fs.readFileSync(storePath, 'utf8'));
    } catch {
      return { matches: {} };
    }
  }

  function writeStore(store) {
    const tempPath = `${storePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tempPath, storePath);
  }

  return { readStore, writeStore };
}

function saveMatch(db, report) {
  const receivedAt = new Date().toISOString();
  const store = db.readStore();

  const players = [
    ...(report.blueTeam ?? []).map((p) => ({ ...p, team: p.team ?? 'BLUE' })),
    ...(report.redTeam ?? []).map((p) => ({ ...p, team: p.team ?? 'RED' }))
  ];

  store.matches[report.matchSessionId] = {
    summary: {
      matchSessionId: report.matchSessionId,
      gameMode: report.gameMode,
      startTime: report.startTime,
      endTime: report.endTime ?? null,
      playerOutcome: report.playerOutcome ?? null,
      winnerTeam: report.winnerTeam ?? null,
      connectedSummoner: report.connectedSummoner ?? null,
      clientVersion: report.clientVersion,
      reportedAt: report.reportedAt ?? receivedAt,
      receivedAt
    },
    players,
    bet: report.bet ?? null,
    payload: report
  };

  db.writeStore(store);
}

function listMatches(db, { limit = 50, offset = 0 } = {}) {
  const store = db.readStore();
  const all = Object.values(store.matches)
    .map((entry) => entry.summary)
    .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)));

  return all.slice(offset, offset + limit);
}

function getMatch(db, matchSessionId) {
  const store = db.readStore();
  const entry = store.matches[matchSessionId];
  return entry?.payload ?? null;
}

function getMatchDetails(db, matchSessionId) {
  const store = db.readStore();
  const entry = store.matches[matchSessionId];
  if (!entry) return null;

  return {
    ...entry.summary,
    players: entry.players,
    bet: entry.bet
  };
}

module.exports = {
  openDatabase,
  saveMatch,
  listMatches,
  getMatch,
  getMatchDetails
};
