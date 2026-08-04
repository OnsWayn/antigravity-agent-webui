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

function createOriginGuard(options = {}) {
  const port = Number(options.port || 3000);
  const allowedOrigins = buildAllowedOrigins(port, options.allowedOrigins);

  return function originGuard(req, res, next) {
    const origin = normalizeOrigin(req.headers.origin);
    if (!origin) return next();

    if (!allowedOrigins.has(origin)) {
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-goog-api-key');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

module.exports = {
  buildAllowedOrigins,
  createOriginGuard,
  normalizeOrigin
};
