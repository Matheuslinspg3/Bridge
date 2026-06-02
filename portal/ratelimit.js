import { queryOne, run } from './db.js';
import { PLANS, getActiveSubscription } from './billing.js';

// In-memory RPM tracker: { apiKey: { count, windowStart } }
const rpmTracker = {};

function getDayStart() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function getMonthStart() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Busca tokens output usados hoje por esta key
function getDailyUsage(apiKey) {
  const dayStart = getDayStart();
  const row = queryOne(
    `SELECT COALESCE(SUM(tokens_output), 0) as total
     FROM usage_log WHERE api_key = ? AND logged_at >= ?`,
    [apiKey, dayStart]
  );
  return row?.total || 0;
}

// Busca tokens output usados no mês por esta key
function getMonthlyUsage(apiKey) {
  const monthStart = getMonthStart();
  const row = queryOne(
    `SELECT COALESCE(SUM(tokens_output), 0) as total
     FROM usage_log WHERE api_key = ? AND logged_at >= ?`,
    [apiKey, monthStart]
  );
  return row?.total || 0;
}

// Checa RPM (requests por minuto)
function checkRPM(apiKey, limit) {
  const now = Date.now();
  if (!rpmTracker[apiKey] || now - rpmTracker[apiKey].windowStart > 60000) {
    rpmTracker[apiKey] = { count: 0, windowStart: now };
  }
  rpmTracker[apiKey].count++;
  return rpmTracker[apiKey].count <= limit;
}

/**
 * Checa limites do plano antes de processar request.
 * Retorna { blocked: false } ou { blocked: true, reason: string }
 */
export function checkPlanLimits(apiKey, body) {
  const sub = getActiveSubscription(apiKey);
  if (!sub) return { blocked: false }; // não é key do portal, deixa passar

  const plan = PLANS[sub.plan_id];
  if (!plan) return { blocked: false };

  // 1. RPM
  if (!checkRPM(apiKey, plan.rpm)) {
    return { blocked: true, reason: `Rate limit: máximo ${plan.rpm} req/min no plano ${plan.name}` };
  }

  // 2. max_tokens por request
  const reqMaxTokens = body?.max_tokens || body?.maxTokens || 0;
  if (reqMaxTokens > plan.maxTokensReq) {
    if (body && body.max_tokens !== undefined) body.max_tokens = plan.maxTokensReq;
    if (body && body.maxTokens !== undefined) body.maxTokens = plan.maxTokensReq;
  }

  // 3. Budget diário
  const dailyUsage = getDailyUsage(apiKey);
  if (dailyUsage >= plan.blockAbove) {
    return { blocked: true, reason: `Limite diário excedido (${plan.name}). Tente novamente amanhã.` };
  }

  // 4. Cap mensal
  const monthlyUsage = getMonthlyUsage(apiKey);
  if (monthlyUsage >= plan.tokensMonth) {
    return { blocked: true, reason: `Cota mensal esgotada (${plan.name}). Faça upgrade ou aguarde o próximo ciclo.` };
  }

  return { blocked: false, plan, sub };
}

/**
 * Registra uso de tokens output após resposta.
 */
export function recordPortalUsage(apiKey, tokensInput, tokensOutput) {
  if (!apiKey) return;
  const sub = getActiveSubscription(apiKey);
  if (!sub) return;
  run(
    `INSERT INTO usage_log (api_key, tokens_input, tokens_output, logged_at) VALUES (?, ?, ?, datetime('now'))`,
    [apiKey, tokensInput || 0, tokensOutput || 0]
  );
}

export { getDailyUsage, getMonthlyUsage };
