/**
 * Multi-provider failover with model-tier awareness.
 *
 * Providers are ordered by priority (1 = primary). Each provider has
 * models ordered by tier (1 = best). On failure (5xx, timeout, connection
 * error, upstream 429), the system falls to the next model/provider in
 * the chain transparently.
 *
 * Circuit-breaker per provider/model: after failure, cooldown before retry.
 * Recovery: after cooldown expires, primary is tried again first.
 */

// ── In-memory state ──
let providers = [];
let failoverConfig = { timeoutMs: 30000, cooldownMs: 60000 };

// Circuit-breaker state: { [providerId:modelName]: { failedAt, failures } }
const circuitState = {};

export function getProviders() { return providers; }
export function setProviders(p) { if (Array.isArray(p)) providers = p; }
export function getFailoverConfig() { return failoverConfig; }
export function setFailoverConfig(cfg) { if (cfg) failoverConfig = { ...failoverConfig, ...cfg }; }

// ── Seed default from existing upstream config ──
const DEFAULT_MODELS = [
  { name: 'claude-opus-4-8', tier: 1, cost: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { name: 'claude-opus-4-7', tier: 2, cost: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { name: 'claude-opus-4-6', tier: 3, cost: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  { name: 'claude-sonnet-4-6', tier: 4, cost: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { name: 'claude-haiku-4-5-20251001', tier: 5, cost: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 } },
];

export function initProviders(configProviders, configFailover, existingUpstreams) {
  if (configProviders && configProviders.length > 0) {
    providers = configProviders;
  } else if (existingUpstreams && existingUpstreams.length > 0) {
    // Migrate existing upstream[0] to providers[0]
    const up = existingUpstreams[0];
    providers = [{
      id: 'principal',
      label: 'Provedor Principal',
      baseUrl: up.baseUrl,
      apiKey: up.apiKey,
      enabled: true,
      priority: 1,
      models: DEFAULT_MODELS,
    }, {
      id: 'revenda2',
      label: 'Provedor Revenda 2 (slot vazio)',
      baseUrl: '',
      apiKey: '',
      enabled: false,
      priority: 2,
      models: [],
    }];
  } else {
    providers = [{
      id: 'principal',
      label: 'Provedor Principal',
      baseUrl: '',
      apiKey: '',
      enabled: true,
      priority: 1,
      models: DEFAULT_MODELS,
    }];
  }
  if (configFailover) failoverConfig = { ...failoverConfig, ...configFailover };
}

// ── Build failover chain for a request ──
// Returns ordered array of { provider, model } to try
export function buildFailoverChain(requestedModel) {
  const enabledProviders = providers
    .filter(p => p.enabled && p.baseUrl)
    .sort((a, b) => a.priority - b.priority);

  const chain = [];
  for (const provider of enabledProviders) {
    const models = [...(provider.models || [])].sort((a, b) => a.tier - b.tier);
    // If the requested model exists in this provider, start from it
    const startIdx = models.findIndex(m => m.name === requestedModel);
    const orderedModels = startIdx >= 0
      ? [...models.slice(startIdx), ...models.slice(0, startIdx)]
      : models;
    for (const model of orderedModels) {
      chain.push({ provider, model });
    }
  }
  return chain;
}

// ── Circuit-breaker ──
function circuitKey(providerId, modelName) {
  return `${providerId}:${modelName}`;
}

export function isCircuitOpen(providerId, modelName) {
  const key = circuitKey(providerId, modelName);
  const state = circuitState[key];
  if (!state) return false;
  if (Date.now() - state.failedAt > failoverConfig.cooldownMs) {
    // Cooldown expired — allow retry (half-open)
    delete circuitState[key];
    return false;
  }
  return true;
}

export function recordFailure(providerId, modelName) {
  const key = circuitKey(providerId, modelName);
  circuitState[key] = {
    failedAt: Date.now(),
    failures: (circuitState[key]?.failures || 0) + 1,
  };
}

export function recordSuccess(providerId, modelName) {
  const key = circuitKey(providerId, modelName);
  delete circuitState[key];
}

// ── Get model cost (¥/M) ──
export function getModelCost(providerId, modelName) {
  const provider = providers.find(p => p.id === providerId);
  if (!provider) return null;
  const model = (provider.models || []).find(m => m.name === modelName);
  return model?.cost || null;
}

// ── Failover status for monitoring ──
export function getCircuitStatus() {
  return { ...circuitState };
}

// ── CRUD (for future /dev UI) ──
export function addProvider(data) {
  providers.push(data);
}
export function updateProvider(id, patch) {
  const p = providers.find(x => x.id === id);
  if (!p) return false;
  Object.assign(p, patch);
  return true;
}
export function removeProvider(id) {
  const before = providers.length;
  providers = providers.filter(x => x.id !== id);
  return providers.length < before;
}
