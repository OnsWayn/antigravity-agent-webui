const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildOpenAIConversation,
  buildSafeHistoryInput,
  estimateImageTokens,
  estimateTokenBreakdown,
  estimateTokens,
  hashNonAssistant,
  mergeTools,
  openaiMessageToInputParts,
  parseImageRef,
  pendingFunctionCalls,
  toChatCompletion,
  DEFAULT_IMAGE_TOKENS,
  MAX_IMAGE_TOKENS
} = require('../gateway/translate');

function jpegDataUrl({ width = 1920, height = 1080, dataUrlLength } = {}) {
  const prefix = 'data:image/jpeg;base64,';
  const sof = Buffer.from([
    0xFF, 0xD8,
    0xFF, 0xC0, 0x00, 0x0B, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xFF, 0xD9
  ]);
  if (!dataUrlLength) return prefix + sof.toString('base64');
  const b64Target = Math.max(0, dataUrlLength - prefix.length);
  const rawTarget = Math.floor(b64Target * 3 / 4);
  const pad = Math.max(0, rawTarget - sof.length);
  const buf = Buffer.concat([
    sof.subarray(0, sof.length - 2),
    Buffer.alloc(pad, 0x00),
    Buffer.from([0xFF, 0xD9])
  ]);
  let b64 = buf.toString('base64');
  if (prefix.length + b64.length > dataUrlLength) b64 = b64.slice(0, dataUrlLength - prefix.length);
  while (prefix.length + b64.length < dataUrlLength) b64 += 'A';
  return prefix + b64;
}

function countInputImages(input) {
  if (!Array.isArray(input)) return 0;
  return input.filter((part) => part && part.type === 'image').length;
}
const { resolveModel: resolveGatewayModel } = require('../gateway/models');

test('maps data URL images into Interactions image parts', () => {
  const parts = openaiMessageToInputParts({
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }
    ]
  });
  assert.equal(parts[0].type, 'text');
  assert.deepEqual(parts[1], { type: 'image', mime_type: 'image/png', data: 'aGVsbG8=' });
  const parsed = parseImageRef('https://example.com/a.png');
  assert.equal(parsed.url, 'https://example.com/a.png');
});

test('continues a conversation with only the new user turn', () => {
  const first = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' }
  ];
  const firstTurn = buildOpenAIConversation({ messages: first, stored: null });
  assert.equal(firstTurn.mode, 'new');
  assert.equal(firstTurn.input, 'hello');
  assert.equal(firstTurn.environment, 'remote');
  assert.equal(firstTurn.systemInstruction, 'sys');

  const second = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'next' }
  ];
  const continued = buildOpenAIConversation({
    messages: second,
    stored: {
      interaction_id: 'int-1',
      environment_id: 'env-1',
      prefix_hash: hashNonAssistant(first)
    }
  });
  assert.equal(continued.mode, 'continue');
  assert.equal(continued.input, 'next');
  assert.equal(continued.previousInteractionId, 'int-1');
  assert.equal(continued.environment, 'env-1');
});

test('changing the system prompt does not fork an existing sandbox chat', () => {
  const storedHash = hashNonAssistant([
    { role: 'system', content: 'sys v1' },
    { role: 'user', content: 'hello' }
  ]);
  const continued = buildOpenAIConversation({
    messages: [
      { role: 'system', content: 'sys v2 ' + new Date().toISOString() },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' }
    ],
    stored: {
      interaction_id: 'int-1',
      environment_id: 'env-1',
      prefix_hash: storedHash
    }
  });
  assert.equal(continued.mode, 'continue');
  assert.equal(continued.environment, 'env-1');
  assert.equal(continued.input, 'next');
});

test('forks when earlier history is edited', () => {
  const storedHash = hashNonAssistant([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' }
  ]);
  const edited = buildOpenAIConversation({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'CHANGED' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' }
    ],
    stored: {
      interaction_id: 'int-1',
      environment_id: 'env-1',
      prefix_hash: storedHash
    }
  });
  assert.equal(edited.mode, 'fork');
  assert.equal(edited.previousInteractionId, undefined);
  assert.equal(edited.environment, 'remote');
  assert.deepEqual(edited.input, [
    { type: 'text', text: 'User: CHANGED' },
    { type: 'text', text: 'Assistant: hi' },
    { type: 'text', text: 'User: next' }
  ]);
});

test('maps trailing tool messages to function_result', () => {
  const result = buildOpenAIConversation({
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'get_weather' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '{"ok":true}' }
    ],
    stored: {
      interaction_id: 'int-2',
      environment_id: 'env-2',
      prefix_hash: hashNonAssistant([
        { role: 'user', content: 'weather?' }
      ])
    },
    resolveCallId: (id) => id === 'call_1' ? 'google-1' : id
  });
  assert.equal(result.mode, 'continue');
  assert.equal(result.input[0].type, 'function_result');
  assert.equal(result.input[0].call_id, 'google-1');
});

test('merges client tools with Antigravity defaults', () => {
  const tools = mergeTools({
    body: {
      tools: [{
        type: 'function',
        function: { name: 'lookup', description: 'd', parameters: { type: 'object' } }
      }],
      extra_body: {
        mcp_servers: [{ name: 'Weather-API', url: 'https://example.com/mcp' }]
      }
    },
    headers: {}
  });
  assert.equal(tools[0].type, 'code_execution');
  assert.equal(tools.some((tool) => tool.name === 'lookup'), true);
  assert.equal(tools.some((tool) => tool.type === 'mcp_server' && tool.name === 'weather_api'), true);
});

test('converts requires_action steps into OpenAI tool_calls', () => {
  const completion = toChatCompletion({
    requestedModel: 'gemini-3.7-flash',
    data: {
      id: 'int-9',
      status: 'requires_action',
      output_text: '',
      steps: [{ type: 'function_call', id: 'g1', name: 'lookup', arguments: { q: 'hi' } }],
      usage: { total_input_tokens: 10, total_output_tokens: 2, total_tokens: 12 }
    }
  });
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, 'lookup');
});

test('pending function calls ignore already executed ids', () => {
  const pending = pendingFunctionCalls({
    steps: [
      { type: 'function_call', id: 'a', name: 'one' },
      { type: 'function_result', call_id: 'a' },
      { type: 'function_call', id: 'b', name: 'two' }
    ]
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'b');
});

test('key migration flattens history onto a new sandbox without previous ids', () => {
  const { migrateConversationForKeyChange } = require('../gateway/translate');
  const migrated = migrateConversationForKeyChange({
    input: 'next',
    environment: 'env-old',
    previousInteractionId: 'int-old',
    mode: 'continue',
    systemInstruction: 'sys'
  }, {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'continue the file' }
    ]
  });
  assert.equal(migrated.environment, 'remote');
  assert.equal(migrated.previousInteractionId, undefined);
  assert.equal(migrated.mode, 'migrate');
  assert.match(String(JSON.stringify(migrated.input)), /hello/);
  assert.match(String(JSON.stringify(migrated.input)), /hi there/);
  assert.match(String(JSON.stringify(migrated.input)), /NEW sandbox/);
});

test('resolveModel supports default backends and custom models', () => {
  assert.equal(resolveGatewayModel('gemini-3.5-flash-lite').backendModel, 'gemini-3.5-flash-lite');
  assert.equal(resolveGatewayModel('antigravity-preview-05-2026/gemini-3.6-flash').backendModel, 'gemini-3.6-flash');
  // Custom model pass-through
  const custom = resolveGatewayModel('gemini-3.1-pro-preview');
  assert.equal(custom.ok, true);
  assert.equal(custom.backendModel, 'gemini-3.1-pro-preview');
  assert.equal(custom.custom, true);
  // Disabled custom model
  assert.equal(resolveGatewayModel('gemini-3.1-pro-preview', { allowCustom: false }).ok, false);
  // Allowed models filter
  assert.equal(resolveGatewayModel('gemini-3.5-flash', { allowedModels: ['gemini-3.7-flash'] }).ok, false);
  assert.equal(resolveGatewayModel('gemini-3.7-flash', { allowedModels: ['gemini-3.7-flash'] }).ok, true);
});

test('model catalog only lists Antigravity agent ids, not the key Gemini catalog', () => {
  const { listGatewayModels } = require('../gateway/models');
  const ids = listGatewayModels().map((model) => model.id);
  assert.deepEqual(ids, [
    'antigravity-preview-05-2026',
    'antigravity-preview-05-2026/gemini-3.7-flash',
    'antigravity-preview-05-2026/gemini-3.6-flash',
    'antigravity-preview-05-2026/gemini-3.5-flash',
    'antigravity-preview-05-2026/gemini-3.5-flash-lite'
  ]);
});

test('preserves multi-turn conversation and tool calls history on new and fork modes', () => {
  const messages = [
    { role: 'system', content: 'You are an assistant' },
    { role: 'user', content: 'read file foo.txt' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"foo.txt"}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'hello world contents' },
    { role: 'assistant', content: 'file content is hello world' },
    { role: 'user', content: 'what was in the file?' }
  ];

  // New mode with pre-existing multi-turn history
  const convNew = buildOpenAIConversation({ messages, stored: null });
  assert.equal(convNew.mode, 'new');
  assert.equal(convNew.previousInteractionId, undefined);
  assert.equal(Array.isArray(convNew.input), true);
  const inputStr = JSON.stringify(convNew.input);
  assert.match(inputStr, /read file foo\.txt/);
  assert.match(inputStr, /hello world contents/);
  assert.match(inputStr, /file content is hello world/);
  assert.match(inputStr, /what was in the file\?/);
  assert.doesNotMatch(inputStr, /\[Calls:/);
  assert.doesNotMatch(inputStr, /Tool result \(/);

  // Fork mode with mismatched prefix hash
  const convFork = buildOpenAIConversation({
    messages,
    stored: {
      interaction_id: 'old-int',
      environment_id: 'old-env',
      prefix_hash: 'mismatched-hash'
    }
  });
  assert.equal(convFork.mode, 'fork');
  assert.equal(convFork.previousInteractionId, undefined);
  assert.equal(Array.isArray(convFork.input), true);
  const forkInputStr = JSON.stringify(convFork.input);
  assert.match(forkInputStr, /read file foo\.txt/);
  assert.match(forkInputStr, /hello world contents/);
  assert.match(forkInputStr, /what was in the file\?/);
  assert.doesNotMatch(forkInputStr, /\[Calls:/);
  assert.doesNotMatch(forkInputStr, /Tool result \(/);
  assert.equal(convFork.forkReason, 'prefix_mismatch');
  assert.match(convFork.targetConversationKey, /:fork:/);
});

test('summarizeToolHistory keeps call ids and never emits [Calls:] templates', () => {
  const { summarizeToolHistory, flattenMessagesToInput, migrateConversationForKeyChange } = require('../gateway/translate');
  const messages = [
    { role: 'user', content: 'run python' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_123', function: { name: 'astrbot_execute_python', arguments: '{"code":"print(1)"}' } }]
    },
    { role: 'tool', tool_call_id: 'call_123', name: 'astrbot_execute_python', content: 'PIL available; cairosvg available' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'continue' }
  ];
  const summary = summarizeToolHistory(messages);
  assert.equal(summary.summaries.length, 1);
  assert.equal(summary.summaries[0].callId, 'call_123');
  assert.equal(summary.summaries[0].name, 'astrbot_execute_python');
  assert.match(summary.summaries[0].resultPreview, /PIL available/);

  const flattened = JSON.stringify(flattenMessagesToInput(messages));
  assert.doesNotMatch(flattened, /\[Calls:/);
  assert.doesNotMatch(flattened, /Tool result \(/);
  assert.match(flattened, /astrbot_execute_python/);
  assert.match(flattened, /call_123/);

  const migrated = migrateConversationForKeyChange({
    input: 'continue',
    environment: 'env-old',
    previousInteractionId: 'int-old',
    mode: 'continue',
    conversationKey: 'hdr:qq:1'
  }, { messages });
  assert.equal(migrated.mode, 'migrate');
  assert.equal(migrated.upstreamTransition, 'frok');
  const migratedText = JSON.stringify(migrated.input);
  assert.doesNotMatch(migratedText, /\[Calls:/);
  assert.match(migratedText, /NEW sandbox/);
  assert.match(migratedText, /call_123/);
});

test('replayed early user message forks instead of continuing', () => {
  const first = [
    { role: 'user', content: '今天新闻' },
    { role: 'assistant', content: '头条如下' },
    { role: 'user', content: '再详细点' }
  ];
  const stored = {
    interaction_id: 'int-1',
    environment_id: 'env-1',
    prefix_hash: hashNonAssistant(first.slice(0, -1)),
    transcript_json: JSON.stringify([
      { role: 'user', text: '今天新闻' },
      { role: 'assistant', text: '头条如下' },
      { role: 'user', text: '再详细点' }
    ]),
    conversation_key: 'hdr:s1'
  };
  const replayed = buildOpenAIConversation({
    messages: [{ role: 'user', content: '今天新闻' }],
    headers: { 'x-session-id': 's1' },
    stored
  });
  assert.equal(replayed.mode, 'fork');
  assert.equal(replayed.forkReason, 'replayed_old_message');
  assert.equal(replayed.previousInteractionId, undefined);
  assert.match(replayed.targetConversationKey, /:fork:/);
});

test('orphan tool calls are recorded without invented results', () => {
  const { summarizeToolHistory } = require('../gateway/translate');
  const summary = summarizeToolHistory([
    {
      role: 'assistant',
      tool_calls: [{ id: 'call_orphan', function: { name: 'lookup', arguments: '{}' } }]
    }
  ]);
  assert.equal(summary.summaries.length, 0);
  assert.equal(summary.orphans.length, 1);
  assert.equal(summary.orphans[0].callId, 'call_orphan');
  assert.equal(summary.toolTraceStatus, 'orphan');
});

test('estimateTokens uses visual image tokens instead of chars/4 for a 351763 data URL', () => {
  const url = jpegDataUrl({ width: 1920, height: 1080, dataUrlLength: 351763 });
  assert.equal(url.length, 351763);
  const estimated = estimateTokens(url);
  const naive = Math.ceil(url.length / 4);
  assert.ok(estimated >= 258 && estimated <= MAX_IMAGE_TOKENS, `got ${estimated}`);
  assert.notEqual(estimated, naive);
  assert.ok(naive > 80000);
  assert.equal(estimateImageTokens({ url }), estimated);
});

test('estimateTokens keeps chars/4 for plain strings', () => {
  const text = 'abcd'.repeat(100);
  assert.equal(estimateTokens(text), Math.ceil(text.length / 4));
  assert.equal(estimateTokens('hello'), Math.ceil('hello'.length / 4));
});

test('tiny JPEG uses tile or media-resolution default, not chars/4', () => {
  const url = jpegDataUrl({ width: 10, height: 10 });
  const estimated = estimateTokens({ type: 'image', mime_type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) });
  const naive = Math.ceil(url.length / 4);
  assert.ok(estimated === 258 || estimated === 1120 || estimated === DEFAULT_IMAGE_TOKENS, `got ${estimated}`);
  assert.notEqual(estimated, naive);
  assert.ok(estimated <= MAX_IMAGE_TOKENS);
});

test('unparseable image data falls back to DEFAULT_IMAGE_TOKENS and stays capped', () => {
  const estimated = estimateTokens({
    type: 'image',
    mime_type: 'image/jpeg',
    data: 'this-is-not-a-valid-image-payload!!!!'
  });
  assert.equal(estimated, DEFAULT_IMAGE_TOKENS);
  assert.ok(estimated <= MAX_IMAGE_TOKENS);
});

test('buildSafeHistoryInput keeps last-user text and both large images under 24000 budget', () => {
  const big = jpegDataUrl({ width: 1920, height: 1080, dataUrlLength: 351763 });
  const small = jpegDataUrl({ width: 640, height: 480, dataUrlLength: 57179 });
  const rebuilt = buildSafeHistoryInput([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'older context ' + 'x'.repeat(8000) },
    { role: 'assistant', content: 'ack ' + 'y'.repeat(8000) },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请根据表情包和参考人物继续画' },
        { type: 'image_url', image_url: { url: big } },
        { type: 'image_url', image_url: { url: small } }
      ]
    }
  ], { maxInputTokens: 24000 });
  const text = typeof rebuilt.input === 'string' ? rebuilt.input : JSON.stringify(rebuilt.input);
  assert.match(text, /请根据表情包和参考人物继续画/);
  assert.equal(countInputImages(rebuilt.input), 2);
  assert.ok(rebuilt.estimatedTokens <= 24000 || rebuilt.imageCount === 2);
  assert.ok(rebuilt.estimatedTokens < 50000);
});

test('buildSafeHistoryInput keeps only the last copy of a replayed image', () => {
  const url = jpegDataUrl({ width: 800, height: 600, dataUrlLength: 120000 });
  const imageTurn = {
    role: 'user',
    content: [
      { type: 'text', text: 'see this' },
      { type: 'image_url', image_url: { url } }
    ]
  };
  const rebuilt = buildSafeHistoryInput([
    imageTurn,
    { role: 'assistant', content: 'ok' },
    { ...imageTurn, content: [...imageTurn.content] },
    { role: 'assistant', content: 'still ok' },
    { ...imageTurn, content: [...imageTurn.content] }
  ], { maxInputTokens: 24000 });
  assert.equal(countInputImages(rebuilt.input), 1);
  const text = JSON.stringify(rebuilt.input);
  assert.match(text, /see this/);
});

test('over-budget plain text still drops oldest turns and keeps the last user', () => {
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: `user-${i} ${'x'.repeat(6000)}` });
    if (i < 9) messages.push({ role: 'assistant', content: `asst-${i} ${'y'.repeat(6000)}` });
  }
  const rebuilt = buildSafeHistoryInput(messages, { maxInputTokens: 24000 });
  assert.equal(rebuilt.truncated, true);
  const text = typeof rebuilt.input === 'string' ? rebuilt.input : JSON.stringify(rebuilt.input);
  assert.match(text, /user-9/);
  assert.doesNotMatch(text, /user-0 /);
  assert.ok(rebuilt.keptTurns >= 1);
  assert.ok(rebuilt.droppedTurns >= 1);
});

test('estimateTokenBreakdown reports image count without inflating text tokens', () => {
  const url = jpegDataUrl({ width: 1920, height: 1080, dataUrlLength: 80000 });
  const breakdown = estimateTokenBreakdown([
    { type: 'text', text: 'hello image' },
    { type: 'image', mime_type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) }
  ]);
  assert.equal(breakdown.imageCount, 1);
  assert.ok(breakdown.imageTokens >= 258 && breakdown.imageTokens <= MAX_IMAGE_TOKENS);
  assert.ok(breakdown.textTokens < 100);
  assert.equal(breakdown.tokens, breakdown.textTokens + breakdown.imageTokens);
});
