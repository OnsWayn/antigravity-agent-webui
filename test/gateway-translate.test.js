const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildOpenAIConversation,
  hashNonAssistant,
  mergeTools,
  openaiMessageToInputParts,
  parseImageRef,
  pendingFunctionCalls,
  toChatCompletion
} = require('../gateway/translate');
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
  assert.equal(edited.input, 'next');
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

test('resolveModel only allows the probed backend list', () => {
  assert.equal(resolveGatewayModel('gemini-3.5-flash-lite').backendModel, 'gemini-3.5-flash-lite');
  assert.equal(resolveGatewayModel('antigravity-preview-05-2026/gemini-3.6-flash').backendModel, 'gemini-3.6-flash');
  assert.equal(resolveGatewayModel('gemini-3.1-pro-preview').ok, false);
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
