function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const limit = 1024 * 1024;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks));
    });

    req.on('error', reject);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req._rawBody !== undefined) {
      if (req._rawBody.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(req._rawBody.toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
      return;
    }

    readRawBody(req)
      .then((raw) => {
        req._rawBody = raw;
        if (raw.length === 0) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw.toString('utf8')));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      })
      .catch(reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

function sendFile(res, statusCode, filePath, contentType) {
  const fs = require('fs');
  const stream = fs.createReadStream(filePath);

  stream.on('open', () => {
    res.writeHead(statusCode, { 'Content-Type': contentType });
    stream.pipe(res);
  });

  stream.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 404, { error: 'File not found' });
    }
  });
}

module.exports = {
  readJsonBody,
  readRawBody,
  sendJson,
  parseUrl,
  sendFile
};
