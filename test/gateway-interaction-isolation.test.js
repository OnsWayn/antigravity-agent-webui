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
const { createSessionLockManager } = require('../gateway/lock');
const { createGatewayLogger, sanitizeValue } = require('../gateway/logger');
const {
  conversationKeyFrom,
  requireConversationKey,
  migrateConversationForKeyChange
} = require('../gateway/translate');

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

function withTestGateway(options = {}, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-isolation-test-'));
  const database = new AppDatabase(path.join(directory, 'test.db'));
  const masterKey = 'unit-master-key';
  const callUpstream = options.callUpstream || (async () => ({
    id: 'int-test-1',
    environment_id: 'env-test-1',
    status: 'completed',
    output_text: 'hello'
  }));

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(createGatewayRouter({
    database,
    masterKey,
    enabled: true,
    enforceSessionHeader: options.enforceSessionHeader || false,
    sessionQueueLimit: options.sessionQueueLimit || 3,
    callUpstream
  }));

  return listen(app).then(async (ctx) => {
    try {
      await callback({
        base: ctx.base,
        database,
        masterKey,
        directory
      });
    } finally {
      await new Promise((resolve) => ctx.server.close(resolve));
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('Session Isolation: Two QQ windows with identical messages get distinct conversationKeys and environments', async () => {
  const interactions = [];
  await withTestGateway({
    callUpstream: async ({ apiKey, payload }) => {
      const interactionIndex = interactions.length + 1;
      const result = {
        id: `int-${payload.environment || 'env'}-${interactionIndex}`,
        environment_id: payload.environment === 'remote' ? `env-created-${interactionIndex}` : payload.environment,
        status: 'completed',
        output_text: `response for turn ${interactionIndex}`
      };
      interactions.push({ payload, result });
      return result;
    }
  }, async ({ base, database, masterKey }) => {
    const encrypted = encryptSecret('gemini-shared-key', masterKey);
    database.insertUpstreamKey({
      name: 'key1',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      suffix: keySuffix('gemini-shared-key')
    });
    const client = generateClientToken();
    const clientRow = database.insertClientToken({
      name: 'qq-bot',
      tokenHash: client.tokenHash,
      tokenPrefix: client.tokenPrefix,
      quotaTokens: -1
    });

    const headersA = {
      Authorization: `Bearer ${client.token}`,
      'x-session-id': 'qq:private:10001'
    };
    const headersB = {
      Authorization: `Bearer ${client.token}`,
      'x-session-id': 'qq:private:10002'
    };

    // Both QQ windows send identical message "Hello"
    const reqA = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers: headersA,
      body: {
        model: 'gemini-3.5-flash-lite',
        messages: [{ role: 'user', content: 'Hello' }]
      }
    });
    assert.equal(reqA.status, 200);

    const reqB = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers: headersB,
      body: {
        model: 'gemini-3.5-flash-lite',
        messages: [{ role: 'user', content: 'Hello' }]
      }
    });
    assert.equal(reqB.status, 200);

    // Verify DB stored distinct rows
    const storedA = database.getGatewayConversation(clientRow.id, 'hdr:qq:private:10001');
    const storedB = database.getGatewayConversation(clientRow.id, 'hdr:qq:private:10002');
    assert.ok(storedA, 'Session A row exists');
    assert.ok(storedB, 'Session B row exists');
    assert.notEqual(storedA.environment_id, storedB.environment_id, 'Environments must be isolated');
    assert.notEqual(storedA.interaction_id, storedB.interaction_id, 'Interaction IDs must be isolated');
  });
});

test('Session Lock: Sequential execution of requests within the same session', async () => {
  const executionOrder = [];
  await withTestGateway({
    callUpstream: async ({ payload }) => {
      const tag = payload.input;
      executionOrder.push(`start:${tag}`);
      await new Promise((r) => setTimeout(r, 40));
      executionOrder.push(`end:${tag}`);
      return {
        id: `int-${tag}`,
        environment_id: 'env-1',
        status: 'completed',
        output_text: `done:${tag}`
      };
    }
  }, async ({ base, database, masterKey }) => {
    const encrypted = encryptSecret('gemini-key', masterKey);
    database.insertUpstreamKey({
      name: 'key1',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      suffix: keySuffix('gemini-key')
    });
    const client = generateClientToken();
    database.insertClientToken({
      name: 'client',
      tokenHash: client.tokenHash,
      tokenPrefix: client.tokenPrefix,
      quotaTokens: -1
    });

    const headers = {
      Authorization: `Bearer ${client.token}`,
      'x-session-id': 'qq:group:555666'
    };

    // Send two requests concurrently to the same session
    const p1 = request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'req1' }] }
    });
    const p2 = request(base, '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'req2' }] }
    });

    const [res1, res2] = await Promise.all([p1, p2]);
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);

    // Verify sequential execution (req1 ends before req2 starts)
    assert.deepEqual(executionOrder, [
      'start:req1',
      'end:req1',
      'start:req2',
      'end:req2'
    ]);
  });
});

test('Session Lock: Reject when queue limit exceeded', async () => {
  const lock = createSessionLockManager({ defaultTimeoutMs: 5000, defaultQueueLimit: 1 });
  const release1 = await lock.acquireLock('session-test', { requestId: 'req1' });

  let queued = false;
  const p2 = lock.acquireLock('session-test', { requestId: 'req2' }).then((rel) => {
    queued = true;
    return rel;
  });

  // Third request exceeds queueLimit of 1
  await assert.rejects(
    async () => {
      await lock.acquireLock('session-test', { requestId: 'req3' });
    },
    (err) => err.status === 429 && err.code === 'session_busy'
  );

  release1();
  const release2 = await p2;
  assert.equal(queued, true);
  release2();
});

test('Key Rotation Migration: Preserves function_result structure and tool context', () => {
  const conversation = {
    input: [
      {
        type: 'function_result',
        name: 'meshy_image_fetch',
        call_id: 'call_491550',
        result: [{ type: 'text', text: '{"status":"SUCCEEDED","model_url":"http://..."}' }]
      }
    ],
    environment: 'env_old_6ec62',
    previousInteractionId: 'int_old_123',
    mode: 'continue',
    upstreamKeyId: 'uk_1',
    conversationKey: 'hdr:qq:private:123456'
  };

  const source = {
    stored: {
      interaction_id: 'int_old_123',
      environment_id: 'env_old_6ec62',
      transcript_json: JSON.stringify([
        { role: 'user', text: 'Generate a 3D chair' },
        { role: 'assistant', text: 'Starting Meshy generation...' }
      ])
    }
  };

  const migrated = migrateConversationForKeyChange(conversation, source);
  assert.equal(migrated.mode, 'migrate');
  assert.equal(migrated.environment, 'remote');
  assert.equal(migrated.previousInteractionId, undefined);

  // Verify function_result structure is preserved in input array
  assert.ok(Array.isArray(migrated.input));
  const functionResultItem = migrated.input.find((part) => part && part.type === 'function_result');
  assert.ok(functionResultItem, 'Must contain structured function_result');
  assert.equal(functionResultItem.name, 'meshy_image_fetch');
  assert.equal(functionResultItem.call_id, 'call_491550');

  // Verify task recovery context is included
  const recoveryText = migrated.input.find((part) => part && part.type === 'text' && part.text.includes('task continuation'));
  assert.ok(recoveryText, 'Must include task continuation explanation');
  assert.ok(recoveryText.text.includes('call_491550'));
});

test('Database: context_version increments on updates and tracks created_at', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-db-test-'));
  const database = new AppDatabase(path.join(directory, 'test.db'));

  try {
    const key = 'hdr:test:session';
    const tokenId = 'tok_1';

    database.upsertGatewayConversation({
      tokenId,
      conversationKey: key,
      interactionId: 'int_1',
      environmentId: 'env_1',
      prefixHash: 'hash_1',
      model: 'model_1',
      upstreamKeyId: 'key_1',
      transcript: []
    });

    const row1 = database.getGatewayConversation(tokenId, key);
    assert.equal(row1.context_version, 1);
    assert.ok(row1.created_at > 0);
    const firstCreatedAt = row1.created_at;

    database.upsertGatewayConversation({
      tokenId,
      conversationKey: key,
      interactionId: 'int_2',
      environmentId: 'env_1',
      prefixHash: 'hash_2',
      model: 'model_1',
      upstreamKeyId: 'key_1',
      transcript: []
    });

    const row2 = database.getGatewayConversation(tokenId, key);
    assert.equal(row2.context_version, 2);
    assert.equal(row2.created_at, firstCreatedAt, 'created_at must be preserved on update');
    assert.equal(row2.interaction_id, 'int_2');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Sanitization: sensitive keys, base64 images and system instructions are redacted', () => {
  const raw = {
    apiKey: 'AIzaSySecretApiKey1234567890',
    authorization: 'Bearer secret_token',
    system_instruction: 'You are a super secret system prompt with 100 rules',
    image: {
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='.repeat(5)
    },
    normalField: 'hello world'
  };

  const sanitized = sanitizeValue(raw);
  assert.equal(sanitized.apiKey, '[REDACTED]');
  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.match(sanitized.system_instruction, /<system_instruction len=\d+ hash=[a-f0-9]+>/);
  assert.match(sanitized.image.data, /<omitted base64 len=\d+ sha256=[a-f0-9]+>/);
  assert.equal(sanitized.normalField, 'hello world');
});

test('Enforce Session Header: rejects requests without x-session-id when enabled', async () => {
  await withTestGateway({ enforceSessionHeader: true }, async ({ base, database, masterKey }) => {
    const encrypted = encryptSecret('gemini-key', masterKey);
    database.insertUpstreamKey({
      name: 'key1',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      suffix: keySuffix('gemini-key')
    });
    const client = generateClientToken();
    database.insertClientToken({
      name: 'client',
      tokenHash: client.tokenHash,
      tokenPrefix: client.tokenPrefix,
      quotaTokens: -1
    });

    const res = await request(base, '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${client.token}` },
      body: {
        model: 'gemini-3.5-flash-lite',
        messages: [{ role: 'user', content: 'hello' }]
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'missing_session_id');
  });
});
