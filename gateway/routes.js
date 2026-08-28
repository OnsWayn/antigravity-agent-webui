const express = require('express');
const { authenticateClient } = require('./auth');
const { openaiError, geminiError, sendJson } = require('./errors');
const { callInteractions } = require('./interactions');
const { AGENT_ID, listGatewayModels, resolveModel } = require('./models');
const { isRateLimitError, pickUpstreamKey, RATE_LIMIT_TRIES_PER_KEY, RATE_LIMIT_COOLDOWN_MS, TpmTracker, RequestCounter } = require('./upstream');
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
  requireConversationKey,
  geminiToolsFromBody,
  mergeTools,
  migrateConversationForKeyChange,
  appendTranscript,
  extractOutputText,
  toChatCompletion,
  toGeminiGenerateContent,
  toResponsesResult,
  usageFromInteraction,
  resolveStoredConversation,
  observeCallMarkers,
  isDuplicateCompletedTurn,
  lastAssistantFromTranscript,
  estimateTokens
} = require('./translate');
const { resolveGatewaySettings } = require('./settings');
const { pacificDayKey, nextPacificMidnightMs } = require('./pacific-time');

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

function publicUpstreamKey(row, extras = {}) {
  const now = extras.now != null ? Number(extras.now) : Date.now();
  const today = pacificDayKey(now);
  const rpdUsed = row.rpd_pacific_day === today ? Number(row.rpd_count || 0) : 0;
  const rpmUsed = extras.requestCounter && typeof extras.requestCounter.getRpm === 'function'
    ? extras.requestCounter.getRpm(row.id, now)
    : Number(row.rpmUsed || 0);
  return {
    id: row.id,
    name: row.name,
    suffix: row.key_suffix,
    proxyUrl: row.proxy_url || null,
    enabled: Boolean(row.enabled),
    failCount: Number(row.fail_count || 0),
    cooldownUntil: row.cooldown_until || null,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    rpmUsed,
    rpdUsed,
    rpdResetAt: nextPacificMidnightMs(now),
    rpdDay: today
  };
}

function parseDiagnostics(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function mergeRequestDiagnostics(database, requestId, patch = {}) {
  if (!requestId || !database || typeof database.updateGatewayRequestLog !== 'function') return;
  const existing = database.getGatewayRequestLog(requestId);
  const current = parseDiagnostics(existing?.diagnostics_json);
  database.updateGatewayRequestLog(requestId, {
    diagnosticsJson: { ...current, ...patch }
  });
}

function disconnectedError() {
  const error = new Error('client disconnected');
  error.code = 'client_disconnected';
  error.status = 499;
  return error;
}

function clientDisconnected(req) {
  const socket = req?.socket || req?.connection;
  return req?.aborted === true || socket?.destroyed === true;
}

function sleepAbortable(ms, req) {
  const duration = Math.max(0, Number(ms) || 0);
  return new Promise((resolve, reject) => {
    if (duration <= 0) {
      resolve();
      return;
    }
    if (clientDisconnected(req)) {
      reject(disconnectedError());
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (ok) resolve();
      else reject(disconnectedError());
    };
    const timer = setTimeout(() => finish(true), duration);
    const poll = setInterval(() => {
      if (clientDisconnected(req)) finish(false);
    }, 20);
  });
}

function estimateNeededTokens(database, conversation) {
  const fromLog = database && typeof database.getLatestSuccessTotalTokens === 'function'
    ? database.getLatestSuccessTotalTokens(conversation?.conversationKey)
    : null;
  if (Number.isFinite(fromLog) && fromLog > 0) return fromLog;
  const estimated = estimateTokens(conversation?.input);
  return Number.isFinite(estimated) && estimated > 0 ? estimated : 0;
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

function persistSuccess({ database, token, conversation, resolved, data, endpoint, startedAt, status = 200, upstreamKeyId, stored, logger, requestId }) {
  const usage = usageFromInteraction(data);
  if (usage.totalTokens > 0) database.addClientTokenUsage(token.id, usage.totalTokens);
  const mode = conversation?.mode;
  const targetKey = conversation?.targetConversationKey || conversation?.conversationKey;
  let persistenceDecision = 'skipped';
  let persistenceConflict = false;

  if (mode !== 'stateless' && targetKey) {
    const isContinue = mode === 'continue' || conversation?.upstreamTransition === 'frok';
    const cas = isContinue && stored && stored.conversation_key === targetKey
      ? {
        expectedInteractionId: stored.interaction_id || null,
        expectedUpstreamKeyId: stored.upstream_key_id || null,
        expectedEnvironmentId: stored.environment_id || null
      }
      : {};
    const result = database.upsertGatewayConversation({
      tokenId: token.id,
      conversationKey: targetKey,
      interactionId: data.id,
      environmentId: data.environment_id || null,
      prefixHash: conversation.nextPrefixHash,
      model: resolved.backendModel,
      upstreamKeyId: upstreamKeyId || null,
      transcript: appendTranscript(stored, conversation, extractOutputText(data)),
      parentConversationKey: conversation.parentConversationKey || (mode === 'fork' ? conversation.sourceConversationKey : null),
      parentInteractionId: conversation.parentInteractionId || null,
      parentEnvironmentId: conversation.parentEnvironmentId || null,
      parentUpstreamKeyId: conversation.parentUpstreamKeyId || null,
      ...cas
    });
    persistenceDecision = mode === 'fork' ? 'write_branch' : (conversation?.upstreamTransition === 'frok' ? 'update_trunk_after_frok' : 'update_trunk');
    persistenceConflict = Boolean(result?.conflict);
    if (persistenceConflict && logger) {
      logger.logEvent('warn', 'persistence_conflict', {
        requestId,
        sourceConversationKey: conversation.sourceConversationKey || conversation.conversationKey,
        targetConversationKey: targetKey,
        expectedInteractionId: stored?.interaction_id || null
      });
    }
    if (requestId) {
      try {
        mergeRequestDiagnostics(database, requestId, {
          persistenceDecision,
          persistenceConflict
        });
      } catch {}
    }
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
  return { persistenceDecision, persistenceConflict };
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
    sessionLockTimeoutMs = 120000, // waiter wait cap; the holder is never timed out
    sessionQueueLimit = 3,
    log = () => {},
    callUpstream = callInteractions,
    tpmLimit,
    tpmThresholdRatio,
    tpmWindowMs,
    migrationMaxInputTokens,
    requestCounter: injectedRequestCounter
  } = options;

  const logger = createGatewayLogger(log);
  const requestCounter = injectedRequestCounter || new RequestCounter();
  const tpmTracker = new TpmTracker({
    onReserveExpired: (info) => logger.logEvent('warn', 'tpm_reserve_expired', info)
  });

  function currentSettings() {
    const resolved = resolveGatewaySettings(database);
    return {
      tpmStrategy: resolved.tpmStrategy,
      tpmLimit: tpmLimit != null ? Number(tpmLimit) : resolved.tpmLimit,
      tpmThresholdRatio: tpmThresholdRatio != null ? Number(tpmThresholdRatio) : resolved.tpmThresholdRatio,
      tpmWindowMs: tpmWindowMs != null ? Number(tpmWindowMs) : resolved.tpmWindowMs,
      tpmPaceLimit: resolved.tpmPaceLimit,
      tpmPaceMaxWaitMs: resolved.tpmPaceMaxWaitMs,
      tpmPaceDelayMs: resolved.tpmPaceDelayMs,
      tpmReserveTtlMs: resolved.tpmReserveTtlMs,
      migrationMaxInputTokens: migrationMaxInputTokens != null ? Number(migrationMaxInputTokens) : resolved.migrationMaxInputTokens
    };
  }

  function applyTpmSettings() {
    const settings = currentSettings();
    tpmTracker.configure({
      limitTpm: settings.tpmLimit,
      thresholdRatio: settings.tpmThresholdRatio,
      windowMs: settings.tpmWindowMs,
      reserveTtlMs: settings.tpmReserveTtlMs
    });
    requestCounter.configure({ windowMs: settings.tpmWindowMs });
    return settings;
  }

  function noteUpstreamAttempt(keyId) {
    requestCounter.recordRequest(keyId);
    if (database && typeof database.incrementUpstreamKeyRequest === 'function') {
      database.incrementUpstreamKeyRequest(keyId);
    }
  }

  function settleTpmUsage(keyId, usageTokens, currentReserveId) {
    if (currentReserveId) {
      const committed = tpmTracker.commitReservation(currentReserveId, usageTokens);
      if (!committed) tpmTracker.record(keyId, usageTokens);
      return null;
    }
    tpmTracker.record(keyId, usageTokens);
    return null;
  }

  async function applyPaceStrategy({
    req,
    res,
    stream,
    upstream,
    conversation,
    source,
    settings,
    requestId,
    switchIndex
  }) {
    const stickyId = conversation.upstreamKeyId || source.stored?.upstream_key_id || null;
    const stickyPace = settings.tpmStrategy === 'pace'
      && switchIndex === 0
      && stickyId
      && upstream.row.id === stickyId;
    if (!stickyPace) {
      return {
        upstream,
        tpmAvoided: Boolean(upstream.tpmAvoided),
        reserveId: null,
        tpmPacingDecision: null,
        tpmPaceWaitMs: 0
      };
    }

    const needed = estimateNeededTokens(database, conversation);
    const limit = settings.tpmPaceLimit;
    const pickAlt = () => {
      try {
        const alt = pickUpstreamKey(database, masterKey, {
          preferId: null,
          excludeIds: [upstream.row.id],
          tpmTracker,
          strategy: 'pace',
          tpmPaceLimit: limit,
          needed
        });
        if (alt.row.id !== upstream.row.id) {
          return { ...alt, tpmAvoided: true };
        }
      } catch {}
      return { ...upstream, tpmAvoided: false };
    };

    const skipToFrok = (waitMs, decision) => {
      logger.logEvent('info', 'tpm_pacing_skipped_frok', {
        requestId,
        waitMs: Number.isFinite(waitMs) ? waitMs : null,
        needed,
        recentUsage: tpmTracker.getRecentUsage(upstream.row.id),
        tpmPaceLimit: limit,
        upstreamKeyId: upstream.row.id,
        tpmPacingDecision: decision
      });
      const next = pickAlt();
      return {
        upstream: next,
        tpmAvoided: Boolean(next.tpmAvoided),
        reserveId: null,
        tpmPacingDecision: decision,
        tpmPaceWaitMs: Number.isFinite(waitMs) ? waitMs : 0
      };
    };

    const maxWait = Number(settings.tpmPaceMaxWaitMs);
    let waitMs = tpmTracker.timeUntilFits(upstream.row.id, needed, { limitTpm: limit });
    if (needed > limit || waitMs === Infinity) {
      return skipToFrok(waitMs, 'frok_oversize');
    }
    if (!(waitMs <= maxWait)) {
      return skipToFrok(waitMs, 'frok_timeout');
    }

    if (waitMs > 0) {
      const sleepMs = Math.min(
        waitMs + settings.tpmPaceDelayMs,
        settings.tpmWindowMs + settings.tpmPaceDelayMs
      );
      logger.logEvent('info', 'tpm_pacing', {
        requestId,
        waitMs,
        paceDelayMs: settings.tpmPaceDelayMs,
        needed,
        recentUsage: tpmTracker.getRecentUsage(upstream.row.id),
        tpmPaceLimit: limit,
        upstreamKeyId: upstream.row.id
      });
      if (stream) {
        try { res.write(`: tpm_pacing wait_ms=${sleepMs}\n\n`); } catch {}
      } else {
        disableTimeouts(req, res);
      }
      await sleepAbortable(sleepMs, req);
      waitMs = tpmTracker.timeUntilFits(upstream.row.id, needed, { limitTpm: limit });
      if (needed > limit || waitMs === Infinity) {
        return skipToFrok(waitMs, 'frok_oversize');
      }
      if (!(waitMs <= maxWait)) {
        return skipToFrok(waitMs, 'frok_timeout');
      }
      if (waitMs > 0) {
        const extraSleep = Math.min(
          waitMs + settings.tpmPaceDelayMs,
          settings.tpmWindowMs + settings.tpmPaceDelayMs
        );
        await sleepAbortable(extraSleep, req);
      }
    }

    let reserveId = tpmTracker.tryReserve(upstream.row.id, needed, {
      limitTpm: limit,
      ttlMs: settings.tpmReserveTtlMs
    });
    if (!reserveId) {
      waitMs = tpmTracker.timeUntilFits(upstream.row.id, needed, { limitTpm: limit });
      if (waitMs === 0) {
        reserveId = tpmTracker.tryReserve(upstream.row.id, needed, {
          limitTpm: limit,
          ttlMs: settings.tpmReserveTtlMs
        });
      }
      if (!reserveId) {
        return skipToFrok(waitMs, !(waitMs <= maxWait) ? 'frok_timeout' : 'frok_oversize');
      }
    }

    return {
      upstream,
      tpmAvoided: false,
      reserveId,
      tpmPacingDecision: waitMs > 0 ? 'wait' : 'send',
      tpmPaceWaitMs: waitMs > 0 ? waitMs : 0
    };
  }

  applyTpmSettings();
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

  function replayDuplicateCompletedTurn({
    req,
    res,
    resolved,
    stored,
    messages,
    requestId,
    conversationKey,
    endpoint = '/v1/chat/completions'
  }) {
    if (!isDuplicateCompletedTurn(messages, stored)) return false;

    const token = req.gatewayToken;
    const startedAt = Date.now();
    const assistantText = lastAssistantFromTranscript(stored);
    const stream = Boolean(req.body?.stream);

    try {
      database.insertGatewayRequestLog({
        requestId,
        tokenId: token?.id || null,
        tokenName: token?.name || null,
        endpoint,
        protocol: 'openai',
        downstreamRequestJson: sanitizeForStorage(req.body),
        downstreamHeadersJson: sanitizeHeaders(req.headers),
        conversationKey: conversationKey || stored.conversation_key || null,
        conversationMode: 'continue',
        previousInteractionId: stored.interaction_id || null,
        responseInteractionId: stored.interaction_id || null,
        responseEnvironmentId: stored.environment_id || null,
        model: resolved.requested,
        backendModel: resolved.backendModel,
        stream,
        status: assistantText ? 'success' : 'error',
        errorCode: assistantText ? null : 'duplicate_turn',
        errorMessage: assistantText ? null : 'Duplicate turn already completed; no transcript to replay',
        durationMs: 0,
        createdAt: startedAt,
        upstreamTransition: 'replay',
        diagnosticsJson: { duplicateTurnReplay: true }
      });
    } catch {}

    if (!assistantText) {
      logger.logEvent('warn', 'duplicate_turn_missing_transcript', {
        requestId,
        conversationKey: conversationKey || stored.conversation_key
      });
      sendJson(res, 409, openaiError(409, 'Duplicate turn already completed', 'duplicate_turn').body);
      return true;
    }

    const data = {
      id: stored.interaction_id,
      environment_id: stored.environment_id,
      status: 'completed',
      output_text: assistantText
    };
    logger.logEvent('info', 'duplicate_turn_replayed', {
      requestId,
      conversationKey: conversationKey || stored.conversation_key,
      interactionId: stored.interaction_id
    });

    if (stream) {
      const stopHeartbeat = startSse(res);
      const created = Math.floor(Date.now() / 1000);
      const id = data.id || `chatcmpl_${Date.now()}`;
      emitLiveChatDelta(res, {
        id,
        model: resolved.requested,
        created,
        text: assistantText
      });
      emitChatCompletionsFinish({
        res,
        data,
        requestedModel: resolved.requested,
        id,
        created
      });
      stopHeartbeat();
      res.end();
      return true;
    }

    sendJson(res, 200, toChatCompletion({
      data,
      requestedModel: resolved.requested
    }));
    return true;
  }

  function bindConversationToKey(conversation, upstream, source, {
    forceMigrate = false,
    requestId,
    rebuildReason,
    maxInputTokens
  } = {}) {
    const boundId = conversation.upstreamKeyId || source?.stored?.upstream_key_id;
    if (!forceMigrate && boundId && boundId === upstream.row.id) return conversation;
    if (!forceMigrate && !boundId) return conversation;
    const reason = rebuildReason || (forceMigrate ? 'rate_limit' : 'key_rotation');
    logger.logEvent('info', 'key_rotation_started', {
      requestId,
      conversationKey: conversation.conversationKey,
      sourceConversationKey: conversation.sourceConversationKey || conversation.conversationKey,
      fromKeyUpstreamId: boundId || null,
      toKeyUpstreamId: upstream.row.id,
      forceMigrate,
      contextRebuildReason: reason
    });
    logger.logEvent('info', 'context_rebuild_started', {
      requestId,
      conversationKey: conversation.conversationKey,
      contextRebuildReason: reason
    });
    const originalMode = conversation.mode;
    const migrated = migrateConversationForKeyChange(conversation, source, { maxInputTokens });
    return {
      ...migrated,
      mode: originalMode && originalMode !== 'migrate' ? originalMode : 'continue',
      conversationMode: originalMode && originalMode !== 'migrate' ? originalMode : 'continue',
      upstreamTransition: 'frok',
      contextRebuildReason: reason,
      sourceUpstreamKeyId: boundId || null,
      parentConversationKey: conversation.sourceConversationKey || conversation.conversationKey,
      parentInteractionId: conversation.previousInteractionId || source?.stored?.interaction_id || null,
      parentEnvironmentId: (conversation.environment && conversation.environment !== 'remote')
        ? conversation.environment
        : (source?.stored?.environment_id || null),
      parentUpstreamKeyId: boundId || null,
      sourcePreviousInteractionId: conversation.previousInteractionId || source?.stored?.interaction_id || null,
      upstreamPreviousInteractionId: null,
      targetConversationKey: conversation.targetConversationKey || conversation.conversationKey
    };
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
    const settings = applyTpmSettings();
    const callMarkers = conversation.callMarkers || observeCallMarkers(req.body);

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
        previousInteractionId: conversation.previousInteractionId || conversation.sourcePreviousInteractionId || null,
        model: resolved.requested,
        backendModel: resolved.backendModel,
        stream: Boolean(stream),
        status: 'pending',
        createdAt: startedAt,
        upstreamTransition: conversation.upstreamTransition || 'none',
        contextRebuildReason: conversation.contextRebuildReason || null,
        forkReason: conversation.forkReason || null,
        sourceConversationKey: conversation.sourceConversationKey || conversation.conversationKey || null,
        targetConversationKey: conversation.targetConversationKey || conversation.conversationKey || null,
        sourceUpstreamKeyId: conversation.sourceUpstreamKeyId || conversation.upstreamKeyId || null,
        upstreamPreviousInteractionId: conversation.upstreamPreviousInteractionId !== undefined
          ? conversation.upstreamPreviousInteractionId
          : (conversation.previousInteractionId || null),
        rawCallMarkerDetected: callMarkers.detected,
        rawCallMarkerCount: callMarkers.count,
        toolTraceStatus: conversation.toolTraceStatus || (callMarkers.suspectedModelGenerated ? 'suspected_model_generated' : 'none')
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
        let reserveId = null;
        try {
          upstream = pickUpstreamKey(database, masterKey, {
            preferId: switchIndex === 0 ? (conversation.upstreamKeyId || source.stored?.upstream_key_id) : null,
            excludeIds,
            tpmTracker,
            strategy: settings.tpmStrategy,
            tpmPaceLimit: settings.tpmPaceLimit,
            needed: estimateNeededTokens(database, conversation)
          });
        } catch (error) {
          lastError = error;
          break;
        }

        let tpmAvoided = Boolean(upstream.tpmAvoided);
        let tpmPacingDecision = null;
        let tpmPaceWaitMs = 0;
        try {
          const paced = await applyPaceStrategy({
            req,
            res,
            stream,
            upstream,
            conversation,
            source,
            settings,
            requestId,
            switchIndex
          });
          upstream = paced.upstream;
          tpmAvoided = Boolean(paced.tpmAvoided);
          reserveId = paced.reserveId || null;
          tpmPacingDecision = paced.tpmPacingDecision;
          tpmPaceWaitMs = paced.tpmPaceWaitMs || 0;
        } catch (error) {
          if (reserveId) tpmTracker.cancelReservation(reserveId);
          lastError = error;
          if (error.code === 'client_disconnected') {
            try {
              database.updateGatewayRequestLog(requestId, {
                status: 'error',
                errorCode: 'client_disconnected',
                errorMessage: error.message,
                durationMs: Date.now() - startedAt
              });
            } catch {}
            try { res.destroy(); } catch {}
            return;
          }
          break;
        }

        if (tpmPacingDecision) {
          try {
            mergeRequestDiagnostics(database, requestId, {
              tpmStrategy: settings.tpmStrategy,
              tpmPaceWaitMs,
              tpmPacingDecision
            });
          } catch {}
        }

        if (switchIndex > 0) {
          logger.logEvent('warn', 'key_rotated', {
            requestId,
            conversationKey: conversation.conversationKey,
            switchIndex,
            newUpstreamKeyId: upstream.row.id
          });
        }
        if (tpmAvoided) {
          logger.logEvent('info', 'tpm_avoidance', {
            requestId,
            conversationKey: conversation.conversationKey,
            avoidedUpstreamKeyId: conversation.upstreamKeyId || source.stored?.upstream_key_id || null,
            selectedUpstreamKeyId: upstream.row.id,
            tpmLimit: settings.tpmStrategy === 'pace' ? settings.tpmPaceLimit : settings.tpmLimit,
            tpmThresholdRatio: settings.tpmThresholdRatio,
            recentUsage: tpmTracker.getRecentUsage(conversation.upstreamKeyId || source.stored?.upstream_key_id)
          });
        }

        let conversationForCall = bindConversationToKey(
          conversation,
          upstream,
          source,
          {
            forceMigrate: switchIndex > 0,
            requestId,
            rebuildReason: switchIndex > 0
              ? 'rate_limit'
              : (tpmAvoided ? 'tpm_limit' : 'key_rotation'),
            maxInputTokens: settings.migrationMaxInputTokens
          }
        );

        try {
        for (let attempt = 1; attempt <= RATE_LIMIT_TRIES_PER_KEY; attempt++) {
          const payload = buildPayload({ resolved, conversation: conversationForCall, tools, stream });
          try {
            database.updateGatewayRequestLog(requestId, {
              upstreamKeyId: upstream.row.id,
              upstreamKeyName: upstream.row.name,
              keySwitchCount: switchIndex,
              retryCount: attempt - 1,
              upstreamRequestJson: sanitizeForStorage(payload),
              conversationMode: conversationForCall.mode || null,
              upstreamTransition: conversationForCall.upstreamTransition || 'none',
              contextRebuildReason: conversationForCall.contextRebuildReason || null,
              forkReason: conversationForCall.forkReason || null,
              sourceConversationKey: conversationForCall.sourceConversationKey || conversationForCall.conversationKey || null,
              targetConversationKey: conversationForCall.targetConversationKey || conversationForCall.conversationKey || null,
              sourceUpstreamKeyId: conversationForCall.sourceUpstreamKeyId || conversation.upstreamKeyId || null,
              previousInteractionId: conversationForCall.sourcePreviousInteractionId || conversation.previousInteractionId || null,
              upstreamPreviousInteractionId: conversationForCall.previousInteractionId || null,
              toolTraceStatus: conversationForCall.toolTraceStatus || null
            });
          } catch {}

          logger.logEvent('info', 'interaction_request', {
            requestId,
            endpoint,
            model: resolved.requested,
            backendModel: resolved.backendModel,
            mode: conversationForCall.mode,
            conversationMode: conversationForCall.mode,
            upstreamTransition: conversationForCall.upstreamTransition || 'none',
            contextRebuildReason: conversationForCall.contextRebuildReason || null,
            stream,
            upstreamKey: upstream.row.id,
            attempt,
            conversationKey: conversationForCall.conversationKey,
            sourceConversationKey: conversationForCall.sourceConversationKey,
            targetConversationKey: conversationForCall.targetConversationKey,
            previousInteractionId: conversationForCall.previousInteractionId,
            environment: conversationForCall.environment
          });

          try {
            if (stream) {
              let state = {};
              noteUpstreamAttempt(upstream.row.id);
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
              reserveId = settleTpmUsage(upstream.row.id, usage.totalTokens, reserveId);
              persistSuccess({
                database,
                token,
                conversation: conversationForCall,
                resolved,
                data,
                endpoint,
                startedAt,
                upstreamKeyId: upstream.row.id,
                stored: source.stored,
                logger,
                requestId
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
              if (conversationForCall.upstreamTransition === 'frok') {
                logger.logEvent('info', 'context_rebuild_completed', {
                  requestId,
                  conversationKey: conversationForCall.conversationKey,
                  sourceConversationKey: conversationForCall.sourceConversationKey,
                  targetConversationKey: conversationForCall.targetConversationKey,
                  interactionId: data.id,
                  environmentId: data.environment_id,
                  contextRebuildReason: conversationForCall.contextRebuildReason,
                  conversationMode: conversationForCall.mode,
                  upstreamTransition: 'frok'
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

            noteUpstreamAttempt(upstream.row.id);
            const data = await callUpstream({
              apiKey: upstream.apiKey,
              payload,
              proxyUrl: upstream.proxyUrl,
              stream: false
            });
            const usage = usageFromInteraction(data);
            reserveId = settleTpmUsage(upstream.row.id, usage.totalTokens, reserveId);
            persistSuccess({
              database,
              token,
              conversation: conversationForCall,
              resolved,
              data,
              endpoint,
              startedAt,
              upstreamKeyId: upstream.row.id,
              stored: source.stored,
              logger,
              requestId
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
            if (conversationForCall.upstreamTransition === 'frok') {
              logger.logEvent('info', 'context_rebuild_completed', {
                requestId,
                conversationKey: conversationForCall.conversationKey,
                sourceConversationKey: conversationForCall.sourceConversationKey,
                targetConversationKey: conversationForCall.targetConversationKey,
                interactionId: data.id,
                environmentId: data.environment_id,
                contextRebuildReason: conversationForCall.contextRebuildReason,
                conversationMode: conversationForCall.mode,
                upstreamTransition: 'frok'
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
              if (reserveId) {
                tpmTracker.cancelReservation(reserveId);
                reserveId = null;
              }
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

            if (reserveId) {
              tpmTracker.cancelReservation(reserveId);
              reserveId = null;
            }
            excludeIds.push(upstream.row.id);
            break;
          }
        }
        } finally {
          if (reserveId) {
            tpmTracker.cancelReservation(reserveId);
            reserveId = null;
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
      const stored = resolveStoredConversation(database, token.id, conversationKey, req.body.messages);
      if (replayDuplicateCompletedTurn({
        req,
        res,
        resolved,
        stored,
        messages: req.body.messages,
        requestId,
        conversationKey,
        endpoint: '/v1/chat/completions'
      })) {
        return;
      }
      const conversation = buildOpenAIConversation({
        messages: req.body.messages,
        headers: req.headers,
        body: req.body,
        stored,
        resolveCallId: (id) => database.resolveGoogleCallId(id),
        requestId,
        sourceConversationKey: conversationKey,
        maxInputTokens: currentSettings().migrationMaxInputTokens
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
