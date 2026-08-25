const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AppDatabase } = require('../database');
const { encryptSecret, keySuffix } = require('../gateway/crypto');
const { isRateLimitError, pickUpstreamKey, TpmTracker } = require('../gateway/upstream');

function withDatabase(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-up-'));
  const database = new AppDatabase(path.join(directory, 'test.db'));
  try {
    return callback(database);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function insertKey(database, master, secret, name) {
  const encrypted = encryptSecret(secret, master);
  return database.insertUpstreamKey({
    name,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    suffix: keySuffix(secret)
  });
}

test('detects 429 and resource exhausted as rate limits', () => {
  assert.equal(isRateLimitError({ status: 429, message: 'slow down' }), true);
  assert.equal(isRateLimitError({ status: 400, code: 'RESOURCE_EXHAUSTED' }), true);
  assert.equal(isRateLimitError({ status: 500, message: 'boom' }), false);
});

test('new chats round-robin least recently used keys', () => {
  withDatabase((database) => {
    const master = 'm';
    const a = insertKey(database, master, 'secret-a', 'A');
    const b = insertKey(database, master, 'secret-b', 'B');
    const first = pickUpstreamKey(database, master);
    assert.equal(first.row.id, a.id);
    database.markUpstreamKeyUsed(first.row.id);
    const second = pickUpstreamKey(database, master);
    assert.equal(second.row.id, b.id);
  });
});

test('sticky preferId wins while the key is healthy', () => {
  withDatabase((database) => {
    const master = 'm';
    const a = insertKey(database, master, 'secret-a', 'A');
    const b = insertKey(database, master, 'secret-b', 'B');
    database.markUpstreamKeyUsed(a.id);
    const picked = pickUpstreamKey(database, master, { preferId: a.id });
    assert.equal(picked.row.id, a.id);
    assert.notEqual(picked.row.id, b.id);
  });
});

test('cooldown after three 429s skips that key', () => {
  withDatabase((database) => {
    const master = 'm';
    const a = insertKey(database, master, 'secret-a', 'A');
    insertKey(database, master, 'secret-b', 'B');
    database.markUpstreamKeyUsed(a.id, { rateLimited: true, cooldownMs: 60_000 });
    database.markUpstreamKeyUsed(a.id, { rateLimited: true, cooldownMs: 60_000 });
    database.markUpstreamKeyUsed(a.id, { rateLimited: true, cooldownMs: 60_000 });
    const picked = pickUpstreamKey(database, master, { preferId: a.id, now: Date.now() + 1000 });
    assert.notEqual(picked.row.id, a.id);
  });
});

test('TpmTracker tracks sliding window usage and pickUpstreamKey avoids keys near limit', () => {
  const tracker = new TpmTracker({ windowMs: 60000, limitTpm: 100000, thresholdRatio: 0.8 });
  const now = 1000000;
  tracker.record('key-1', 50000, now - 30000);
  assert.equal(tracker.getRecentUsage('key-1', now), 50000);
  assert.equal(tracker.isNearLimit('key-1', { now }), false);

  tracker.record('key-1', 35000, now - 10000);
  assert.equal(tracker.getRecentUsage('key-1', now), 85000);
  assert.equal(tracker.isNearLimit('key-1', { now }), true); // 85k >= 80k threshold

  // Pruning after window expiration
  assert.equal(tracker.getRecentUsage('key-1', now + 35000), 35000);
  assert.equal(tracker.isNearLimit('key-1', { now: now + 35000 }), false);

  // pickUpstreamKey with tpmTracker
  withDatabase((database) => {
    const master = 'm';
    const a = insertKey(database, master, 'secret-a', 'A');
    const b = insertKey(database, master, 'secret-b', 'B');

    tracker.record(a.id, 90000, now);
    const picked = pickUpstreamKey(database, master, { now, tpmTracker: tracker });
    assert.equal(picked.row.id, b.id); // key A is near limit, picked B
  });
});
