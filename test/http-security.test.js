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
  guard({ method: 'GET', headers: { origin: 'https://evil.example' } }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error.code, 'ORIGIN_NOT_ALLOWED');
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
