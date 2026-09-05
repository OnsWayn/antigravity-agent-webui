const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AppDatabase } = require('../database');
const { encryptSecret, keySuffix } = require('../gateway/crypto');
const {
  workspaceTarget,
  normalizeSources,
  applySandboxFiles,
  resolveSandboxCredentials,
  resolveSandboxProxy,
  resolveSandboxModel
} = require('../sandbox');

test('workspaceTarget always lands under /workspace and rejects traversal', () => {
  assert.equal(workspaceTarget('notes.txt'), '/workspace/notes.txt');
  assert.equal(workspaceTarget('/tmp/data.csv'), '/workspace/tmp/data.csv');
  assert.equal(workspaceTarget('/workspace/app/main.py'), '/workspace/app/main.py');
  assert.throws(() => workspaceTarget('../etc/passwd'), /不合法/);
});

test('normalizeSources decodes base64 binary files and utf8 text', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const files = normalizeSources([
    { target: 'readme.txt', content: 'hello sandbox', encoding: 'utf8' },
    { name: 'icon.png', content: png.toString('base64'), encoding: 'base64' }
  ]);
  assert.equal(files.length, 2);
  assert.equal(files[0].target, '/workspace/readme.txt');
  assert.equal(files[0].content, 'hello sandbox');
  assert.equal(files[0].binary, false);
  assert.equal(files[1].target, '/workspace/icon.png');
  assert.equal(files[1].binary, true);
  assert.equal(files[1].content, png.toString('latin1'));
});

test('applySandboxFiles injects sources on a new sandbox and prepends writes when reusing', () => {
  const created = applySandboxFiles(
    { agent: 'antigravity-preview-05-2026', input: 'summarize the csv', environment: 'remote' },
    { sources: [{ target: 'sales.csv', content: 'a,b\n1,2' }] }
  );
  assert.equal(created.environment.type, 'remote');
  assert.equal(created.environment.sources[0].target, '/workspace/sales.csv');
  assert.equal(created.environment.sources[0].content, 'a,b\n1,2');
  assert.equal(created.environment.sources[0].binary, undefined);

  const reused = applySandboxFiles(
    { input: 'continue', environment: 'env-abc' },
    { sources: [{ target: '/workspace/note.txt', content: 'keep this' }] }
  );
  assert.equal(reused.environment, 'env-abc');
  assert.match(reused.input, /\/workspace\/note.txt/);
  assert.match(reused.input, /keep this/);
  assert.match(reused.input, /continue$/);
});

test('sessions remember the web-selected upstream key id', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sandbox-db-'));
  const database = new AppDatabase(path.join(directory, 'test.db'));
  try {
    database.saveInteraction({
      environmentId: 'env-key-bind',
      interactionId: 'turn-1',
      prompt: 'hi',
      outputText: 'ok',
      upstreamKeyId: 'key-42',
      timestamp: 1
    });
    const sessions = database.listSessions();
    assert.equal(sessions[0].upstreamKeyId, 'key-42');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('auto sandbox model omits a concrete model id', () => {
  assert.equal(resolveSandboxModel('auto'), undefined);
  assert.equal(resolveSandboxModel('AUTO'), undefined);
  assert.equal(resolveSandboxModel(''), undefined);
  assert.equal(resolveSandboxModel('gemini-3.8-flash'), 'gemini-3.8-flash');
});

test('web sandbox credentials decrypt a chosen pool key and skip header-only keys', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sandbox-auth-'));
  const database = new AppDatabase(path.join(directory, 'test.db'));
  const masterKey = 'unit-master-key';
  const adminToken = 'unit-admin';
  const apiKey = 'AIzaSySandboxDirectKey99';
  try {
    const encrypted = encryptSecret(apiKey, masterKey);
    const row = database.insertUpstreamKey({
      name: 'web-direct',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      suffix: keySuffix(apiKey),
      proxyUrl: 'http://127.0.0.1:7890'
    });

    const resolved = resolveSandboxCredentials({
      headers: { 'x-gateway-admin-token': 'unit-admin', 'x-upstream-key-id': row.id },
      body: {}
    }, { database, masterKey, adminToken });

    assert.equal(resolved.apiKey, apiKey);
    assert.equal(resolved.keyId, row.id);
    assert.equal(resolved.source, 'upstream_key');
    assert.equal(resolved.keyProxyUrl, 'http://127.0.0.1:7890');

    const proxy = resolveSandboxProxy({}, resolved);
    assert.equal(proxy.useProxy, true);
    assert.equal(proxy.proxyUrl, 'http://127.0.0.1:7890');

    assert.throws(
      () => resolveSandboxCredentials({
        headers: {},
        body: { upstreamKeyId: row.id }
      }, { database, masterKey, adminToken }),
      /管理 Token/
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
