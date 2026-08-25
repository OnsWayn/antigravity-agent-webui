const { sha256 } = require('./crypto');

const rpmHits = new Map();

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return '';
}

function checkRpm(tokenId, rpm) {
  if (!rpm || rpm <= 0) return true;
  const now = Date.now();
  const recent = (rpmHits.get(tokenId) || []).filter((stamp) => now - stamp < 60000);
  if (recent.length >= rpm) {
    rpmHits.set(tokenId, recent);
    return false;
  }
  recent.push(now);
  rpmHits.set(tokenId, recent);
  return true;
}

function authenticateClient(req, database) {
  const token = extractBearerToken(req);
  if (!token || !token.startsWith('ag-')) {
    return { ok: false, status: 401, code: 'invalid_api_key', message: 'Missing or invalid API token. Use Authorization: Bearer ag-...' };
  }
  const row = database.getClientTokenByHash(sha256(token));
  if (!row) {
    return { ok: false, status: 401, code: 'invalid_api_key', message: 'Invalid API token' };
  }
  if (!row.enabled) {
    return { ok: false, status: 403, code: 'token_disabled', message: 'API token is disabled' };
  }
  if (row.expires_at && Number(row.expires_at) > 0 && Number(row.expires_at) < Date.now()) {
    return { ok: false, status: 403, code: 'token_expired', message: 'API token has expired' };
  }
  const quota = Number(row.quota_tokens);
  if (quota >= 0 && Number(row.used_tokens) >= quota) {
    return { ok: false, status: 429, code: 'insufficient_quota', message: 'Token quota exceeded', type: 'insufficient_quota' };
  }
  if (!checkRpm(row.id, Number(row.rpm))) {
    return { ok: false, status: 429, code: 'rate_limit_exceeded', message: 'Rate limit exceeded', type: 'rate_limit_error' };
  }
  return { ok: true, token: row };
}

function authenticateAdmin(req, adminToken) {
  if (!adminToken) {
    return { ok: false, status: 503, code: 'admin_not_configured', message: 'GATEWAY_ADMIN_TOKEN is not configured' };
  }
  const provided = extractBearerToken(req)
    || String(req.headers['x-gateway-admin-token'] || req.headers['x-admin-token'] || '').trim();
  if (!provided || provided !== adminToken) {
    return { ok: false, status: 401, code: 'invalid_admin_token', message: 'Invalid admin token' };
  }
  return { ok: true };
}

module.exports = {
  extractBearerToken,
  authenticateClient,
  authenticateAdmin,
  checkRpm
};
