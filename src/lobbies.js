const crypto = require('crypto');

const LOBBY_TTL_MS = 3 * 60 * 60 * 1000;

function normalizeSummoner(value) {
  return String(value ?? '').trim().toUpperCase();
}

function isRosterTeam(team) {
  const normalized = String(team ?? '').trim().toUpperCase();
  return normalized === 'BLUE' || normalized === 'RED';
}

function isResolvableSummoner(value) {
  const name = String(value ?? '').trim();
  return Boolean(name) && name.toUpperCase() !== 'UNKNOWN';
}

function playerKey(player) {
  if (player.summonerId > 0) return `id:${player.summonerId}`;
  const name = normalizeSummoner(player.summonerName);
  if (name) return `name:${name}`;
  return `bot:${player.team}:${player.championId}:${player.summonerName}`;
}

function computeRosterKey(humanNames) {
  return (humanNames ?? [])
    .map((name) => normalizeSummoner(name))
    .filter(Boolean)
    .sort()
    .join('|');
}

function generateMatchSessionId() {
  return crypto.randomBytes(8).toString('hex');
}

function mapLobbyRow(row) {
  if (!row) return null;
  return {
    matchSessionId: row.match_session_id ?? row.matchSessionId,
    rosterKey: row.roster_key ?? row.rosterKey,
    gameMode: row.game_mode ?? row.gameMode,
    queueId: row.queue_id ?? row.queueId ?? '0',
    phase: row.phase ?? 'Lobby',
    lobbyOwnerSummoner: row.lobby_owner_summoner ?? row.lobbyOwnerSummoner ?? null,
    players: row.players ?? [],
    selfTeams: row.self_teams ?? row.selfTeams ?? {},
    peerTeams: row.peer_teams ?? row.peerTeams ?? {},
    updatedAt: row.updated_at?.toISOString?.() ?? row.updatedAt,
    expiresAt: row.expires_at?.toISOString?.() ?? row.expiresAt
  };
}

async function ensureLobbySchema(db) {
  if (db.mode === 'postgres') {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS active_lobbies (
        match_session_id TEXT PRIMARY KEY,
        roster_key TEXT NOT NULL,
        game_mode TEXT NOT NULL,
        queue_id TEXT NOT NULL DEFAULT '0',
        phase TEXT NOT NULL DEFAULT 'Lobby',
        lobby_owner_summoner TEXT,
        players JSONB NOT NULL DEFAULT '[]'::jsonb,
        self_teams JSONB NOT NULL DEFAULT '{}'::jsonb,
        peer_teams JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_active_lobbies_roster_key ON active_lobbies (roster_key);
      CREATE INDEX IF NOT EXISTS idx_active_lobbies_expires_at ON active_lobbies (expires_at);
    `);
    return;
  }

  const store = db.readStore();
  if (!store.activeLobbies) store.activeLobbies = {};
  if (!store.lobbyRosterIndex) store.lobbyRosterIndex = {};
  db.writeStore(store);
}

function isExpired(lobby) {
  if (!lobby?.expiresAt) return true;
  return Date.parse(lobby.expiresAt) <= Date.now();
}

function reconcileDualHumanSelfTeams(selfTeams, peerTeams) {
  const keys = Object.keys(selfTeams ?? {}).filter((key) => isRosterTeam(selfTeams[key]?.team));
  if (keys.length !== 2) return;

  const [a, b] = keys;
  const teamA = selfTeams[a].team;
  const teamB = selfTeams[b].team;
  if (teamA !== teamB) return;

  const peerB = peerTeams?.[b];
  const peerA = peerTeams?.[a];
  if (isRosterTeam(peerB) && peerB !== teamA) {
    selfTeams[b] = { ...selfTeams[b], team: peerB };
    return;
  }

  if (isRosterTeam(peerA) && peerA !== teamB) {
    selfTeams[a] = { ...selfTeams[a], team: peerA };
    return;
  }

  selfTeams[b] = { ...selfTeams[b], team: teamA === 'BLUE' ? 'RED' : 'BLUE' };
}

function rebuildPlayers(players, selfTeams, peerTeams) {
  return (players ?? []).map((player) => {
    if (player.isBot) return player;

    const key = normalizeSummoner(player.summonerName);
    const team = selfTeams?.[key]?.team ?? peerTeams?.[key] ?? player.team;
    return { ...player, team };
  });
}

function mergeLobbyReport(existing, body) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + LOBBY_TTL_MS).toISOString();
  const reporter = normalizeSummoner(body.connectedSummoner);
  const selfTeams = { ...(existing?.selfTeams ?? {}) };
  const peerTeams = { ...(existing?.peerTeams ?? {}) };
  let lobbyOwnerSummoner = existing?.lobbyOwnerSummoner ?? null;

  for (const player of body.players ?? []) {
    if (!player.isBot && player.isLeader) {
      if (normalizeSummoner(player.summonerName) === reporter &&
          isResolvableSummoner(body.connectedSummoner)) {
        lobbyOwnerSummoner = body.connectedSummoner;
      } else if (isResolvableSummoner(player.summonerName) &&
        (!lobbyOwnerSummoner || !isResolvableSummoner(lobbyOwnerSummoner))) {
        lobbyOwnerSummoner = player.summonerName;
      }
    }
  }

  for (const player of body.players ?? []) {
    if (player.isBot) continue;

    const key = normalizeSummoner(player.summonerName);
    if (!key || !isRosterTeam(player.team)) continue;

    if (key === reporter) {
      selfTeams[key] = { team: player.team, at: body.reportedAt ?? now };
      continue;
    }

    if (!selfTeams[key]) {
      peerTeams[key] = player.team;
    }
  }

  reconcileDualHumanSelfTeams(selfTeams, peerTeams);
  const players = rebuildPlayers(body.players ?? existing?.players ?? [], selfTeams, peerTeams);

  return {
    matchSessionId: body.matchSessionId ?? existing?.matchSessionId,
    rosterKey: body.rosterKey ?? existing?.rosterKey,
    gameMode: body.gameMode ?? existing?.gameMode ?? 'CLASSIC',
    queueId: body.queueId ?? existing?.queueId ?? '0',
    phase: body.phase ?? existing?.phase ?? 'Lobby',
    lobbyOwnerSummoner,
    players,
    selfTeams,
    peerTeams,
    updatedAt: now,
    expiresAt
  };
}

async function saveLobbyRecord(db, record) {
  await ensureLobbySchema(db);

  if (db.mode === 'postgres') {
    await db.pool.query(
      `
      INSERT INTO active_lobbies (
        match_session_id, roster_key, game_mode, queue_id, phase,
        lobby_owner_summoner, players, self_teams, peer_teams, updated_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (match_session_id) DO UPDATE SET
        roster_key = EXCLUDED.roster_key,
        game_mode = EXCLUDED.game_mode,
        queue_id = EXCLUDED.queue_id,
        phase = EXCLUDED.phase,
        lobby_owner_summoner = EXCLUDED.lobby_owner_summoner,
        players = EXCLUDED.players,
        self_teams = EXCLUDED.self_teams,
        peer_teams = EXCLUDED.peer_teams,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at
      `,
      [
        record.matchSessionId,
        record.rosterKey,
        record.gameMode,
        record.queueId,
        record.phase,
        record.lobbyOwnerSummoner,
        JSON.stringify(record.players ?? []),
        JSON.stringify(record.selfTeams ?? {}),
        JSON.stringify(record.peerTeams ?? {}),
        record.updatedAt,
        record.expiresAt
      ]
    );
  } else {
    const store = db.readStore();
    store.activeLobbies[record.matchSessionId] = record;
    store.lobbyRosterIndex[record.rosterKey] = record.matchSessionId;
    db.writeStore(store);
  }

  return record;
}

async function getLobby(db, matchSessionId) {
  await ensureLobbySchema(db);

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT match_session_id, roster_key, game_mode, queue_id, phase,
             lobby_owner_summoner, players, self_teams, peer_teams, updated_at, expires_at
      FROM active_lobbies
      WHERE match_session_id = $1
      `,
      [matchSessionId]
    );
    const lobby = mapLobbyRow(result.rows[0]);
    return lobby && !isExpired(lobby) ? lobby : null;
  }

  const store = db.readStore();
  const lobby = mapLobbyRow(store.activeLobbies?.[matchSessionId]);
  return lobby && !isExpired(lobby) ? lobby : null;
}

async function findLobbyByRosterKey(db, rosterKey) {
  await ensureLobbySchema(db);

  if (db.mode === 'postgres') {
    const result = await db.pool.query(
      `
      SELECT match_session_id, roster_key, game_mode, queue_id, phase,
             lobby_owner_summoner, players, self_teams, peer_teams, updated_at, expires_at
      FROM active_lobbies
      WHERE roster_key = $1 AND expires_at > NOW()
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [rosterKey]
    );
    return mapLobbyRow(result.rows[0]);
  }

  const store = db.readStore();
  const matchSessionId = store.lobbyRosterIndex?.[rosterKey];
  if (!matchSessionId) return null;
  const lobby = mapLobbyRow(store.activeLobbies?.[matchSessionId]);
  return lobby && !isExpired(lobby) ? lobby : null;
}

async function upsertLobby(db, body) {
  const existing = body.matchSessionId ? await getLobby(db, body.matchSessionId) : null;
  const record = mergeLobbyReport(existing, body);
  return saveLobbyRecord(db, record);
}

async function resolveLobby(db, body) {
  const humanNames = body.humanNames ?? body.humans ?? [];
  const rosterKey = computeRosterKey(humanNames);
  if (!rosterKey) {
    const err = new Error('At least one human summoner is required');
    err.code = 'VALIDATION';
    throw err;
  }

  let existing = body.matchSessionId ? await getLobby(db, body.matchSessionId) : null;
  if (!existing) {
    existing = await findLobbyByRosterKey(db, rosterKey);
  }

  const matchSessionId = existing?.matchSessionId ?? generateMatchSessionId();
  const merged = mergeLobbyReport(existing, {
    ...body,
    matchSessionId,
    rosterKey
  });

  return saveLobbyRecord(db, merged);
}

async function deleteLobby(db, matchSessionId) {
  await ensureLobbySchema(db);
  const existing = await getLobby(db, matchSessionId);
  if (!existing) return false;

  if (db.mode === 'postgres') {
    await db.pool.query('DELETE FROM active_lobbies WHERE match_session_id = $1', [matchSessionId]);
    return true;
  }

  const store = db.readStore();
  delete store.activeLobbies[matchSessionId];
  if (store.lobbyRosterIndex?.[existing.rosterKey] === matchSessionId) {
    delete store.lobbyRosterIndex[existing.rosterKey];
  }
  db.writeStore(store);
  return true;
}

function validateLobbySync(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Body must be a JSON object'];
  if (!Array.isArray(body.players) || body.players.length === 0) {
    errors.push('players must be a non-empty array');
  }
  if (!body.gameMode || typeof body.gameMode !== 'string') errors.push('gameMode is required');
  return errors;
}

module.exports = {
  computeRosterKey,
  resolveLobby,
  upsertLobby,
  getLobby,
  deleteLobby,
  validateLobbySync
};
