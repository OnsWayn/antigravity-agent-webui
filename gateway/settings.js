const { BACKEND_MODELS } = require('./models');

const DEFAULT_GATEWAY_SETTINGS = {
  tpmStrategy: 'clone',
  tpmLimit: 100000,
  tpmThresholdRatio: 0.8,
  tpmWindowMs: 60000,
  tpmPaceLimit: 100000,
  tpmPaceMaxWaitMs: 20000,
  tpmPaceDelayMs: 5000,
  migrationMaxInputTokens: 24000,
  internalErrorRetryLimit: 2,
  hashIgnorePrefixes: ['<RAG-Faiss-Memory>'],
  gatewayModels: BACKEND_MODELS.slice()
};

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseRatio(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function parseStrategy(value, fallback = DEFAULT_GATEWAY_SETTINGS.tpmStrategy) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'frok' || raw === 'clone') return 'clone';
  if (raw === 'pace') return 'pace';
  const fb = String(fallback || '').trim().toLowerCase();
  if (fb === 'pace') return 'pace';
  if (fb === 'frok' || fb === 'clone') return 'clone';
  return 'clone';
}

function invalidSettings(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'invalid_settings';
  return error;
}

function splitPrefixSource(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return trimmed.split(/\r?\n/);
}

function parsePrefixList(value, fallback = DEFAULT_GATEWAY_SETTINGS.hashIgnorePrefixes, { strict = false } = {}) {
  if (value == null) return Array.isArray(fallback) ? fallback.slice() : [];
  if (typeof value === 'string' && value.trim() === '') {
    if (strict) throw invalidSettings('hashIgnorePrefixes must not be an empty string');
    return [];
  }
  const source = splitPrefixSource(value);
  if (!source) {
    if (strict) throw invalidSettings('hashIgnorePrefixes must be an array or newline-separated string');
    return Array.isArray(fallback) ? fallback.slice() : [];
  }
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const prefix = String(item == null ? '' : item).trim();
    if (!prefix) continue;
    if (prefix.length < 2 || prefix.length > 200) {
      if (strict) throw invalidSettings('hashIgnorePrefixes entries must be 2–200 characters');
      continue;
    }
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    out.push(prefix);
    if (out.length > 32) {
      if (strict) throw invalidSettings('hashIgnorePrefixes supports at most 32 entries');
      break;
    }
  }
  return out;
}

function parseModelCatalog(value, fallback = DEFAULT_GATEWAY_SETTINGS.gatewayModels, { strict = false } = {}) {
  if (value == null) return Array.isArray(fallback) ? fallback.slice() : [];
  if (typeof value === 'string' && value.trim() === '') return [];
  const source = splitPrefixSource(value);
  if (!source) {
    if (strict) throw invalidSettings('gatewayModels must be an array or newline-separated string');
    return Array.isArray(fallback) ? fallback.slice() : [];
  }
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const id = String(item == null ? '' : item).trim();
    if (!id) continue;
    if (id.length > 128) {
      if (strict) throw invalidSettings('gatewayModels entries must be 1–128 characters');
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length > 64) {
      if (strict) throw invalidSettings('gatewayModels supports at most 64 entries');
      break;
    }
  }
  return out;
}

function envGatewaySettings() {
  const tpmWindowMs = parsePositiveInt(process.env.GATEWAY_TPM_WINDOW_MS, DEFAULT_GATEWAY_SETTINGS.tpmWindowMs);
  const settings = {
    tpmStrategy: parseStrategy(process.env.GATEWAY_TPM_STRATEGY, DEFAULT_GATEWAY_SETTINGS.tpmStrategy),
    tpmLimit: parsePositiveInt(process.env.GATEWAY_TPM_LIMIT, DEFAULT_GATEWAY_SETTINGS.tpmLimit),
    tpmThresholdRatio: parseRatio(process.env.GATEWAY_TPM_THRESHOLD_RATIO, DEFAULT_GATEWAY_SETTINGS.tpmThresholdRatio),
    tpmWindowMs,
    tpmPaceLimit: parsePositiveInt(process.env.GATEWAY_TPM_PACE_LIMIT, DEFAULT_GATEWAY_SETTINGS.tpmPaceLimit),
    tpmPaceMaxWaitMs: parseNonNegativeInt(process.env.GATEWAY_TPM_PACE_MAX_WAIT_MS, DEFAULT_GATEWAY_SETTINGS.tpmPaceMaxWaitMs),
    tpmPaceDelayMs: parseNonNegativeInt(process.env.GATEWAY_TPM_PACE_DELAY_MS, DEFAULT_GATEWAY_SETTINGS.tpmPaceDelayMs),
    migrationMaxInputTokens: parsePositiveInt(
      process.env.GATEWAY_MIGRATION_MAX_INPUT_TOKENS,
      DEFAULT_GATEWAY_SETTINGS.migrationMaxInputTokens
    ),
    internalErrorRetryLimit: parsePositiveInt(
      process.env.GATEWAY_INTERNAL_ERROR_RETRY_LIMIT,
      DEFAULT_GATEWAY_SETTINGS.internalErrorRetryLimit
    ),
    hashIgnorePrefixes: parsePrefixList(
      process.env.GATEWAY_HASH_IGNORE_PREFIXES,
      DEFAULT_GATEWAY_SETTINGS.hashIgnorePrefixes,
      { strict: false }
    ),
    gatewayModels: parseModelCatalog(
      process.env.GATEWAY_MODELS,
      DEFAULT_GATEWAY_SETTINGS.gatewayModels,
      { strict: false }
    )
  };
  if (process.env.GATEWAY_TPM_RESERVE_TTL_MS != null && process.env.GATEWAY_TPM_RESERVE_TTL_MS !== '') {
    settings.tpmReserveTtlMs = parsePositiveInt(process.env.GATEWAY_TPM_RESERVE_TTL_MS, tpmWindowMs);
  }
  return settings;
}

function clampGatewaySettings(input = {}, fallback = DEFAULT_GATEWAY_SETTINGS) {
  const base = { ...DEFAULT_GATEWAY_SETTINGS, ...fallback, ...input };
  const tpmStrategy = parseStrategy(base.tpmStrategy, fallback.tpmStrategy || DEFAULT_GATEWAY_SETTINGS.tpmStrategy);
  const tpmLimit = parsePositiveInt(base.tpmLimit, fallback.tpmLimit);
  const tpmWindowMs = parsePositiveInt(base.tpmWindowMs, fallback.tpmWindowMs);
  const tpmPaceLimit = parsePositiveInt(base.tpmPaceLimit, fallback.tpmPaceLimit ?? DEFAULT_GATEWAY_SETTINGS.tpmPaceLimit);
  const tpmPaceMaxWaitMs = parseNonNegativeInt(
    base.tpmPaceMaxWaitMs,
    fallback.tpmPaceMaxWaitMs ?? DEFAULT_GATEWAY_SETTINGS.tpmPaceMaxWaitMs
  );
  const tpmPaceDelayMs = parseNonNegativeInt(
    base.tpmPaceDelayMs,
    fallback.tpmPaceDelayMs ?? DEFAULT_GATEWAY_SETTINGS.tpmPaceDelayMs
  );
  const migrationMaxInputTokens = parsePositiveInt(base.migrationMaxInputTokens, fallback.migrationMaxInputTokens);
  let tpmThresholdRatio = parseRatio(base.tpmThresholdRatio, fallback.tpmThresholdRatio);
  const tpmReserveTtlMs = parsePositiveInt(
    base.tpmReserveTtlMs,
    parsePositiveInt(fallback.tpmReserveTtlMs, tpmWindowMs)
  );
  const internalErrorRetryLimit = parsePositiveInt(
    base.internalErrorRetryLimit,
    fallback.internalErrorRetryLimit ?? DEFAULT_GATEWAY_SETTINGS.internalErrorRetryLimit
  );
  const hashIgnorePrefixes = parsePrefixList(
    base.hashIgnorePrefixes,
    fallback.hashIgnorePrefixes ?? DEFAULT_GATEWAY_SETTINGS.hashIgnorePrefixes,
    { strict: true }
  );
  const gatewayModels = parseModelCatalog(
    base.gatewayModels,
    fallback.gatewayModels ?? DEFAULT_GATEWAY_SETTINGS.gatewayModels,
    { strict: true }
  );

  if (tpmLimit < 1000) throw invalidSettings('tpmLimit must be >= 1000');
  if (tpmThresholdRatio < 0.1 || tpmThresholdRatio > 1) throw invalidSettings('tpmThresholdRatio must be between 0.1 and 1');
  if (tpmWindowMs < 1000) throw invalidSettings('tpmWindowMs must be >= 1000');
  if (tpmPaceLimit < 1000) throw invalidSettings('tpmPaceLimit must be >= 1000');
  if (tpmReserveTtlMs < 1000) throw invalidSettings('tpmReserveTtlMs must be >= 1000');
  if (migrationMaxInputTokens < 1024) throw invalidSettings('migrationMaxInputTokens must be >= 1024');
  if (internalErrorRetryLimit < 1) throw invalidSettings('internalErrorRetryLimit must be >= 1');

  return {
    tpmStrategy,
    tpmLimit,
    tpmThresholdRatio,
    tpmWindowMs,
    tpmPaceLimit,
    tpmPaceMaxWaitMs,
    tpmPaceDelayMs,
    tpmReserveTtlMs,
    migrationMaxInputTokens,
    internalErrorRetryLimit,
    hashIgnorePrefixes,
    gatewayModels
  };
}

function resolveGatewaySettings(database) {
  const stored = database && typeof database.getGatewaySettingsMap === 'function'
    ? (database.getGatewaySettingsMap() || {})
    : {};
  return clampGatewaySettings(stored, envGatewaySettings());
}

module.exports = {
  DEFAULT_GATEWAY_SETTINGS,
  envGatewaySettings,
  clampGatewaySettings,
  resolveGatewaySettings,
  parsePrefixList,
  parseModelCatalog,
  parseStrategy
};
