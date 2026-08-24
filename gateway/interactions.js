const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;

function resolveEnvProxyUrl() {
  const raw = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.PROXY_URL || '';
  if (!raw) return null;
  let targetUrl = String(raw).trim();
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = `http://127.0.0.1:${targetUrl}`;
  }
  return targetUrl;
}

function agentFor(proxyUrl) {
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}

async function consumeSseFrame(raw, onEvent) {
  const data = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return;
  try {
    await onEvent(JSON.parse(data));
  } catch {
    // ignore malformed SSE chunks
  }
}

async function parseSseStream(stream, onEvent) {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString('utf8').replace(/\r\n/g, '\n');
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      await consumeSseFrame(raw, onEvent);
    }
  }
  if (buffer.trim()) await consumeSseFrame(buffer, onEvent);
}

async function downloadImage(url, proxyUrl) {
  const options = { timeout: 30000, redirect: 'follow' };
  const agent = agentFor(proxyUrl);
  if (agent) options.agent = agent;
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = new Error(`Failed to download image (${response.status})`);
    error.status = 400;
    throw error;
  }
  const buffer = await response.buffer();
  if (buffer.length > IMAGE_LIMIT_BYTES) {
    const error = new Error('Image exceeds the 10 MB gateway limit');
    error.status = 400;
    throw error;
  }
  const mime = response.headers.get('content-type') || 'image/png';
  return { mime_type: mime.split(';')[0], data: buffer.toString('base64') };
}

async function hydrateImages(input, proxyUrl) {
  if (typeof input === 'string' || !input) return input;
  if (!Array.isArray(input)) return input;
  const next = [];
  for (const part of input) {
    if (part && part.type === 'image' && part.url && !part.data) {
      const downloaded = await downloadImage(part.url, proxyUrl);
      next.push({ type: 'image', mime_type: downloaded.mime_type, data: downloaded.data });
    } else if (part && part.type === 'image' && part.data) {
      next.push({ type: 'image', mime_type: part.mime_type || 'image/png', data: part.data });
    } else {
      next.push(part);
    }
  }
  return next;
}

async function callInteractions({
  apiKey,
  payload,
  proxyUrl,
  stream = false,
  onEvent
}) {
  const proxy = proxyUrl || resolveEnvProxyUrl();
  const body = { ...payload };
  body.input = await hydrateImages(body.input, proxy);
  if (stream) body.stream = true;

  const url = stream ? `${GEMINI_INTERACTIONS_URL}?alt=sse` : GEMINI_INTERACTIONS_URL;
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body),
    timeout: REQUEST_TIMEOUT_MS
  };
  const agent = agentFor(proxy);
  if (agent) options.agent = agent;

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const wrapped = new Error(`网络连接至 Google Gemini API 失败: ${error.message}`);
    wrapped.status = 502;
    wrapped.code = 'FETCH_FAILED';
    throw wrapped;
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (stream && response.ok && contentType.includes('application/json') && !contentType.includes('event-stream')) {
    const data = await response.json();
    if (onEvent) await onEvent(data);
    return data;
  }

  if (stream && response.ok) {
    const events = [];
    await parseSseStream(response.body, async (event) => {
      events.push(event);
      if (onEvent) await onEvent(event);
    });
    return { stream: true, events, status: response.status };
  }

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    const error = new Error(`收到非 JSON 的异常响应 (HTTP ${response.status})`);
    error.status = response.status;
    error.code = 'INVALID_RESPONSE';
    error.rawOutput = responseText;
    throw error;
  }

  if (!response.ok) {
    const details = data.error || {};
    const error = new Error(details.message || `Gemini API HTTP ${response.status}`);
    error.status = response.status;
    error.code = details.status || details.code || `HTTP_${response.status}`;
    error.rawError = data;
    throw error;
  }

  return data;
}

module.exports = {
  GEMINI_INTERACTIONS_URL,
  IMAGE_LIMIT_BYTES,
  resolveEnvProxyUrl,
  callInteractions,
  hydrateImages,
  downloadImage
};
