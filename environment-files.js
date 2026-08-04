const tar = require('tar-stream');
const path = require('path');

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

class ArchiveFileNotFoundError extends Error {
  constructor(requestedPath, availablePaths) {
    super(`环境快照中未找到文件: ${requestedPath}`);
    this.name = 'ArchiveFileNotFoundError';
    this.code = 'FILE_NOT_FOUND_IN_SNAPSHOT';
    this.status = 404;
    this.availablePaths = availablePaths;
  }
}

class ArchiveFileAmbiguousError extends Error {
  constructor(requestedPath, matchingPaths) {
    super(`环境快照中存在多个同名文件，请选择完整路径: ${requestedPath}`);
    this.name = 'ArchiveFileAmbiguousError';
    this.code = 'MULTIPLE_FILES_IN_SNAPSHOT';
    this.status = 409;
    this.availablePaths = matchingPaths;
  }
}

function normalizeArchivePath(filePath) {
  if (typeof filePath !== 'string') return '';
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(?:\.\/)+/, '')
    .split('/')
    .filter(segment => segment && segment !== '.')
    .join('/');
}

function scoreArchivePath(entryPath, targetPath) {
  const lowerPath = entryPath.toLowerCase();
  const targetBase = path.posix.basename(targetPath).toLowerCase();
  const entryBase = path.posix.basename(entryPath).toLowerCase();
  const targetExtension = path.posix.extname(targetBase);
  const depth = entryPath.split('/').length;
  let score = 0;

  if (entryBase === targetBase) score += 1000;
  else if (targetBase && entryBase.includes(targetBase)) score += 500;
  if (targetExtension && path.posix.extname(entryBase) === targetExtension) score += 120;

  if (lowerPath.startsWith('workspace/')) score += 450;
  else if (lowerPath.startsWith('home/oai/share/')) score += 420;
  else if (lowerPath.startsWith('tmp/')) score += 350;
  else if (lowerPath.startsWith('root/') || lowerPath.startsWith('home/')) score += 300;
  else if (depth <= 2) score += 250;

  if (/^(?:usr|var|etc|lib|lib64|bin|sbin|proc|sys|dev)\//.test(lowerPath)) score -= 600;
  return score;
}

function extractFileFromTar(readable, requestedPath, options = {}) {
  const targetPath = normalizeArchivePath(requestedPath);
  const maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  const maxArchiveBytes = options.maxArchiveBytes || DEFAULT_MAX_ARCHIVE_BYTES;
  const maxListedPaths = options.maxListedPaths || 100;
  const maxCandidateRecords = options.maxCandidateRecords || 5000;
  const hasExplicitDirectory = /[\\/]/.test(requestedPath);

  if (!targetPath || targetPath.split('/').includes('..')) {
    const error = new Error('要提取的文件路径不合法');
    error.code = 'INVALID_FILE_PATH';
    error.status = 400;
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const candidateRecords = [];
    const fallbackPaths = [];
    const basenameMatches = [];
    let archiveBytes = 0;
    let exactMatch = null;
    let basenameMatch = null;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (!error.code) error.code = 'SNAPSHOT_EXTRACTION_FAILED';
      reject(error);
    };

    readable.on('data', (chunk) => {
      archiveBytes += chunk.length;
      if (archiveBytes > maxArchiveBytes) {
        const error = new Error(`环境快照超过安全上限 ${Math.round(maxArchiveBytes / 1024 / 1024)} MB`);
        error.code = 'SNAPSHOT_TOO_LARGE';
        error.status = 413;
        readable.destroy(error);
      }
    });
    readable.on('error', fail);
    extract.on('error', fail);

    extract.on('entry', (header, stream, next) => {
      const entryPath = normalizeArchivePath(header.name);
      const isFile = header.type === 'file';
      const targetBase = path.posix.basename(targetPath).toLowerCase();
      const isExactMatch = isFile && hasExplicitDirectory && entryPath === targetPath;
      const isBasenameMatch = isFile && path.posix.basename(entryPath).toLowerCase() === targetBase;

      if (isFile) {
        if (fallbackPaths.length < maxListedPaths) fallbackPaths.push(`/${entryPath}`);
        const score = scoreArchivePath(entryPath, targetPath);
        if (score > 0 && candidateRecords.length < maxCandidateRecords) {
          candidateRecords.push({
            path: `/${entryPath}`,
            score,
            modifiedAt: header.mtime ? new Date(header.mtime).getTime() : 0
          });
        }
        if (isBasenameMatch && basenameMatches.length < maxListedPaths) {
          basenameMatches.push(`/${entryPath}`);
        }
      }

      // Buffer the exact match, or the first basename match as a fallback. If
      // more basename matches appear later, return a choice instead of guessing.
      const shouldBuffer = isExactMatch || (isBasenameMatch && !basenameMatch);
      if (!shouldBuffer) {
        stream.on('end', next);
        stream.resume();
        return;
      }

      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxFileBytes) {
          const error = new Error(`目标文件超过安全上限 ${Math.round(maxFileBytes / 1024 / 1024)} MB`);
          error.code = 'FILE_TOO_LARGE';
          error.status = 413;
          stream.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (!settled) {
          const match = {
            buffer: Buffer.concat(chunks),
            archivePath: `/${entryPath}`,
            header
          };
          if (isExactMatch) exactMatch = match;
          else basenameMatch = match;
        }
        next();
      });
    });

    extract.on('finish', () => {
      if (settled) return;
      settled = true;
      const availablePaths = candidateRecords
        .sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))
        .map(item => item.path)
        .filter((item, index, values) => values.indexOf(item) === index)
        .slice(0, maxListedPaths);

      if (exactMatch) {
        resolve({ ...exactMatch, matchedBy: 'exact', availablePaths, archiveBytes });
        return;
      }
      if (basenameMatches.length === 1 && basenameMatch) {
        resolve({ ...basenameMatch, matchedBy: 'basename', availablePaths, archiveBytes });
        return;
      }
      if (basenameMatches.length > 1) {
        reject(new ArchiveFileAmbiguousError(requestedPath, basenameMatches));
        return;
      }
      if (!basenameMatch) {
        reject(new ArchiveFileNotFoundError(
          requestedPath,
          availablePaths.length > 0 ? availablePaths : fallbackPaths
        ));
        return;
      }
    });

    readable.pipe(extract);
  });
}

module.exports = {
  ArchiveFileAmbiguousError,
  ArchiveFileNotFoundError,
  DEFAULT_MAX_ARCHIVE_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  extractFileFromTar,
  normalizeArchivePath,
  scoreArchivePath
};
