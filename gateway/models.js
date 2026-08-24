const AGENT_ID = 'antigravity-preview-05-2026';
const DEFAULT_BACKEND_MODEL = 'gemini-3.7-flash';
const BACKEND_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite'
];

function listGatewayModels() {
  const created = 1740000000;
  const owned_by = 'google-antigravity';
  const ids = [AGENT_ID, ...BACKEND_MODELS.map((model) => `${AGENT_ID}/${model}`)];
  return ids.map((id) => {
    const backend = id === AGENT_ID ? DEFAULT_BACKEND_MODEL : id.slice(AGENT_ID.length + 1);
    return {
      id,
      object: 'model',
      created,
      owned_by,
      root: AGENT_ID,
      parent: id === AGENT_ID ? null : AGENT_ID,
      description: id === AGENT_ID
        ? `Antigravity managed agent (default agent_config.model=${DEFAULT_BACKEND_MODEL})`
        : `Antigravity managed agent using agent_config.model=${backend}`
    };
  });
}

function resolveModel(rawModel) {
  const value = String(rawModel || AGENT_ID).trim();
  if (!value) {
    return { ok: true, requested: AGENT_ID, agent: AGENT_ID, backendModel: DEFAULT_BACKEND_MODEL };
  }

  if (value === AGENT_ID) {
    return { ok: true, requested: value, agent: AGENT_ID, backendModel: DEFAULT_BACKEND_MODEL };
  }

  if (BACKEND_MODELS.includes(value)) {
    return { ok: true, requested: value, agent: AGENT_ID, backendModel: value };
  }

  const slash = value.indexOf('/');
  if (slash > 0) {
    const agent = value.slice(0, slash);
    const backend = value.slice(slash + 1);
    if (agent === AGENT_ID && BACKEND_MODELS.includes(backend)) {
      return { ok: true, requested: value, agent: AGENT_ID, backendModel: backend };
    }
  }

  return {
    ok: false,
    requested: value,
    error: `Unknown model '${value}'. This gateway only serves ${AGENT_ID} and its internal backends: ${BACKEND_MODELS.map((model) => `${AGENT_ID}/${model}`).join(', ')}.`
  };
}

module.exports = {
  AGENT_ID,
  DEFAULT_BACKEND_MODEL,
  BACKEND_MODELS,
  listGatewayModels,
  resolveModel
};
