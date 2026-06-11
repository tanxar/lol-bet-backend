const http = require('http');
const config = require('./config');
const {
  openDatabase,
  saveMatch,
  listMatches,
  getMatch,
  getMatchDetails,
  checkDatabaseHealth
} = require('./db');
const { readJsonBody, sendJson, parseUrl } = require('./http');

let db;

function checkApiKey(req, res) {
  if (!config.apiKey) return true;

  const headerKey = req.headers['x-api-key'];
  if (headerKey && headerKey === config.apiKey) return true;

  sendJson(res, 401, { error: 'Invalid or missing API key' });
  return false;
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

function logRequest(req, pathname, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}${suffix}`);
}

async function handleRequest(req, res) {
  const url = parseUrl(req);
  const pathname = url.pathname;
  logRequest(req, pathname);

  if (req.method === 'GET' && pathname === '/health') {
    try {
      const dbHealth = await checkDatabaseHealth(db);
      sendJson(res, 200, { ok: true, service: 'lol-bet-tracker-server', database: dbHealth });
    } catch (err) {
      console.error('Health check failed:', err);
      sendJson(res, 503, { ok: false, service: 'lol-bet-tracker-server', error: 'Database unavailable' });
    }
    return;
  }

  if (pathname.startsWith('/api/matches')) {
    if (!checkApiKey(req, res)) return;

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
        await saveMatch(db, body);
        const betInfo = body.bet
          ? `bet=${body.bet.ruleType} pick=${body.bet.pickedTeam} status=${body.bet.status}`
          : 'no-bet';
        console.log(
          `Match saved: ${body.matchSessionId} mode=${body.gameMode} outcome=${body.playerOutcome ?? 'in-progress'} ${betInfo}`
        );
        sendJson(res, 201, { ok: true, matchSessionId: body.matchSessionId });
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

  sendJson(res, 404, { error: 'Not found' });
}

async function main() {
  db = await openDatabase(config);

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
    if (config.apiKey) {
      console.log('API key authentication enabled (X-Api-Key header)');
    } else {
      console.log('Warning: API_KEY not set — endpoints are open');
    }
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
