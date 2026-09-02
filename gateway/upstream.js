const crypto = require('crypto');
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

function isInternalError(error) {
  const message = String(error?.message || '');
  const code = String(error?.code || error?.statusName || '').toUpperCase();
  const status = Number(error?.status);
  const messageMatch = /internal error encountered/i.test(message);
  if (messageMatch) return true;
  if (status === 500 && (code === 'INTERNAL' || code === 'API_ERROR') && messageMatch) return true;
  return false;
}

function rewriteInternalError(error) {
  const original = String(error?.message || '').trim();
  const message = /internal error encountered/i.test(original)
    ? original
    : 'Internal error encountered.';
  const next = new Error(message);
  next.status = 400;
  next.code = 'INTERNAL';
  next.type = 'invalid_request_error';
  next.rawError = error?.rawError || {
    error: { message, type: 'invalid_request_error', code: 'INTERNAL' }
  };
  return next;
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

class RequestCounter {
  constructor({ windowMs = 60000 } = {}) {
    this.windowMs = windowMs;
    this.records = new Map();
  }

  configure({ windowMs } = {}) {
    if (Number.isFinite(Number(windowMs)) && Number(windowMs) > 0) this.windowMs = Number(windowMs);
    return this;
  }

  recordRequest(keyId, ts = Date.now()) {
    if (!keyId) return;
    const list = this.records.get(keyId) || [];
    list.push(Number(ts));
    this.records.set(keyId, list);
    this.prune(keyId, ts);
  }

  prune(keyId, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const list = this.records.get(keyId);
    if (!list) return;
    const filtered = list.filter((timestamp) => timestamp >= cutoff);
    if (filtered.length === 0) this.records.delete(keyId);
    else this.records.set(keyId, filtered);
  }

  getRpm(keyId, now = Date.now()) {
    this.prune(keyId, now);
    return (this.records.get(keyId) || []).length;
  }

  clear() {
    this.records.clear();
  }
}

class TpmTracker {
  constructor({
    windowMs = 60000,
    limitTpm = 100000,
    thresholdRatio = 0.8,
    reserveTtlMs,
    onReserveExpired
  } = {}) {
    this.windowMs = windowMs;
    this.limitTpm = limitTpm;
    this.thresholdRatio = thresholdRatio;
    this.reserveTtlMs = Number.isFinite(Number(reserveTtlMs)) && Number(reserveTtlMs) >= 1000
      ? Number(reserveTtlMs)
      : windowMs;
    this.onReserveExpired = typeof onReserveExpired === 'function' ? onReserveExpired : null;
    this.records = new Map();
  }

  configure({ windowMs, limitTpm, thresholdRatio, reserveTtlMs } = {}) {
    if (Number.isFinite(Number(windowMs)) && Number(windowMs) > 0) this.windowMs = Number(windowMs);
    if (Number.isFinite(Number(limitTpm)) && Number(limitTpm) > 0) this.limitTpm = Number(limitTpm);
    if (Number.isFinite(Number(thresholdRatio)) && Number(thresholdRatio) > 0) this.thresholdRatio = Number(thresholdRatio);
    if (Number.isFinite(Number(reserveTtlMs)) && Number(reserveTtlMs) >= 1000) this.reserveTtlMs = Number(reserveTtlMs);
    else if (reserveTtlMs === null) this.reserveTtlMs = this.windowMs;
    return this;
  }

  record(keyId, tokens, timestamp = Date.now()) {
    if (!keyId || !Number.isFinite(tokens) || tokens <= 0) return;
    this.prune(keyId, timestamp);
    const list = this.records.get(keyId) || [];
    list.push({ tokens: Number(tokens), timestamp: Number(timestamp) });
    this.records.set(keyId, list);
  }

  prune(keyId, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const list = this.records.get(keyId);
    if (!list) return;
    const filtered = [];
    for (const item of list) {
      if (item.kind === 'reserve') {
        if (Number(item.expiresAt) <= now || item.timestamp < cutoff) {
          if (this.onReserveExpired && Number(item.expiresAt) <= now) {
            this.onReserveExpired({
              keyId,
              reserveId: item.reserveId,
              needed: item.tokens,
              ageMs: now - item.timestamp
            });
          }
          continue;
        }
      } else if (item.timestamp < cutoff) {
        continue;
      }
      filtered.push(item);
    }
    if (filtered.length === 0) this.records.delete(keyId);
    else this.records.set(keyId, filtered);
  }

  getRecentUsage(keyId, now = Date.now()) {
    this.prune(keyId, now);
    const list = this.records.get(keyId) || [];
    return list.reduce((sum, item) => sum + Number(item.tokens || 0), 0);
  }

  isNearLimit(keyId, {
    limitTpm = this.limitTpm,
    thresholdRatio = this.thresholdRatio,
    now = Date.now()
  } = {}) {
    const usage = this.getRecentUsage(keyId, now);
    return usage >= limitTpm * thresholdRatio;
  }

  timeUntilFits(keyId, needed, { limitTpm = this.limitTpm, now = Date.now() } = {}) {
    this.prune(keyId, now);
    const need = Number(needed) || 0;
    const limit = Number(limitTpm) || this.limitTpm;
    if (!(need > 0)) return 0;
    if (need > limit) return Infinity;
    const list = [...(this.records.get(keyId) || [])].sort((a, b) => a.timestamp - b.timestamp);
    let usage = list.reduce((sum, item) => sum + Number(item.tokens || 0), 0);
    if (usage + need < limit) return 0;
    for (const item of list) {
      usage -= Number(item.tokens || 0);
      if (usage + need < limit) {
        return Math.max(0, item.timestamp + this.windowMs - now);
      }
    }
    return Infinity;
  }

  tryReserve(keyId, needed, { limitTpm = this.limitTpm, now = Date.now(), ttlMs } = {}) {
    if (!keyId) return null;
    this.prune(keyId, now);
    const need = Number(needed) || 0;
    const limit = Number(limitTpm) || this.limitTpm;
    if (need > limit) return null;
    const usage = this.getRecentUsage(keyId, now);
    if (usage + need >= limit && need > 0) return null;
    const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) >= 1000 ? Number(ttlMs) : this.reserveTtlMs;
    const reserveId = crypto.randomUUID();
    const list = this.records.get(keyId) || [];
    list.push({
      reserveId,
      keyId,
      tokens: Math.max(0, need),
      timestamp: Number(now),
      expiresAt: Number(now) + ttl,
      kind: 'reserve'
    });
    this.records.set(keyId, list);
    return reserveId;
  }

  commitReservation(reserveId, actualTokens, timestamp = Date.now()) {
    if (!reserveId) return false;
    for (const [keyId, list] of this.records.entries()) {
      const index = list.findIndex((item) => item.kind === 'reserve' && item.reserveId === reserveId);
      if (index < 0) continue;
      list.splice(index, 1);
      if (list.length === 0) this.records.delete(keyId);
      else this.records.set(keyId, list);
      this.record(keyId, actualTokens, timestamp);
      return true;
    }
    return false;
  }

  cancelReservation(reserveId) {
    if (!reserveId) return false;
    for (const [keyId, list] of this.records.entries()) {
      const next = list.filter((item) => !(item.kind === 'reserve' && item.reserveId === reserveId));
      if (next.length === list.length) continue;
      if (next.length === 0) this.records.delete(keyId);
      else this.records.set(keyId, next);
      return true;
    }
    return false;
  }

  clear() {
    this.records.clear();
  }
}

function pickUpstreamKey(database, masterKey, {
  preferId,
  excludeIds = [],
  now = Date.now(),
  tpmTracker,
  strategy = 'clone',
  tpmPaceLimit,
  needed = 0
} = {}) {
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
  const pace = strategy === 'pace';

  if (pace) {
    if (preferId) {
      const preferredHealthy = pool.find((row) => row.id === preferId);
      if (preferredHealthy) {
        return { ...decryptKeyRow(preferredHealthy, masterKey), tpmAvoided: false };
      }
    }

    let candidatePool = pool;
    if (tpmTracker && typeof tpmTracker.getRecentUsage === 'function') {
      const limit = Number(tpmPaceLimit) > 0 ? Number(tpmPaceLimit) : tpmTracker.limitTpm;
      const need = Number(needed) > 0 ? Number(needed) : 0;
      const tpmSafe = pool.filter((row) => tpmTracker.getRecentUsage(row.id, now) + need < limit);
      if (tpmSafe.length > 0) {
        candidatePool = tpmSafe;
      } else {
        candidatePool = [...pool].sort(
          (a, b) => tpmTracker.getRecentUsage(a.id, now) - tpmTracker.getRecentUsage(b.id, now)
        );
      }
    }
    return { ...decryptKeyRow(candidatePool[0], masterKey), tpmAvoided: false };
  }

  let candidatePool = pool;
  if (tpmTracker && typeof tpmTracker.isNearLimit === 'function') {
    const tpmSafe = pool.filter((row) => !tpmTracker.isNearLimit(row.id, { now }));
    if (tpmSafe.length > 0) {
      candidatePool = tpmSafe;
    }
  }

  if (preferId) {
    const preferredSafe = candidatePool.find((row) => row.id === preferId);
    if (preferredSafe) {
      return { ...decryptKeyRow(preferredSafe, masterKey), tpmAvoided: false };
    }
    if (candidatePool.length > 0 && candidatePool !== pool) {
      return { ...decryptKeyRow(candidatePool[0], masterKey), tpmAvoided: true };
    }
    const preferredInPool = pool.find((row) => row.id === preferId);
    if (preferredInPool) {
      return { ...decryptKeyRow(preferredInPool, masterKey), tpmAvoided: false };
    }
  }

  return { ...decryptKeyRow(candidatePool[0], masterKey), tpmAvoided: false };
}

module.exports = {
  RATE_LIMIT_TRIES_PER_KEY,
  RATE_LIMIT_COOLDOWN_MS,
  isRateLimitError,
  isInternalError,
  rewriteInternalError,
  pickUpstreamKey,
  decryptKeyRow,
  TpmTracker,
  RequestCounter
};
