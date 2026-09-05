const { authenticateAdmin } = require('./gateway/auth');
const { decryptKeyRow } = require('./gateway/upstream');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCES = 32;

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function workspaceTarget(raw, fallbackName = '') {
  let value = String(raw || fallbackName || '').replace(/\\/g, '/').trim();
  if (!value) {
    throw httpError(400, 'INVALID_FILE_PATH', '沙盒文件缺少目标路径');
  }
  if (value.includes('\0') || value.split('/').includes('..')) {
    throw httpError(400, 'INVALID_FILE_PATH', '沙盒文件路径不合法');
  }
  value = value.replace(/^(\.\/)+/, '');
  if (!value.startsWith('/')) value = `/workspace/${value}`;
  else if (!value.startsWith('/workspace/')) value = `/workspace${value}`;
  if (value === '/workspace' || value === '/workspace/') {
    throw httpError(400, 'INVALID_FILE_PATH', '沙盒文件路径不能是 /workspace 根目录');
  }
  return value;
}

function decodeSourceContent(source) {
  const encoding = String(source?.encoding || 'utf8').toLowerCase();
  const raw = source?.content;
  if (raw == null) return { content: '', binary: false, bytes: 0 };
  if (encoding === 'base64') {
    const buffer = Buffer.from(String(raw), 'base64');
    return {
      content: buffer.toString('latin1'),
      binary: true,
      bytes: buffer.length
    };
  }
  const text = String(raw);
  return { content: text, binary: false, bytes: Buffer.byteLength(text, 'utf8') };
}

function normalizeSources(sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) return [];
  if (sources.length > MAX_SOURCES) {
    throw httpError(400, 'TOO_MANY_FILES', `一次最多注入 ${MAX_SOURCES} 个文件`);
  }
  let total = 0;
  const seen = new Set();
  const normalized = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const target = workspaceTarget(source.target, source.name);
    if (seen.has(target)) {
      throw httpError(400, 'DUPLICATE_FILE_PATH', `重复的沙盒文件路径: ${target}`);
    }
    seen.add(target);
    const decoded = decodeSourceContent(source);
    if (decoded.bytes > MAX_FILE_BYTES) {
      throw httpError(400, 'FILE_TOO_LARGE', `${target} 超过 ${MAX_FILE_BYTES} 字节上限`);
    }
    total += decoded.bytes;
    if (total > MAX_TOTAL_SOURCE_BYTES) {
      throw httpError(400, 'FILES_TOO_LARGE', `注入文件合计超过 ${MAX_TOTAL_SOURCE_BYTES} 字节上限`);
    }
    normalized.push({
      type: 'inline',
      target,
      content: decoded.content,
      binary: decoded.binary
    });
  }
  return normalized;
}

function toGoogleSources(sources = []) {
  return sources.map((source) => ({
    type: source.type || 'inline',
    target: source.target,
    content: source.content
  }));
}

function buildReuseFilePreamble(files = []) {
  if (!files.length) return '';
  const lines = [
    'The user uploaded files that must exist in this existing sandbox before you do the rest of the task.',
    'Use the code_execution tool. Create parent directories as needed. Overwrite if a file already exists.',
    ''
  ];
  for (const file of files) {
    if (file.binary) {
      const b64 = Buffer.from(file.content, 'latin1').toString('base64');
      lines.push(`Binary file ${file.target} (base64). Decode and write with Python:`);
      lines.push('```python');
      lines.push('import base64, pathlib');
      lines.push(`pathlib.Path(${JSON.stringify(file.target)}).parent.mkdir(parents=True, exist_ok=True)`);
      lines.push(`pathlib.Path(${JSON.stringify(file.target)}).write_bytes(base64.b64decode(${JSON.stringify(b64)}))`);
      lines.push('```');
      lines.push('');
    } else {
      lines.push(`Text file ${file.target}:`);
      lines.push('```');
      lines.push(file.content);
      lines.push('```');
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function prependInput(input, preamble) {
  if (!preamble) return input;
  if (typeof input === 'string') return preamble + input;
  if (Array.isArray(input)) return [{ type: 'text', text: preamble }, ...input];
  if (input == null) return preamble.trim();
  return preamble + String(input);
}

function resolveSandboxModel(model) {
  const value = String(model || '').trim();
  if (!value || value.toLowerCase() === 'auto') return undefined;
  return value;
}

function resolveSandboxCredentials(req, { database, masterKey, adminToken } = {}) {
  const headers = req.headers || {};
  const upstreamKeyId = String(req.body?.upstreamKeyId || headers['x-upstream-key-id'] || '').trim();
  const rawKey = String(headers['x-goog-api-key'] || req.body?.apiKey || '').trim();

  if (upstreamKeyId) {
    const auth = authenticateAdmin({ headers }, adminToken);
    if (!auth.ok) {
      throw httpError(
        auth.status,
        auth.code,
        auth.message === 'Invalid admin token'
          ? '网页选 Key 直连需要有效的管理 Token。请到「运行设置」填写 GATEWAY_ADMIN_TOKEN 后重试。'
          : auth.message
      );
    }
    if (!masterKey) {
      throw httpError(503, 'GATEWAY_NOT_CONFIGURED', 'GATEWAY_MASTER_KEY is not configured');
    }
    const row = database.getUpstreamKey(upstreamKeyId);
    if (!row) throw httpError(404, 'UPSTREAM_KEY_NOT_FOUND', '所选上游 Key 不存在');
    const decrypted = decryptKeyRow(row, masterKey);
    return {
      apiKey: decrypted.apiKey,
      keyId: row.id,
      keyName: row.name,
      keyProxyUrl: decrypted.proxyUrl || null,
      source: 'upstream_key'
    };
  }

  if (rawKey) {
    return {
      apiKey: rawKey,
      keyId: null,
      keyName: null,
      keyProxyUrl: null,
      source: 'header'
    };
  }

  throw httpError(400, 'MISSING_API_KEY', '请在沙盒任务页选择上游 Key。网页提交不再使用右上角单独的浏览器 Key。');
}

function resolveSandboxProxy(body = {}, credentials = {}) {
  if (body.useProxy === false) return { useProxy: false, proxyUrl: undefined };
  if (body.useProxy === true) {
    return {
      useProxy: true,
      proxyUrl: String(body.proxyUrl || credentials.keyProxyUrl || '').trim() || undefined
    };
  }
  if (credentials.keyProxyUrl) {
    return { useProxy: true, proxyUrl: credentials.keyProxyUrl };
  }
  return { useProxy: body.useProxy, proxyUrl: body.proxyUrl };
}

function collectSources(body = {}) {
  const list = [];
  if (Array.isArray(body.sources)) list.push(...body.sources);
  if (body.environment && typeof body.environment === 'object' && Array.isArray(body.environment.sources)) {
    list.push(...body.environment.sources);
  }
  return list;
}

function applySandboxFiles(payload, body = {}) {
  const files = normalizeSources(collectSources(body));
  const environment = payload.environment;
  const reusing = typeof environment === 'string' && environment !== 'remote';
  if (!files.length) return payload;
  if (reusing) {
    payload.input = prependInput(payload.input, buildReuseFilePreamble(files));
    return payload;
  }
  payload.environment = {
    type: 'remote',
    sources: toGoogleSources(files)
  };
  return payload;
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_TOTAL_SOURCE_BYTES,
  MAX_SOURCES,
  workspaceTarget,
  normalizeSources,
  toGoogleSources,
  buildReuseFilePreamble,
  prependInput,
  resolveSandboxModel,
  resolveSandboxCredentials,
  resolveSandboxProxy,
  applySandboxFiles
};
