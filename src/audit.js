const fs = require('fs');
const path = require('path');

let auditStream = null;

function initAudit(config) {
  if (!config.auditLog) return;

  const dir = path.dirname(config.auditLog);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  auditStream = fs.createWriteStream(config.auditLog, { flags: 'a' });
}

function auditLog(action, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    action,
    ...details
  };

  const line = JSON.stringify(entry);
  console.log(`[audit] ${action}`, details.summoner ?? details.proposalId ?? '');

  if (auditStream && !auditStream.destroyed) {
    auditStream.write(`${line}\n`);
  }
}

module.exports = { initAudit, auditLog };
