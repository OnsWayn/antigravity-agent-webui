const express = require('express');
const { authenticateClient } = require('./auth');
const { openaiError, geminiError, sendJson } = require('./errors');
const { callInteractions } = require('./interactions');
const { AGENT_ID, listGatewayModels, resolveModel } = require('./models');
const { isRateLimitError, pickUpstreamKey, RATE_LIMIT_TRIES_PER_KEY, RATE_LIMIT_COOLDOWN_MS, TpmTracker } = require('./upstream');
const {
  applyStreamEvent,
  emitChatCompletionsFinish,
  emitLiveChatDelta,
  finalizeStreamState,
  startSse,
  writeSse,
  chatChunk
} = require('./stream');
const { createGatewayLogger, generateRequestId } = require('./logger');
const { createSessionLockManager } = require('./lock');
const {
  buildGeminiConversation,
  buildOpenAIConversation,
  buildResponsesConversation,
  conversationKeyFrom,
  requireConversationKey,
  geminiToolsFromBody,
  mergeTools,
  migrateConversationForKeyChange,
  appendTranscript,
  extractOutputText,
  toChatCompletion,
  toGeminiGenerateContent,
  toResponsesResult,
  usageFromInteraction
} = require('./translate');

function sanitizeHeaders(headers = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (/auth|key|secret|cookie|token/i.test(key)) {
      safe[key] = '[REDACTED]';
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function sanitizeForStorage(value, key = '') {
  if (value === null || value === undefined) return value;
  if (/api.?key|authorization|secret|password/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (value.startsWith('data:') && value.includes(';base64,')) {
      return `[base64 image omitted: ${value.length} chars]`;
    }
    if (key === 'data' && value.length > 256) return `[binary data omitted: ${value.length} chars]`;
    if (value.length > 50000) return `${value.slice(0, 50000)}\n[truncated]`;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForStorage(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeForStorage(childValue, childKey)
    ]));
  }
  return value;
}

function publicUpstreamKey(row) {
  return {
    id: row.id,
    name: row.name,
    suffix: row.key_suffix,
    proxyUrl: row.proxy_url || null,
    enabled: Boolean(row.enabled),
    failCount: Number(row.fail_count || 0),
    cooldownUntil: row.cooldown_until || null,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at
  };
}

function requireGatewayReady({ enabled, masterKey }) {
  if (enabled === false) {
    const error = new Error('Gateway is disabled');
    error.status = 503;
    error.code = 'gateway_disabled';
    throw error;
  }
  if (!masterKey) {
    const error = new Error('GATEWAY_MASTER_KEY is not configured');
    error.status = 503;
    error.code = 'gateway_not_configured';
    throw error;
  }
}

function disableTimeouts(req, res) {
  if (typeof req.setTimeout === 'function') req.setTimeout(0);
  if (typeof res.setTimeout === 'function') res.setTimeout(0);
  if (req.socket && typeof req.socket.setTimeout === 'function') req.socket.setTimeout(0);
}

function buildPayload({ resolved, conversation, tools, stream }) {
  const payload = {
    agent: AGENT_ID,
    input: conversation.input,
    environment: conversation.environment || 'remote',
    agent_config: {
      type: 'antigravity',
      model: resolved.backendModel
    }
  };
  if (conversation.previousInteractionId) {
    payload.previous_interaction_id = conversation.previousInteractionId;
  }
  if (conversation.systemInstruction) {
    payload.system_instruction = conversation.systemInstruction;
  }
  if (Array.isArray(tools) && tools.length) payload.tools = tools;
  if (stream) payload.stream = true;
  return payload;
}

function persistSuccess({ database, token, conversation, resolved, data, endpoint, startedAt, status = 200, upstreamKeyId, stored }) {
  const usage = usageFromInteraction(data);
  if (usage.totalTokens > 0) database.addClientTokenUsage(token.id, usage.totalTokens);
  if (conversation?.conversationKey) {
    database.upsertGatewayConversation({
      tokenId: token.id,
      conversationKey: conversation.conversationKey,
      interactionId: data.id,
      environmentId: data.environment_id || null,
      prefixHash: conversation.nextPrefixHash,
      model: resolved.backendModel,
      upstreamKeyId: upstreamKeyId || null,
      transcript: appendTranscript(stored, conversation, extractOutputText(data))
    });
  }
  database.insertUsageLog({
    tokenId: token.id,
    endpoint,
    model: resolved.requested,
    interactionId: data.id,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    status,
    durationMs: Date.now() - startedAt
  });
}

function persistFailure({ database, token, resolved, endpoint, startedAt, error }) {
  database.insertUsageLog({
    tokenId: token?.id,
    endpoint,
    model: resolved?.requested,
    status: error.status || 500,
    durationMs: Date.now() - startedAt,
    error: error.message
  });
}

function saveToolMappings(database, token, data, callsSaver) {
  return ({ openaiCallId, googleCallId, name }) => {
    database.saveGatewayToolCall({
      openaiCallId,
      googleCallId,
      name,
      tokenId: token.id,
      interactionId: data?.id
    });
    if (callsSaver) callsSaver({ openaiCallId, googleCallId, name });
  };
}

function createGatewayRouter(options = {}) {
  const {
    database,
    masterKey,
    enabled = process.env.GATEWAY_ENABLED !== 'false',
    enforceSessionHeader = process.env.GATEWAY_ENFORCE_SESSION_HEADER === 'true',
    sessionLockTimeoutMs = 120000,
    sessionQueueLimit = 3,
    log = () => {},
    callUpstream = callInteractions
  } = options;

  const logger = createGatewayLogger(log);
  const tpmTracker = new TpmTracker();
  const lockManager = createSessionLockManager({
    defaultTimeoutMs: sessionLockTimeoutMs,
    defaultQueueLimit: sessionQueueLimit,
    onLockEvent: (level, event, data) => logger.logEvent(level, event, data)
  });

  const router = express.Router();

  function authOrError(req, res, protocol) {
    try {
      requireGatewayReady({ enabled, masterKey });
    } catch (error) {
      if (protocol === 'gemini') sendJson(res, error.status, geminiError(error.status, error.message, 'UNAVAILABLE').body);
      else sendJson(res, error.status, openaiError(error.status, error.message, error.code).body);
      return null;
    }
    const auth = authenticateClient(req, database);
    if (!auth.ok) {
      if (protocol === 'gemini') sendJson(res, auth.status, geminiError(auth.status, auth.message, 'UNAUTHENTICATED').body);
      else sendJson(res, auth.status, openaiError(auth.status, auth.message, auth.code, auth.type || 'invalid_request_error').body);
      return null;
    }
    return auth.token;
  }

  function sendUpstreamError(res, protocol, error) {
    const status = error.status && error.status >= 400 ? error.status : 502;
    if (protocol === 'gemini') sendJson(res, status, geminiError(status, error.message, 'INTERNAL').body);
    else sendJson(res, status, openaiError(status, error.message, error.code || 'upstream_error', 'api_error').body);
  }

  function bindConversationToKey(conversation, upstream, source, { forceMigrate = false, requestId } = {}) {
    const boundId = conversation.upstreamKeyId || source?.stored?.upstream_key_id;
    if (!forceMigrate && boundId && boundId === upstream.row.id) return conversation;
    if (!forceMigrate && !boundId) return conversation;
    logger.logEvent('info', 'context_migration_started', {
      requestId,
      conversationKey: conversation.conversationKey,
      fromKeyUpstreamId: boundId || null,
      toKeyUpstreamId: upstream.row.id,
      forceMigrate
    });
    return migrateConversationForKeyChange(conversation, source);
  }

  async function runInteraction({
    req,
    res,
    protocol,
    resolved,
    conversation,
    tools,
    stream,
    endpoint,
    source = {},
    requestId = generateRequestId('req')
  }) {
    const token = req.gatewayToken;
    const startedAt = Date.now();
    const excludeIds = [];
    const keyBudget = Math.max(1, database.listEnabledUpstreamKeys().length);
    let lastError;
    let streamed = false;
    let stopHeartbeat = () => {};
    const created = Math.floor(Date.now() / 1000);
    const streamId = `chatcmpl_${Date.now()}`;

    // Record initial request log
    try {
      database.insertGatewayRequestLog({
        requestId,
        tokenId: token?.id || null,
        tokenName: token?.name || null,
        endpoint,
        protocol,
        downstreamRequestJson: sanitizeForStorage(req.body),
        downstreamHeadersJson: sanitizeHeaders(req.headers),
        conversationKey: conversation.conversationKey || null,
        conversationMode: conversation.mode || null,
        previousInteractionId: conversation.previousInteractionId || null,
        model: resolved.requested,
        backendModel: resolved.backendModel,
        stream: Boolean(stream),
        status: 'pending',
        createdAt: startedAt
      });
    } catch {}

    if (stream) {
      disableTimeouts(req, res);
      stopHeartbeat = startSse(res);
      streamed = true;
      if (protocol === 'openai') {
        writeSse(res, chatChunk({
          id: streamId,
          model: resolved.requested,
          created,
          delta: { role: 'assistant', content: '' }
        }));
      }
      try { res.write(': antigravity sandbox starting\n\n'); } catch {}
    }

    try {
      for (let switchIndex = 0; switchIndex < keyBudget; switchIndex++) {
        let upstream;
        try {
          upstream = pickUpstreamKey(database, masterKey, {
            preferId: switchIndex === 0 ? (conversation.upstreamKeyId || source.stored?.upstream_key_id) : null,
            excludeIds,
            tpmTracker
          });
        } catch (error) {
          lastError = error;
          break;
        }

        if (switchIndex > 0) {
          logger.logEvent('warn', 'key_rotated', {
            requestId,
            conversationKey: conversation.conversationKey,
            switchIndex,
            newUpstreamKeyId: upstream.row.id
          });
        }

        let conversationForCall = bindConversationToKey(
          conversation,
          upstream,
          source,
          { forceMigrate: switchIndex > 0, requestId }
        );

        for (let attempt = 1; attempt <= RATE_LIMIT_TRIES_PER_KEY; attempt++) {
          const payload = buildPayload({ resolved, conversation: conversationForCall, tools, stream });
          try {
            database.updateGatewayRequestLog(requestId, {
              upstreamKeyId: upstream.row.id,
              upstreamKeyName: upstream.row.name,
              keySwitchCount: switchIndex,
              retryCount: attempt - 1,
              upstreamRequestJson: sanitizeForStorage(payload)
            });
          } catch {}

          logger.logEvent('info', 'interaction_request', {
            requestId,
            endpoint,
            model: resolved.requested,
            backendModel: resolved.backendModel,
            mode: conversationForCall.mode,
            stream,
            upstreamKey: upstream.row.id,
            attempt,
            conversationKey: conversationForCall.conversationKey,
            previousInteractionId: conversationForCall.previousInteractionId,
            environment: conversationForCall.environment
          });

          try {
            if (stream) {
              let state = {};
              const result = await callUpstream({
                apiKey: upstream.apiKey,
                payload,
                proxyUrl: upstream.proxyUrl,
                stream: true,
                onEvent: async (event) => {
                  state = applyStreamEvent(event, state);
                  const eventType = event?.event_type || event?.type;
                  if (eventType === 'step.start' && event.step?.type) {
                    try { res.write(`: step ${event.step.type} ${event.step.name || ''}\n\n`); } catch {}
                  }
                  if (protocol === 'openai' && state.lastDelta) {
                    emitLiveChatDelta(res, {
                      id: state.id || streamId,
                      model: resolved.requested,
                      created,
                      text: state.lastDelta
                    });
                  } else if (protocol === 'responses' && state.lastDelta) {
                    writeSse(res, { type: 'response.output_text.delta', delta: state.lastDelta }, 'response.output_text.delta');
                  } else if (protocol === 'gemini' && state.lastDelta) {
                    writeSse(res, {
                      candidates: [{ content: { role: 'model', parts: [{ text: state.lastDelta }] } }]
                    });
                  }
                }
              });
              const data = finalizeStreamState(state);
              if (!data.id && result?.events?.length) {
                const last = result.events[result.events.length - 1];
                if (last?.id) data.id = last.id;
              }
              const usage = usageFromInteraction(data);
              tpmTracker.record(upstream.row.id, usage.totalTokens);
              persistSuccess({
                database,
                token,
                conversation: conversationForCall,
                resolved,
                data,
                endpoint,
                startedAt,
                upstreamKeyId: upstream.row.id,
                stored: source.stored
              });
              database.markUpstreamKeyUsed(upstream.row.id);
              try {
                database.updateGatewayRequestLog(requestId, {
                  upstreamResponseJson: sanitizeForStorage(data),
                  upstreamResponseStatus: 200,
                  responseInteractionId: data.id || null,
                  responseEnvironmentId: data.environment_id || null,
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  totalTokens: usage.totalTokens,
                  durationMs: Date.now() - startedAt,
                  status: 'success'
                });
              } catch {}
              logger.logEvent('info', 'interaction_response', {
                requestId,
                endpoint,
                status: 200,
                responseInteractionId: data.id,
                responseEnvironmentId: data.environment_id,
                responseStatus: data.status,
                stream: true
              });
              if (conversationForCall.mode === 'migrate') {
                logger.logEvent('info', 'context_migration_succeeded', {
                  requestId,
                  conversationKey: conversationForCall.conversationKey,
                  interactionId: data.id,
                  environmentId: data.environment_id
                });
              }
              if (protocol === 'openai') {
                emitChatCompletionsFinish({
                  res,
                  data,
                  requestedModel: resolved.requested,
                  saveMapping: saveToolMappings(database, token, data),
                  id: data.id || streamId,
                  created
                });
              } else if (protocol === 'responses') {
                writeSse(res, {
                  type: 'response.completed',
                  response: toResponsesResult({ data, requestedModel: resolved.requested })
                }, 'response.completed');
                writeSse(res, '[DONE]');
              } else {
                writeSse(res, toGeminiGenerateContent({ data }));
              }
              return;
            }

            const data = await callUpstream({
              apiKey: upstream.apiKey,
              payload,
              proxyUrl: upstream.proxyUrl,
              stream: false
            });
            const usage = usageFromInteraction(data);
            tpmTracker.record(upstream.row.id, usage.totalTokens);
            persistSuccess({
              database,
              token,
              conversation: conversationForCall,
              resolved,
              data,
              endpoint,
              startedAt,
              upstreamKeyId: upstream.row.id,
              stored: source.stored
            });
            database.markUpstreamKeyUsed(upstream.row.id);
            try {
              database.updateGatewayRequestLog(requestId, {
                upstreamResponseJson: sanitizeForStorage(data),
                upstreamResponseStatus: 200,
                responseInteractionId: data.id || null,
                responseEnvironmentId: data.environment_id || null,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                durationMs: Date.now() - startedAt,
                status: 'success'
              });
            } catch {}
            logger.logEvent('info', 'interaction_response', {
              requestId,
              endpoint,
              status: 200,
              responseInteractionId: data.id,
              responseEnvironmentId: data.environment_id,
              responseStatus: data.status,
              stream: false
            });
            if (conversationForCall.mode === 'migrate') {
              logger.logEvent('info', 'context_migration_succeeded', {
                requestId,
                conversationKey: conversationForCall.conversationKey,
                interactionId: data.id,
                environmentId: data.environment_id
              });
            }
            if (protocol === 'openai') {
              sendJson(res, 200, toChatCompletion({
                data,
                requestedModel: resolved.requested,
                saveMapping: saveToolMappings(database, token, data)
              }));
            } else if (protocol === 'responses') {
              sendJson(res, 200, toResponsesResult({ data, requestedModel: resolved.requested }));
            } else {
              sendJson(res, 200, toGeminiGenerateContent({ data }));
            }
            return;
          } catch (error) {
            lastError = error;
            if (!isRateLimitError(error)) {
              database.markUpstreamKeyUsed(upstream.row.id, { failed: true });
              persistFailure({ database, token, resolved, endpoint, startedAt, error });
              try {
                database.updateGatewayRequestLog(requestId, {
                  status: 'error',
                  errorMessage: error.message,
                  errorCode: error.code || String(error.status || ''),
                  upstreamResponseStatus: error.status || 500,
                  upstreamResponseJson: sanitizeForStorage(error.rawError || { error: { message: error.message, code: error.code, status: error.status } }),
                  durationMs: Date.now() - startedAt
                });
              } catch {}
              logger.logEvent('error', 'interaction_error', {
                requestId,
                endpoint,
                message: error.message,
                code: error.code,
                status: error.status,
                isRateLimit: false
              });
              if (streamed) {
                writeSse(res, { error: { message: error.message, type: 'api_error' } });
                writeSse(res, '[DONE]');
                return;
              }
              sendUpstreamError(res, protocol, error);
              return;
            }

            database.markUpstreamKeyUsed(upstream.row.id, {
              rateLimited: true,
              cooldownMs: RATE_LIMIT_COOLDOWN_MS
            });
            try {
              database.updateGatewayRequestLog(requestId, {
                status: 'rate_limited',
                errorMessage: error.message,
                errorCode: error.code || String(error.status || '429'),
                upstreamResponseStatus: error.status || 429,
                upstreamResponseJson: sanitizeForStorage(error.rawError || { error: { message: error.message, code: error.code, status: error.status } }),
                durationMs: Date.now() - startedAt
              });
            } catch {}
            logger.logEvent('warn', 'key_rate_limited', {
              requestId,
              upstreamKey: upstream.row.id,
              attempt,
              message: error.message
            });

            if (attempt < RATE_LIMIT_TRIES_PER_KEY) continue;

            excludeIds.push(upstream.row.id);
            break;
          }
        }
      }

      persistFailure({ database, token, resolved, endpoint, startedAt, error: lastError || new Error('upstream failed') });
      const fail = lastError || new Error('All upstream keys failed');
      fail.status = fail.status || 429;
      fail.code = fail.code || 'all_keys_rate_limited';
      try {
        database.updateGatewayRequestLog(requestId, {
          status: 'error',
          errorMessage: fail.message,
          errorCode: fail.code || 'all_keys_rate_limited',
          upstreamResponseStatus: fail.status || 429,
          upstreamResponseJson: sanitizeForStorage(fail.rawError || { error: { message: fail.message, code: fail.code, status: fail.status } }),
          durationMs: Date.now() - startedAt
        });
      } catch {}
      logger.logEvent('error', 'all_keys_exhausted', {
        requestId,
        message: fail.message,
        code: fail.code,
        status: fail.status
      });
      if (streamed) {
        writeSse(res, { error: { message: fail.message, type: 'api_error', code: fail.code } });
        writeSse(res, '[DONE]');
        return;
      }
      sendUpstreamError(res, protocol, fail);
    } finally {
      if (streamed) {
        stopHeartbeat();
        res.end();
      }
    }
  }

  function handleModels(req, res) {
    const token = authOrError(req, res, 'openai');
    if (!token) return;
    const allowed = token.allowed_models ? JSON.parse(token.allowed_models) : null;
    let list = listGatewayModels();
    if (Array.isArray(allowed) && allowed.length > 0) {
      list = list.filter((m) => allowed.includes(m.id) || (m.parent && allowed.includes(m.id.slice(m.parent.length + 1))));
    }
    sendJson(res, 200, { object: 'list', data: list });
  }

  async function handleChatCompletions(req, res) {
    const token = authOrError(req, res, 'openai');
    if (!token) return;
    req.gatewayToken = token;
    let allowedModels = null;
    if (token.allowed_models) {
      try { allowedModels = JSON.parse(token.allowed_models); } catch {}
    }
    const resolved = resolveModel(req.body?.model, {
      allowCustom: true,
      allowedModels,
      defaultModel: token.default_model || null
    });
    if (!resolved.ok) {
      sendJson(res, 400, openaiError(400, resolved.error, 'model_not_found').body);
      return;
    }
    if (!Array.isArray(req.body?.messages)) {
      sendJson(res, 400, openaiError(400, 'messages is required', 'invalid_request_error').body);
      return;
    }

    let conversationKey;
    try {
      conversationKey = requireConversationKey({
        messages: req.body.messages,
        headers: req.headers,
        body: req.body,
        enforce: enforceSessionHeader
      });
    } catch (err) {
      sendJson(res, err.status || 400, openaiError(err.status || 400, err.message, err.code || 'invalid_request_error').body);
      return;
    }

    const requestId = generateRequestId('req_openai');
    let releaseLock = () => {};
    try {
      releaseLock = await lockManager.acquireLock(conversationKey, { requestId });
    } catch (lockErr) {
      sendJson(res, lockErr.status || 429, openaiError(lockErr.status || 429, lockErr.message, lockErr.code || 'session_busy').body);
      return;
    }

    try {
      const stored = database.getGatewayConversation(token.id, conversationKey);
      const conversation = buildOpenAIConversation({
        messages: req.body.messages,
        headers: req.headers,
        body: req.body,
        stored,
        resolveCallId: (id) => database.resolveGoogleCallId(id)
      });
      const tools = mergeTools({ body: req.body, headers: req.headers, tokenConfig: token });
      await runInteraction({
        req,
        res,
        protocol: 'openai',
        resolved,
        conversation,
        tools,
        stream: Boolean(req.body?.stream),
        endpoint: '/v1/chat/completions',
        source: { messages: req.body.messages, stored },
        requestId
      });
    } finally {
      releaseLock();
    }
  }

  async function handleResponses(req, res) {
    const token = authOrError(req, res, 'openai');
    if (!token) return;
    req.gatewayToken = token;
    let allowedModels = null;
    if (token.allowed_models) {
      try { allowedModels = JSON.parse(token.allowed_models); } catch {}
    }
    const resolved = resolveModel(req.body?.model, {
      allowCustom: true,
      allowedModels,
      defaultModel: token.default_model || null
    });
    if (!resolved.ok) {
      sendJson(res, 400, openaiError(400, resolved.error, 'model_not_found').body);
      return;
    }
    if (req.body?.input == null) {
      sendJson(res, 400, openaiError(400, 'input is required', 'invalid_request_error').body);
      return;
    }

    let conversationKey;
    try {
      conversationKey = req.body.previous_response_id
        ? `resp:${req.body.previous_response_id}`
        : requireConversationKey({
          messages: [],
          headers: req.headers,
          body: req.body,
          enforce: enforceSessionHeader
        });
    } catch (err) {
      sendJson(res, err.status || 400, openaiError(err.status || 400, err.message, err.code || 'invalid_request_error').body);
      return;
    }

    const requestId = generateRequestId('req_resp');
    let releaseLock = () => {};
    try {
      releaseLock = await lockManager.acquireLock(conversationKey, { requestId });
    } catch (lockErr) {
      sendJson(res, lockErr.status || 429, openaiError(lockErr.status || 429, lockErr.message, lockErr.code || 'session_busy').body);
      return;
    }

    try {
      const stored = database.getGatewayConversation(token.id, conversationKey)
        || (req.body.previous_response_id
          ? { interaction_id: req.body.previous_response_id, environment_id: null, prefix_hash: '' }
          : null);
      const resolvedStored = database.getGatewayConversation(token.id, conversationKey) || stored;
      const conversation = buildResponsesConversation({
        body: req.body,
        headers: req.headers,
        stored: resolvedStored
      });
      const tools = mergeTools({ body: req.body, headers: req.headers, tokenConfig: token });
      await runInteraction({
        req,
        res,
        protocol: 'responses',
        resolved,
        conversation,
        tools,
        stream: Boolean(req.body?.stream),
        endpoint: '/v1/responses',
        source: { input: req.body.input, stored: resolvedStored },
        requestId
      });
    } finally {
      releaseLock();
    }
  }

  async function handleGeminiGenerate(req, res, { stream }) {
    const token = authOrError(req, res, 'gemini');
    if (!token) return;
    req.gatewayToken = token;
    const rawModel = decodeURIComponent(req.params.model || req.body?.model || AGENT_ID);
    let allowedModels = null;
    if (token.allowed_models) {
      try { allowedModels = JSON.parse(token.allowed_models); } catch {}
    }
    const resolved = resolveModel(rawModel, {
      allowCustom: true,
      allowedModels,
      defaultModel: token.default_model || null
    });
    if (!resolved.ok) {
      sendJson(res, 400, geminiError(400, resolved.error).body);
      return;
    }
    const contents = req.body?.contents;
    if (!Array.isArray(contents) || !contents.length) {
      sendJson(res, 400, geminiError(400, 'contents is required').body);
      return;
    }

    const conversationProbe = buildGeminiConversation({
      body: req.body,
      headers: req.headers,
      stored: null
    });
    const conversationKey = conversationProbe.conversationKey;

    if (enforceSessionHeader && !req.headers['x-session-id'] && !req.headers['x-ag-session-id']) {
      sendJson(res, 400, geminiError(400, 'Missing x-session-id header', 'INVALID_ARGUMENT').body);
      return;
    }

    const requestId = generateRequestId('req_gemini');
    let releaseLock = () => {};
    try {
      releaseLock = await lockManager.acquireLock(conversationKey, { requestId });
    } catch (lockErr) {
      sendJson(res, lockErr.status || 429, geminiError(lockErr.status || 429, lockErr.message, 'RESOURCE_EXHAUSTED').body);
      return;
    }

    try {
      const stored = database.getGatewayConversation(token.id, conversationKey);
      const conversation = buildGeminiConversation({
        body: req.body,
        headers: req.headers,
        stored
      });
      const mappedTools = geminiToolsFromBody(req.body, token);
      const fakeBody = {
        tools: mappedTools.map((tool) => (
          tool.type === 'function'
            ? { type: 'function', function: tool }
            : tool
        )),
        extra_body: req.body.extra_body,
        mcp_servers: req.body.mcp_servers
      };
      const tools = mergeTools({
        body: mappedTools.length ? fakeBody : req.body,
        headers: req.headers,
        tokenConfig: token
      });
      await runInteraction({
        req,
        res,
        protocol: 'gemini',
        resolved,
        conversation,
        tools,
        stream,
        endpoint: stream ? ':streamGenerateContent' : ':generateContent',
        source: { contents, stored },
        requestId
      });
    } finally {
      releaseLock();
    }
  }

  router.get('/v1/models', handleModels);
  router.get('/v1beta/openai/models', handleModels);
  router.get('/v1beta/models', handleModels);
  router.post('/v1/chat/completions', handleChatCompletions);
  router.post('/v1beta/openai/chat/completions', handleChatCompletions);
  router.post('/v1/responses', handleResponses);
  router.post('/v1/chat/responses', handleResponses);
  router.post(/^\/v1beta\/models\/(.+):generateContent$/, (req, res) => {
    req.params.model = decodeURIComponent(req.params[0] || req.params.model || '');
    return handleGeminiGenerate(req, res, { stream: false });
  });
  router.post(/^\/v1beta\/models\/(.+):streamGenerateContent$/, (req, res) => {
    req.params.model = decodeURIComponent(req.params[0] || req.params.model || '');
    return handleGeminiGenerate(req, res, { stream: true });
  });

  return router;
}

module.exports = {
  createGatewayRouter,
  publicUpstreamKey,
  pickUpstreamKey,
  buildPayload
};
