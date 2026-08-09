const crypto = require('crypto');

/** @type {Map<string, Set<import('http').ServerResponse>>} */
const matchSubscribers = new Map();

/** @type {import('redis').RedisClientType | null} */
let redisPublisher = null;
/** @type {import('redis').RedisClientType | null} */
let redisSubscriber = null;

const REDIS_CHANNEL = 'lol-bet:match-events';

async function initEventBus(config) {
  if (!config.redisUrl) return;

  try {
    const { createClient } = require('redis');
    redisPublisher = createClient({ url: config.redisUrl });
    redisSubscriber = createClient({ url: config.redisUrl });
    await redisPublisher.connect();
    await redisSubscriber.connect();

    await redisSubscriber.subscribe(REDIS_CHANNEL, (message) => {
      try {
        const { matchSessionId, eventType, data } = JSON.parse(message);
        fanOutLocal(matchSessionId, eventType, data);
      } catch (err) {
        console.error('Redis event parse failed:', err);
      }
    });

    console.log('Redis event bus connected');
  } catch (err) {
    console.warn('Redis unavailable — using in-memory events only:', err.message);
    redisPublisher = null;
    redisSubscriber = null;
  }
}

function fanOutLocal(matchSessionId, eventType, data) {
  const payload = formatSse(eventType, data);
  const subs = matchSubscribers.get(matchSessionId);
  if (!subs) return;

  for (const res of subs) {
    if (res.writableEnded) continue;
    try {
      res.write(payload);
    } catch {
      subs.delete(res);
    }
  }
}

function formatSse(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function subscribeMatchStream(matchSessionId, res) {
  if (!matchSubscribers.has(matchSessionId)) {
    matchSubscribers.set(matchSessionId, new Set());
  }
  const subs = matchSubscribers.get(matchSessionId);
  subs.add(res);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(formatSse('connected', { matchSessionId, at: new Date().toISOString() }));

  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(': heartbeat\n\n');
  }, 25000);

  res.on('close', () => {
    clearInterval(heartbeat);
    subs.delete(res);
    if (subs.size === 0) matchSubscribers.delete(matchSessionId);
  });
}

function publishMatchEvent(matchSessionId, eventType, data) {
  fanOutLocal(matchSessionId, eventType, data);

  if (redisPublisher?.isOpen) {
    redisPublisher
      .publish(REDIS_CHANNEL, JSON.stringify({ matchSessionId, eventType, data }))
      .catch((err) => console.error('Redis publish failed:', err));
  }
}

function computeRosterSnapshotHash(players) {
  const humans = (players ?? [])
    .filter((p) => !p.isBot)
    .map((p) => {
      const name = String(p.summonerName ?? '').trim().toUpperCase();
      const team = String(p.team ?? '').trim().toUpperCase();
      const champ = Number(p.championId ?? 0);
      return `${name}:${team}:${champ}`;
    })
    .filter(Boolean)
    .sort()
    .join('|');

  return crypto.createHash('sha256').update(humans).digest('hex').slice(0, 16);
}

module.exports = {
  initEventBus,
  subscribeMatchStream,
  publishMatchEvent,
  computeRosterSnapshotHash
};
