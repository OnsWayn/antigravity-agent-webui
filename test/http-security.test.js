const assert = require('node:assert/strict');
const test = require('node:test');
const { buildAllowedOrigins, createOriginGuard, normalizeOrigin } = require('../http-security');

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    ended: false,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; }
  };
}

test('allows only local origins by default', () => {
  const origins = buildAllowedOrigins(3100);
  assert.equal(origins.has('http://localhost:3100'), true);
  assert.equal(origins.has('http://127.0.0.1:3100'), true);
  assert.equal(origins.has('https://example.com'), false);
});

test('normalizes explicitly configured origins', () => {
  const origins = buildAllowedOrigins(3000, 'https://example.com/path, invalid, http://dev.local:5173/');
  assert.equal(origins.has('https://example.com'), true);
  assert.equal(origins.has('http://dev.local:5173'), true);
  assert.equal(normalizeOrigin('not a url'), '');
});

test('rejects an untrusted browser origin', () => {
  const guard = createOriginGuard({ port: 3000 });
  const response = createResponse();
  let calledNext = false;
  guard({ method: 'GET', headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error.code, 'ORIGIN_NOT_ALLOWED');
});

test('allows the LAN origin that matches the request Host', () => {
  const guard = createOriginGuard({ port: 3000 });
  const response = createResponse();
  let calledNext = false;
  guard({
    method: 'GET',
    headers: { origin: 'http://192.168.1.20:3000', host: '192.168.1.20:3000' }
  }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'http://192.168.1.20:3000');
});

test('gateway paths accept foreign browser origins and extra headers', () => {
  const { isGatewayPath, createOriginGuard } = require('../http-security');
  assert.equal(isGatewayPath('/v1/chat/completions'), true);
  assert.equal(isGatewayPath('/v1beta/models/gemini-3.7-flash:generateContent'), true);
  assert.equal(isGatewayPath('/api/sessions'), false);

  const guard = createOriginGuard({ port: 3000 });
  const response = createResponse();
  let calledNext = false;
  guard({ method: 'OPTIONS', originalUrl: '/v1/chat/completions', headers: { origin: 'https://chat.example' } }, response, () => { calledNext = true; });
  assert.equal(response.statusCode, 204);
  assert.equal(calledNext, false);
  assert.match(response.headers['Access-Control-Allow-Headers'], /Authorization/);
});

test('handles preflight for an allowed origin', () => {
  const guard = createOriginGuard({ port: 3000 });
  const response = createResponse();
  let calledNext = false;
  guard({ method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 204);
  assert.equal(response.ended, true);
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'http://localhost:3000');
});
