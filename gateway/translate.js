const crypto = require('crypto');
const { AGENT_ID } = require('./models');

const DEFAULT_ANTIGRAVITY_TOOLS = [
  { type: 'code_execution' },
  { type: 'google_search' },
  { type: 'url_context' }
];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function textOfContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (typeof content.text === 'string') return content.text;
    return '';
  }
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
    if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') return '[image]';
    return '';
  }).join('');
}

function textOfMessage(message) {
  if (!message) return '';
  return textOfContent(message.content) || textOfContent(message.text) || '';
}

function imageFingerprint(part) {
  if (!part) return '[image]';
  const url = typeof part === 'string' ? part : (part.url || part.image_url?.url || part.image_url || '');
  if (typeof url === 'string' && url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const meta = comma >= 0 ? url.slice(0, comma) : 'data:image';
    const data = comma >= 0 ? url.slice(comma + 1) : '';
    return `[image:${meta}:${data.length}]`;
  }
  if (part.data) return `[image:${part.mime_type || part.mimeType || 'image'}:${String(part.data).length}]`;
  return `[image:${String(url).slice(0, 80)}]`;
}

function normalizeForHash(message) {
  if (!message) return null;
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => call.id || call.function?.name || '')
    : undefined;
  const content = message.content;
  let text = textOfMessage(message);
  if (Array.isArray(content)) {
    text = content.map((part) => {
      if (!part || typeof part === 'string') return part || '';
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
      if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') return imageFingerprint(part);
      return '';
    }).join('');
  }
  return {
    role: message.role || '',
    text,
    tool_call_id: message.tool_call_id || null,
    name: message.name || null,
    tool_calls: toolCalls
  };
}

function fingerprintMessages(messages) {
  return (messages || []).filter((message) => {
    const role = message?.role;
    return role === 'user' || role === 'tool' || role === 'function';
  });
}

function hashNonAssistant(messages) {
  return sha256(JSON.stringify(fingerprintMessages(messages).map(normalizeForHash)));
}

function parseDataUrl(url) {
  const match = String(url || '').match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  return { type: 'image', mime_type: match[1], data: match[2] };
}

function parseImageRef(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const dataUrl = parseDataUrl(value);
    if (dataUrl) return dataUrl;
    if (/^https?:\/\//i.test(value)) return { type: 'image', url: value };
    return { type: 'image', mime_type: 'image/png', data: value };
  }
  if (value.type === 'image' && (value.data || value.url)) {
    return {
      type: 'image',
      mime_type: value.mime_type || value.mimeType || 'image/png',
      data: value.data,
      url: value.url
    };
  }
  const url = value.url || value.image_url?.url || value.image_url;
  if (typeof url === 'string') return parseImageRef(url);
  if (value.data || value.inline_data || value.inlineData) {
    const inline = value.inline_data || value.inlineData || value;
    return {
      type: 'image',
      mime_type: inline.mime_type || inline.mimeType || 'image/png',
      data: inline.data
    };
  }
  return null;
}

function openaiMessageToInputParts(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textOfMessage(message);

  const parts = [];
  for (const item of content) {
    if (item == null) continue;
    if (typeof item === 'string') {
      if (item) parts.push({ type: 'text', text: item });
      continue;
    }
    const type = item.type;
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      if (item.text) parts.push({ type: 'text', text: item.text });
    } else if (type === 'image_url' || type === 'input_image' || type === 'image') {
      const image = parseImageRef(item.image_url || item);
      if (image) parts.push(image);
    } else if (item.inline_data || item.inlineData) {
      const image = parseImageRef(item);
      if (image) parts.push(image);
    }
  }
  if (parts.length === 0) return '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

const CALL_MARKER_RE = /\[Calls:/i;
const TOOL_RESULT_MARKER_RE = /Tool result\s*\(/i;
const FAKE_SUCCESS_RE = /Message sent to session/i;

function estimateTokens(value) {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function redactSensitive(text) {
  return String(text || '')
    .replace(/AIzaSy[0-9A-Za-z\-_]{10,}/g, '[redacted-key]')
    .replace(/\bsk-[A-Za-z0-9]{10,}/g, '[redacted-secret]')
    .replace(/data:[^;]+;base64,[A-Za-z0-9+/=]{80,}/g, '[omitted-base64]');
}

function isSuspectedModelGeneratedToolTrace(text) {
  const value = String(text || '');
  return CALL_MARKER_RE.test(value) || TOOL_RESULT_MARKER_RE.test(value) || FAKE_SUCCESS_RE.test(value);
}

function stripFakeToolTrace(text) {
  return String(text || '')
    .replace(/\[Calls:[\s\S]*?\]/gi, '')
    .replace(/Tool result\s*\([^)]*\):[^\n]*/gi, '')
    .trim();
}

function observeCallMarkers(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  const matches = text.match(/\[Calls:/gi) || [];
  return {
    detected: matches.length > 0,
    count: matches.length,
    suspectedModelGenerated: isSuspectedModelGeneratedToolTrace(text)
  };
}

function summarizeToolHistory(messages, { maxItems = 12, maxResultChars = 400 } = {}) {
  const msgs = Array.isArray(messages) ? messages : [];
  const summaries = [];
  const orphans = [];
  const duplicates = [];
  const seenResults = new Set();
  const toolResultsById = new Map();

  for (const message of msgs) {
    if (message?.role !== 'tool' && message?.role !== 'function') continue;
    const id = message.tool_call_id || message.id;
    const raw = textOfMessage(message);
    if (!id && isSuspectedModelGeneratedToolTrace(raw)) continue;
    const text = redactSensitive(raw);
    if (!id) continue;
    if (toolResultsById.has(id)) duplicates.push(id);
    else toolResultsById.set(id, { name: message.name, text });
  }

  const claimedIds = new Set();
  for (const message of msgs) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const id = call.id;
      const name = call.function?.name || call.name || 'tool';
      claimedIds.add(id);
      const result = id ? toolResultsById.get(id) : null;
      if (!result) {
        orphans.push({ name, callId: id || null, status: 'orphan' });
        continue;
      }
      const resultKey = `${id}:${result.text.slice(0, 80)}`;
      if (seenResults.has(resultKey)) {
        duplicates.push(id);
        continue;
      }
      seenResults.add(resultKey);
      summaries.push({
        name,
        callId: id,
        status: 'completed',
        resultPreview: truncateText(result.text, maxResultChars)
      });
    }
  }

  return {
    summaries: summaries.slice(0, maxItems),
    orphans,
    duplicates,
    toolTraceStatus: summaries.length
      ? 'summary'
      : (orphans.length ? 'orphan' : (duplicates.length ? 'duplicate' : 'none'))
  };
}

function formatToolSummaryBlock(summaryResult) {
  if (!summaryResult?.summaries?.length && !summaryResult?.orphans?.length) return '';
  const lines = ['历史工具执行摘要（仅供参考，不是当前待执行调用）：'];
  for (const item of summaryResult.summaries || []) {
    lines.push(`工具名：${item.name}`);
    lines.push(`调用标识：${item.callId || 'unknown'}`);
    lines.push('执行状态：已完成');
    lines.push(`结果摘要：${item.resultPreview}`);
    lines.push('');
  }
  for (const item of summaryResult.orphans || []) {
    lines.push(`工具名：${item.name}`);
    lines.push(`调用标识：${item.callId || 'unknown'}`);
    lines.push('执行状态：未配对（无结果）');
    lines.push('');
  }
  return lines.join('\n').trim();
}

function collapseInputParts(parts) {
  const list = (parts || []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1 && list[0].type === 'text') return list[0].text;
  return list;
}

function collectSafeHistoryParts(messages) {
  const parts = [];
  for (const message of messages || []) {
    if (!message || message.role === 'system') continue;
    if (message.role === 'tool' || message.role === 'function') continue;

    const converted = openaiMessageToInputParts(message);
    const label = message.role === 'assistant' ? 'Assistant' : 'User';

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const contentText = typeof converted === 'string'
        ? converted
        : (Array.isArray(converted) ? converted.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n') : '');
      const visible = stripFakeToolTrace(contentText);
      if (visible) parts.push({ type: 'text', text: `${label}: ${visible}` });
      continue;
    }

    if (typeof converted === 'string') {
      const text = message.role === 'assistant' ? stripFakeToolTrace(converted) : converted;
      if (text) parts.push({ type: 'text', text: `${label}: ${text}` });
      continue;
    }

    if (Array.isArray(converted)) {
      const textParts = converted.filter((part) => part.type === 'text');
      const imageParts = converted.filter((part) => part.type === 'image');
      const joined = textParts.map((part) => part.text).join('\n');
      const text = message.role === 'assistant' ? stripFakeToolTrace(joined) : joined;
      if (text) parts.push({ type: 'text', text: `${label}: ${text}` });
      else if (imageParts.length) parts.push({ type: 'text', text: `${label}:` });
      parts.push(...imageParts);
    }
  }
  return parts;
}

function buildSafeHistoryInput(messages, {
  kind = 'history',
  extraParts = [],
  maxInputTokens = 24000,
  preamble
} = {}) {
  const summary = summarizeToolHistory(messages);
  const summaryBlock = formatToolSummaryBlock(summary);
  const historyParts = collectSafeHistoryParts(messages);
  const lead = [];
  if (preamble) lead.push({ type: 'text', text: preamble });
  if (summaryBlock) lead.push({ type: 'text', text: summaryBlock });

  let kept = historyParts.slice();
  const extras = Array.isArray(extraParts) ? extraParts.filter(Boolean) : [];
  const assemble = (turns) => collapseInputParts([...lead, ...turns, ...extras]);
  let input = assemble(kept);
  let truncated = false;
  while (estimateTokens(input) > maxInputTokens && kept.length > 1) {
    kept = kept.slice(1);
    input = assemble(kept);
    truncated = true;
  }
  return {
    input,
    summary,
    truncated,
    estimatedTokens: estimateTokens(input),
    callMarkers: observeCallMarkers(messages)
  };
}

function flattenMessagesToInput(messages, options = {}) {
  return buildSafeHistoryInput(messages, options).input;
}

function deriveForkConversationKey(sourceKey, requestId, prefixHash) {
  const req = requestId || `fork_${Date.now()}`;
  const hash = String(prefixHash || 'none').slice(0, 16);
  return `${sourceKey}:fork:${req}:${hash}`;
}

function classifyPrefixMismatch(stored, msgs) {
  const transcript = parseTranscript(stored);
  const lastUser = lastUserMessage(msgs);
  const lastUserText = textOfMessage(lastUser);
  const storedUsers = transcript.filter((turn) => turn.role === 'user').map((turn) => String(turn.text || ''));

  if (lastUserText && storedUsers.length >= 2) {
    const earlier = storedUsers.slice(0, -1);
    if (earlier.includes(lastUserText) && lastUserText !== storedUsers[storedUsers.length - 1]) {
      return 'replayed_old_message';
    }
  }

  const currentCount = (msgs || []).filter((message) => message && message.role !== 'system').length;
  if (transcript.length > 0 && currentCount < transcript.length) {
    const lastAssistant = [...transcript].reverse().find((turn) => turn.role === 'assistant');
    const currentAssistantTexts = (msgs || []).filter((message) => message.role === 'assistant').map(textOfMessage);
    const hasLastAssistant = lastAssistant?.text
      && currentAssistantTexts.some((text) => text && String(text).includes(String(lastAssistant.text).slice(0, 80)));
    if (!hasLastAssistant) return 'truncated_history';
    return 'compressed_context_not_verifiable';
  }

  return 'prefix_mismatch';
}

function withConversationMeta(conversation, extra = {}) {
  const mode = extra.mode || conversation.mode;
  const sourceKey = extra.sourceConversationKey || conversation.sourceConversationKey || conversation.conversationKey;
  return {
    ...conversation,
    ...extra,
    mode,
    conversationMode: extra.conversationMode || extra.mode || conversation.conversationMode || mode,
    sourceConversationKey: sourceKey,
    targetConversationKey: extra.targetConversationKey
      || conversation.targetConversationKey
      || conversation.conversationKey,
    upstreamTransition: extra.upstreamTransition || conversation.upstreamTransition || 'none',
    contextRebuildReason: extra.contextRebuildReason !== undefined
      ? extra.contextRebuildReason
      : (conversation.contextRebuildReason || null),
    forkReason: extra.forkReason !== undefined ? extra.forkReason : (conversation.forkReason || null)
  };
}

function resolveStoredConversation(database, tokenId, sourceKey, messages) {
  if (!database || typeof database.listGatewayConversationsForSource !== 'function') {
    return database?.getGatewayConversation?.(tokenId, sourceKey) || null;
  }
  const rows = database.listGatewayConversationsForSource(tokenId, sourceKey);
  if (!rows.length) return null;
  const msgs = Array.isArray(messages) ? messages : [];
  const toolMessages = trailingToolMessages(msgs);
  const isToolTurn = toolMessages.length > 0;
  const prefix = isToolTurn ? msgs.slice(0, msgs.length - toolMessages.length) : msgs.slice(0, -1);
  const prefixHash = hashNonAssistant(prefix);
  const exact = rows.find((row) => row.prefix_hash === prefixHash);
  if (exact) return exact;

  const withoutSystem = msgs.filter((message) => message?.role !== 'system');
  const prefixWithoutSystem = isToolTurn
    ? withoutSystem.slice(0, withoutSystem.length - toolMessages.length)
    : withoutSystem.slice(0, -1);
  const altHash = hashNonAssistant(prefixWithoutSystem);
  const sysMatch = rows.find((row) => row.prefix_hash === altHash);
  if (sysMatch) return sysMatch;
  return rows.find((row) => row.conversation_key === sourceKey) || rows[0] || null;
}

function lastUserMessage(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i];
  }
  return null;
}

function trailingToolMessages(messages) {
  const tools = [];
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === 'tool' || role === 'function') tools.unshift(messages[i]);
    else break;
  }
  return tools;
}

function conversationKeyFrom({ messages, headers = {}, body = {} }) {
  if (body.previous_response_id) return `resp:${body.previous_response_id}`;
  const sessionId = headers['x-session-id'] || headers['x-ag-session-id'];
  if (sessionId) return `hdr:${sessionId}`;
  // Fallback: use fingerprint of first user message.
  // This is inherently unsafe for multi-session scenarios (two windows sending
  // identical first messages will collide), but we keep it for backward
  // compatibility when enforce_session_header is disabled.
  const user = (messages || []).find((message) => message.role === 'user');
  return `fp:${sha256(textOfMessage(user))}`;
}

/**
 * 验证请求中是否包含稳定的 session 标识。
 * 当 enforce 为 true 时，缺少 header 会抛出 400 错误。
 * @param {object} params - 包含 headers、body 和 enforce 标志
 * @returns {string} conversationKey
 */
function requireConversationKey({ messages, headers = {}, body = {}, enforce = false }) {
  if (body.previous_response_id) return `resp:${body.previous_response_id}`;
  const sessionId = headers['x-session-id'] || headers['x-ag-session-id'];
  if (sessionId) return `hdr:${sessionId}`;
  if (enforce) {
    const error = new Error(
      'Missing x-session-id or x-ag-session-id header. '
      + 'A stable session identifier is required to prevent conversation cross-talk. '
      + 'Set it to a unique value per QQ conversation window (e.g. qq:private:{user_id} or qq:group:{group_id}).'
    );
    error.status = 400;
    error.code = 'missing_session_id';
    throw error;
  }
  const user = (messages || []).find((message) => message.role === 'user');
  return `fp:${sha256(textOfMessage(user))}`;
}

function headerFlag(headers, name) {
  const value = headers?.[name];
  return value === 'true' || value === '1';
}

function toFunctionResult(message, resolveCallId) {
  const openaiId = message.tool_call_id || message.id;
  const callId = typeof resolveCallId === 'function' ? resolveCallId(openaiId) : openaiId;
  const text = textOfMessage(message);
  return {
    type: 'function_result',
    name: message.name || 'tool',
    call_id: callId || openaiId,
    result: [{ type: 'text', text: text || '' }]
  };
}

function buildOpenAIConversation({
  messages,
  headers = {},
  body = {},
  stored = null,
  resolveCallId,
  requestId,
  sourceConversationKey,
  maxInputTokens
} = {}) {
  const msgs = Array.isArray(messages) ? messages : [];
  const stateless = headerFlag(headers, 'x-ag-stateless') || body.store === false;
  const reuseEnv = headerFlag(headers, 'x-ag-reuse-environment');
  const systemInstruction = msgs
    .filter((message) => message?.role === 'system')
    .map(textOfMessage)
    .filter(Boolean)
    .join('\n') || undefined;
  const lookupKey = sourceConversationKey || conversationKeyFrom({ messages: msgs, headers, body });
  const storedKey = stored?.conversation_key || lookupKey;
  const nextPrefixHash = hashNonAssistant(msgs);
  const callMarkers = observeCallMarkers(msgs);

  if (stateless) {
    const rebuilt = buildSafeHistoryInput(msgs, { kind: 'history', maxInputTokens });
    return withConversationMeta({
      input: rebuilt.input,
      environment: reuseEnv && stored?.environment_id ? stored.environment_id : 'remote',
      previousInteractionId: undefined,
      systemInstruction,
      conversationKey: lookupKey,
      nextPrefixHash,
      mode: 'stateless',
      upstreamKeyId: stored?.upstream_key_id || null,
      toolTraceStatus: rebuilt.summary.toolTraceStatus,
      callMarkers
    }, { sourceConversationKey: lookupKey, targetConversationKey: lookupKey });
  }

  const toolMessages = trailingToolMessages(msgs);
  const isToolTurn = toolMessages.length > 0;
  const last = msgs[msgs.length - 1];
  const prefix = isToolTurn ? msgs.slice(0, msgs.length - toolMessages.length) : msgs.slice(0, -1);
  const prefixHash = hashNonAssistant(prefix);

  const input = isToolTurn
    ? toolMessages.map((message) => toFunctionResult(message, resolveCallId))
    : openaiMessageToInputParts(last || lastUserMessage(msgs));

  const withoutSystem = msgs.filter((m) => m.role !== 'system');
  const isMultiTurn = withoutSystem.length > 1;

  if (!stored) {
    const rebuilt = isMultiTurn ? buildSafeHistoryInput(msgs, { kind: 'history', maxInputTokens }) : null;
    return withConversationMeta({
      input: rebuilt ? rebuilt.input : input,
      environment: 'remote',
      previousInteractionId: undefined,
      systemInstruction,
      conversationKey: lookupKey,
      nextPrefixHash,
      mode: 'new',
      upstreamKeyId: null,
      toolTraceStatus: rebuilt?.summary.toolTraceStatus || 'none',
      callMarkers
    }, { sourceConversationKey: lookupKey, targetConversationKey: lookupKey });
  }

  if (stored.prefix_hash !== prefixHash) {
    const prefixWithoutSystem = isToolTurn
      ? withoutSystem.slice(0, withoutSystem.length - toolMessages.length)
      : withoutSystem.slice(0, -1);
    const storedWithoutSystem = hashNonAssistant(prefixWithoutSystem);

    if (storedWithoutSystem === stored.prefix_hash && stored.interaction_id) {
      return withConversationMeta({
        input,
        environment: stored.environment_id || 'remote',
        previousInteractionId: stored.interaction_id,
        systemInstruction,
        conversationKey: storedKey,
        nextPrefixHash,
        mode: 'continue',
        upstreamKeyId: stored.upstream_key_id || null,
        callMarkers
      }, { sourceConversationKey: lookupKey, targetConversationKey: storedKey });
    }

    const forkReason = classifyPrefixMismatch(stored, msgs);
    const targetConversationKey = deriveForkConversationKey(lookupKey, requestId, nextPrefixHash);
    const rebuilt = buildSafeHistoryInput(msgs, { kind: 'history', maxInputTokens });
    return withConversationMeta({
      input: isMultiTurn ? rebuilt.input : openaiMessageToInputParts(lastUserMessage(msgs) || last),
      environment: reuseEnv && stored.environment_id ? stored.environment_id : 'remote',
      previousInteractionId: undefined,
      systemInstruction,
      conversationKey: lookupKey,
      nextPrefixHash,
      mode: 'fork',
      upstreamKeyId: stored.upstream_key_id || null,
      toolTraceStatus: rebuilt.summary.toolTraceStatus,
      callMarkers
    }, {
      sourceConversationKey: lookupKey,
      targetConversationKey,
      forkReason
    });
  }

  return withConversationMeta({
    input,
    environment: stored.environment_id || 'remote',
    previousInteractionId: stored.interaction_id,
    systemInstruction,
    conversationKey: storedKey,
    nextPrefixHash,
    mode: 'continue',
    upstreamKeyId: stored.upstream_key_id || null,
    callMarkers
  }, { sourceConversationKey: lookupKey, targetConversationKey: storedKey });
}

function mapOpenAITool(tool) {
  if (!tool) return null;
  if (tool.type === 'mcp_server') return normalizeMcpServer(tool);
  const fn = tool.function || tool;
  if (tool.type && tool.type !== 'function' && !tool.function) return null;
  const name = fn.name;
  if (!name) return null;
  return {
    type: 'function',
    name,
    description: fn.description || '',
    parameters: fn.parameters || { type: 'object', properties: {} }
  };
}

function normalizeMcpServer(server) {
  if (!server || !server.url) return null;
  const name = String(server.name || 'mcp').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const mapped = {
    type: 'mcp_server',
    name,
    url: server.url
  };
  if (server.headers) mapped.headers = server.headers;
  if (Array.isArray(server.allowed_tools)) mapped.allowed_tools = server.allowed_tools;
  return mapped;
}

function mergeTools({ body = {}, headers = {}, includeBuiltin, tokenConfig = {} }) {
  const clientTools = [];
  const openaiTools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of openaiTools) {
    const mapped = mapOpenAITool(tool);
    if (mapped) clientTools.push(mapped);
  }

  const extra = body.extra_body || {};
  const mcpList = extra.mcp_servers || body.mcp_servers || [];
  if (Array.isArray(mcpList)) {
    for (const server of mcpList) {
      const mapped = normalizeMcpServer(server);
      if (mapped) clientTools.push(mapped);
    }
  }

  const headerDisable = headers['x-ag-antigravity-tools'] === 'false' || extra.antigravity_tools === false;
  const wantBuiltin = includeBuiltin !== false && !headerDisable;

  const builtinTools = [];
  if (wantBuiltin) {
    if (tokenConfig.tool_code_execution !== 0 && tokenConfig.toolCodeExecution !== 0) {
      builtinTools.push({ type: 'code_execution' });
    }
    if (tokenConfig.tool_google_search !== 0 && tokenConfig.toolGoogleSearch !== 0) {
      builtinTools.push({ type: 'google_search' });
    }
    if (tokenConfig.tool_url_context !== 0 && tokenConfig.toolUrlContext !== 0) {
      builtinTools.push({ type: 'url_context' });
    }
  }

  if (!clientTools.length) return builtinTools.length ? builtinTools : undefined;
  if (!builtinTools.length) return clientTools;
  return [...builtinTools, ...clientTools];
}

function pendingFunctionCalls(data) {
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  const executed = new Set(steps.filter((step) => step.type === 'function_result').map((step) => step.call_id));
  return steps.filter((step) => step.type === 'function_call' && !executed.has(step.id));
}

function extractOutputText(data) {
  if (data?.output_text && String(data.output_text).trim()) return data.output_text;
  const textParts = [];
  for (const step of data?.steps || []) {
    if (step.type !== 'model_output' && step.type !== 'output') continue;
    if (Array.isArray(step.content)) {
      for (const item of step.content) {
        if (item?.type === 'text' && item.text) textParts.push(item.text);
        else if (typeof item === 'string') textParts.push(item);
      }
    } else if (typeof step.content === 'string') {
      textParts.push(step.content);
    } else if (step.text) {
      textParts.push(step.text);
    }
  }
  return textParts.join('\n\n') || '';
}

function usageFromInteraction(data) {
  const usage = data?.usage || {};
  const prompt = Number(usage.total_input_tokens || usage.prompt_tokens || 0);
  const completion = Number(usage.total_output_tokens || usage.completion_tokens || 0);
  const total = Number(usage.total_tokens || prompt + completion);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total
  };
}

function toOpenAIToolCalls(calls, saveMapping) {
  return (calls || []).map((call) => {
    const googleId = call.id || call.call_id;
    const openaiId = googleId && String(googleId).startsWith('call_') ? googleId : `call_${googleId || crypto.randomUUID()}`;
    if (typeof saveMapping === 'function') {
      saveMapping({ openaiCallId: openaiId, googleCallId: googleId, name: call.name });
    }
    const args = call.arguments == null
      ? '{}'
      : (typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments));
    return {
      id: openaiId,
      type: 'function',
      function: {
        name: call.name,
        arguments: args
      }
    };
  });
}

function toChatCompletion({ data, requestedModel, saveMapping }) {
  const calls = pendingFunctionCalls(data);
  const toolCalls = calls.length ? toOpenAIToolCalls(calls, saveMapping) : undefined;
  const content = extractOutputText(data) || (toolCalls ? null : '');
  const usage = usageFromInteraction(data);
  return {
    id: data.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls ? { tool_calls: toolCalls } : {})
      },
      finish_reason: toolCalls ? 'tool_calls' : (data.status === 'incomplete' ? 'length' : 'stop')
    }],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens
    }
  };
}

function responsesInputToParts(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts = [];
  for (const item of input) {
    if (item == null) continue;
    if (typeof item === 'string') {
      parts.push({ type: 'text', text: item });
      continue;
    }
    const type = item.type;
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      if (item.text) parts.push({ type: 'text', text: item.text });
    } else if (type === 'input_image' || type === 'image') {
      const image = parseImageRef(item.image_url || item);
      if (image) parts.push(image);
    } else if (type === 'message') {
      const nested = responsesInputToParts(item.content);
      if (typeof nested === 'string') {
        if (nested) parts.push({ type: 'text', text: nested });
      } else if (Array.isArray(nested)) {
        parts.push(...nested);
      }
    } else if (type === 'function_call_output') {
      parts.push({
        type: 'function_result',
        name: item.name || 'tool',
        call_id: item.call_id,
        result: [{ type: 'text', text: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '') }]
      });
    }
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

function buildResponsesConversation({ body = {}, headers = {}, stored = null }) {
  const input = responsesInputToParts(body.input);
  const conversationKey = body.previous_response_id
    ? `resp:${body.previous_response_id}`
    : (headers['x-session-id'] || headers['x-ag-session-id']
      ? `hdr:${headers['x-session-id'] || headers['x-ag-session-id']}`
      : `fp:${sha256(typeof input === 'string' ? input : JSON.stringify(input))}`);
  const reuseEnv = headerFlag(headers, 'x-ag-reuse-environment');
  const systemInstruction = typeof body.instructions === 'string' ? body.instructions : undefined;

  if (body.previous_response_id && stored) {
    return withConversationMeta({
      input,
      environment: stored.environment_id || 'remote',
      previousInteractionId: stored.interaction_id || body.previous_response_id,
      systemInstruction,
      conversationKey: `resp:${body.previous_response_id}`,
      nextPrefixHash: sha256(typeof input === 'string' ? input : JSON.stringify(input)),
      mode: 'continue',
      upstreamKeyId: stored.upstream_key_id || null
    });
  }

  const mode = stored ? 'fork' : 'new';
  const targetConversationKey = mode === 'fork'
    ? deriveForkConversationKey(conversationKey, headers['x-request-id'], sha256(typeof input === 'string' ? input : JSON.stringify(input)))
    : conversationKey;
  return withConversationMeta({
    input,
    environment: reuseEnv && stored?.environment_id ? stored.environment_id : 'remote',
    previousInteractionId: undefined,
    systemInstruction,
    conversationKey,
    nextPrefixHash: sha256(typeof input === 'string' ? input : JSON.stringify(input)),
    mode,
    upstreamKeyId: stored?.upstream_key_id || null,
    forkReason: mode === 'fork' ? 'prefix_mismatch' : null
  }, { sourceConversationKey: conversationKey, targetConversationKey });
}

function toResponsesResult({ data, requestedModel }) {
  const text = extractOutputText(data);
  const usage = usageFromInteraction(data);
  const calls = pendingFunctionCalls(data);
  const output = [];
  if (text) {
    output.push({
      type: 'message',
      id: `msg_${data.id || 'out'}`,
      role: 'assistant',
      content: [{ type: 'output_text', text }]
    });
  }
  for (const call of calls) {
    output.push({
      type: 'function_call',
      id: call.id,
      call_id: call.id,
      name: call.name,
      arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {})
    });
  }
  return {
    id: data.id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: data.status === 'requires_action' ? 'incomplete' : (data.status || 'completed'),
    model: requestedModel,
    output,
    output_text: text,
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens
    }
  };
}

function geminiPartsToInput(parts) {
  const input = [];
  for (const part of parts || []) {
    if (!part) continue;
    if (typeof part.text === 'string' && part.text) input.push({ type: 'text', text: part.text });
    const inline = part.inline_data || part.inlineData;
    if (inline?.data) {
      input.push({
        type: 'image',
        mime_type: inline.mime_type || inline.mimeType || 'image/png',
        data: inline.data
      });
    }
    if (part.functionResponse || part.function_response) {
      const fr = part.functionResponse || part.function_response;
      input.push({
        type: 'function_result',
        name: fr.name,
        call_id: fr.id || fr.call_id,
        result: [{ type: 'text', text: JSON.stringify(fr.response || fr) }]
      });
    }
  }
  if (input.length === 1 && input[0].type === 'text') return input[0].text;
  return input;
}

function buildGeminiConversation({ body = {}, headers = {}, stored = null }) {
  const contents = Array.isArray(body.contents) ? body.contents : [];
  const systemInstruction = body.system_instruction?.parts
    ? textOfContent(body.system_instruction.parts)
    : (typeof body.systemInstruction === 'string' ? body.systemInstruction : undefined);
  const last = contents[contents.length - 1];
  const input = geminiPartsToInput(last?.parts || []);
  const conversationKey = headers['x-session-id'] || headers['x-ag-session-id']
    ? `hdr:${headers['x-session-id'] || headers['x-ag-session-id']}`
    : `fp:${sha256(JSON.stringify((contents[0]?.parts || []).map((part) => part.text || '[p]')))}`;
  const prefix = contents.slice(0, -1);
  const prefixHash = sha256(JSON.stringify(prefix.map((item) => ({
    role: item.role,
    text: textOfContent(item.parts)
  }))));
  const nextPrefixHash = sha256(JSON.stringify(contents.map((item) => ({
    role: item.role,
    text: textOfContent(item.parts)
  }))));
  const reuseEnv = headerFlag(headers, 'x-ag-reuse-environment');

  if (!stored) {
    return withConversationMeta({
      input: contents.length > 1 ? flattenGeminiContents(contents) : input,
      environment: 'remote',
      previousInteractionId: undefined,
      systemInstruction,
      conversationKey,
      nextPrefixHash,
      mode: 'new',
      upstreamKeyId: null
    });
  }
  if (stored.prefix_hash !== prefixHash) {
    const targetConversationKey = deriveForkConversationKey(conversationKey, headers['x-request-id'], nextPrefixHash);
    return withConversationMeta({
      input: contents.length > 1 ? flattenGeminiContents(contents) : input,
      environment: reuseEnv && stored.environment_id ? stored.environment_id : 'remote',
      previousInteractionId: undefined,
      systemInstruction,
      conversationKey,
      nextPrefixHash,
      mode: 'fork',
      upstreamKeyId: stored.upstream_key_id || null,
      forkReason: 'prefix_mismatch'
    }, { sourceConversationKey: conversationKey, targetConversationKey });
  }
  return withConversationMeta({
    input,
    environment: stored.environment_id || 'remote',
    previousInteractionId: stored.interaction_id,
    systemInstruction,
    conversationKey: stored.conversation_key || conversationKey,
    nextPrefixHash,
    mode: 'continue',
    upstreamKeyId: stored.upstream_key_id || null
  }, { sourceConversationKey: conversationKey, targetConversationKey: stored.conversation_key || conversationKey });
}

function geminiToolsFromBody(body, tokenConfig = {}) {
  const mapped = [];
  for (const tool of body?.tools || []) {
    if (tool.functionDeclarations || tool.function_declarations) {
      const decls = tool.functionDeclarations || tool.function_declarations;
      for (const decl of decls) {
        const mappedFn = mapOpenAITool({ type: 'function', function: decl });
        if (mappedFn) mapped.push(mappedFn);
      }
    }
    if (tool.type === 'mcp_server' || tool.mcp_server) {
      const mappedMcp = normalizeMcpServer(tool.mcp_server || tool);
      if (mappedMcp) mapped.push(mappedMcp);
    }
    if ((tool.google_search || tool.googleSearch) && tokenConfig.tool_google_search !== 0 && tokenConfig.toolGoogleSearch !== 0) {
      mapped.push({ type: 'google_search' });
    }
    if ((tool.code_execution || tool.codeExecution) && tokenConfig.tool_code_execution !== 0 && tokenConfig.toolCodeExecution !== 0) {
      mapped.push({ type: 'code_execution' });
    }
    if ((tool.url_context || tool.urlContext) && tokenConfig.tool_url_context !== 0 && tokenConfig.toolUrlContext !== 0) {
      mapped.push({ type: 'url_context' });
    }
  }
  return mapped;
}

function toGeminiGenerateContent({ data }) {
  const text = extractOutputText(data);
  const calls = pendingFunctionCalls(data);
  const parts = [];
  if (text) parts.push({ text });
  for (const call of calls) {
    let args = call.arguments || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args || '{}'); } catch { args = {}; }
    }
    parts.push({
      functionCall: {
        name: call.name,
        args
      }
    });
  }
  const usage = usageFromInteraction(data);
  return {
    candidates: [{
      content: {
        role: 'model',
        parts: parts.length ? parts : [{ text: '' }]
      },
      finishReason: calls.length ? 'STOP' : 'STOP'
    }],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens,
      candidatesTokenCount: usage.completion_tokens,
      totalTokenCount: usage.total_tokens
    }
  };
}

const MIGRATION_NOTE = 'Previous conversation context follows. Continue in this NEW sandbox. Do not assume files from the old environment still exist.';

function parseTranscript(stored) {
  if (!stored?.transcript_json) return [];
  if (Array.isArray(stored.transcript_json)) return stored.transcript_json;
  try {
    const parsed = JSON.parse(stored.transcript_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isDuplicateCompletedTurn(messages, stored) {
  if (!stored?.prefix_hash) return false;
  return hashNonAssistant(messages) === stored.prefix_hash;
}

function lastAssistantFromTranscript(stored) {
  const turns = parseTranscript(stored);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === 'assistant' && turns[i].text) return String(turns[i].text);
  }
  return '';
}

function flattenGeminiContents(contents) {
  const messages = (contents || []).map((item) => ({
    role: item?.role === 'model' ? 'assistant' : (item?.role || 'user'),
    content: (item?.parts || []).map((part) => {
      if (part?.text) return { type: 'text', text: part.text };
      if (part?.inline_data || part?.inlineData) return part;
      return part;
    })
  }));
  return flattenMessagesToInput(messages);
}

function transcriptToInput(transcript, extraInput) {
  const parts = [];
  for (const turn of transcript || []) {
    const role = turn.role === 'assistant' ? 'Assistant' : 'User';
    if (turn.text) parts.push({ type: 'text', text: `${role}: ${turn.text}` });
  }
  if (typeof extraInput === 'string' && extraInput.trim()) {
    parts.push({ type: 'text', text: `User: ${extraInput}` });
  } else if (Array.isArray(extraInput)) {
    parts.push(...extraInput);
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

function withMigrationPreamble(input) {
  if (typeof input === 'string') {
    return `${MIGRATION_NOTE}\n\n${input}`;
  }
  if (Array.isArray(input)) {
    return [{ type: 'text', text: MIGRATION_NOTE }, ...input];
  }
  return input;
}

function migrateConversationForKeyChange(conversation, source = {}, options = {}) {
  const { messages, contents, stored } = source;
  const maxInputTokens = Number(options.maxInputTokens) > 0 ? Number(options.maxInputTokens) : 24000;
  const currentInput = conversation.input;
  const hasFunctionResults = Array.isArray(currentInput)
    && currentInput.some((item) => item && item.type === 'function_result');
  const functionResults = hasFunctionResults
    ? currentInput.filter((item) => item && item.type === 'function_result')
    : [];

  let rebuilt;
  if (Array.isArray(messages) && messages.length > 0) {
    rebuilt = buildSafeHistoryInput(messages, {
      kind: 'migrate',
      maxInputTokens,
      preamble: MIGRATION_NOTE,
      extraParts: functionResults
    });
  } else if (Array.isArray(contents) && contents.length > 0) {
    rebuilt = {
      input: withMigrationPreamble(flattenGeminiContents(contents)),
      summary: summarizeToolHistory([]),
      truncated: false,
      estimatedTokens: 0,
      callMarkers: observeCallMarkers(contents)
    };
  } else {
    const transcript = parseTranscript(stored);
    const input = transcript.length > 0
      ? withMigrationPreamble(transcriptToInput(transcript, hasFunctionResults ? undefined : conversation.input))
      : withMigrationPreamble(conversation.input);
    rebuilt = {
      input: hasFunctionResults
        ? (Array.isArray(input) ? [...input, ...functionResults] : [{ type: 'text', text: input }, ...functionResults])
        : input,
      summary: summarizeToolHistory([]),
      truncated: false,
      estimatedTokens: estimateTokens(input),
      callMarkers: observeCallMarkers(conversation.input)
    };
  }

  if (hasFunctionResults) {
    const recoveryText = buildToolRecoveryContext(currentInput, source, { maxInputTokens });
    const parts = [
      { type: 'text', text: MIGRATION_NOTE },
      { type: 'text', text: recoveryText },
      ...functionResults
    ];
    rebuilt = {
      ...rebuilt,
      input: parts,
      estimatedTokens: estimateTokens(parts)
    };
  }

  return withConversationMeta({
    ...conversation,
    input: rebuilt.input,
    environment: 'remote',
    previousInteractionId: undefined,
    mode: 'migrate',
    rebuildMode: 'migrate',
    upstreamKeyId: null,
    migrationTruncated: Boolean(rebuilt.truncated),
    migrationInputTokensEstimated: rebuilt.estimatedTokens,
    toolTraceStatus: rebuilt.summary?.toolTraceStatus || conversation.toolTraceStatus || 'none',
    callMarkers: rebuilt.callMarkers || conversation.callMarkers
  }, {
    upstreamTransition: 'frok',
    sourceConversationKey: conversation.sourceConversationKey || conversation.conversationKey,
    targetConversationKey: conversation.targetConversationKey || conversation.conversationKey
  });
}

/**
 * 为工具调用迁移构建恢复上下文。
 * 描述未完成的工具调用和结果，以便新 Interaction 链能理解这些 function_result。
 * @param {Array} input - 当前包含 function_result 的 input 数组
 * @param {object} source - 原始请求源数据
 * @returns {string} 恢复上下文文本
 */
function buildToolRecoveryContext(input, source = {}, options = {}) {
  const results = (input || []).filter((item) => item && item.type === 'function_result');
  const maxInputTokens = Number(options.maxInputTokens) > 0 ? Number(options.maxInputTokens) : 24000;
  const historyParts = [];
  let summaryBlock = '';

  if (Array.isArray(source.messages) && source.messages.length > 0) {
    const rebuilt = buildSafeHistoryInput(source.messages, { kind: 'history', maxInputTokens });
    summaryBlock = formatToolSummaryBlock(rebuilt.summary);
    const flattened = rebuilt.input;
    if (typeof flattened === 'string' && flattened.trim()) {
      historyParts.push(flattened);
    } else if (Array.isArray(flattened)) {
      for (const part of flattened) {
        if (part.type === 'text' && part.text && part.text !== summaryBlock) historyParts.push(part.text);
      }
    }
  } else if (Array.isArray(source.contents) && source.contents.length > 0) {
    const flattened = flattenGeminiContents(source.contents);
    if (typeof flattened === 'string' && flattened.trim()) {
      historyParts.push(flattened);
    } else if (Array.isArray(flattened)) {
      for (const part of flattened) {
        if (part.type === 'text' && part.text) historyParts.push(part.text);
      }
    }
  } else {
    const transcript = parseTranscript(source.stored);
    for (const turn of transcript) {
      const role = turn.role === 'assistant' ? 'Assistant' : 'User';
      const text = stripFakeToolTrace(String(turn.text || ''));
      if (text) historyParts.push(`${role}: ${text}`);
    }
  }

  const parts = [];
  parts.push('This is a task continuation after an API key rotation. The previous interaction chain is no longer accessible.');
  if (summaryBlock) {
    parts.push('');
    parts.push(summaryBlock);
  }

  if (historyParts.length) {
    parts.push('');
    parts.push('Conversation history (reference only):');
    parts.push(historyParts.join('\n\n'));
  }

  parts.push('');
  parts.push(`The previous interaction requested ${results.length} tool call(s). The tool(s) have been executed and their results follow as function_result items.`);
  for (const result of results) {
    const preview = Array.isArray(result.result)
      ? truncateText(redactSensitive(result.result.map((item) => String(item.text || '')).join('; ')), 400)
      : '(no preview)';
    parts.push(`  - Tool: ${result.name || 'unknown'}, call_id: ${result.call_id || 'unknown'}, result preview: ${preview}`);
  }
  parts.push('');
  parts.push('Please process the tool results and continue the task. Do NOT re-execute the tools — they have already completed successfully. The history above is not a current tool call.');

  return parts.join('\n');
}

function appendTranscript(stored, conversation, outputText) {
  const prev = parseTranscript(stored);
  const prompt = typeof conversation?.input === 'string'
    ? conversation.input
    : (Array.isArray(conversation?.input)
      ? conversation.input.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      : '');
  if (prompt && conversation?.mode !== 'migrate') {
    prev.push({ role: 'user', text: prompt.slice(0, 20000) });
  } else if (prompt) {
    prev.push({ role: 'user', text: prompt.slice(0, 20000) });
  }
  if (outputText) prev.push({ role: 'assistant', text: String(outputText).slice(0, 20000) });
  return prev.slice(-40);
}

function collectImageUrls(input) {
  const urls = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object' && value.type === 'image' && value.url) urls.push(value);
  };
  visit(input);
  return urls;
}

module.exports = {
  AGENT_ID,
  DEFAULT_ANTIGRAVITY_TOOLS,
  textOfMessage,
  hashNonAssistant,
  parseImageRef,
  openaiMessageToInputParts,
  flattenMessagesToInput,
  conversationKeyFrom,
  requireConversationKey,
  buildOpenAIConversation,
  buildResponsesConversation,
  buildGeminiConversation,
  mergeTools,
  geminiToolsFromBody,
  pendingFunctionCalls,
  extractOutputText,
  usageFromInteraction,
  toChatCompletion,
  toResponsesResult,
  toGeminiGenerateContent,
  collectImageUrls,
  toOpenAIToolCalls,
  mapOpenAITool,
  flattenGeminiContents,
  migrateConversationForKeyChange,
  appendTranscript,
  parseTranscript,
  summarizeToolHistory,
  observeCallMarkers,
  estimateTokens,
  deriveForkConversationKey,
  resolveStoredConversation,
  buildSafeHistoryInput,
  classifyPrefixMismatch,
  isDuplicateCompletedTurn,
  lastAssistantFromTranscript
};
