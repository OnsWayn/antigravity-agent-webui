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

class TpmTracker {
  constructor({ windowMs = 60000, limitTpm = 100000, thresholdRatio = 0.8 } = {}) {
    this.windowMs = windowMs;
    this.limitTpm = limitTpm;
    this.thresholdRatio = thresholdRatio;
    this.records = new Map();
  }

  record(keyId, tokens, timestamp = Date.now()) {
    if (!keyId || !Number.isFinite(tokens) || tokens <= 0) return;
    const list = this.records.get(keyId) || [];
    list.push({ tokens: Number(tokens), timestamp: Number(timestamp) });
    this.records.set(keyId, list);
    this.prune(keyId, timestamp);
  }

  prune(keyId, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const list = this.records.get(keyId);
    if (!list) return;
    const filtered = list.filter((item) => item.timestamp >= cutoff);
    if (filtered.length === 0) {
      this.records.delete(keyId);
    } else {
      this.records.set(keyId, filtered);
    }
  }

  getRecentUsage(keyId, now = Date.now()) {
    this.prune(keyId, now);
    const list = this.records.get(keyId) || [];
    return list.reduce((sum, item) => sum + item.tokens, 0);
  }

  isNearLimit(keyId, { limitTpm = this.limitTpm, thresholdRatio = this.thresholdRatio, now = Date.now() } = {}) {
    const usage = this.getRecentUsage(keyId, now);
    return usage >= limitTpm * thresholdRatio;
  }

  clear() {
    this.records.clear();
  }
}

function pickUpstreamKey(database, masterKey, { preferId, excludeIds = [], now = Date.now(), tpmTracker } = {}) {
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

  let candidatePool = pool;
  if (tpmTracker && typeof tpmTracker.isNearLimit === 'function') {
    const tpmSafe = pool.filter((row) => !tpmTracker.isNearLimit(row.id, { now }));
    if (tpmSafe.length > 0) {
      candidatePool = tpmSafe;
    }
  }

  if (preferId) {
    const preferred = candidatePool.find((row) => row.id === preferId);
    if (preferred) return decryptKeyRow(preferred, masterKey);
    // If preferred is healthy but was filtered by TPM, fallback to preferred if in pool
    if (candidatePool !== pool) {
      const preferredInPool = pool.find((row) => row.id === preferId);
      if (preferredInPool) return decryptKeyRow(preferredInPool, masterKey);
    }
  }

  return decryptKeyRow(candidatePool[0], masterKey);
}

module.exports = {
  RATE_LIMIT_TRIES_PER_KEY,
  RATE_LIMIT_COOLDOWN_MS,
  isRateLimitError,
  pickUpstreamKey,
  decryptKeyRow,
  TpmTracker
};
