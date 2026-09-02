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
const { RequestCounter } = require('../gateway/upstream');

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
        Connection: 'close',
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
  const requestCounter = new RequestCounter();
  app.use(createOriginGuard({ port: 3999 }));
  app.use(express.json({ limit: '8mb' }));
  app.use(createGatewayRouter({
    database,
    masterKey,
    enabled: true,
    callUpstream,
    requestCounter
  }));
  app.use('/api/gateway', createAdminRouter({
    database,
    masterKey,
    adminToken,
    enabled: true,
    requestCounter
  }));
  return listen(app).then(async (ctx) => {
    try {
      await callback({ ...ctx, database, masterKey, adminToken });
    } finally {
      if (typeof ctx.server.closeAllConnections === 'function') ctx.server.closeAllConnections();
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
    assert.doesNotMatch(JSON.stringify(migrated.input), /\[Calls:/);

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

test('forked history does not overwrite the trunk conversation pointer', async () => {
  let interaction = 0;
  await withApp(async () => {
    interaction += 1;
    return {
      id: `int-${interaction}`,
      status: 'completed',
      environment_id: `env-${interaction}`,
      output_text: `out-${interaction}`,
      steps: [{ type: 'model_output', content: [{ type: 'text', text: `out-${interaction}` }] }],
      usage: { total_input_tokens: 10, total_output_tokens: 2, total_tokens: 12 }
    };
  }, async ({ base, database, masterKey }) => {
    const key = encryptSecret('key-a', masterKey);
    database.insertUpstreamKey({
      name: 'A',
      ciphertext: key.ciphertext,
      iv: key.iv,
      tag: key.tag,
      suffix: 'keya'
    });
    const generated = generateClientToken();
    database.insertClientToken({
      name: 'client',
      tokenHash: generated.tokenHash,
      tokenPrefix: generated.tokenPrefix,
      quotaTokens: -1
    });
    const headers = {
      Authorization: `Bearer ${generated.token}`,
      'x-session-id': 'stable-session'
    };

    const first = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: {
        model: 'antigravity-preview-05-2026',
        messages: [{ role: 'user', content: 'hello sandbox' }]
      }
    });
    assert.equal(first.status, 200);
    const tokenRow = database.listClientTokens()[0];
    const trunkBefore = database.getGatewayConversation(tokenRow.id, 'hdr:stable-session');
    assert.equal(trunkBefore.interaction_id, 'int-1');

    const forked = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: {
        model: 'antigravity-preview-05-2026',
        messages: [
          { role: 'user', content: 'unrelated summary of earlier chat' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'new question' }
        ]
      }
    });
    assert.equal(forked.status, 200);
    const trunkAfter = database.getGatewayConversation(tokenRow.id, 'hdr:stable-session');
    assert.equal(trunkAfter.interaction_id, trunkBefore.interaction_id);
    assert.equal(trunkAfter.environment_id, trunkBefore.environment_id);
    const branches = database.listGatewayConversationsForSource(tokenRow.id, 'hdr:stable-session')
      .filter((row) => row.conversation_key !== 'hdr:stable-session');
    assert.ok(branches.length >= 1);
    assert.equal(branches[0].interaction_id, 'int-2');
  });
});

test('admin settings expose and update TPM limits', async () => {
  await withApp(async () => ({
    id: 'int-x',
    status: 'completed',
    environment_id: 'env-x',
    output_text: 'ok',
    steps: [],
    usage: { total_tokens: 1 }
  }), async ({ base, adminToken, database }) => {
    const getRes = await request(base, '/api/gateway/settings', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json.settings.tpmLimit, 100000);
    assert.equal(getRes.json.settings.tpmStrategy, 'clone');
    assert.equal(getRes.json.settings.internalErrorRetryLimit, 2);
    assert.deepEqual(getRes.json.settings.hashIgnorePrefixes, ['<RAG-Faiss-Memory>']);

    const patchRes = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { tpmLimit: 8000, tpmThresholdRatio: 0.5, tpmWindowMs: 30000, migrationMaxInputTokens: 4096 }
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.json.settings.tpmLimit, 8000);
    assert.equal(database.getGatewaySettingsMap().tpmLimit, 8000);

    const statusRes = await request(base, '/api/gateway/status');
    assert.equal(statusRes.json.settings.tpmLimit, 8000);
  });
});

test('settings PATCH round-trips pace fields, TTL, and invalid strategy keeps the previous value', async () => {
  await withApp(async () => ({}), async ({ base, adminToken }) => {
    const patchRes = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        tpmStrategy: 'pace',
        tpmPaceLimit: 90000,
        tpmPaceMaxWaitMs: 15000,
        tpmPaceDelayMs: 1000,
        tpmReserveTtlMs: 12000,
        tpmWindowMs: 30000
      }
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.json.settings.tpmStrategy, 'pace');
    assert.equal(patchRes.json.settings.tpmPaceLimit, 90000);
    assert.equal(patchRes.json.settings.tpmPaceMaxWaitMs, 15000);
    assert.equal(patchRes.json.settings.tpmPaceDelayMs, 1000);
    assert.equal(patchRes.json.settings.tpmReserveTtlMs, 12000);

    const bad = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { tpmStrategy: 'nope' }
    });
    assert.equal(bad.status, 200);
    assert.equal(bad.json.settings.tpmStrategy, 'pace');
  });
});

function seedGatewayClient(database, masterKey, { keys = ['gemini-test-key'] } = {}) {
  const inserted = keys.map((secret, index) => database.insertUpstreamKey({
    name: `key-${index}`,
    ...encryptSecret(secret, masterKey),
    suffix: keySuffix(secret)
  }));
  const generated = generateClientToken();
  database.insertClientToken({
    name: 'client',
    tokenHash: generated.tokenHash,
    tokenPrefix: generated.tokenPrefix,
    quotaTokens: -1
  });
  return {
    keys: inserted,
    token: generated.token,
    headers: { Authorization: `Bearer ${generated.token}`, 'x-session-id': 'pace-session' }
  };
}

function jpegDataUrl({ width = 1920, height = 1080, dataUrlLength } = {}) {
  const prefix = 'data:image/jpeg;base64,';
  const sof = Buffer.from([
    0xFF, 0xD8,
    0xFF, 0xC0, 0x00, 0x0B, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xFF, 0xD9
  ]);
  if (!dataUrlLength) return prefix + sof.toString('base64');
  const b64Target = Math.max(0, dataUrlLength - prefix.length);
  const rawTarget = Math.floor(b64Target * 3 / 4);
  const pad = Math.max(0, rawTarget - sof.length);
  const buf = Buffer.concat([
    sof.subarray(0, sof.length - 2),
    Buffer.alloc(pad, 0x00),
    Buffer.from([0xFF, 0xD9])
  ]);
  let b64 = buf.toString('base64');
  if (prefix.length + b64.length > dataUrlLength) b64 = b64.slice(0, dataUrlLength - prefix.length);
  while (prefix.length + b64.length < dataUrlLength) b64 += 'A';
  return prefix + b64;
}

function parseDiagnostics(row) {
  try {
    const parsed = JSON.parse(row?.diagnostics_json || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

test('successful callUpstream increments rpmUsed and rpdUsed on GET /keys', async () => {
  let calls = 0;
  await withApp(async () => {
    calls += 1;
    return {
      id: `int-${calls}`,
      status: 'completed',
      environment_id: 'env-count',
      output_text: 'ok',
      steps: [],
      usage: { total_tokens: 11 }
    };
  }, async ({ base, database, masterKey, adminToken }) => {
    const { headers } = seedGatewayClient(database, masterKey);
    const first = { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }] };
    const second = {
      model: 'gemini-3.7-flash',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next' }
      ]
    };
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: first })).status, 200);
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: second })).status, 200);
    const keysRes = await request(base, '/api/gateway/keys', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(keysRes.status, 200);
    const key = keysRes.json.keys[0];
    assert.ok(key.rpmUsed >= 2);
    assert.ok(key.rpdUsed >= 2);
    assert.equal(typeof key.rpdResetAt, 'number');
    assert.match(String(key.rpdDay), /^\d{4}-\d{2}-\d{2}$/);
  });
});

test('abort during TPM pacing wait does not increment request counts', async () => {
  let calls = 0;
  await withApp(async () => {
    calls += 1;
    return {
      id: `int-wait-${calls}`,
      status: 'completed',
      environment_id: 'env-wait',
      output_text: 'ok',
      steps: [],
      usage: { total_tokens: 800 }
    };
  }, async ({ base, database, masterKey, adminToken }) => {
    const { headers } = seedGatewayClient(database, masterKey);
    const patched = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        tpmStrategy: 'pace',
        tpmPaceLimit: 1000,
        tpmWindowMs: 1000,
        tpmPaceMaxWaitMs: 1000,
        tpmPaceDelayMs: 0,
        tpmReserveTtlMs: 1000
      }
    });
    assert.equal(patched.status, 200);
    const first = { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'wait-me' }] };
    const second = {
      model: 'gemini-3.7-flash',
      messages: [
        { role: 'user', content: 'wait-me' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'wait-again' }
      ]
    };
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: first })).status, 200);
    assert.equal(calls, 1);

    await new Promise((resolve, reject) => {
      const url = new URL('/v1/chat/completions', base);
      const payload = Buffer.from(JSON.stringify(second));
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers
        }
      }, () => {});
      req.on('error', () => resolve());
      req.write(payload);
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 80);
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(calls, 1);

    const keysRes = await request(base, '/api/gateway/keys', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(keysRes.json.keys[0].rpdUsed, 1);
  });
});

test('pace waits when the next round cannot strictly fit, and froks when wait exceeds max', async () => {
  const timestamps = [];
  const payloads = [];
  await withApp(async ({ payload }) => {
    timestamps.push(Date.now());
    payloads.push(payload);
    return {
      id: `int-pace-${timestamps.length}`,
      status: 'completed',
      environment_id: `env-pace-${timestamps.length}`,
      output_text: 'ok',
      steps: [],
      usage: { total_tokens: 800 }
    };
  }, async ({ base, database, masterKey, adminToken }) => {
    const { headers } = seedGatewayClient(database, masterKey, { keys: ['secret-a', 'secret-b'] });
    const patched = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        tpmStrategy: 'pace',
        tpmPaceLimit: 1000,
        tpmWindowMs: 1000,
        tpmPaceMaxWaitMs: 2000,
        tpmPaceDelayMs: 0,
        tpmReserveTtlMs: 1000
      }
    });
    assert.equal(patched.status, 200);
    const first = { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'pace-hi' }] };
    const second = {
      model: 'gemini-3.7-flash',
      messages: [
        { role: 'user', content: 'pace-hi' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'pace-next' }
      ]
    };
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: first })).status, 200);
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: second })).status, 200);
    assert.ok(timestamps[1] - timestamps[0] >= 700);
    assert.equal(payloads[1].previous_interaction_id, 'int-pace-1');
  });
});

test('pace froks immediately when estimated wait exceeds maxWait', async () => {
  const payloads = [];
  await withApp(async ({ payload }) => {
    payloads.push(payload);
    return {
      id: `int-frok-${payloads.length}`,
      status: 'completed',
      environment_id: `env-frok-${payloads.length}`,
      output_text: 'ok',
      steps: [],
      usage: { total_tokens: 800 }
    };
  }, async ({ base, database, masterKey, adminToken }) => {
    const { headers } = seedGatewayClient(database, masterKey, { keys: ['secret-a', 'secret-b'] });
    const patched = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        tpmStrategy: 'pace',
        tpmPaceLimit: 1000,
        tpmWindowMs: 60000,
        tpmPaceMaxWaitMs: 0,
        tpmPaceDelayMs: 0,
        tpmReserveTtlMs: 60000
      }
    });
    assert.equal(patched.status, 200);
    const first = { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'frok-hi' }] };
    const second = {
      model: 'gemini-3.7-flash',
      messages: [
        { role: 'user', content: 'frok-hi' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'frok-next' }
      ]
    };
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: first })).status, 200);
    const started = Date.now();
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: second })).status, 200);
    assert.ok(Date.now() - started < 2000);
    assert.equal(payloads[1].previous_interaction_id, undefined);
    const { logs } = database.listGatewayRequestLogs({ limit: 5 });
    assert.equal(logs[0].upstream_transition, 'clone');
    const diag = parseDiagnostics(logs[0]);
    assert.equal(diag.tpmPacingDecision, 'clone_timeout');
  });
});

test('pace new request with a large inline image does not frok_oversize', async () => {
  const payloads = [];
  await withApp(async ({ payload }) => {
    payloads.push(payload);
    return {
      id: `int-img-${payloads.length}`,
      status: 'completed',
      environment_id: 'env-img',
      output_text: 'ok',
      steps: [],
      usage: { total_input_tokens: 9000, total_output_tokens: 200, total_tokens: 9200 }
    };
  }, async ({ base, database, masterKey, adminToken }) => {
    const { headers } = seedGatewayClient(database, masterKey);
    headers['x-session-id'] = 'img-new-session';
    const patched = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        tpmStrategy: 'pace',
        tpmPaceLimit: 100000,
        tpmWindowMs: 60000,
        tpmPaceMaxWaitMs: 20000,
        tpmPaceDelayMs: 0
      }
    });
    assert.equal(patched.status, 200);
    const url = jpegDataUrl({ width: 1920, height: 1080, dataUrlLength: 420000 });
    assert.ok(Math.ceil(url.length / 4) > 100000);
    const res = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: {
        model: 'gemini-3.7-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url } }
          ]
        }]
      }
    });
    assert.equal(res.status, 200);
    assert.equal(payloads[0].previous_interaction_id, undefined);
    const { logs } = database.listGatewayRequestLogs({ limit: 5 });
    const diag = parseDiagnostics(logs[0]);
    assert.notEqual(diag.tpmPacingDecision, 'clone_oversize');
    assert.notEqual(diag.tpmPacingDecision, 'frok_oversize');
    assert.notEqual(logs[0].upstream_transition, 'clone');
    assert.notEqual(logs[0].upstream_transition, 'frok');
    assert.ok(diag.neededTokens < 20000, `neededTokens=${diag.neededTokens}`);
    assert.ok(diag.estimatedImageCount >= 1);
    assert.equal(diag.neededSource, 'estimate');
  });
});

test('fork then continue uses logged usage for neededSource and does not frok_oversize', async () => {
  const payloads = [];
  await withApp(async ({ payload }) => {
    payloads.push(payload);
    return {
      id: `int-forkimg-${payloads.length}`,
      status: 'completed',
      environment_id: `env-forkimg-${payloads.length}`,
      output_text: 'ok',
      steps: [],
      usage: { total_input_tokens: 8800, total_output_tokens: 300, total_tokens: 9100 }
    };
  }, async ({ base, database, masterKey, adminToken }) => {
    const { headers } = seedGatewayClient(database, masterKey);
    headers['x-session-id'] = 'img-fork-session';
    await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { tpmStrategy: 'pace', tpmPaceLimit: 100000, tpmPaceDelayMs: 0 }
    });
    const url = jpegDataUrl({ width: 1920, height: 1080, dataUrlLength: 351763 });
    const imageContent = (text) => [
      { type: 'text', text },
      { type: 'image_url', image_url: { url } }
    ];
    assert.equal((await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: imageContent('hello') }] }
    })).status, 200);

    const forked = {
      model: 'gemini-3.7-flash',
      messages: [
        { role: 'user', content: imageContent('CHANGED') },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: imageContent('next') }
      ]
    };
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: forked })).status, 200);
    assert.equal(payloads[1].previous_interaction_id, undefined);
    const forkImages = Array.isArray(payloads[1].input)
      ? payloads[1].input.filter((part) => part && part.type === 'image').length
      : 0;
    assert.equal(forkImages, 1);

    const continued = {
      model: 'gemini-3.7-flash',
      messages: [
        { role: 'user', content: imageContent('CHANGED') },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: imageContent('next') },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: imageContent('again') }
      ]
    };
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: continued })).status, 200);

    const { logs } = database.listGatewayRequestLogs({ limit: 10 });
    const continueLog = logs.find((row) => row.conversation_mode === 'continue') || logs[0];
    const diag = parseDiagnostics(continueLog);
    assert.match(String(diag.neededSource || ''), /^log:/);
    assert.ok(diag.neededTokens < 100000, `neededTokens=${diag.neededTokens}`);
    assert.notEqual(diag.tpmPacingDecision, 'clone_oversize');
    assert.notEqual(diag.tpmPacingDecision, 'frok_oversize');
  });
});

test('stored frok strategy is normalized to clone on GET', async () => {
  await withApp(async () => ({}), async ({ base, adminToken, database }) => {
    database.setGatewaySettings({ tpmStrategy: 'frok' });
    const getRes = await request(base, '/api/gateway/settings', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json.settings.tpmStrategy, 'clone');
  });
});

test('PATCH hashIgnorePrefixes round-trips and rejects empty or oversized lists', async () => {
  await withApp(async () => ({}), async ({ base, adminToken }) => {
    const ok = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { hashIgnorePrefixes: '<RAG-Faiss-Memory>\n<system_reminder>' }
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.settings.hashIgnorePrefixes, ['<RAG-Faiss-Memory>', '<system_reminder>']);

    const empty = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { hashIgnorePrefixes: '' }
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'invalid_settings');

    const tooLong = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { hashIgnorePrefixes: ['x'.repeat(201)] }
    });
    assert.equal(tooLong.status, 400);

    const tooMany = await request(base, '/api/gateway/settings', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { hashIgnorePrefixes: Array.from({ length: 33 }, (_, i) => `p${i}`) }
    });
    assert.equal(tooMany.status, 400);
  });
});

test('consecutive Internal error trips a session circuit and returns HTTP 400', async () => {
  let calls = 0;
  await withApp(async () => {
    calls += 1;
    const error = new Error('Internal error encountered.');
    error.status = 500;
    error.code = 'api_error';
    throw error;
  }, async ({ base, database, masterKey }) => {
    const { headers } = seedGatewayClient(database, masterKey);
    headers['x-session-id'] = 'internal-session';
    const body = { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hello' }] };
    const first = await request(base, '/v1/chat/completions', { method: 'POST', headers, body });
    assert.equal(first.status, 400);
    assert.equal(first.json.error.code, 'INTERNAL');
    assert.equal(first.json.error.type, 'invalid_request_error');
    assert.match(first.json.error.message, /Internal error encountered/i);
    const second = await request(base, '/v1/chat/completions', { method: 'POST', headers, body });
    assert.equal(second.status, 400);
    const third = await request(base, '/v1/chat/completions', { method: 'POST', headers, body });
    assert.equal(third.status, 400);
    assert.equal(calls, 2);
    const { logs } = database.listGatewayRequestLogs({ limit: 10 });
    const circuitLog = logs.find((row) => parseDiagnostics(row).internalErrorCircuit) || logs[0];
    assert.equal(parseDiagnostics(circuitLog).internalErrorCircuit, true);
    assert.equal(circuitLog.error_code, 'INTERNAL');
  });
});

test('fork after Internal error clears the circuit', async () => {
  let calls = 0;
  await withApp(async () => {
    calls += 1;
    if (calls === 2 || calls === 3) {
      const error = new Error('Internal error encountered.');
      error.status = 500;
      error.code = 'INTERNAL';
      throw error;
    }
    return {
      id: `int-clear-${calls}`,
      status: 'completed',
      environment_id: 'env-clear',
      output_text: 'ok',
      steps: [],
      usage: { total_tokens: 11 }
    };
  }, async ({ base, database, masterKey }) => {
    const { headers } = seedGatewayClient(database, masterKey);
    headers['x-session-id'] = 'internal-fork-session';
    const first = { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hello' }] };
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: first })).status, 200);
    const continued = {
      model: 'gemini-3.7-flash',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next' }
      ]
    };
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: continued })).status, 400);
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: continued })).status, 400);
    assert.equal((await request(base, '/v1/chat/completions', { method: 'POST', headers, body: continued })).status, 400);
    assert.equal(calls, 3);
    const forked = {
      model: 'gemini-3.7-flash',
      messages: [
        { role: 'user', content: 'CHANGED' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'new question' }
      ]
    };
    const res = await request(base, '/v1/chat/completions', { method: 'POST', headers, body: forked });
    assert.equal(res.status, 200);
    assert.equal(calls, 4);
  });
});

test('429 still rotates keys and is not treated as Internal error', async () => {
  let calls = 0;
  await withApp(async () => {
    calls += 1;
    if (calls <= 3) {
      const error = new Error('Resource exhausted');
      error.status = 429;
      error.code = 'RESOURCE_EXHAUSTED';
      throw error;
    }
    return {
      id: `int-429-${calls}`,
      status: 'completed',
      environment_id: 'env-429',
      output_text: 'ok',
      steps: [],
      usage: { total_tokens: 11 }
    };
  }, async ({ base, database, masterKey }) => {
    const { headers } = seedGatewayClient(database, masterKey, { keys: ['secret-a', 'secret-b'] });
    headers['x-session-id'] = 'rate-session';
    const res = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }] }
    });
    assert.equal(res.status, 200);
    assert.ok(calls >= 4);
  });
});

test('hash ignore diagnostics record hits and keep continue for RAG injection', async () => {
  const payloads = [];
  await withApp(async ({ payload }) => {
    payloads.push(payload);
    return {
      id: `int-rag-${payloads.length}`,
      status: 'completed',
      environment_id: `env-rag-${payloads.length}`,
      output_text: 'ok',
      steps: [],
      usage: { total_tokens: 20 }
    };
  }, async ({ base, database, masterKey }) => {
    const { headers } = seedGatewayClient(database, masterKey);
    headers['x-session-id'] = 'rag-session';
    const rag = '<RAG-Faiss-Memory>\n--- BEGIN HISTORICAL MEMORY REFERENCE ---\nstuff';
    const first = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: `hello\n${rag}` }] }
    });
    assert.equal(first.status, 200);
    const second = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: {
        model: 'gemini-3.7-flash',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: `next\n${rag}` }
        ]
      }
    });
    assert.equal(second.status, 200);
    assert.equal(payloads[1].previous_interaction_id, 'int-rag-1');
    assert.match(String(payloads[1].input), /RAG-Faiss-Memory/);
    const { logs } = database.listGatewayRequestLogs({ limit: 5 });
    const continueLog = logs.find((row) => row.conversation_mode === 'continue');
    assert.ok(continueLog);
    const diag = parseDiagnostics(continueLog);
    assert.equal(diag.hashIgnoreApplied, true);
    assert.ok(Array.isArray(diag.hashIgnoreHits) && diag.hashIgnoreHits.includes('<RAG-Faiss-Memory>'));
  });
});

test('abort during a hung upstream call marks the log client_disconnected', async () => {
  await withApp(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      id: 'int-hang',
      status: 'completed',
      environment_id: 'env-hang',
      output_text: 'late',
      steps: [],
      usage: { total_tokens: 1 }
    };
  }, async ({ base, database, masterKey }) => {
    const { headers } = seedGatewayClient(database, masterKey);
    headers['x-session-id'] = 'hang-session';
    await new Promise((resolve) => {
      const url = new URL('/v1/chat/completions', base);
      const payload = Buffer.from(JSON.stringify({
        model: 'gemini-3.7-flash',
        messages: [{ role: 'user', content: 'hang' }]
      }));
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers
        }
      }, () => {});
      req.on('error', () => resolve());
      req.write(payload);
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 80);
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { logs } = database.listGatewayRequestLogs({ limit: 5 });
    assert.ok(logs.length >= 1);
    assert.notEqual(logs[0].status, 'pending');
    assert.equal(logs[0].error_code, 'client_disconnected');
  });
});
