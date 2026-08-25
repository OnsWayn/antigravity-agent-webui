const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const express = require('express');
const { AppDatabase } = require('../database');
const { encryptSecret, generateClientToken, keySuffix } = require('../gateway/crypto');
const { createGatewayRouter } = require('../gateway/routes');
const { createAdminRouter } = require('../gateway/admin-routes');
const { createOriginGuard } = require('../http-security');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function request(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function withApp(callUpstream, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-gateway-'));
  const database = new AppDatabase(path.join(directory, 'test.db'));
  const masterKey = 'unit-master-key';
  const adminToken = 'unit-admin';
  const app = express();
  app.use(createOriginGuard({ port: 3999 }));
  app.use(express.json({ limit: '2mb' }));
  app.use(createGatewayRouter({
    database,
    masterKey,
    enabled: true,
    callUpstream
  }));
  app.use('/api/gateway', createAdminRouter({
    database,
    masterKey,
    adminToken,
    enabled: true
  }));
  return listen(app).then(async (ctx) => {
    try {
      await callback({ ...ctx, database, masterKey, adminToken });
    } finally {
      await new Promise((resolve) => ctx.server.close(resolve));
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('rejects unpermitted models and missing tokens', async () => {
  await withApp(async () => ({}), async ({ base, database }) => {
    const missing = await request(base, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(missing.status, 401);

    const generated = generateClientToken();
    database.insertClientToken({
      name: 'client',
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
      quotaTokens: -1,
      allowedModels: ['gemini-3.7-flash']
    });
    const unpermitted = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${generated.token}` },
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(unpermitted.status, 400);
    assert.match(unpermitted.json.error.message, /not permitted for this token/);
  });
});

test('chat completions, responses and gemini endpoints share Interactions payload', async () => {
  let captured = null;
  await withApp(async ({ payload }) => {
    captured = payload;
    return {
      id: 'int-live',
      status: 'completed',
      environment_id: 'env-live',
      output_text: 'pong',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'pong' }] }],
      usage: { total_input_tokens: 10, total_output_tokens: 1, total_tokens: 11 }
    };
  }, async ({ base, database, masterKey, adminToken }) => {
    const encrypted = encryptSecret('gemini-test-key', masterKey);
    database.insertUpstreamKey({
      name: 'test',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      suffix: keySuffix('gemini-test-key')
    });
    const generated = generateClientToken();
    database.insertClientToken({
      name: 'client',
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
      quotaTokens: -1
    });
    const headers = { Authorization: `Bearer ${generated.token}` };

    const chat = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: {
        model: 'gemini-3.5-flash-lite',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'ping' }
        ]
      }
    });
    assert.equal(chat.status, 200);
    assert.equal(chat.json.choices[0].message.content, 'pong');
    assert.equal(captured.agent, 'antigravity-preview-05-2026');
    assert.equal(captured.agent_config.model, 'gemini-3.5-flash-lite');
    assert.equal(captured.environment, 'remote');
    assert.equal(captured.input, 'ping');
    assert.equal(captured.system_instruction, 'be brief');

    const image = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: {
        model: 'gemini-3.7-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }
          ]
        }]
      }
    });
    assert.equal(image.status, 200);
    assert.equal(Array.isArray(captured.input), true);
    assert.equal(captured.input[1].type, 'image');

    const responses = await request(base, '/v1/responses', {
      method: 'POST',
      headers,
      body: { model: 'antigravity-preview-05-2026', input: 'ping' }
    });
    assert.equal(responses.status, 200);
    assert.equal(responses.json.output_text, 'pong');

    const gemini = await request(base, '/v1beta/models/antigravity-preview-05-2026/gemini-3.6-flash:generateContent', {
      method: 'POST',
      headers,
      body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }
    });
    assert.equal(gemini.status, 200);
    assert.equal(gemini.json.candidates[0].content.parts[0].text, 'pong');
    assert.equal(captured.agent, 'antigravity-preview-05-2026');
    assert.equal(captured.agent_config.model, 'gemini-3.6-flash');

    const models = await request(base, '/v1/models', { headers });
    assert.equal(models.status, 200);
    assert.equal(models.json.data.some((item) => item.id === 'antigravity-preview-05-2026'), true);
    assert.equal(models.json.data.some((item) => item.id === 'antigravity-preview-05-2026/gemini-3.7-flash'), true);
    assert.equal(models.json.data.some((item) => item.id === 'gemini-3.7-flash'), false);

    const admin = await request(base, '/api/gateway/usage', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(admin.status, 200);
    assert.ok(admin.json.logs.length >= 1);
  });
});

test('sticky key keeps environment; 429 x3 migrates context onto a new key and sandbox', async () => {
  const calls = [];
  await withApp(async ({ apiKey, payload }) => {
    calls.push({ apiKey, payload });
    if (apiKey === 'key-a') {
      const error = new Error('RESOURCE_EXHAUSTED');
      error.status = 429;
      error.code = 'RESOURCE_EXHAUSTED';
      throw error;
    }
    return {
      id: 'int-b',
      status: 'completed',
      environment_id: 'env-b',
      output_text: 'recovered',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'recovered' }] }],
      usage: { total_input_tokens: 20, total_output_tokens: 2, total_tokens: 22 }
    };
  }, async ({ base, database, masterKey }) => {
    const keyA = encryptSecret('key-a', masterKey);
    const keyB = encryptSecret('key-b', masterKey);
    database.insertUpstreamKey({
      name: 'A',
      ciphertext: keyA.ciphertext,
      iv: keyA.iv,
      tag: keyA.tag,
      suffix: 'keya'
    });
    database.insertUpstreamKey({
      name: 'B',
      ciphertext: keyB.ciphertext,
      iv: keyB.iv,
      tag: keyB.tag,
      suffix: 'keyb'
    });
    const generated = generateClientToken();
    database.insertClientToken({
      name: 'client',
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
      quotaTokens: -1
    });
    const headers = { Authorization: `Bearer ${generated.token}` };

    const first = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: {
        model: 'antigravity-preview-05-2026',
        messages: [
          { role: 'user', content: 'hello sandbox' },
          { role: 'assistant', content: 'I wrote /workspace/a.txt' },
          { role: 'user', content: 'keep going' }
        ]
      }
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.choices[0].message.content, 'recovered');
    assert.equal(calls.filter((item) => item.apiKey === 'key-a').length, 3);
    assert.equal(calls.some((item) => item.apiKey === 'key-b'), true);
    const migrated = calls.find((item) => item.apiKey === 'key-b').payload;
    assert.equal(migrated.environment, 'remote');
    assert.equal(migrated.previous_interaction_id, undefined);
    assert.match(JSON.stringify(migrated.input), /I wrote \/workspace\/a.txt/);
    assert.match(JSON.stringify(migrated.input), /keep going/);

    calls.length = 0;
    const second = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: {
        model: 'antigravity-preview-05-2026',
        messages: [
          { role: 'user', content: 'hello sandbox' },
          { role: 'assistant', content: 'I wrote /workspace/a.txt' },
          { role: 'user', content: 'keep going' },
          { role: 'assistant', content: 'recovered' },
          { role: 'user', content: 'and then' }
        ]
      }
    });
    assert.equal(second.status, 200);
    assert.equal(calls[0].apiKey, 'key-b');
    assert.equal(calls[0].payload.previous_interaction_id, 'int-b');
    assert.equal(calls[0].payload.environment, 'env-b');
  });
});

test('gateway paths skip origin rejection', async () => {
  await withApp(async () => ({}), async ({ base }) => {
    const blocked = await request(base, '/api/health', {
      headers: { Origin: 'https://evil.example' }
    });
    // /api/health is not registered on this test app, so 404 rather than 403.
    // Use a registered admin path instead.
    const admin = await request(base, '/api/gateway/status', {
      headers: { Origin: 'https://evil.example' }
    });
    assert.equal(admin.status, 403);

    const gateway = await request(base, '/v1/models', {
      headers: { Origin: 'https://openai-client.example' }
    });
    assert.equal(gateway.status, 401);
  });
});

test('gateway request logs are stored and queryable via admin API', async () => {
  await withApp(async ({ payload }) => {
    return {
      id: 'int-logged',
      status: 'completed',
      environment_id: 'env-logged',
      output_text: 'hello logged world',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hello logged world' }] }],
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 }
    };
  }, async ({ base, database, masterKey, adminToken }) => {
    const encrypted = encryptSecret('gemini-key', masterKey);
    database.insertUpstreamKey({
      name: 'KeyAlpha',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      suffix: 'KeyA'
    });

    const generated = generateClientToken();
    const token = database.insertClientToken({
      name: 'CursorToken',
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
      quotaTokens: -1,
      toolCodeExecution: 0,
      toolGoogleSearch: 1,
      toolUrlContext: 0
    });

    const headers = {
      Authorization: `Bearer ${generated.token}`,
      'x-session-id': 'test-log-session'
    };

    const res = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: {
        model: 'gemini-3.7-flash',
        messages: [{ role: 'user', content: 'test logs' }]
      }
    });
    assert.equal(res.status, 200);

    // Query admin logs API
    const logsRes = await request(base, '/api/gateway/logs', {
      headers: { 'x-admin-token': adminToken }
    });
    assert.equal(logsRes.status, 200);
    assert.equal(logsRes.json.success, true);
    assert.equal(logsRes.json.total, 1);
    const logItem = logsRes.json.logs[0];
    assert.equal(logItem.token_name, 'CursorToken');
    assert.equal(logItem.status, 'success');
    assert.equal(logItem.total_tokens, 20);

    // Query single log
    const singleRes = await request(base, `/api/gateway/logs/${logItem.request_id}`, {
      headers: { 'x-admin-token': adminToken }
    });
    assert.equal(singleRes.status, 200);
    assert.equal(singleRes.json.log.request_id, logItem.request_id);

    // Clear logs
    const deleteRes = await request(base, '/api/gateway/logs', {
      method: 'DELETE',
      headers: { 'x-admin-token': adminToken }
    });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.json.cleared, 1);
  });
});
