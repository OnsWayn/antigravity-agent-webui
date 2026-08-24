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

function flattenMessagesToInput(messages) {
  const parts = [];
  for (const message of messages || []) {
    if (!message || message.role === 'system') continue;
    if (message.role === 'tool' || message.role === 'function') {
      const text = textOfMessage(message);
      parts.push({ type: 'text', text: `Tool result (${message.name || message.tool_call_id || 'tool'}): ${text}` });
      continue;
    }
    const converted = openaiMessageToInputParts(message);
    const label = message.role === 'assistant' ? 'Assistant' : 'User';
    if (typeof converted === 'string') {
      if (converted) parts.push({ type: 'text', text: `${label}: ${converted}` });
    } else if (Array.isArray(converted)) {
      const textParts = converted.filter((part) => part.type === 'text');
      const imageParts = converted.filter((part) => part.type === 'image');
      if (textParts.length) {
        parts.push({ type: 'text', text: `${label}: ${textParts.map((part) => part.text).join('\n')}` });
      } else {
        parts.push({ type: 'text', text: `${label}:` });
      }
      parts.push(...imageParts);
    }
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
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

function buildOpenAIConversation({ messages, headers = {}, body = {}, stored = null, resolveCallId }) {
  const msgs = Array.isArray(messages) ? messages : [];
  const stateless = headerFlag(headers, 'x-ag-stateless') || body.store === false;
  const reuseEnv = headerFlag(headers, 'x-ag-reuse-environment');
  const systemInstruction = msgs
    .filter((message) => message?.role === 'system')
    .map(textOfMessage)
    .filter(Boolean)
    .join('\n') || undefined;
  const conversationKey = conversationKeyFrom({ messages: msgs, headers, body });
  const nextPrefixHash = hashNonAssistant(msgs);

  if (stateless) {
    return {
      input: flattenMessagesToInput(msgs),
      environment: reuseEnv && stored?.environment_id ? stored.environment_id : 'remote',
      previousInteractionId: undefined,
      systemInstruction,
      conversationKey,
      nextPrefixHash,
      mode: 'stateless',
      upstreamKeyId: stored?.upstream_key_id || null
    };
  }

  const toolMessages = trailingToolMessages(msgs);
  const isToolTurn = toolMessages.length > 0;
  const last = msgs[msgs.length - 1];
  const prefix = isToolTurn ? msgs.slice(0, msgs.length - toolMessages.length) : msgs.slice(0, -1);
  const prefixHash = hashNonAssistant(prefix);

  const input = isToolTurn
    ? toolMessages.map((message) => toFunctionResult(message, resolveCallId))
    : openaiMessageToInputParts(last || lastUserMessage(msgs));

  if (!stored) {
    return {
      input,
      environment: 'remote',
      previousInteractionId: undefined,
      systemInstruction,
      conversationKey,
      nextPrefixHash,
      mode: 'new',
      upstreamKeyId: null
    };
  }

  if (stored.prefix_hash !== prefixHash) {
    const user = lastUserMessage(msgs) || last;
    return {
      input: openaiMessageToInputParts(user),
      environment: reuseEnv && stored.environment_id ? stored.environment_id : 'remote',
      previousInteractionId: undefined,
      systemInstruction,
      conversationKey,
      nextPrefixHash,
      mode: 'fork',
      upstreamKeyId: stored.upstream_key_id || null
    };
  }

  return {
    input,
    environment: stored.environment_id || 'remote',
    previousInteractionId: stored.interaction_id,
    systemInstruction,
    conversationKey,
    nextPrefixHash,
    mode: 'continue',
    upstreamKeyId: stored.upstream_key_id || null
  };
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

function mergeTools({ body = {}, headers = {}, includeBuiltin }) {
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

  if (!clientTools.length) return wantBuiltin ? undefined : [];
  if (!wantBuiltin) return clientTools;
  return [...DEFAULT_ANTIGRAVITY_TOOLS, ...clientTools];
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
    return {
      input,
      environment: stored.environment_id || 'remote',
      previousInteractionId: stored.interaction_id || body.previous_response_id,
      systemInstruction,
      conversationKey: `resp:${body.previous_response_id}`,
      nextPrefixHash: sha256(typeof input === 'string' ? input : JSON.stringify(input)),
      mode: 'continue',
      upstreamKeyId: stored.upstream_key_id || null
    };
  }

  return {
    input,
    environment: reuseEnv && stored?.environment_id ? stored.environment_id : 'remote',
    previousInteractionId: undefined,
    systemInstruction,
    conversationKey,
    nextPrefixHash: sha256(typeof input === 'string' ? input : JSON.stringify(input)),
    mode: stored ? 'fork' : 'new',
    upstreamKeyId: stored?.upstream_key_id || null
  };
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
    return {
      input,
      environment: 'remote',
      previousInteractionId: undefined,
      systemInstruction,
      conversationKey,
      nextPrefixHash,
      mode: 'new',
      upstreamKeyId: null
    };
  }
  if (stored.prefix_hash !== prefixHash) {
    return {
      input,
      environment: reuseEnv && stored.environment_id ? stored.environment_id : 'remote',
      previousInteractionId: undefined,
      systemInstruction,
      conversationKey,
      nextPrefixHash,
      mode: 'fork',
      upstreamKeyId: stored.upstream_key_id || null
    };
  }
  return {
    input,
    environment: stored.environment_id || 'remote',
    previousInteractionId: stored.interaction_id,
    systemInstruction,
    conversationKey,
    nextPrefixHash,
    mode: 'continue',
    upstreamKeyId: stored.upstream_key_id || null
  };
}

function geminiToolsFromBody(body) {
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
    if (tool.google_search || tool.googleSearch) mapped.push({ type: 'google_search' });
    if (tool.code_execution || tool.codeExecution) mapped.push({ type: 'code_execution' });
    if (tool.url_context || tool.urlContext) mapped.push({ type: 'url_context' });
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

function migrateConversationForKeyChange(conversation, source = {}) {
  const { messages, contents, stored } = source;
  let input;
  if (Array.isArray(messages) && messages.length > 0) {
    input = flattenMessagesToInput(messages);
  } else if (Array.isArray(contents) && contents.length > 0) {
    input = flattenGeminiContents(contents);
  } else {
    const transcript = parseTranscript(stored);
    input = transcript.length
      ? transcriptToInput(transcript, conversation.input)
      : conversation.input;
  }
  return {
    ...conversation,
    input: withMigrationPreamble(input),
    environment: 'remote',
    previousInteractionId: undefined,
    mode: 'migrate',
    upstreamKeyId: null
  };
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
  flattenMessagesToInput,
  flattenGeminiContents,
  migrateConversationForKeyChange,
  appendTranscript,
  parseTranscript
};
