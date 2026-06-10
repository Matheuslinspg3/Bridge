import { queryOne, queryAll, run } from './db.js';
import { PLANS, getActiveSubscription, getTopupsThisMonth } from './billing.js';

// ── Config defaults (overridable via config.json quotaConfig) ──
let quotaConfig = {
  tetoDiarioDivisor: 5,       // daily cap = weekly_bucket / this
  throttleThreshold: 0.70,    // at 70% of daily cap, halve RPM
  pesoUltimaSemana: 1.5,      // last week gets 1.5x weight for rollover distribution
  forfeitSemana1: 1.0,        // week 1: 100% of leftover is forfeited
  forfeitSemanasMeio: 0.5,    // weeks 2-3: 50% forfeited, 50% rolls over
};

export function setQuotaConfig(cfg) {
  if (cfg) quotaConfig = { ...quotaConfig, ...cfg };
}
export function getQuotaConfig() { return { ...quotaConfig }; }

// ── In-memory RPM tracker ──
const rpmTracker = {};

function getDayStartUTC() {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function getMonthStartUTC() {
  const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Get tokens used in a time window for an api_key
function getUsageInWindow(apiKey, from, to) {
  const row = queryOne(
    `SELECT COALESCE(SUM(tokens_output + tokens_input), 0) as total
     FROM usage_log WHERE api_key = ? AND logged_at >= ? AND logged_at < ?`,
    [apiKey, from, to]
  );
  return row?.total || 0;
}

// Get total tokens used today
function getDailyUsage(apiKey) {
  const dayStart = getDayStartUTC();
  const row = queryOne(
    `SELECT COALESCE(SUM(tokens_output + tokens_input), 0) as total
     FROM usage_log WHERE api_key = ? AND logged_at >= ?`,
    [apiKey, dayStart]
  );
  return row?.total || 0;
}

// Get total tokens used this month
function getMonthlyUsage(apiKey) {
  const monthStart = getMonthStartUTC();
  const row = queryOne(
    `SELECT COALESCE(SUM(tokens_output + tokens_input), 0) as total
     FROM usage_log WHERE api_key = ? AND logged_at >= ?`,
    [apiKey, monthStart]
  );
  return row?.total || 0;
}

// ── Weekly bucket calculation ──

/**
 * Compute week boundaries relative to subscription start.
 * Returns array of 4 objects: { start: ISO, end: ISO, weekNum: 1-4 }
 */
function getWeekBoundaries(startsAt) {
  const start = new Date(startsAt);
  start.setUTCHours(0, 0, 0, 0);
  const weeks = [];
  for (let i = 0; i < 4; i++) {
    const wStart = new Date(start.getTime() + i * 7 * 86400000);
    const wEnd = new Date(start.getTime() + (i + 1) * 7 * 86400000);
    weeks.push({ start: wStart.toISOString(), end: wEnd.toISOString(), weekNum: i + 1 });
  }
  return weeks;
}

/**
 * Get current week index (0-3) relative to subscription start.
 * Returns -1 if outside the 4-week window.
 */
function getCurrentWeekIndex(startsAt) {
  const start = new Date(startsAt); start.setUTCHours(0, 0, 0, 0);
  const now = Date.now();
  const elapsed = now - start.getTime();
  const weekIdx = Math.floor(elapsed / (7 * 86400000));
  return weekIdx >= 0 && weekIdx < 4 ? weekIdx : -1;
}

/**
 * Calculate effective weekly quota including rollover bonuses.
 * Returns { weeklyQuota: number, dailyCap: number } for the current week.
 */
function computeEffectiveQuota(apiKey, sub, plan) {
  const topupTokens = getTopupsThisMonth(sub.user_id);
  const totalMonthly = plan.tokensMonth + topupTokens;
  const baseBucket = Math.floor(totalMonthly / 4);

  const weeks = getWeekBoundaries(sub.starts_at);
  const currentIdx = getCurrentWeekIndex(sub.starts_at);
  if (currentIdx < 0) return { weeklyQuota: baseBucket, dailyCap: Math.floor(baseBucket / quotaConfig.tetoDiarioDivisor) };

  // Calculate rollover bonuses from previous weeks
  let rolloverPool = 0;

  for (let i = 0; i < currentIdx; i++) {
    const weekUsage = getUsageInWindow(apiKey, weeks[i].start, weeks[i].end);
    const weekQuota = baseBucket + (i === 0 ? 0 : rolloverPool); // simplified: each week had baseBucket + accumulated bonus
    const leftover = Math.max(0, baseBucket - weekUsage); // leftover based on base bucket only for clarity

    let forfeitRate;
    if (i === 0) {
      forfeitRate = quotaConfig.forfeitSemana1; // week 1: 100% forfeited
    } else if (i < 3) {
      forfeitRate = quotaConfig.forfeitSemanasMeio; // weeks 2-3: 50% forfeited
    } else {
      forfeitRate = 1.0; // week 4: no rollover (last week)
    }

    const rolloverAmount = Math.floor(leftover * (1 - forfeitRate));
    rolloverPool += rolloverAmount;
  }

  // Distribute rollover to current and remaining weeks with weight on last
  const remainingWeeks = 4 - currentIdx;
  let currentBonus = 0;
  if (remainingWeeks > 0 && rolloverPool > 0) {
    // Weighted distribution: last week gets pesoUltimaSemana, others get 1.0
    const isLastWeek = currentIdx === 3;
    const weights = [];
    for (let j = currentIdx; j < 4; j++) {
      weights.push(j === 3 ? quotaConfig.pesoUltimaSemana : 1.0);
    }
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const currentWeight = weights[0]; // weight for current week
    currentBonus = Math.floor(rolloverPool * (currentWeight / totalWeight));
  }

  const weeklyQuota = baseBucket + currentBonus;
  const dailyCap = Math.floor(weeklyQuota / quotaConfig.tetoDiarioDivisor);

  return { weeklyQuota, dailyCap, baseBucket, rolloverPool, currentBonus };
}

// Check RPM
function checkRPM(apiKey, limit) {
  const now = Date.now();
  if (!rpmTracker[apiKey] || now - rpmTracker[apiKey].windowStart > 60000) {
    rpmTracker[apiKey] = { count: 0, windowStart: now };
  }
  rpmTracker[apiKey].count++;
  return rpmTracker[apiKey].count <= limit;
}

/**
 * Check plan limits before processing request.
 * Implements: RPM, max_tokens clamp, daily cap (weekly bucket), monthly cap, throttle.
 */
export function checkPlanLimits(apiKey, body) {
  const sub = getActiveSubscription(apiKey);
  if (!sub) return { blocked: false };

  const plan = PLANS[sub.plan_id];
  if (!plan) return { blocked: false };

  // 1. Compute effective quota for current week
  const { weeklyQuota, dailyCap } = computeEffectiveQuota(apiKey, sub, plan);
  const dailyUsage = getDailyUsage(apiKey);

  // 2. Throttle: at 70%+ of daily cap, halve RPM
  let effectiveRpm = plan.rpm;
  if (dailyCap > 0 && dailyUsage >= dailyCap * quotaConfig.throttleThreshold) {
    effectiveRpm = Math.max(1, Math.floor(plan.rpm / 2));
  }

  // 3. RPM check
  if (!checkRPM(apiKey, effectiveRpm)) {
    const throttled = effectiveRpm < plan.rpm;
    return { blocked: true, reason: throttled
      ? `Rate limit (throttled): ${effectiveRpm} req/min — uso diário acima de ${Math.round(quotaConfig.throttleThreshold*100)}%`
      : `Rate limit: máximo ${plan.rpm} req/min no plano ${plan.name}` };
  }

  // 4. max_tokens per request clamp
  const reqMaxTokens = body?.max_tokens || body?.maxTokens || 0;
  if (reqMaxTokens > plan.maxTokensReq) {
    if (body && body.max_tokens !== undefined) body.max_tokens = plan.maxTokensReq;
    if (body && body.maxTokens !== undefined) body.maxTokens = plan.maxTokensReq;
  }

  // 5. Daily cap (from weekly bucket)
  if (dailyUsage >= dailyCap) {
    return { blocked: true, reason: `Limite diário atingido, volta amanhã. (${plan.name}, cota semanal: ${Math.round(weeklyQuota/1e6)}M)` };
  }

  // 6. Monthly cap (total safety net)
  const topupTokens = getTopupsThisMonth(sub.user_id);
  const monthlyLimit = plan.tokensMonth + topupTokens;
  const monthlyUsage = getMonthlyUsage(apiKey);
  if (monthlyUsage >= monthlyLimit) {
    return { blocked: true, reason: `Cota mensal esgotada (${plan.name}). Compre um pacote extra ou aguarde o próximo ciclo.` };
  }

  return { blocked: false, plan, sub };
}

/**
 * Record token usage (input, output, cache_write, cache_read).
 */
export function recordPortalUsage(apiKey, tokensInput, tokensOutput, tokensCacheWrite, tokensCacheRead) {
  if (!apiKey) return;
  const sub = getActiveSubscription(apiKey);
  if (!sub) return;
  run(
    `INSERT INTO usage_log (api_key, tokens_input, tokens_output, tokens_cache_write, tokens_cache_read, logged_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [apiKey, tokensInput || 0, tokensOutput || 0, tokensCacheWrite || 0, tokensCacheRead || 0]
  );
}

export { getDailyUsage, getMonthlyUsage, computeEffectiveQuota };
