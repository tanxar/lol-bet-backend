function normalizeSummonerName(value) {
  return String(value ?? '').trim().toUpperCase();
}

module.exports = { normalizeSummonerName };
