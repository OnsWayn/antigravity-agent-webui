const { pendingFunctionCalls, extractOutputText, usageFromInteraction, toOpenAIToolCalls } = require('./translate');

function writeSse(res, payload, eventName) {
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

function startSse(res, { heartbeatMs = 3000 } = {}) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (typeof res.flush === 'function') res.flush();

  const timer = setInterval(() => {
    try {
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch {}
  }, heartbeatMs);
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}

function chatChunk({ id, model, created, delta, finishReason, usage }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: delta || {},
      finish_reason: finishReason || null
    }],
    ...(usage ? { usage } : {})
  };
}

function emitChatCompletionsFinish({ res, data, requestedModel, saveMapping, id, created }) {
  const streamId = id || data.id || `chatcmpl_${Date.now()}`;
  const createdAt = created || Math.floor(Date.now() / 1000);
  const calls = pendingFunctionCalls(data);
  const usage = usageFromInteraction(data);
  if (calls.length) {
    const toolCalls = toOpenAIToolCalls(calls, saveMapping);
    writeSse(res, chatChunk({
      id: streamId,
      model: requestedModel,
      created: createdAt,
      delta: { tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }
    }));
  }
  writeSse(res, chatChunk({
    id: streamId,
    model: requestedModel,
    created: createdAt,
    delta: {},
    finishReason: calls.length ? 'tool_calls' : (data.status === 'incomplete' ? 'length' : 'stop'),
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens
    }
  }));
  writeSse(res, '[DONE]');
}

function emitChatCompletionsStream({ res, data, requestedModel, saveMapping }) {
  const id = data.id || `chatcmpl_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const text = extractOutputText(data);
  const calls = pendingFunctionCalls(data);
  const usage = usageFromInteraction(data);

  writeSse(res, chatChunk({ id, model: requestedModel, created, delta: { role: 'assistant', content: '' } }));
  if (text) {
    writeSse(res, chatChunk({ id, model: requestedModel, created, delta: { content: text } }));
  }
  if (calls.length) {
    const toolCalls = toOpenAIToolCalls(calls, saveMapping);
    writeSse(res, chatChunk({
      id,
      model: requestedModel,
      created,
      delta: { tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }
    }));
    writeSse(res, chatChunk({
      id,
      model: requestedModel,
      created,
      delta: {},
      finishReason: 'tool_calls',
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      }
    }));
  } else {
    writeSse(res, chatChunk({
      id,
      model: requestedModel,
      created,
      delta: {},
      finishReason: data.status === 'incomplete' ? 'length' : 'stop',
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      }
    }));
  }
  writeSse(res, '[DONE]');
}

function emitLiveChatDelta(res, { id, model, created, text }) {
  if (!text) return;
  writeSse(res, chatChunk({ id, model, created, delta: { content: text } }));
}

function emitResponsesStream({ res, data, requestedModel }) {
  const id = data.id;
  const text = extractOutputText(data);
  writeSse(res, {
    type: 'response.created',
    response: { id, object: 'response', status: 'in_progress', model: requestedModel }
  }, 'response.created');
  if (text) {
    writeSse(res, {
      type: 'response.output_text.delta',
      delta: text
    }, 'response.output_text.delta');
  }
  writeSse(res, {
    type: 'response.completed',
    response: {
      id,
      object: 'response',
      status: data.status || 'completed',
      model: requestedModel,
      output_text: text
    }
  }, 'response.completed');
  writeSse(res, '[DONE]');
}

function emitGeminiStream({ res, data }) {
  const text = extractOutputText(data);
  const payload = {
    candidates: [{
      content: { role: 'model', parts: [{ text: text || '' }] },
      finishReason: 'STOP'
    }]
  };
  writeSse(res, payload);
}

function applyStreamEvent(event, state) {
  const next = state || { text: '', calls: {}, id: null, status: null, usage: null, data: null };
  if (!event || typeof event !== 'object') return next;
  if (event.id) next.id = event.id;
  if (event.status) next.status = event.status;
  if (event.usage) next.usage = event.usage;
  if (event.environment_id) next.environmentId = event.environment_id;
  if (event.interaction?.environment_id) next.environmentId = event.interaction.environment_id;
  const type = event.event_type || event.type;
  if (type === 'step.delta' && event.delta?.type === 'text' && event.delta.text) {
    next.text += event.delta.text;
    next.lastDelta = event.delta.text;
  } else {
    next.lastDelta = '';
  }
  if (type === 'step.start' && event.step?.type === 'function_call') {
    next.calls[event.index ?? event.step.id] = {
      id: event.step.id,
      name: event.step.name,
      arguments: typeof event.step.arguments === 'string'
        ? event.step.arguments
        : JSON.stringify(event.step.arguments || {})
    };
  }
  if (type === 'step.delta' && event.delta?.type === 'arguments') {
    const current = next.calls[event.index];
    if (current) current.arguments += event.delta.partial_arguments || '';
  }
  if (event.object === 'interaction' || event.steps) {
    next.data = event;
    next.text = extractOutputText(event) || next.text;
  }
  if (type === 'interaction.completed' || type === 'interaction.complete') {
    next.data = event.interaction || event;
    if (next.data?.output_text) next.text = next.data.output_text;
    next.status = next.data?.status || 'completed';
  }
  return next;
}

function finalizeStreamState(state) {
  const calls = Object.values(state.calls || {});
  const data = state.data || {
    id: state.id,
    status: state.status || (calls.length ? 'requires_action' : 'completed'),
    output_text: state.text,
    usage: state.usage,
    environment_id: state.environmentId,
    steps: [
      ...(state.text ? [{ type: 'model_output', content: [{ type: 'text', text: state.text }] }] : []),
      ...calls.map((call) => ({
        type: 'function_call',
        id: call.id,
        name: call.name,
        arguments: call.arguments
      }))
    ]
  };
  if (!data.output_text) data.output_text = state.text;
  if (!data.id) data.id = state.id;
  if (!data.environment_id && state.environmentId) data.environment_id = state.environmentId;
  return data;
}

module.exports = {
  writeSse,
  startSse,
  chatChunk,
  emitChatCompletionsStream,
  emitChatCompletionsFinish,
  emitLiveChatDelta,
  emitResponsesStream,
  emitGeminiStream,
  applyStreamEvent,
  finalizeStreamState
};
