const AGENT_ID = 'antigravity-preview-05-2026';
const DEFAULT_BACKEND_MODEL = 'gemini-3.7-flash';
const BACKEND_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash'
];

function normalizeCatalog(catalog) {
  const source = Array.isArray(catalog) ? catalog : BACKEND_MODELS;
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const id = String(item == null ? '' : item).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function stripAgentPrefix(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === AGENT_ID) return '';
  if (raw.startsWith(`${AGENT_ID}/`)) return raw.slice(AGENT_ID.length + 1);
  return raw;
}

function listGatewayModels({ catalog, customModels = [] } = {}) {
  const created = 1740000000;
  const owned_by = 'google-antigravity';
  const source = catalog !== undefined
    ? catalog
    : [...BACKEND_MODELS, ...(Array.isArray(customModels) ? customModels : [])];
  return normalizeCatalog(source).map((id) => ({
    id,
    object: 'model',
    created,
    owned_by,
    root: id,
    parent: null,
    description: `Pass-through model; upstream agent_config.model=${id}`
  }));
}

function resolveModel(rawModel, { allowCustom = true, allowedModels = null, defaultModel = null } = {}) {
  const fallbackBackend = (defaultModel && String(defaultModel).trim()) || DEFAULT_BACKEND_MODEL;
  const value = String(rawModel || fallbackBackend).trim();
  if (!value || value === AGENT_ID) {
    return { ok: true, requested: value || AGENT_ID, agent: AGENT_ID, backendModel: fallbackBackend };
  }

  const backendModel = stripAgentPrefix(value) || fallbackBackend;
  const known = BACKEND_MODELS.includes(backendModel);
  if (!known && allowCustom === false) {
    return {
      ok: false,
      requested: value,
      error: `Unknown model '${value}'. This gateway serves ${normalizeCatalog().join(', ')}.`
    };
  }

  const result = {
    ok: true,
    requested: value,
    agent: AGENT_ID,
    backendModel,
    custom: known ? undefined : true
  };

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
  resolveModel,
  stripAgentPrefix,
  normalizeCatalog
};
