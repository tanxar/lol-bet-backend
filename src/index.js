const http = require('http');
const config = require('./config');
const { openDatabase, saveMatch, listMatches, getMatch, getMatchDetails } = require('./db');
const { readJsonBody, sendJson, parseUrl } = require('./http');

const db = openDatabase(config.dataDir);

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

async function handleRequest(req, res) {
  const url = parseUrl(req);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'lol-bet-tracker-server' });
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
        saveMatch(db, body);
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

      try {
        const matches = listMatches(db, { limit, offset });
        sendJson(res, 200, { matches, limit, offset });
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
          const match = getMatch(db, matchSessionId);
          if (!match) {
            sendJson(res, 404, { error: 'Match not found' });
            return;
          }
          sendJson(res, 200, match);
          return;
        }

        const details = getMatchDetails(db, matchSessionId);
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
