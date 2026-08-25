const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { AppDatabase } = require('../database');

function withDatabase(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-db-'));
  const database = new AppDatabase(path.join(directory, 'test.db'));
  try {
    callback(database);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('stores sessions, turns and usage data', () => {
  withDatabase((database) => {
    database.saveInteraction({
      environmentId: 'env-123456',
      interactionId: 'interaction-1',
      prompt: 'hello',
      outputText: 'world',
      steps: [{ type: 'model_output' }],
      status: 'completed',
      model: 'gemini-test',
      usage: { total_tokens: 42 },
      timestamp: 1000
    });

    const sessions = database.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].envId, 'env-123456');
    assert.equal(sessions[0].turns.length, 1);
    assert.equal(sessions[0].turns[0].usage.total_tokens, 42);
    assert.deepEqual(sessions[0].turns[0].steps, [{ type: 'model_output' }]);
  });
});

test('imports legacy localStorage sessions without duplicating turns', () => {
  withDatabase((database) => {
    const legacy = [{
      id: 'env-legacy',
      envId: 'env-legacy',
      name: '旧会话',
      updatedAt: 2000,
      turns: [{ interactionId: 'old-turn', prompt: '旧问题', outputText: '旧回答', timestamp: 2000 }]
    }];

    database.importLegacySessions(legacy);
    database.importLegacySessions(legacy);
    const sessions = database.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].turns.length, 1);
    assert.equal(sessions[0].name, '旧会话');
  });
});

test('stores encrypted-looking upstream keys and hashed client tokens', () => {
  withDatabase((database) => {
    database.insertUpstreamKey({
      name: 'prod',
      ciphertext: 'cipher',
      iv: 'iv',
      tag: 'tag',
      suffix: 'Ab12'
    });
    const keys = database.listUpstreamKeys();
    assert.equal(keys.length, 1);
    assert.equal(keys[0].key_suffix, 'Ab12');
    assert.equal(JSON.stringify(keys).includes('AIza'), false);

    const token = database.insertClientToken({
      name: 'ui',
      tokenHash: 'abc',
      tokenPrefix: 'ag-123456',
      quotaTokens: 100
    });
    database.addClientTokenUsage(token.id, 12);
    const loaded = database.getClientToken(token.id);
    assert.equal(loaded.used_tokens, 12);
    assert.equal(loaded.quota_tokens, 100);
  });
});

test('deleting a session cascades to its turns', () => {
  withDatabase((database) => {
    const saved = database.saveInteraction({
      environmentId: 'env-delete',
      interactionId: 'turn-delete',
      prompt: 'p',
      outputText: 'o'
    });
    assert.equal(database.deleteSession(saved.sessionId), true);
    assert.deepEqual(database.stats(), { environments: 1, sessions: 0, interactions: 0, artifacts: 0, errors: 0 });
  });
});

test('tracks artifact metadata without losing the latest turn', () => {
  withDatabase((database) => {
    database.saveInteraction({
      environmentId: 'env-artifact',
      interactionId: 'turn-artifact',
      prompt: '生成报告',
      outputText: '/workspace/report.pdf',
      timestamp: 3000
    });
    database.recordArtifact({
      environmentId: 'env-artifact',
      interactionId: 'turn-artifact',
      filePath: '/workspace/report.pdf',
      filename: 'report.pdf',
      provider: 'chunked',
      sizeBytes: 1024
    });

    const session = database.listSessions()[0];
    assert.equal(session.lastInteractionId, 'turn-artifact');
    assert.equal(session.lastOutput, '/workspace/report.pdf');
    assert.equal(database.stats().artifacts, 1);
  });
});

test('keeps independent conversations in the same environment', () => {
  withDatabase((database) => {
    const first = database.saveInteraction({
      environmentId: 'env-shared',
      interactionId: 'turn-a',
      prompt: 'A',
      outputText: 'answer A',
      timestamp: 1000
    });
    const second = database.saveInteraction({
      environmentId: 'env-shared',
      interactionId: 'turn-b',
      prompt: 'B',
      outputText: 'answer B',
      timestamp: 2000
    });

    assert.notEqual(first.sessionId, second.sessionId);
    const sessions = database.listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(new Set(sessions.map(session => session.envId)).size, 1);
    assert.deepEqual(sessions.map(session => session.turns.length), [1, 1]);
  });
});

test('resolves continuation session from previous interaction id', () => {
  withDatabase((database) => {
    const first = database.saveInteraction({
      environmentId: 'env-chain',
      interactionId: 'turn-1',
      prompt: 'first',
      outputText: 'one',
      timestamp: 1000
    });
    const second = database.saveInteraction({
      environmentId: 'env-chain',
      previousInteractionId: 'turn-1',
      interactionId: 'turn-2',
      prompt: 'second',
      outputText: 'two',
      timestamp: 2000
    });

    assert.equal(second.sessionId, first.sessionId);
    const sessions = database.listSessions();
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].turns.map(turn => turn.interactionId), ['turn-1', 'turn-2']);
  });
});

test('does not move a session when its id is reused with another environment', () => {
  withDatabase((database) => {
    const first = database.saveInteraction({
      environmentId: 'env-one',
      sessionId: 'fixed-session',
      interactionId: 'turn-one'
    });
    const second = database.saveInteraction({
      environmentId: 'env-two',
      sessionId: 'fixed-session',
      interactionId: 'turn-two'
    });

    assert.equal(first.sessionId, 'fixed-session');
    assert.notEqual(second.sessionId, 'fixed-session');
    const sessions = database.listSessions();
    assert.equal(sessions.find(session => session.id === 'fixed-session').envId, 'env-one');
    assert.equal(sessions.find(session => session.id === second.sessionId).envId, 'env-two');
  });
});

test('migrates schema v1 without losing sessions, turns, artifacts or errors', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-v1-migration-'));
  const databasePath = path.join(directory, 'v1.db');
  const oldDatabase = new DatabaseSync(databasePath);
  oldDatabase.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 1000);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_interaction_id TEXT, last_prompt TEXT, last_output TEXT, last_steps_json TEXT
    );
    CREATE TABLE interactions (
      interaction_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
      output_text TEXT NOT NULL DEFAULT '', steps_json TEXT, status TEXT, model TEXT,
      usage_json TEXT, request_json TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, interaction_id TEXT,
      file_path TEXT NOT NULL, filename TEXT NOT NULL, provider TEXT, size_bytes INTEGER,
      download_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(session_id, file_path)
    );
    CREATE TABLE task_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, previous_interaction_id TEXT,
      code TEXT, http_status INTEGER, message TEXT NOT NULL, request_json TEXT,
      error_json TEXT, created_at INTEGER NOT NULL
    );
    INSERT INTO sessions VALUES ('legacy-session', 'legacy-env', '旧会话', 1000, 3000, 'legacy-2', 'p2', 'o2', '[]');
    INSERT INTO interactions VALUES ('legacy-1', 'legacy-session', 'p1', 'o1', '[]', 'completed', 'm', '{"total_tokens":1}', '{}', 1000);
    INSERT INTO interactions VALUES ('legacy-2', 'legacy-session', 'p2', 'o2', '[]', 'completed', 'm', '{"total_tokens":2}', '{}', 3000);
    INSERT INTO artifacts(session_id, interaction_id, file_path, filename, provider, size_bytes, created_at, updated_at)
      VALUES ('legacy-session', 'legacy-2', '/workspace/a.svg', 'a.svg', 'snapshot', 10, 3000, 3000);
    INSERT INTO task_errors(session_id, previous_interaction_id, code, http_status, message, created_at)
      VALUES ('legacy-session', 'legacy-1', 'OLD_ERROR', 500, 'old failure', 2000);
  `);
  oldDatabase.close();

  const database = new AppDatabase(databasePath);
  try {
    const sessions = database.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'legacy-session');
    assert.equal(sessions[0].envId, 'legacy-env');
    assert.deepEqual(sessions[0].turns.map(turn => turn.interactionId), ['legacy-1', 'legacy-2']);
    assert.deepEqual(database.stats(), { environments: 1, sessions: 1, interactions: 2, artifacts: 1, errors: 1 });
    assert.equal(database.db.prepare('SELECT environment_id FROM artifacts').get().environment_id, 'legacy-env');
    assert.equal(database.db.prepare('SELECT environment_id FROM task_errors').get().environment_id, 'legacy-env');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Schema V5: manages gateway_request_logs with CRUD, filtering, and auto-cleanup', () => {
  withDatabase((database) => {
    const entry1 = database.insertGatewayRequestLog({
      requestId: 'req_1',
      tokenId: 'tk-1',
      tokenName: 'Client 1',
      endpoint: '/v1/chat/completions',
      protocol: 'openai',
      downstreamRequestJson: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hello' }] },
      upstreamRequestJson: { agent: 'antigravity-preview-05-2026' },
      conversationKey: 'hdr:qq-1',
      conversationMode: 'new',
      model: 'gemini-3.7-flash',
      backendModel: 'gemini-3.7-flash',
      status: 'pending',
      createdAt: Date.now() - 10000
    });
    assert.equal(entry1.request_id, 'req_1');
    assert.equal(entry1.status, 'pending');

    const updated = database.updateGatewayRequestLog('req_1', {
      status: 'success',
      upstreamResponseStatus: 200,
      upstreamResponseJson: { output_text: 'hello response' },
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      durationMs: 1500
    });
    assert.equal(updated.status, 'success');
    assert.equal(updated.total_tokens, 30);

    database.insertGatewayRequestLog({
      requestId: 'req_2',
      tokenId: 'tk-2',
      tokenName: 'Client 2',
      endpoint: '/v1/chat/completions',
      protocol: 'openai',
      downstreamRequestJson: { model: 'gemini-3.6-flash' },
      conversationKey: 'hdr:qq-2',
      conversationMode: 'continue',
      model: 'gemini-3.6-flash',
      backendModel: 'gemini-3.6-flash',
      status: 'error',
      errorMessage: 'Rate limit',
      createdAt: Date.now()
    });

    const listAll = database.listGatewayRequestLogs({ limit: 10 });
    assert.equal(listAll.total, 2);
    assert.equal(listAll.logs.length, 2);

    const listFiltered = database.listGatewayRequestLogs({ status: 'error' });
    assert.equal(listFiltered.total, 1);
    assert.equal(listFiltered.logs[0].request_id, 'req_2');

    const listByToken = database.listGatewayRequestLogs({ tokenId: 'tk-1' });
    assert.equal(listByToken.total, 1);
    assert.equal(listByToken.logs[0].request_id, 'req_1');

    const listSearch = database.listGatewayRequestLogs({ search: 'Client 2' });
    assert.equal(listSearch.total, 1);
    assert.equal(listSearch.logs[0].request_id, 'req_2');

    // Test cleanup
    const oldTime = Date.now() - 6 * 86400 * 1000;
    database.insertGatewayRequestLog({
      requestId: 'req_old',
      status: 'success',
      createdAt: oldTime
    });
    assert.equal(database.listGatewayRequestLogs({ limit: 10 }).total, 3);
    database.cleanOldGatewayRequestLogs({ maxDays: 5 });
    assert.equal(database.listGatewayRequestLogs({ limit: 10 }).total, 2);

    assert.equal(database.clearGatewayRequestLogs(), 2);
    assert.equal(database.listGatewayRequestLogs({ limit: 10 }).total, 0);
  });
});

test('Schema V5: client_tokens fine control columns and updates', () => {
  withDatabase((database) => {
    const token = database.insertClientToken({
      name: 'Controlled Token',
      tokenHash: 'hash-ctrl',
      tokenPrefix: 'ag-ctrl',
      quotaTokens: 5000,
      allowedModels: ['gemini-3.7-flash', 'gemini-3.6-flash'],
      defaultModel: 'gemini-3.6-flash',
      toolCodeExecution: 1,
      toolGoogleSearch: 0,
      toolUrlContext: 1
    });

    assert.equal(token.name, 'Controlled Token');
    assert.equal(token.default_model, 'gemini-3.6-flash');
    assert.deepEqual(JSON.parse(token.allowed_models), ['gemini-3.7-flash', 'gemini-3.6-flash']);
    assert.equal(token.tool_code_execution, 1);
    assert.equal(token.tool_google_search, 0);
    assert.equal(token.tool_url_context, 1);

    const updated = database.updateClientToken(token.id, {
      toolGoogleSearch: 1,
      toolUrlContext: 0,
      allowedModels: ['gemini-3.7-flash']
    });

    assert.equal(updated.tool_google_search, 1);
    assert.equal(updated.tool_url_context, 0);
    assert.deepEqual(JSON.parse(updated.allowed_models), ['gemini-3.7-flash']);
  });
});
