const AGENT_ID = 'antigravity-preview-05-2026';
const DEFAULT_BACKEND_MODEL = 'gemini-3.7-flash';
const BACKEND_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite'
];

function listGatewayModels({ customModels = [] } = {}) {
  const created = 1740000000;
  const owned_by = 'google-antigravity';
  const allBackends = Array.from(new Set([...BACKEND_MODELS, ...(Array.isArray(customModels) ? customModels : [])]));
  const ids = [AGENT_ID, ...allBackends.map((model) => `${AGENT_ID}/${model}`)];
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

function resolveModel(rawModel, { allowCustom = true, allowedModels = null, defaultModel = null } = {}) {
  const defaultVal = defaultModel ? String(defaultModel).trim() : AGENT_ID;
  const value = String(rawModel || defaultVal).trim();
  if (!value) {
    const fallbackBackend = defaultModel || DEFAULT_BACKEND_MODEL;
    return { ok: true, requested: AGENT_ID, agent: AGENT_ID, backendModel: fallbackBackend };
  }

  let result = null;

  if (value === AGENT_ID) {
    result = { ok: true, requested: value, agent: AGENT_ID, backendModel: defaultModel || DEFAULT_BACKEND_MODEL };
  } else if (BACKEND_MODELS.includes(value)) {
    result = { ok: true, requested: value, agent: AGENT_ID, backendModel: value };
  } else {
    const slash = value.indexOf('/');
    if (slash > 0) {
      const agent = value.slice(0, slash);
      const backend = value.slice(slash + 1);
      if (agent === AGENT_ID && BACKEND_MODELS.includes(backend)) {
        result = { ok: true, requested: value, agent: AGENT_ID, backendModel: backend };
      } else if (allowCustom) {
        result = { ok: true, requested: value, agent: agent || AGENT_ID, backendModel: backend, custom: true };
      }
    } else if (allowCustom) {
      result = { ok: true, requested: value, agent: AGENT_ID, backendModel: value, custom: true };
    }
  }

  if (!result) {
    return {
      ok: false,
      requested: value,
      error: `Unknown model '${value}'. This gateway serves ${AGENT_ID} and its backends: ${BACKEND_MODELS.map((model) => `${AGENT_ID}/${model}`).join(', ')}.`
    };
  }

  // Check token allowedModels whitelist if provided
  if (Array.isArray(allowedModels) && allowedModels.length > 0) {
    const isAllowed = allowedModels.includes(result.requested)
      || allowedModels.includes(result.backendModel)
      || allowedModels.includes(`${AGENT_ID}/${result.backendModel}`)
      || (result.requested === AGENT_ID && allowedModels.includes(result.backendModel));

    if (!isAllowed) {
      return {
        ok: false,
        requested: value,
        error: `Model '${value}' is not permitted for this token. Allowed models: ${allowedModels.join(', ')}.`
      };
    }
  }

  return result;
}

module.exports = {
  AGENT_ID,
  DEFAULT_BACKEND_MODEL,
  BACKEND_MODELS,
  listGatewayModels,
  resolveModel
};
