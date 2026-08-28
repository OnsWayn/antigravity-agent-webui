const express = require('express');
const { authenticateAdmin } = require('./auth');
const { encryptSecret, generateClientToken, keySuffix } = require('./crypto');
const { sendJson } = require('./errors');
const { listGatewayModels } = require('./models');
const { publicUpstreamKey } = require('./routes');
const { resolveGatewaySettings, clampGatewaySettings, envGatewaySettings } = require('./settings');

function publicToken(row) {
  let allowedModels = null;
  if (row.allowed_models) {
    try {
      allowedModels = typeof row.allowed_models === 'string' ? JSON.parse(row.allowed_models) : row.allowed_models;
    } catch {}
  }
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    quotaTokens: Number(row.quota_tokens),
    usedTokens: Number(row.used_tokens),
    rpm: row.rpm,
    enabled: Boolean(row.enabled),
    expiresAt: row.expires_at,
    allowedModels,
    defaultModel: row.default_model || null,
    toolCodeExecution: row.tool_code_execution !== 0,
    toolGoogleSearch: row.tool_google_search !== 0,
    toolUrlContext: row.tool_url_context !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const SETTINGS_PATCH_KEYS = [
  'tpmStrategy',
  'tpmLimit',
  'tpmThresholdRatio',
  'tpmWindowMs',
  'tpmPaceLimit',
  'tpmPaceMaxWaitMs',
  'tpmPaceDelayMs',
  'tpmReserveTtlMs',
  'migrationMaxInputTokens'
];

function createAdminRouter(options = {}) {
  const {
    database,
    masterKey,
    adminToken,
    enabled = process.env.GATEWAY_ENABLED !== 'false',
    requestCounter
  } = options;

  function mapUpstreamKey(row) {
    return publicUpstreamKey(row, { requestCounter });
  }

  const router = express.Router();

  function requireAdmin(req, res, next) {
    const auth = authenticateAdmin(req, adminToken);
    if (!auth.ok) {
      return sendJson(res, auth.status, { success: false, error: { code: auth.code, message: auth.message } });
    }
    return next();
  }

  router.get('/status', (req, res) => {
    sendJson(res, 200, {
      success: true,
      enabled,
      configured: Boolean(masterKey),
      adminConfigured: Boolean(adminToken),
      upstreamKeys: database.listUpstreamKeys().length,
      tokens: database.listClientTokens().length,
      models: listGatewayModels().map((model) => model.id),
      settings: resolveGatewaySettings(database)
    });
  });

  router.use(requireAdmin);

  router.get('/keys', (req, res) => {
    sendJson(res, 200, {
      success: true,
      keys: database.listUpstreamKeys().map(mapUpstreamKey)
    });
  });

  router.post('/keys', (req, res) => {
    if (!masterKey) {
      return sendJson(res, 503, { success: false, error: { code: 'gateway_not_configured', message: 'GATEWAY_MASTER_KEY is not configured' } });
    }
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!apiKey) {
      return sendJson(res, 400, { success: false, error: { code: 'missing_api_key', message: 'apiKey is required' } });
    }
    const encrypted = encryptSecret(apiKey, masterKey);
    const row = database.insertUpstreamKey({
      name: req.body?.name,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      suffix: keySuffix(apiKey),
      proxyUrl: req.body?.proxyUrl || null
    });
    sendJson(res, 201, { success: true, key: mapUpstreamKey(row) });
  });

  router.patch('/keys/:id', (req, res) => {
    if (!masterKey) {
      return sendJson(res, 503, { success: false, error: { code: 'gateway_not_configured', message: 'GATEWAY_MASTER_KEY is not configured' } });
    }
    const fields = {
      name: req.body?.name,
      proxyUrl: req.body?.proxyUrl,
      enabled: req.body?.enabled
    };
    if (req.body?.apiKey) {
      const encrypted = encryptSecret(String(req.body.apiKey).trim(), masterKey);
      fields.ciphertext = encrypted.ciphertext;
      fields.iv = encrypted.iv;
      fields.tag = encrypted.tag;
      fields.suffix = keySuffix(req.body.apiKey);
    }
    const row = database.updateUpstreamKey(req.params.id, fields);
    if (!row) return sendJson(res, 404, { success: false, error: { code: 'not_found', message: 'Upstream key not found' } });
    sendJson(res, 200, { success: true, key: mapUpstreamKey(row) });
  });

  router.delete('/keys/:id', (req, res) => {
    const deleted = database.deleteUpstreamKey(req.params.id);
    sendJson(res, deleted ? 200 : 404, {
      success: deleted,
      error: deleted ? undefined : { code: 'not_found', message: 'Upstream key not found' }
    });
  });

  router.get('/tokens', (req, res) => {
    sendJson(res, 200, {
      success: true,
      tokens: database.listClientTokens().map(publicToken)
    });
  });

  router.post('/tokens', (req, res) => {
    const generated = generateClientToken();
    const row = database.insertClientToken({
      name: req.body?.name,
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
      quotaTokens: req.body?.quotaTokens,
      rpm: req.body?.rpm,
      expiresAt: req.body?.expiresAt,
      allowedModels: req.body?.allowedModels,
      defaultModel: req.body?.defaultModel,
      toolCodeExecution: req.body?.toolCodeExecution !== undefined ? (req.body.toolCodeExecution ? 1 : 0) : 1,
      toolGoogleSearch: req.body?.toolGoogleSearch !== undefined ? (req.body.toolGoogleSearch ? 1 : 0) : 1,
      toolUrlContext: req.body?.toolUrlContext !== undefined ? (req.body.toolUrlContext ? 1 : 0) : 1
    });
    sendJson(res, 201, {
      success: true,
      token: publicToken(row),
      secret: generated.token
    });
  });

  router.patch('/tokens/:id', (req, res) => {
    const row = database.updateClientToken(req.params.id, {
      name: req.body?.name,
      quotaTokens: req.body?.quotaTokens,
      rpm: req.body?.rpm,
      enabled: req.body?.enabled,
      expiresAt: req.body?.expiresAt,
      allowedModels: req.body?.allowedModels,
      defaultModel: req.body?.defaultModel,
      toolCodeExecution: req.body?.toolCodeExecution !== undefined ? (req.body.toolCodeExecution ? 1 : 0) : undefined,
      toolGoogleSearch: req.body?.toolGoogleSearch !== undefined ? (req.body.toolGoogleSearch ? 1 : 0) : undefined,
      toolUrlContext: req.body?.toolUrlContext !== undefined ? (req.body.toolUrlContext ? 1 : 0) : undefined
    });
    if (!row) return sendJson(res, 404, { success: false, error: { code: 'not_found', message: 'Token not found' } });
    sendJson(res, 200, { success: true, token: publicToken(row) });
  });

  router.delete('/tokens/:id', (req, res) => {
    const deleted = database.deleteClientToken(req.params.id);
    sendJson(res, deleted ? 200 : 404, {
      success: deleted,
      error: deleted ? undefined : { code: 'not_found', message: 'Token not found' }
    });
  });

  router.get('/usage', (req, res) => {
    const logs = database.listUsageLogs({
      tokenId: req.query.tokenId,
      limit: Number(req.query.limit || 100)
    });
    sendJson(res, 200, { success: true, logs });
  });

  router.get('/logs', (req, res) => {
    const result = database.listGatewayRequestLogs({
      limit: req.query.limit,
      offset: req.query.offset,
      status: req.query.status,
      tokenId: req.query.tokenId,
      conversationKey: req.query.conversationKey,
      startTime: req.query.startTime,
      endTime: req.query.endTime,
      search: req.query.search
    });
    sendJson(res, 200, { success: true, ...result });
  });

  router.get('/logs/:requestId', (req, res) => {
    const log = database.getGatewayRequestLog(req.params.requestId);
    if (!log) {
      return sendJson(res, 404, { success: false, error: { code: 'not_found', message: 'Log not found' } });
    }
    sendJson(res, 200, { success: true, log });
  });

  router.delete('/logs', (req, res) => {
    const count = database.clearGatewayRequestLogs();
    sendJson(res, 200, { success: true, cleared: count });
  });

  router.get('/settings', (req, res) => {
    sendJson(res, 200, {
      success: true,
      settings: resolveGatewaySettings(database),
      defaults: envGatewaySettings()
    });
  });

  router.patch('/settings', (req, res) => {
    try {
      const current = resolveGatewaySettings(database);
      const patch = {};
      for (const key of SETTINGS_PATCH_KEYS) {
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
          patch[key] = req.body[key];
        }
      }
      const next = clampGatewaySettings(patch, current);
      database.setGatewaySettings(next);
      sendJson(res, 200, { success: true, settings: resolveGatewaySettings(database) });
    } catch (error) {
      sendJson(res, error.status || 400, {
        success: false,
        error: { code: error.code || 'invalid_settings', message: error.message }
      });
    }
  });

  return router;
}

module.exports = {
  createAdminRouter,
  publicToken
};
