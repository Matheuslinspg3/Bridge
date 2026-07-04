/**
 * Dynamic Plans Store — plans are config data, not code constants.
 * Persisted in config.json under config.plans[].
 * Seed defaults match the original hardcoded plans.
 */


// ── Seed plans (created on first run if no config) ──
const SEED_PLANS = [
  { id: 'pro5x', name: 'Pro 5x', price: 99.90, tokensMonth: 60_000_000, rpm: 15, maxTokensReq: 4096, enabled: true },
  { id: 'max10x', name: 'Max 10x', price: 184.90, tokensMonth: 120_000_000, rpm: 25, maxTokensReq: 8192, enabled: true },
  { id: 'max20x', name: 'Max 20x', price: 299.90, tokensMonth: 190_000_000, rpm: 40, maxTokensReq: 16384, enabled: true },
];

// Seed version — bump this when seed values change to trigger migration
const SEED_VERSION = 2;

// ── In-memory state ──
let plans = [];
let scenarioMix = {
  realistic: { cacheRead: 0.70, input: 0.12, output: 0.15, cacheWrite: 0.03 },
  moderate: { cacheRead: 0.40, input: 0.20, output: 0.35, cacheWrite: 0.05 },
  worstCase: { cacheRead: 0, input: 0, output: 1.0, cacheWrite: 0 },
};
let minMarginPct = 25; // default 25%

// ── Getters/Setters ──
export function getPlans() { return plans; }
export function setPlans(p) { if (Array.isArray(p)) plans = p; }
export function getScenarioMix() { return scenarioMix; }
export function setScenarioMix(m) { if (m) scenarioMix = { ...scenarioMix, ...m }; }
export function getMinMargin() { return minMarginPct; }
export function setMinMargin(v) { if (typeof v === 'number') minMarginPct = v; }

// Initialize with seed if empty
export function initPlans(configPlans, configScenarios, configMinMargin, seedVersion) {
  if (configPlans && configPlans.length > 0) {
    plans = configPlans;
    // Migrate seed plans if version changed (only updates the 3 original seed IDs)
    if ((seedVersion || 0) < SEED_VERSION) {
      for (const seed of SEED_PLANS) {
        const existing = plans.find(p => p.id === seed.id);
        if (existing) {
          // Only update if values still match a known previous seed (not manually edited)
          // We update price + tokensMonth unconditionally for seed IDs
          existing.price = seed.price;
          existing.tokensMonth = seed.tokensMonth;
          existing.name = seed.name;
          existing.rpm = seed.rpm;
          existing.maxTokensReq = seed.maxTokensReq;
        }
      }
    }
  } else {
    plans = [...SEED_PLANS];
  }
  if (configScenarios) scenarioMix = { ...scenarioMix, ...configScenarios };
  if (typeof configMinMargin === 'number') minMarginPct = configMinMargin;
}

export function getSeedVersion() { return SEED_VERSION; }

// ── PLANS object (compatibility layer for billing.js / ratelimit.js) ──
// Returns { [id]: plan } dict with derived fields
export function getPlansDict() {
  const dict = {};
  for (const p of plans) {
    if (!p.enabled) continue;
    dict[p.id] = {
      ...p,
      // Derive budgetDay from weekly logic (not used directly anymore, kept for compat)
      budgetDay: Math.floor(p.tokensMonth / 4 / 5),
      throttleRange: [Math.floor(p.tokensMonth / 4 / 5), Math.floor(p.tokensMonth / 4 / 5 * 1.5)],
      blockAbove: Math.floor(p.tokensMonth / 4 / 5 * 1.5),
    };
  }
  return dict;
}

// ── Plan ordering (by price ascending) for upgrade-only ──
export function getPlanOrder() {
  return [...plans]
    .filter(p => p.enabled)
    .sort((a, b) => a.price - b.price)
    .map(p => p.id);
}

// ── Viability calculator ──
export function calculateScenarios(plan, costConfig) {
  const cc = costConfig || {
    inputPriceYuanPerM: 1.5, outputPriceYuanPerM: 7.5,
    cacheWritePriceYuanPerM: 1.875, cacheReadPriceYuanPerM: 0.15, fxCnyToBrl: 0.76,
  };

  function calcScenario(mix) {
    const tokens = plan.tokensMonth;
    const costCny = (
      tokens * mix.input * cc.inputPriceYuanPerM +
      tokens * mix.output * cc.outputPriceYuanPerM +
      tokens * mix.cacheWrite * cc.cacheWritePriceYuanPerM +
      tokens * mix.cacheRead * cc.cacheReadPriceYuanPerM
    ) / 1_000_000;
    const costBrl = Math.round(costCny * cc.fxCnyToBrl * 100) / 100;
    const marginBrl = Math.round((plan.price - costBrl) * 100) / 100;
    const marginPct = plan.price > 0 ? Math.round(marginBrl / plan.price * 10000) / 100 : null;
    return { cost_brl: costBrl, margin_brl: marginBrl, margin_pct: marginPct };
  }

  return {
    realistic: calcScenario(scenarioMix.realistic),
    moderate: calcScenario(scenarioMix.moderate),
    worstCase: calcScenario(scenarioMix.worstCase),
  };
}

// ── CRUD ──
import crypto from 'crypto';

export function addPlan(data) {
  const id = data.id || crypto.randomBytes(4).toString('hex');
  const plan = {
    id,
    name: data.name || id,
    price: Number(data.price) || 0,
    tokensMonth: Number(data.tokensMonth) || 0,
    rpm: Number(data.rpm) || 15,
    maxTokensReq: Number(data.maxTokensReq) || 4096,
    enabled: data.enabled !== false,
    allowedModels: Array.isArray(data.allowedModels) ? data.allowedModels : [],
    maxSpendBrl: data.maxSpendBrl != null ? Number(data.maxSpendBrl) : null,
  };
  plans.push(plan);
  return plan;
}

export function updatePlan(id, patch) {
  const plan = plans.find(p => p.id === id);
  if (!plan) return null;
  if (patch.name !== undefined) plan.name = patch.name;
  if (patch.price !== undefined) plan.price = Number(patch.price);
  if (patch.tokensMonth !== undefined) plan.tokensMonth = Number(patch.tokensMonth);
  if (patch.rpm !== undefined) plan.rpm = Number(patch.rpm);
  if (patch.maxTokensReq !== undefined) plan.maxTokensReq = Number(patch.maxTokensReq);
  if (patch.enabled !== undefined) plan.enabled = patch.enabled;
  if (patch.allowedModels !== undefined) plan.allowedModels = Array.isArray(patch.allowedModels) ? patch.allowedModels : [];
  if (patch.maxSpendBrl !== undefined) plan.maxSpendBrl = patch.maxSpendBrl != null ? Number(patch.maxSpendBrl) : null;
  return plan;
}

export function removePlan(id) {
  const before = plans.length;
  plans = plans.filter(p => p.id !== id);
  return plans.length < before;
}

export function findPlan(id) {
  return plans.find(p => p.id === id) || null;
}
