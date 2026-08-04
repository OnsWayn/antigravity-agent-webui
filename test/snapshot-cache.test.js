const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { SnapshotCache } = require('../snapshot-cache');

test('reuses a recent environment snapshot and supports invalidation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-snapshot-'));
  const cache = new SnapshotCache({ directory, ttlMs: 60000, maxBytes: 1024 });
  let downloads = 0;
  const loader = async () => {
    downloads++;
    return Readable.from(Buffer.from(`snapshot-${downloads}`));
  };

  try {
    const first = await cache.get('env-1', loader);
    const second = await cache.get('env-1', loader);
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(downloads, 1);
    assert.equal(fs.readFileSync(second.filePath, 'utf8'), 'snapshot-1');

    cache.invalidate('env-1');
    const third = await cache.get('env-1', loader);
    assert.equal(third.cacheHit, false);
    assert.equal(downloads, 2);
  } finally {
    cache.clear();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects snapshots larger than the configured cache limit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-snapshot-limit-'));
  const cache = new SnapshotCache({ directory, ttlMs: 60000, maxBytes: 4 });
  try {
    await assert.rejects(
      cache.get('env-large', async () => Readable.from(Buffer.from('too large'))),
      error => error.code === 'SNAPSHOT_TOO_LARGE'
    );
  } finally {
    cache.clear();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deduplicates concurrent downloads for the same environment', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-snapshot-concurrent-'));
  const cache = new SnapshotCache({ directory, ttlMs: 60000, maxBytes: 1024 });
  let downloads = 0;
  const loader = async () => {
    downloads++;
    await new Promise(resolve => setImmediate(resolve));
    return Readable.from(Buffer.from('one shared snapshot'));
  };

  try {
    const [first, second] = await Promise.all([
      cache.get('env-concurrent', loader),
      cache.get('env-concurrent', loader)
    ]);
    assert.equal(downloads, 1);
    assert.equal(first.filePath, second.filePath);
    assert.equal(fs.readFileSync(first.filePath, 'utf8'), 'one shared snapshot');
  } finally {
    cache.clear();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
