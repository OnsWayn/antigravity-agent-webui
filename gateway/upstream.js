const { decryptSecret } = require('./crypto');
const { resolveEnvProxyUrl } = require('./interactions');

const RATE_LIMIT_TRIES_PER_KEY = 3;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

function isRateLimitError(error) {
  const status = Number(error?.status);
  const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return status === 429
    || text.includes('resource_exhausted')
    || text.includes('resource exhausted')
    || text.includes('rate limit')
    || text.includes('too many requests')
    || text.includes('quota');
}

function decryptKeyRow(row, masterKey) {
  const apiKey = decryptSecret({
    ciphertext: row.key_ciphertext,
    iv: row.key_iv,
    tag: row.key_tag
  }, masterKey);
  return {
    row,
    apiKey,
    proxyUrl: row.proxy_url || resolveEnvProxyUrl()
  };
}

function pickUpstreamKey(database, masterKey, { preferId, excludeIds = [], now = Date.now() } = {}) {
  const rows = database.listEnabledUpstreamKeys();
  if (!rows.length) {
    const error = new Error('No upstream Gemini API key is configured');
    error.status = 503;
    error.code = 'no_upstream_key';
    throw error;
  }

  const excluded = new Set(excludeIds);
  const available = rows.filter((row) => !excluded.has(row.id));
  if (!available.length) {
    const error = new Error('All upstream Gemini API keys are cooling down after rate limits');
    error.status = 429;
    error.code = 'all_keys_rate_limited';
    throw error;
  }

  const healthy = available.filter((row) => !row.cooldown_until || Number(row.cooldown_until) <= now);
  const pool = healthy.length ? healthy : available;

  if (preferId) {
    const preferred = pool.find((row) => row.id === preferId);
    if (preferred) return decryptKeyRow(preferred, masterKey);
  }

  return decryptKeyRow(pool[0], masterKey);
}

module.exports = {
  RATE_LIMIT_TRIES_PER_KEY,
  RATE_LIMIT_COOLDOWN_MS,
  isRateLimitError,
  pickUpstreamKey,
  decryptKeyRow
};
