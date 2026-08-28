const DEFAULT_GATEWAY_SETTINGS = {
  tpmStrategy: 'frok',
  tpmLimit: 100000,
  tpmThresholdRatio: 0.8,
  tpmWindowMs: 60000,
  tpmPaceLimit: 100000,
  tpmPaceMaxWaitMs: 20000,
  tpmPaceDelayMs: 5000,
  migrationMaxInputTokens: 24000
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
  if (raw === 'frok' || raw === 'pace') return raw;
  return fallback === 'pace' || fallback === 'frok' ? fallback : 'frok';
}

function invalidSettings(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'invalid_settings';
  return error;
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

  if (tpmLimit < 1000) throw invalidSettings('tpmLimit must be >= 1000');
  if (tpmThresholdRatio < 0.1 || tpmThresholdRatio > 1) throw invalidSettings('tpmThresholdRatio must be between 0.1 and 1');
  if (tpmWindowMs < 1000) throw invalidSettings('tpmWindowMs must be >= 1000');
  if (tpmPaceLimit < 1000) throw invalidSettings('tpmPaceLimit must be >= 1000');
  if (tpmReserveTtlMs < 1000) throw invalidSettings('tpmReserveTtlMs must be >= 1000');
  if (migrationMaxInputTokens < 1024) throw invalidSettings('migrationMaxInputTokens must be >= 1024');

  return {
    tpmStrategy,
    tpmLimit,
    tpmThresholdRatio,
    tpmWindowMs,
    tpmPaceLimit,
    tpmPaceMaxWaitMs,
    tpmPaceDelayMs,
    tpmReserveTtlMs,
    migrationMaxInputTokens
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
  resolveGatewaySettings
};
