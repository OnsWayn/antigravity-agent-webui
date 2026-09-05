const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { AppDatabase } = require('./database');
const { extractFileFromTar } = require('./environment-files');
const { createOriginGuard } = require('./http-security');
const { SnapshotCache } = require('./snapshot-cache');
const { createGatewayRouter } = require('./gateway/routes');
const { createAdminRouter } = require('./gateway/admin-routes');
const {
  resolveSandboxCredentials,
  resolveSandboxProxy,
  resolveSandboxModel,
  applySandboxFiles
} = require('./sandbox');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATABASE_PATH = process.env.ANTIGRAVITY_DB_PATH || path.join(__dirname, 'data', 'antigravity.db');
const database = new AppDatabase(DATABASE_PATH);
const snapshotCache = new SnapshotCache({
  directory: process.env.SNAPSHOT_CACHE_DIR || path.join(__dirname, 'data', 'snapshot-cache'),
  ttlMs: Number(process.env.SNAPSHOT_CACHE_TTL_MS || 60000)
});

try {
  database.cleanOldGatewayRequestLogs({ maxDays: 5, maxDailyBytes: 20 * 1024 * 1024 });
} catch (err) {
  console.warn('[Cleanup] Initial gateway log cleanup failed:', err.message);
}

const logCleanInterval = setInterval(() => {
  try {
    database.cleanOldGatewayRequestLogs({ maxDays: 5, maxDailyBytes: 20 * 1024 * 1024 });
  } catch (err) {
    console.warn('[Cleanup] Periodic gateway log cleanup failed:', err.message);
  }
}, 3600 * 1000);
if (logCleanInterval.unref) logCleanInterval.unref();

app.use(createOriginGuard({
  port: PORT,
  allowedOrigins: process.env.ALLOWED_ORIGINS || ''
}));
app.use(express.json({ limit: '50mb' }));

const GATEWAY_MASTER_KEY = process.env.GATEWAY_MASTER_KEY || '';
const GATEWAY_ADMIN_TOKEN = process.env.GATEWAY_ADMIN_TOKEN || '';
const GATEWAY_ENABLED = process.env.GATEWAY_ENABLED !== 'false';
app.use(createGatewayRouter({
  database,
  masterKey: GATEWAY_MASTER_KEY,
  enabled: GATEWAY_ENABLED,
  log: logMessage
}));
app.use('/api/gateway', createAdminRouter({
  database,
  masterKey: GATEWAY_MASTER_KEY,
  adminToken: GATEWAY_ADMIN_TOKEN,
  enabled: GATEWAY_ENABLED
}));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// In-memory server logs
const serverLogs = [];
function logMessage(level, message, details = null) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message, details };
  serverLogs.push(logEntry);
  if (serverLogs.length > 500) serverLogs.shift();

  const logHeader = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (level === 'error') {
    console.error(logHeader, details ? JSON.stringify(details, null, 2) : '');
  } else {
    console.log(logHeader, details ? JSON.stringify(details, null, 2) : '');
  }
}

// Extract output text from interaction data
function extractOutputText(data) {
  if (data.output_text && data.output_text.trim()) {
    return data.output_text;
  }

  const textParts = [];
  if (data.steps && Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (step.type === 'model_output' || step.type === 'output') {
        if (Array.isArray(step.content)) {
          for (const item of step.content) {
            if (item.type === 'text' && item.text) {
              textParts.push(item.text);
            } else if (typeof item === 'string') {
              textParts.push(item);
            }
          }
        } else if (typeof step.content === 'string') {
          textParts.push(step.content);
        } else if (step.text) {
          textParts.push(step.text);
        }
      }
    }
  }

  return textParts.join('\n\n') || '';
}

function extractPrompt(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input
    .filter(item => item && item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n');
}

// Persist request configuration for reproducibility without storing API keys or
// large inline/base64 payloads.
function sanitizeForStorage(value, key = '') {
  if (value === null || value === undefined) return value;
  if (/api.?key|authorization/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (key === 'data' && value.length > 256) return `[binary data omitted: ${value.length} chars]`;
    if (key === 'content' && value.length > 100000) return `${value.slice(0, 100000)}\n[truncated]`;
    return value;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeForStorage(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeForStorage(childValue, childKey)
    ]));
  }
  return value;
}

function findArtifactPaths(text) {
  if (!text) return [];
  return Array.from(new Set(text.match(/\/workspace\/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]+/g) || []));
}

// Bulletproof Base64 Parsing
function parseBase64FromOutput(outputText) {
  if (!outputText) return null;

  let match = outputText.match(/===CHUNK_START===([\s\S]*?)===CHUNK_END===/) ||
              outputText.match(/===BASE64_START===([\s\S]*?)===BASE64_END===/);
  if (match && match[1]) {
    const cleaned = match[1].replace(/[^A-Za-z0-9+/=]/g, '');
    if (cleaned.length > 0) return cleaned;
  }

  if (outputText.includes('===CHUNK_END===') || outputText.includes('===BASE64_END===')) {
    const parts = outputText.split(/===(?:CHUNK|BASE64)_END===/);
    const potentialB64 = parts[0];
    const lines = potentialB64.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const b64Lines = lines.filter(l => /^[A-Za-z0-9+/=\s]+$/.test(l));
    if (b64Lines.length > 0) {
      const combined = b64Lines.join('').replace(/[^A-Za-z0-9+/=]/g, '');
      if (combined.length > 0) return combined;
    }
  }

  const b64Matches = outputText.match(/([A-Za-z0-9+/=\r\n]{50,})/g);
  if (b64Matches && b64Matches.length > 0) {
    let longest = '';
    for (const m of b64Matches) {
      const cleaned = m.replace(/[^A-Za-z0-9+/=]/g, '');
      if (cleaned.length > longest.length) {
        longest = cleaned;
      }
    }
    if (longest.length > 0) return longest;
  }

  return null;
}

// Optional global proxy from environment variables (no hardcoded default)
const ENV_PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.PROXY_URL || '';

// Resolve the proxy URL to use, or null when no proxy should be used.
// - useProxy === false: user explicitly disabled proxy -> never use one
// - useProxy === true:  use user-specified proxyUrl, else env proxy, else local default
// - useProxy undefined: only use proxy when environment variables define one
function resolveProxyUrl(proxyConfig = {}) {
  const { useProxy, proxyUrl } = proxyConfig;
  if (useProxy === false) return null;
  const targetRaw = useProxy === true
    ? (proxyUrl || ENV_PROXY_URL || 'http://127.0.0.1:10808')
    : ENV_PROXY_URL;
  if (!targetRaw) return null;

  let targetUrl = String(targetRaw).trim();
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = `http://127.0.0.1:${targetUrl}`;
  }
  return targetUrl;
}

async function downloadEnvironmentSnapshot(apiKey, environmentId, proxyConfig = {}) {
  const proxyUrlUsed = resolveProxyUrl(proxyConfig);
  const resourceId = String(environmentId).startsWith('environment-')
    ? String(environmentId)
    : `environment-${environmentId}`;
  const url = `${GEMINI_INTERACTIONS_URL.replace('/interactions', '')}/files/${encodeURIComponent(resourceId)}:download?alt=media`;
  const options = {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey },
    redirect: 'follow',
    timeout: 15 * 60 * 1000
  };
  if (proxyUrlUsed) options.agent = new HttpsProxyAgent(proxyUrlUsed);

  logMessage('info', 'Downloading official environment snapshot', {
    environmentId,
    proxy: proxyUrlUsed || 'None'
  });

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const wrapped = new Error(`下载远程环境快照失败: ${error.message}`);
    wrapped.code = error.code || 'SNAPSHOT_DOWNLOAD_FAILED';
    wrapped.status = 502;
    throw wrapped;
  }

  if (!response.ok) {
    const responseText = await response.text();
    const error = new Error(`Gemini Files API 下载环境失败 (HTTP ${response.status})${responseText ? `: ${responseText.slice(0, 1000)}` : ''}`);
    error.code = response.status === 404 ? 'ENVIRONMENT_NOT_FOUND' : 'SNAPSHOT_DOWNLOAD_FAILED';
    error.status = response.status;
    throw error;
  }

  return response.body;
}

async function fetchFileFromEnvironmentSnapshot(apiKey, environmentId, filePath, proxyConfig = {}, forceRefresh = false) {
  const cachedSnapshot = await snapshotCache.get(
    environmentId,
    () => downloadEnvironmentSnapshot(apiKey, environmentId, proxyConfig),
    { forceRefresh }
  );
  const extracted = await extractFileFromTar(fs.createReadStream(cachedSnapshot.filePath), filePath);
  return {
    ...extracted,
    cacheHit: cachedSnapshot.cacheHit,
    snapshotSizeBytes: cachedSnapshot.sizeBytes
  };
}

// Helper for Gemini Interactions API calls
async function callGeminiInteractionsApi(apiKey, payload, proxyConfig = {}) {
  const proxyUrlUsed = resolveProxyUrl(proxyConfig);
  const agent = proxyUrlUsed ? new HttpsProxyAgent(proxyUrlUsed) : null;
  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(payload),
    timeout: 15 * 60 * 1000, // 15 min: agentic tasks can run for a while, but never hang forever
  };

  if (agent) {
    fetchOptions.agent = agent;
  }

  logMessage('info', 'Sending request to Gemini Interactions API', { url: GEMINI_INTERACTIONS_URL, proxy: proxyUrlUsed || 'None', payload });

  let response;
  try {
    response = await fetch(GEMINI_INTERACTIONS_URL, fetchOptions);
  } catch (netErr) {
    const causeMsg = netErr.cause ? (netErr.cause.message || JSON.stringify(netErr.cause)) : netErr.message;
    const causeCode = netErr.cause?.code || 'FETCH_FAILED';

    logMessage('error', 'Network connection to Gemini API failed', {
      error: netErr.message,
      cause: causeMsg,
      code: causeCode,
      proxyUsed: proxyUrlUsed || false
    });

    throw {
      status: 0,
      code: causeCode,
      message: `网络连接至 Google Gemini API 失败: ${netErr.message} [原因: ${causeMsg}]。` + 
               (proxyUrlUsed ? `请检查代理服务 (当前代理: ${proxyUrlUsed}) 是否已正常启动。` : `当前未使用代理，如需代理请在左侧「网络代理配置」中开启。`),
      rawError: { message: netErr.message, cause: netErr.cause, stack: netErr.stack }
    };
  }

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (jsonErr) {
    logMessage('error', 'Non-JSON response received from Gemini API', { status: response.status, responseText });
    throw {
      status: response.status,
      code: 'INVALID_RESPONSE',
      message: `收到非 JSON 的异常响应 (HTTP ${response.status})`,
      rawOutput: responseText
    };
  }

  if (!response.ok) {
    const errorDetails = data.error || {};
    logMessage('error', `Gemini API returned HTTP ${response.status}`, errorDetails);
    throw {
      status: response.status,
      code: errorDetails.status || errorDetails.code || `HTTP_${response.status}`,
      message: errorDetails.message || `API 请求失败，HTTP 状态码: ${response.status}`,
      details: errorDetails.details || null,
      rawError: data
    };
  }

  const extractedText = extractOutputText(data);
  data.output_text = extractedText;

  logMessage('info', 'Gemini Interactions API returned success', {
    id: data.id,
    status: data.status,
    environment_id: data.environment_id,
    outputTextLength: extractedText.length,
    usage: data.usage
  });

  return data;
}

// Local persistence API. API keys intentionally never enter this database.
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    version: '1.8.0',
    sandboxDirectKey: true,
    storage: { type: 'sqlite', ...database.stats() }
  });
});

app.get('/api/sessions', (req, res) => {
  try {
    res.json({ success: true, sessions: database.listSessions() });
  } catch (error) {
    logMessage('error', 'Failed to read sessions from SQLite', { message: error.message });
    res.status(500).json({ success: false, error: { code: 'DATABASE_READ_FAILED', message: error.message } });
  }
});

app.post('/api/sessions/import', (req, res) => {
  try {
    const result = database.importLegacySessions(req.body.sessions);
    res.json({ success: true, imported: result });
  } catch (error) {
    logMessage('error', 'Failed to import legacy sessions', { message: error.message });
    res.status(500).json({ success: false, error: { code: 'DATABASE_IMPORT_FAILED', message: error.message } });
  }
});

app.delete('/api/sessions/:sessionId', (req, res) => {
  try {
    const deleted = database.deleteSession(req.params.sessionId);
    res.status(deleted ? 200 : 404).json({
      success: deleted,
      error: deleted ? undefined : { code: 'SESSION_NOT_FOUND', message: '会话不存在或已被删除' }
    });
  } catch (error) {
    logMessage('error', 'Failed to delete session', { message: error.message });
    res.status(500).json({ success: false, error: { code: 'DATABASE_DELETE_FAILED', message: error.message } });
  }
});

function resolveSandboxRequest(req, res) {
  try {
    const credentials = resolveSandboxCredentials(req, {
      database,
      masterKey: GATEWAY_MASTER_KEY,
      adminToken: GATEWAY_ADMIN_TOKEN
    });
    const proxyConfig = resolveSandboxProxy(req.body || {}, credentials);
    return { credentials, proxyConfig };
  } catch (error) {
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 400;
    logMessage('warn', 'Sandbox credential resolution failed', {
      code: error.code,
      message: error.message
    });
    res.status(status).json({
      success: false,
      error: {
        code: error.code || 'MISSING_API_KEY',
        message: error.message || '未提供可用的沙盒 Key'
      }
    });
    return null;
  }
}

// 1. Create or Continue Interaction
// WebUI submissions pick an upstream key and call Gemini Interactions directly.
// They do not enter the protocol gateway, so clone / fork / 100k TPM rules do not apply.
app.post('/api/interactions/create', async (req, res) => {
  const resolved = resolveSandboxRequest(req, res);
  if (!resolved) return;
  const { credentials, proxyConfig } = resolved;
  const apiKey = credentials.apiKey;

  const {
    agent = 'antigravity-preview-05-2026',
    input,
    environment = 'remote',
    model = 'gemini-3.7-flash',
    maxTotalTokens,
    tools,
    previousInteractionId,
    localSessionId,
    startNewSession = false
  } = req.body;
  const shouldStartNewSession = startNewSession === true;

  const payload = {
    agent,
    input,
    environment
  };

  try {
    applySandboxFiles(payload, req.body);
  } catch (error) {
    return res.status(error.status && error.status >= 400 && error.status < 600 ? error.status : 400).json({
      success: false,
      error: { code: error.code || 'INVALID_SOURCES', message: error.message }
    });
  }

  const agentConfig = {
    type: 'antigravity'
  };
  const resolvedModel = resolveSandboxModel(model);
  if (resolvedModel) agentConfig.model = resolvedModel;
  if (maxTotalTokens && Number(maxTotalTokens) > 0) {
    agentConfig.max_total_tokens = Number(maxTotalTokens);
  }
  payload.agent_config = agentConfig;

  if (tools && Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
  }

  if (previousInteractionId && !shouldStartNewSession) {
    payload.previous_interaction_id = previousInteractionId;
  }

  try {
    const result = await callGeminiInteractionsApi(apiKey, payload, proxyConfig);
    const environmentId = result.environment_id ||
      (typeof environment === 'string' && environment !== 'remote' ? environment : null);
    const outputText = result.output_text || '';
    if (environmentId) {
      const savedInteraction = database.saveInteraction({
        environmentId,
        sessionId: shouldStartNewSession ? null : localSessionId,
        previousInteractionId: shouldStartNewSession ? null : previousInteractionId,
        interactionId: result.id,
        prompt: extractPrompt(input),
        outputText,
        steps: result.steps,
        status: result.status,
        model,
        usage: result.usage,
        request: sanitizeForStorage(payload),
        timestamp: Date.now(),
        upstreamKeyId: credentials.keyId || undefined
      });
      result.local_session_id = savedInteraction?.sessionId || localSessionId || null;
      snapshotCache.invalidate(environmentId);
      for (const filePath of findArtifactPaths(outputText)) {
        database.recordArtifact({
          environmentId,
          interactionId: result.id,
          filePath,
          filename: path.basename(filePath),
          provider: 'detected'
        });
      }
    }
    res.json({ success: true, data: result, sessionId: result.local_session_id || null });
  } catch (err) {
    logMessage('error', 'Interaction creation handler caught error', err);
    const environmentId = typeof environment === 'string' && environment !== 'remote' ? environment : null;
    try {
      database.recordError({
        environmentId,
        previousInteractionId,
        code: err.code,
        httpStatus: err.status,
        message: err.message,
        request: sanitizeForStorage(payload),
        error: sanitizeForStorage(err)
      });
    } catch (databaseError) {
      logMessage('error', 'Failed to persist task error', { message: databaseError.message });
    }
    res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500).json({
      success: false,
      error: err,
      requestPayload: payload
    });
  }
});

// 2. Fetch/Download File Endpoint - Chunked Safe Extraction (No Gemini Safety Refusal & No Truncation)
app.post('/api/interactions/fetch-file', async (req, res) => {
  const resolved = resolveSandboxRequest(req, res);
  if (!resolved) return;
  const { credentials, proxyConfig } = resolved;
  const apiKey = credentials.apiKey;
  const { environmentId, filePath, provider = 'snapshot', forceRefresh = false } = req.body;
  const { useProxy, proxyUrl } = proxyConfig;
  if (!environmentId || !filePath) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMS', message: 'Missing environmentId or filePath' }
    });
  }

  // Snapshot extraction never invokes a shell, so it can safely support spaces
  // and non-ASCII filenames. Legacy providers still use shell commands and keep
  // their stricter allowlist below.
  const filePathSegments = typeof filePath === 'string' ? filePath.replace(/\\/g, '/').split('/') : [];
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0') || filePathSegments.includes('..')) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_FILE_PATH', message: '文件路径不合法：不能是空路径，也不能包含 .. 或空字节' }
    });
  }

  if (provider !== 'snapshot' && !/^\/[A-Za-z0-9_\-./]+$/.test(filePath)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_FILE_PATH', message: '该备用传输方式仅支持由字母、数字及 _ - . / 组成的绝对路径' }
    });
  }

  const filename = path.basename(filePath);

  // Official Files API: download the environment TAR snapshot and safely read
  // the requested entry without asking the model to print the file as Base64.
  if (provider === 'snapshot') {
    try {
      const result = await fetchFileFromEnvironmentSnapshot(
        apiKey,
        environmentId,
        filePath,
        { useProxy, proxyUrl },
        forceRefresh
      );
      const actualFilename = path.posix.basename(result.archivePath) || filename;
      database.recordArtifact({
        environmentId,
        filePath: result.archivePath,
        filename: actualFilename,
        provider: 'snapshot',
        sizeBytes: result.buffer.length
      });
      logMessage('info', 'File extracted from official environment snapshot', {
        environmentId,
        requestedPath: filePath,
        archivePath: result.archivePath,
        matchedBy: result.matchedBy,
        sizeBytes: result.buffer.length,
        snapshotBytesScanned: result.archiveBytes,
        snapshotCache: result.cacheHit ? 'HIT' : 'MISS'
      });
      if (String(req.headers.accept || '').includes('application/octet-stream')) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', result.buffer.length);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(actualFilename)}`);
        res.setHeader('X-File-Name', encodeURIComponent(actualFilename));
        res.setHeader('X-Archive-Path', encodeURIComponent(result.archivePath));
        res.setHeader('X-Matched-By', result.matchedBy || 'exact');
        res.setHeader('X-Snapshot-Cache', result.cacheHit ? 'HIT' : 'MISS');
        return res.send(result.buffer);
      }
      return res.json({
        success: true,
        method: 'base64',
        provider: 'snapshot',
        filename: actualFilename,
        filePath: result.archivePath,
        matchedBy: result.matchedBy,
        cacheHit: result.cacheHit,
        base64Data: result.buffer.toString('base64'),
        sizeBytes: result.buffer.length
      });
    } catch (error) {
      logMessage('error', 'Official environment snapshot extraction failed', {
        code: error.code,
        status: error.status,
        message: error.message,
        availablePaths: error.availablePaths
      });
      return res.status(error.status && error.status >= 400 && error.status < 600 ? error.status : 500).json({
        success: false,
        error: {
          code: error.code || 'SNAPSHOT_EXTRACTION_FAILED',
          message: error.message,
          availablePaths: error.availablePaths || undefined,
          hint: error.code === 'FILE_NOT_FOUND_IN_SNAPSHOT'
            ? '可以只输入文件名让系统自动定位，或从 availablePaths 中选择 Agent 实际写入的路径。'
            : error.code === 'MULTIPLE_FILES_IN_SNAPSHOT'
              ? '存在多个同名文件，请从 availablePaths 中复制所需文件的完整路径。'
              : '可在界面中切换到“旧版 Agent Base64 分块提取”作为备用。'
        }
      });
    }
  }

  // External Cloud URL Providers (transfer.sh removed: service has been shut down)
  if (provider === 'fileio' || provider === 'catbox') {
    let promptCommand, urlRegex;
    if (provider === 'fileio') {
      promptCommand = `Execute bash command directly: curl -s -F "file=@${filePath}" "https://file.io"`;
      urlRegex = /(https?:\/\/file\.io\/[^\s"'\n\}]+)/i;
    } else {
      promptCommand = `Execute bash command directly: curl -s -F "reqtype=fileupload" -F "fileToUpload=@${filePath}" "https://catbox.moe/user/api.php"`;
      urlRegex = /(https?:\/\/files\.catbox\.moe\/[^\s"'\n]+)/i;
    }

    const payload = {
      agent: 'antigravity-preview-05-2026',
      input: promptCommand,
      environment: environmentId,
      agent_config: { type: 'antigravity', model: 'gemini-3.6-flash' },
      tools: [{ type: 'code_execution' }]
    };

    try {
      logMessage('info', `Attempting external cloud upload (${provider}) for "${filePath}"...`);
      const result = await callGeminiInteractionsApi(apiKey, payload, { useProxy, proxyUrl });
      const outputText = result.output_text || '';

      const urlMatch = outputText.match(urlRegex) || outputText.match(/(https?:\/\/[^\s"'\n]+)/i);
      if (urlMatch && urlMatch[1]) {
        const downloadUrl = urlMatch[1].trim();
        database.recordArtifact({
          environmentId,
          filePath,
          filename,
          provider,
          downloadUrl
        });
        return res.json({
          success: true,
          method: 'cloud_url',
          provider,
          downloadUrl,
          filename,
          filePath
        });
      }
      logMessage('warn', `External cloud upload (${provider}) output did not match URL. Output: ${outputText}`);
    } catch (e) {
      logMessage('warn', `External cloud provider (${provider}) failed, falling back to Chunked Extraction...`);
    }
  }

  // LEGACY FALLBACK: ask the agent to print the file in Base64 chunks.
  logMessage('info', `Starting Chunked Safe Extraction for "${filePath}" in environment ${environmentId}...`);

  const chunkSize = 65536; // 64KB per chunk -> ~85KB Base64 text per model output (safe, 25x fewer API calls than 2.5KB)
  let offset = 0;
  const fileBuffers = [];
  let eof = false;
  let attempts = 0;
  const maxAttempts = 100; // Up to ~6.4MB per file

  try {
    while (!eof && attempts < maxAttempts) {
      attempts++;
      const pythonCmd = `Execute bash command: python3 -c "import base64; f=open('${filePath}', 'rb'); f.seek(${offset}); data=f.read(${chunkSize}); print('===CHUNK_START===\\n' + base64.b64encode(data).decode('ascii') + '\\n===CHUNK_END===\\nEOF:' + str(len(data) < ${chunkSize}))"`;

      const payload = {
        agent: 'antigravity-preview-05-2026',
        input: pythonCmd,
        environment: environmentId,
        agent_config: { type: 'antigravity', model: 'gemini-3.6-flash' },
        tools: [{ type: 'code_execution' }]
      };

      const result = await callGeminiInteractionsApi(apiKey, payload, { useProxy, proxyUrl });
      const outputText = result.output_text || '';

      const b64Str = parseBase64FromOutput(outputText);
      if (!b64Str) {
        logMessage('warn', `Chunk #${attempts} parse failed at offset ${offset}. Output: ${outputText}`);
        break;
      }

      const chunkBuf = Buffer.from(b64Str, 'base64');
      fileBuffers.push(chunkBuf);
      offset += chunkBuf.length;

      logMessage('info', `Chunk #${attempts} retrieved: ${chunkBuf.length} bytes. Total so far: ${offset} bytes.`);

      if (outputText.includes('EOF:True') || chunkBuf.length < chunkSize || chunkBuf.length === 0) {
        eof = true;
      }
    }

    if (fileBuffers.length === 0) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'CHUNKED_FETCH_FAILED',
          message: `无法从远程沙盒提取文件 "${filePath}"。`
        }
      });
    }

    const finalBuffer = Buffer.concat(fileBuffers);
    const finalBase64 = finalBuffer.toString('base64');

    logMessage('info', `Chunked Extraction complete! Total size: ${finalBuffer.length} bytes for ${filename}`);

    database.recordArtifact({
      environmentId,
      filePath,
      filename,
      provider: 'chunked',
      sizeBytes: finalBuffer.length
    });

    return res.json({
      success: true,
      method: 'base64',
      provider: 'chunked',
      filename,
      filePath,
      base64Data: finalBase64,
      sizeBytes: finalBuffer.length
    });

  } catch (err) {
    logMessage('error', 'Chunked fetch file handler caught error', err);
    try {
      database.recordError({
        environmentId,
        code: err.code || 'FILE_FETCH_FAILED',
        httpStatus: err.status || 500,
        message: err.message || 'Remote file extraction failed',
        request: { filePath, provider },
        error: sanitizeForStorage(err)
      });
    } catch (databaseError) {
      logMessage('error', 'Failed to persist file extraction error', { message: databaseError.message });
    }
    res.status(500).json({
      success: false,
      error: err
    });
  }
});

// 3. Get Logs Endpoint
app.get('/api/logs', (req, res) => {
  res.json({ logs: serverLogs });
});

const server = app.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  logMessage('info', `Antigravity Agent Web UI Server started on http://${displayHost}:${PORT}`, {
    host: HOST,
    database: DATABASE_PATH,
    gatewayEnabled: GATEWAY_ENABLED,
    gatewayConfigured: Boolean(GATEWAY_MASTER_KEY)
  });
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logMessage('error', `Port ${PORT} is already in use. Stale node process may be running.`);
    console.error(`\n❌ [ERROR] ${HOST}:${PORT} 已被占用！请停止旧服务，或修改 PORT 后重新启动。\n`);
    process.exit(1);
  } else {
    logMessage('error', 'Server start error', err);
  }
});

let isShuttingDown = false;
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logMessage('info', `Received ${signal}, shutting down gracefully`);
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, database, server };
