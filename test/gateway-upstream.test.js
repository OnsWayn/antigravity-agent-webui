const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AppDatabase } = require('../database');
const { encryptSecret, keySuffix } = require('../gateway/crypto');
const { isRateLimitError, isInternalError, pickUpstreamKey, TpmTracker, RequestCounter } = require('../gateway/upstream');

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

test('detects Internal error encountered and does not treat it as a rate limit', () => {
  assert.equal(isInternalError({ status: 500, code: 'api_error', message: 'Internal error encountered.' }), true);
  assert.equal(isInternalError({ status: 500, message: 'internal error encountered' }), true);
  assert.equal(isRateLimitError({ status: 500, code: 'api_error', message: 'Internal error encountered.' }), false);
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

test('sticky preferId near configurable TPM limit yields another key', () => {
  const tracker = new TpmTracker({ windowMs: 60000, limitTpm: 10000, thresholdRatio: 0.8 });
  const now = 2000000;
  withDatabase((database) => {
    const master = 'm';
    const a = insertKey(database, master, 'secret-a', 'A');
    const b = insertKey(database, master, 'secret-b', 'B');
    tracker.record(a.id, 9000, now);
    const picked = pickUpstreamKey(database, master, {
      preferId: a.id,
      now,
      tpmTracker: tracker
    });
    assert.equal(picked.row.id, b.id);
    assert.equal(picked.tpmAvoided, true);
  });
});

test('timeUntilFits uses strict less-than and waits for the oldest record to leave', () => {
  const tracker = new TpmTracker({ windowMs: 60000, limitTpm: 100000 });
  const now = 1_000_000;
  tracker.record('k', 40000, now);
  assert.equal(tracker.timeUntilFits('k', 50000, { now }), 0);

  tracker.clear();
  tracker.record('k', 50000, now);
  const waitEqual = tracker.timeUntilFits('k', 50000, { now });
  assert.ok(waitEqual > 0);
  assert.equal(waitEqual, 60000);

  tracker.clear();
  tracker.record('k', 48000, now);
  assert.equal(tracker.timeUntilFits('k', 52000, { now }), 60000);

  assert.equal(tracker.timeUntilFits('k', 120000, { now }), Infinity);
});

test('tryReserve admits only one concurrent slot and TTL releases it', () => {
  const expired = [];
  const tracker = new TpmTracker({
    windowMs: 60000,
    limitTpm: 100000,
    reserveTtlMs: 1000,
    onReserveExpired: (info) => expired.push(info)
  });
  const first = tracker.tryReserve('k', 90000, { now: 0, ttlMs: 1000 });
  assert.ok(first);
  assert.equal(tracker.tryReserve('k', 20000, { now: 10 }), null);
  assert.equal(tracker.getRecentUsage('k', 10), 90000);

  assert.equal(tracker.getRecentUsage('k', 1001), 0);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].reserveId, first);
  const second = tracker.tryReserve('k', 90000, { now: 1001, ttlMs: 1000 });
  assert.ok(second);
});

test('unexpired reservation still occupies the window for timeUntilFits', () => {
  const tracker = new TpmTracker({ windowMs: 60000, limitTpm: 100000, reserveTtlMs: 60000 });
  const now = 5_000;
  assert.ok(tracker.tryReserve('k', 60000, { now, ttlMs: 60000 }));
  assert.ok(tracker.timeUntilFits('k', 50000, { now: now + 100 }) > 0);
  assert.equal(tracker.tryReserve('k', 50000, { now: now + 100 }), null);
});

test('commitReservation replaces the hold with actual usage', () => {
  const tracker = new TpmTracker({ windowMs: 60000, limitTpm: 100000 });
  const id = tracker.tryReserve('k', 40000, { now: 0 });
  tracker.commitReservation(id, 42000, 10);
  assert.equal(tracker.getRecentUsage('k', 10), 42000);
});

test('RequestCounter drops timestamps outside the sliding window', () => {
  const counter = new RequestCounter({ windowMs: 60000 });
  const now = 1_000_000;
  counter.recordRequest('k', now);
  counter.recordRequest('k', now + 1000);
  counter.recordRequest('k', now + 2000);
  assert.equal(counter.getRpm('k', now + 2000), 3);
  assert.equal(counter.getRpm('k', now + 61000), 2);
});

test('pickUpstreamKey strategy=pace keeps a hot sticky key', () => {
  const tracker = new TpmTracker({ windowMs: 60000, limitTpm: 10000, thresholdRatio: 0.8 });
  const now = 3_000_000;
  withDatabase((database) => {
    const master = 'm';
    const a = insertKey(database, master, 'secret-a', 'A');
    insertKey(database, master, 'secret-b', 'B');
    tracker.record(a.id, 9000, now);
    const picked = pickUpstreamKey(database, master, {
      preferId: a.id,
      now,
      tpmTracker: tracker,
      strategy: 'pace',
      tpmPaceLimit: 10000
    });
    assert.equal(picked.row.id, a.id);
    assert.equal(picked.tpmAvoided, false);
  });
});
