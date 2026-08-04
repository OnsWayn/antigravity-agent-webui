const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

class SnapshotCache {
  constructor(options = {}) {
    this.directory = path.resolve(options.directory || path.join(__dirname, 'data', 'snapshot-cache'));
    this.ttlMs = Number(options.ttlMs || DEFAULT_CACHE_TTL_MS);
    this.maxBytes = Number(options.maxBytes || DEFAULT_MAX_SNAPSHOT_BYTES);
    this.pending = new Map();
    fs.mkdirSync(this.directory, { recursive: true });
  }

  keyForEnvironment(environmentId) {
    return crypto.createHash('sha256').update(String(environmentId)).digest('hex');
  }

  filePathForEnvironment(environmentId) {
    return path.join(this.directory, `${this.keyForEnvironment(environmentId)}.tar`);
  }

  async get(environmentId, loader, options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const filePath = this.filePathForEnvironment(environmentId);
    if (!forceRefresh) {
      try {
        const stat = await fs.promises.stat(filePath);
        if (Date.now() - stat.mtimeMs <= this.ttlMs) {
          return { filePath, cacheHit: true, sizeBytes: stat.size };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    const key = String(environmentId);
    if (this.pending.has(key)) return this.pending.get(key);

    const download = this.download(environmentId, loader, filePath);
    this.pending.set(key, download);
    try {
      return await download;
    } finally {
      this.pending.delete(key);
    }
  }

  async download(environmentId, loader, filePath) {
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let sizeBytes = 0;
    const limiter = new Transform({
      transform: (chunk, encoding, callback) => {
        sizeBytes += chunk.length;
        if (sizeBytes > this.maxBytes) {
          const error = new Error(`环境快照超过缓存上限 ${Math.round(this.maxBytes / 1024 / 1024)} MB`);
          error.code = 'SNAPSHOT_TOO_LARGE';
          error.status = 413;
          callback(error);
          return;
        }
        callback(null, chunk);
      }
    });

    try {
      const readable = await loader(environmentId);
      await pipeline(readable, limiter, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
      await fs.promises.rm(filePath, { force: true });
      await fs.promises.rename(temporaryPath, filePath);
      return { filePath, cacheHit: false, sizeBytes };
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  invalidate(environmentId) {
    if (!environmentId) return;
    try {
      fs.rmSync(this.filePathForEnvironment(environmentId), { force: true });
    } catch {
      // A stale cache is still bounded by TTL; failure to delete must not break a task.
    }
  }

  clear() {
    fs.rmSync(this.directory, { recursive: true, force: true });
    fs.mkdirSync(this.directory, { recursive: true });
  }
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  SnapshotCache
};
