const express = require('express');
const { authenticateClient } = require('./auth');
const { openaiError, geminiError, sendJson } = require('./errors');
const { callInteractions } = require('./interactions');
const { AGENT_ID, listGatewayModels, resolveModel } = require('./models');
const { isRateLimitError, pickUpstreamKey, RATE_LIMIT_TRIES_PER_KEY, RATE_LIMIT_COOLDOWN_MS } = require('./upstream');
const {
  applyStreamEvent,
  emitChatCompletionsFinish,
  emitLiveChatDelta,
  finalizeStreamState,
  startSse,
  writeSse,
  chatChunk
} = require('./stream');
const {
  buildGeminiConversation,
  buildOpenAIConversation,
  buildResponsesConversation,
  conversationKeyFrom,
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
    log = () => {},
    callUpstream = callInteractions
  } = options;

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

  function bindConversationToKey(conversation, upstream, source, { forceMigrate = false } = {}) {
    const boundId = conversation.upstreamKeyId || source?.stored?.upstream_key_id;
    if (!forceMigrate && boundId && boundId === upstream.row.id) return conversation;
    if (!forceMigrate && !boundId) return conversation;
    log('info', 'Migrating conversation onto a new upstream key and sandbox', {
      from: boundId || null,
      to: upstream.row.id
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
    source = {}
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
            excludeIds
          });
        } catch (error) {
          lastError = error;
          break;
        }

        let conversationForCall = bindConversationToKey(
          conversation,
          upstream,
          source,
          { forceMigrate: switchIndex > 0 }
        );

        for (let attempt = 1; attempt <= RATE_LIMIT_TRIES_PER_KEY; attempt++) {
          const payload = buildPayload({ resolved, conversation: conversationForCall, tools, stream });
          log('info', 'Gateway forwarding to Interactions API', {
            endpoint,
            model: resolved.requested,
            backendModel: resolved.backendModel,
            mode: conversationForCall.mode,
            stream,
            upstreamKey: upstream.row.id,
            attempt
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
              log('error', 'Gateway upstream call failed', { message: error.message, code: error.code });
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
            log('warn', 'Upstream key rate limited', {
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
    sendJson(res, 200, { object: 'list', data: listGatewayModels() });
  }

  async function handleChatCompletions(req, res) {
    const token = authOrError(req, res, 'openai');
    if (!token) return;
    req.gatewayToken = token;
    const resolved = resolveModel(req.body?.model);
    if (!resolved.ok) {
      sendJson(res, 400, openaiError(400, resolved.error, 'model_not_found').body);
      return;
    }
    if (!Array.isArray(req.body?.messages)) {
      sendJson(res, 400, openaiError(400, 'messages is required', 'invalid_request_error').body);
      return;
    }
    const conversationKey = conversationKeyFrom({
      messages: req.body.messages,
      headers: req.headers,
      body: req.body
    });
    const stored = database.getGatewayConversation(token.id, conversationKey);
    const conversation = buildOpenAIConversation({
      messages: req.body.messages,
      headers: req.headers,
      body: req.body,
      stored,
      resolveCallId: (id) => database.resolveGoogleCallId(id)
    });
    const tools = mergeTools({ body: req.body, headers: req.headers });
    await runInteraction({
      req,
      res,
      protocol: 'openai',
      resolved,
      conversation,
      tools,
      stream: Boolean(req.body?.stream),
      endpoint: '/v1/chat/completions',
      source: { messages: req.body.messages, stored }
    });
  }

  async function handleResponses(req, res) {
    const token = authOrError(req, res, 'openai');
    if (!token) return;
    req.gatewayToken = token;
    const resolved = resolveModel(req.body?.model);
    if (!resolved.ok) {
      sendJson(res, 400, openaiError(400, resolved.error, 'model_not_found').body);
      return;
    }
    if (req.body?.input == null) {
      sendJson(res, 400, openaiError(400, 'input is required', 'invalid_request_error').body);
      return;
    }
    const key = req.body.previous_response_id
      ? `resp:${req.body.previous_response_id}`
      : conversationKeyFrom({
        messages: [],
        headers: req.headers,
        body: req.body
      });
    const stored = database.getGatewayConversation(token.id, key)
      || (req.body.previous_response_id
        ? { interaction_id: req.body.previous_response_id, environment_id: null, prefix_hash: '' }
        : null);
    const resolvedStored = database.getGatewayConversation(token.id, key) || stored;
    const conversation = buildResponsesConversation({
      body: req.body,
      headers: req.headers,
      stored: resolvedStored
    });
    const tools = mergeTools({ body: req.body, headers: req.headers });
    await runInteraction({
      req,
      res,
      protocol: 'responses',
      resolved,
      conversation,
      tools,
      stream: Boolean(req.body?.stream),
      endpoint: '/v1/responses',
      source: { input: req.body.input, stored: resolvedStored }
    });
  }

  async function handleGeminiGenerate(req, res, { stream }) {
    const token = authOrError(req, res, 'gemini');
    if (!token) return;
    req.gatewayToken = token;
    const rawModel = decodeURIComponent(req.params.model || req.body?.model || AGENT_ID);
    const resolved = resolveModel(rawModel);
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
    const stored = database.getGatewayConversation(token.id, conversationProbe.conversationKey);
    const conversation = buildGeminiConversation({
      body: req.body,
      headers: req.headers,
      stored
    });
    const mappedTools = geminiToolsFromBody(req.body);
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
      headers: req.headers
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
      source: { contents, stored }
    });
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
