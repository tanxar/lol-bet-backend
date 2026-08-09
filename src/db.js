const fs = require('fs');
const path = require('path');

const { mergeMatchPayload } = require('./matchOutcomeValidation');

function openJsonDatabase(dataDir) {
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

  return {
    mode: 'json',
    readStore,
    writeStore
  };
}

async function openPostgresDatabase(databaseUrl) {
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false }
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      match_session_id TEXT PRIMARY KEY,
      game_mode TEXT NOT NULL,
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ,
      player_outcome TEXT,
      winner_team TEXT,
      connected_summoner TEXT,
      client_version TEXT NOT NULL,
      reported_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bet_json JSONB,
      players_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      payload_json JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_matches_start_time ON matches (start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_matches_connected_summoner ON matches (connected_summoner);
    CREATE INDEX IF NOT EXISTS idx_matches_completed ON matches (end_time) WHERE end_time IS NOT NULL;
  `);

  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS blue_score INTEGER;`);
  await pool.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS red_score INTEGER;`);

  return { mode: 'postgres', pool };
}

async function openDatabase(config) {
  if (config.databaseUrl) {
    const db = await openPostgresDatabase(config.databaseUrl);
    console.log('Database: PostgreSQL');
    return db;
  }

  const db = openJsonDatabase(config.dataDir);
  console.log(`Database: JSON file (${path.resolve(config.dataDir)}/store.json)`);
  console.log('Tip: set DATABASE_URL for PostgreSQL on Render');
  return db;
}

function buildPlayers(report) {
  return [
    ...(report.blueTeam ?? []).map((p) => ({ ...p, team: p.team ?? 'BLUE' })),
    ...(report.redTeam ?? []).map((p) => ({ ...p, team: p.team ?? 'RED' }))
  ];
}

function buildSummary(report, receivedAt) {
  return {
    matchSessionId: report.matchSessionId,
    gameMode: report.gameMode,
    startTime: report.startTime,
    endTime: report.endTime ?? null,
    playerOutcome: report.playerOutcome ?? null,
    winnerTeam: report.winnerTeam ?? null,
    connectedSummoner: report.connectedSummoner ?? null,
    blueScore: report.blueScore ?? null,
    redScore: report.redScore ?? null,
    clientVersion: report.clientVersion,
    reportedAt: report.reportedAt ?? receivedAt,
    receivedAt
  };
}

async function saveMatch(db, report) {
  const receivedAt = new Date().toISOString();
  const existing = await getMatch(db, report.matchSessionId);
  const mergedReport = mergeMatchPayload(existing, report);
  const players = buildPlayers(mergedReport);
  const summary = buildSummary(mergedReport, receivedAt);
  summary.outcomeValidation = mergedReport.outcomeValidation ?? null;

  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      INSERT INTO matches (
        match_session_id, game_mode, start_time, end_time, player_outcome,
        winner_team, connected_summoner, blue_score, red_score, client_version, reported_at,
        received_at, bet_json, players_json, payload_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      )
      ON CONFLICT (match_session_id) DO UPDATE SET
        game_mode = EXCLUDED.game_mode,
        start_time = EXCLUDED.start_time,
        end_time = COALESCE(EXCLUDED.end_time, matches.end_time),
        player_outcome = COALESCE(EXCLUDED.player_outcome, matches.player_outcome),
        winner_team = COALESCE(EXCLUDED.winner_team, matches.winner_team),
        connected_summoner = COALESCE(EXCLUDED.connected_summoner, matches.connected_summoner),
        blue_score = COALESCE(EXCLUDED.blue_score, matches.blue_score),
        red_score = COALESCE(EXCLUDED.red_score, matches.red_score),
        client_version = EXCLUDED.client_version,
        reported_at = EXCLUDED.reported_at,
        received_at = EXCLUDED.received_at,
        bet_json = COALESCE(EXCLUDED.bet_json, matches.bet_json),
        players_json = EXCLUDED.players_json,
        payload_json = EXCLUDED.payload_json
      `,
      [
        mergedReport.matchSessionId,
        mergedReport.gameMode,
        mergedReport.startTime,
        mergedReport.endTime ?? null,
        mergedReport.playerOutcome ?? null,
        mergedReport.winnerTeam ?? null,
        mergedReport.connectedSummoner ?? null,
        mergedReport.blueScore ?? null,
        mergedReport.redScore ?? null,
        mergedReport.clientVersion,
        mergedReport.reportedAt ?? receivedAt,
        receivedAt,
        mergedReport.bet ? JSON.stringify(mergedReport.bet) : null,
        JSON.stringify(players),
        JSON.stringify(mergedReport)
      ]
    );
    return mergedReport.outcomeValidation ?? null;
  }

  const store = db.readStore();
  store.matches[mergedReport.matchSessionId] = {
    summary,
    players,
    bet: mergedReport.bet ?? null,
    payload: mergedReport
  };
  db.writeStore(store);
  return mergedReport.outcomeValidation ?? null;
}

async function listMatches(db, { limit = 50, offset = 0, completedOnly = false, summoner = null } = {}) {
  if (db.mode === 'postgres') {
    const conditions = [];
    const params = [];

    if (completedOnly) {
      conditions.push('end_time IS NOT NULL');
      conditions.push("player_outcome IS NOT NULL AND player_outcome <> ''");
    }

    if (summoner) {
      params.push(summoner);
      conditions.push(`connected_summoner = $${params.length}`);
    }

    params.push(limit);
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await db.pool.query(
      `
      SELECT
        match_session_id AS "matchSessionId",
        game_mode AS "gameMode",
        start_time AS "startTime",
        end_time AS "endTime",
        player_outcome AS "playerOutcome",
        winner_team AS "winnerTeam",
        connected_summoner AS "connectedSummoner",
        blue_score AS "blueScore",
        red_score AS "redScore",
        client_version AS "clientVersion",
        reported_at AS "reportedAt",
        received_at AS "receivedAt",
        bet_json AS bet
      FROM matches
      ${where}
      ORDER BY start_time DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
      `,
      params
    );

    return result.rows.map((row) => ({
      matchSessionId: row.matchSessionId,
      gameMode: row.gameMode,
      startTime: row.startTime?.toISOString?.() ?? row.startTime,
      endTime: row.endTime?.toISOString?.() ?? row.endTime,
      playerOutcome: row.playerOutcome,
      winnerTeam: row.winnerTeam,
      connectedSummoner: row.connectedSummoner,
      blueScore: row.blueScore,
      redScore: row.redScore,
      clientVersion: row.clientVersion,
      reportedAt: row.reportedAt?.toISOString?.() ?? row.reportedAt,
      receivedAt: row.receivedAt?.toISOString?.() ?? row.receivedAt,
      bet: row.bet ?? null
    }));
  }

  const store = db.readStore();
  let all = Object.values(store.matches).map((entry) => ({
    ...entry.summary,
    bet: entry.bet ?? null
  }));

  if (completedOnly) {
    all = all.filter((m) => m.endTime && m.playerOutcome);
  }

  if (summoner) {
    all = all.filter((m) => m.connectedSummoner === summoner);
  }

  return all
    .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))
    .slice(offset, offset + limit);
}

async function getMatch(db, matchSessionId) {
  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      'SELECT payload_json AS payload FROM matches WHERE match_session_id = $1',
      [matchSessionId]
    );
    return result.rows[0]?.payload ?? null;
  }

  const store = db.readStore();
  return store.matches[matchSessionId]?.payload ?? null;
}

async function getMatchDetails(db, matchSessionId) {
  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT
        match_session_id AS "matchSessionId",
        game_mode AS "gameMode",
        start_time AS "startTime",
        end_time AS "endTime",
        player_outcome AS "playerOutcome",
        winner_team AS "winnerTeam",
        connected_summoner AS "connectedSummoner",
        client_version AS "clientVersion",
        reported_at AS "reportedAt",
        received_at AS "receivedAt",
        bet_json AS bet,
        players_json AS players
      FROM matches
      WHERE match_session_id = $1
      `,
      [matchSessionId]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      matchSessionId: row.matchSessionId,
      gameMode: row.gameMode,
      startTime: row.startTime?.toISOString?.() ?? row.startTime,
      endTime: row.endTime?.toISOString?.() ?? row.endTime,
      playerOutcome: row.playerOutcome,
      winnerTeam: row.winnerTeam,
      connectedSummoner: row.connectedSummoner,
      clientVersion: row.clientVersion,
      reportedAt: row.reportedAt?.toISOString?.() ?? row.reportedAt,
      receivedAt: row.receivedAt?.toISOString?.() ?? row.receivedAt,
      bet: row.bet ?? null,
      players: row.players ?? []
    };
  }

  const store = db.readStore();
  const entry = store.matches[matchSessionId];
  if (!entry) return null;

  return {
    ...entry.summary,
    players: entry.players,
    bet: entry.bet
  };
}

async function checkDatabaseHealth(db) {
  if (db.mode === 'postgres') {
    await db.pool.query('SELECT 1');
    return { ok: true, mode: 'postgres' };
  }

  db.readStore();
  return { ok: true, mode: 'json' };
}

module.exports = {
  openDatabase,
  saveMatch,
  listMatches,
  getMatch,
  getMatchDetails,
  checkDatabaseHealth
};
