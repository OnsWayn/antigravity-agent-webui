function normalizeOrigin(value) {
  if (!value) return '';
  try {
    return new URL(String(value).trim()).origin;
  } catch {
    return '';
  }
}

function buildAllowedOrigins(port, configuredOrigins = '') {
  const origins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`
  ]);

  for (const value of String(configuredOrigins || '').split(',')) {
    const origin = normalizeOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

function isGatewayPath(url) {
  const path = String(url || '').split('?')[0];
  return path === '/v1' || path === '/v1beta' || path.startsWith('/v1/') || path.startsWith('/v1beta/');
}

const GATEWAY_ALLOW_HEADERS = [
  'Content-Type',
  'Authorization',
  'x-api-key',
  'x-goog-api-key',
  'x-session-id',
  'x-ag-session-id',
  'x-ag-stateless',
  'x-ag-reuse-environment',
  'x-ag-antigravity-tools'
].join(',');

function createOriginGuard(options = {}) {
  const port = Number(options.port || 3000);
  const allowedOrigins = buildAllowedOrigins(port, options.allowedOrigins);

  return function originGuard(req, res, next) {
    const requestPath = req.originalUrl || req.url || '';
    if (isGatewayPath(requestPath)) {
      const origin = normalizeOrigin(req.headers.origin);
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', GATEWAY_ALLOW_HEADERS);
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    }

    const origin = normalizeOrigin(req.headers.origin);
    if (!origin) return next();

    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
    const sameHostOrigin = host ? normalizeOrigin(`${proto}://${host}`) : '';
    if (!allowedOrigins.has(origin) && origin !== sameHostOrigin) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ORIGIN_NOT_ALLOWED',
          message: '该网页来源没有访问本地 Antigravity 服务的权限'
        }
      });
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-goog-api-key,Authorization,x-gateway-admin-token');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

module.exports = {
  buildAllowedOrigins,
  createOriginGuard,
  isGatewayPath,
  normalizeOrigin
};
