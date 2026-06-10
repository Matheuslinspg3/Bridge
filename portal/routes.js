import { Router } from 'express';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import { initDB, queryAll, queryOne, run, saveDB } from './db.js';
import { hashPassword, comparePassword, createToken, requireAuth } from './auth.js';
import {
  PLANS, TOP_UP, createOrder, confirmOrder, rejectOrder,
  getPendingOrders, getRecentConfirmed,
  expireSubscriptions
} from './billing.js';
import { getDailyUsage, getMonthlyUsage, getQuotaConfig, setQuotaConfig, computeEffectiveQuota } from './ratelimit.js';
import {
  getAsaasConfig, setAsaasConfig, getKeysMasked,
  addKey, updateKey, removeKey, findKeyById
} from './asaas.js';
import {
  getPlans, getPlansDict, getPlanOrder,
  addPlan, updatePlan, removePlan, findPlan,
  calculateScenarios, getScenarioMix, setScenarioMix,
  getMinMargin, setMinMargin
} from './plans-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();
router.use(cookieParser());

// ── Admin auth middleware ──
function requireAdmin(req, res, next) {
  const token = req.headers['x-dashboard-token'] || '';
  const expected = process.env.DASHBOARD_PASSWORD || process.env.PROXY_API_KEY || '';
  if (!token || !expected || token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Serve static files for portal
router.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes ──

// POST /portal/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: 'Email e senha obrigatórios' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Senha mínima: 6 caracteres' });

    const existing = queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ error: 'Email já cadastrado' });

    const hash = hashPassword(password);
    const result = run(
      'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)',
      [email, hash, name || '']
    );
    saveDB();

    const user = queryOne('SELECT * FROM users WHERE id = ?', [result.lastInsertRowid]);
    const token = createToken(user);
    res.cookie('portal_token', token, { httpOnly: true, maxAge: 7 * 86400000 });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /portal/login
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: 'Email e senha obrigatórios' });

    const user = queryOne('SELECT * FROM users WHERE email = ? AND enabled = 1', [email]);
    if (!user || !comparePassword(password, user.password_hash))
      return res.status(401).json({ error: 'Email ou senha incorretos' });

    const token = createToken(user);
    res.cookie('portal_token', token, { httpOnly: true, maxAge: 7 * 86400000 });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /portal/logout
router.post('/logout', (req, res) => {
  res.clearCookie('portal_token');
  res.json({ ok: true });
});

// GET /portal/me
router.get('/me', requireAuth, (req, res) => {
  const user = req.portalUser;
  const sub = queryOne(
    `SELECT * FROM subscriptions WHERE user_id = ? AND active = 1 ORDER BY expires_at DESC LIMIT 1`,
    [user.id]
  );

  let usage = null;
  if (sub) {
    usage = {
      daily: getDailyUsage(sub.api_key),
      monthly: getMonthlyUsage(sub.api_key),
    };
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    subscription: sub ? {
      plan_id: sub.plan_id,
      plan: PLANS[sub.plan_id],
      plan_snapshot: sub.plan_snapshot,
      api_key: sub.api_key,
      expires_at: sub.expires_at,
      active: !!sub.active,
    } : null,
    usage,
  });
});

// ── Billing routes ──

// GET /portal/plans
router.get('/plans', (req, res) => {
  const plans = getPlans()
    .filter(p => p.enabled)
    .sort((a, b) => a.price - b.price)
    .map(p => ({ id: p.id, name: p.name, price: p.price, tokensMonth: p.tokensMonth, rpm: p.rpm, maxTokensReq: p.maxTokensReq }));
  res.json(plans);
});

// POST /portal/orders
router.post('/orders', requireAuth, async (req, res) => {
  try {
    const { plan_id } = req.body || {};
    if (!PLANS[plan_id] && plan_id !== 'topup_15m')
      return res.status(400).json({ error: 'Plano inválido' });

    const result = await createOrder(req.portalUser.id, plan_id);
    res.json({
      order: result.order,
      qr_code: result.qrDataUrl,
      pix_payload: result.payload,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /portal/orders (user's orders)
router.get('/orders', requireAuth, (req, res) => {
  const orders = queryAll(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC',
    [req.portalUser.id]
  );
  res.json(orders);
});

// ── Admin payment routes (uses dashboard token) ──

// GET /portal/admin/payments
router.get('/admin/payments', requireAdmin, (req, res) => {
  res.json({
    pending: getPendingOrders(),
    recent: getRecentConfirmed(),
  });
});

// POST /portal/admin/payments/:id/confirm
router.post('/admin/payments/:id/confirm', requireAdmin, (req, res) => {
  try {
    const result = confirmOrder(Number(req.params.id));
    res.json({ ok: true, api_key: result.apiKey, expires_at: result.expiresAt });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /portal/admin/payments/:id/reject
router.post('/admin/payments/:id/reject', requireAdmin, (req, res) => {
  try {
    rejectOrder(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /portal/admin/users — lista contas
router.get('/admin/users', requireAdmin, (req, res) => {
  const users = queryAll(`
    SELECT u.id, u.email, u.name, u.created_at, u.enabled,
      s.plan_id, s.active as sub_active, s.expires_at
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id AND s.active = 1
    ORDER BY u.created_at DESC
  `);
  res.json(users);
});

// DELETE /portal/admin/users/:email — remove conta e todos os dados relacionados
router.delete('/admin/users/:email', requireAdmin, (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    const user = queryOne('SELECT id, email FROM users WHERE lower(email) = ?', [email]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    // usage_log é indexado por api_key — apagar pelos keys das subscriptions do user
    const subs = queryAll('SELECT api_key FROM subscriptions WHERE user_id = ?', [user.id]);
    for (const s of subs) {
      if (s.api_key) run('DELETE FROM usage_log WHERE api_key = ?', [s.api_key]);
    }
    run('DELETE FROM subscriptions WHERE user_id = ?', [user.id]);
    run('DELETE FROM orders WHERE user_id = ?', [user.id]);
    try { run('DELETE FROM topups WHERE user_id = ?', [user.id]); } catch {}
    run('DELETE FROM users WHERE id = ?', [user.id]);
    saveDB();
    res.json({ ok: true, deleted: user.email });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /portal/admin/quota-config
router.get('/admin/quota-config', requireAdmin, (req, res) => {
  res.json(getQuotaConfig());
});

// PUT /portal/admin/quota-config
router.put('/admin/quota-config', requireAdmin, (req, res) => {
  const cfg = req.body || {};
  setQuotaConfig(cfg);
  // Persist to config.json via parent (caller saves config externally)
  res.json({ ok: true, config: getQuotaConfig() });
});

// ── Cost config (RC prices + FX) ──
const DEFAULT_COST_CONFIG = {
  inputPriceYuanPerM: 1.50,
  outputPriceYuanPerM: 7.50,
  cacheWritePriceYuanPerM: 1.875,
  cacheReadPriceYuanPerM: 0.15,
  fxCnyToBrl: 0.76,
};
let costConfig = { ...DEFAULT_COST_CONFIG };

export function setCostConfig(cfg) { if (cfg) costConfig = { ...costConfig, ...cfg }; }
export function getCostConfig() { return { ...costConfig }; }

// GET /portal/admin/cost-config
router.get('/admin/cost-config', requireAdmin, (req, res) => {
  res.json(getCostConfig());
});

// PUT /portal/admin/cost-config
router.put('/admin/cost-config', requireAdmin, (req, res) => {
  const cfg = req.body || {};
  setCostConfig(cfg);
  res.json({ ok: true, config: getCostConfig() });
});

// GET /portal/admin/profit — full P&L with backend calculation
router.get('/admin/profit', requireAdmin, (req, res) => {
  const rows = queryAll(`
    SELECT u.id, u.email,
      s.plan_id,
      COALESCE(rev.total_revenue, 0) as revenue,
      COALESCE(usg.tokens_input, 0) as tokens_input,
      COALESCE(usg.tokens_output, 0) as tokens_output,
      COALESCE(usg.tokens_cache_write, 0) as tokens_cache_write,
      COALESCE(usg.tokens_cache_read, 0) as tokens_cache_read
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id AND s.active = 1
    LEFT JOIN (
      SELECT o.user_id, SUM(o.amount_brl) as total_revenue
      FROM orders o WHERE o.status = 'confirmed'
      GROUP BY o.user_id
    ) rev ON rev.user_id = u.id
    LEFT JOIN (
      SELECT ul.api_key,
        SUM(ul.tokens_input) as tokens_input,
        SUM(ul.tokens_output) as tokens_output,
        SUM(COALESCE(ul.tokens_cache_write, 0)) as tokens_cache_write,
        SUM(COALESCE(ul.tokens_cache_read, 0)) as tokens_cache_read
      FROM usage_log ul GROUP BY ul.api_key
    ) usg ON usg.api_key = s.api_key
    ORDER BY revenue DESC
  `);

  const { inputPriceYuanPerM, outputPriceYuanPerM, cacheWritePriceYuanPerM, cacheReadPriceYuanPerM, fxCnyToBrl } = costConfig;

  let totalRevenue = 0, totalCost = 0, accountsInRed = 0;

  const accounts = rows.map(a => {
    const costBrl = (
      (a.tokens_input * inputPriceYuanPerM) +
      (a.tokens_output * outputPriceYuanPerM) +
      (a.tokens_cache_write * cacheWritePriceYuanPerM) +
      (a.tokens_cache_read * cacheReadPriceYuanPerM)
    ) / 1_000_000 * fxCnyToBrl;

    const marginBrl = a.revenue - costBrl;
    const marginPct = a.revenue > 0 ? Math.round((marginBrl / a.revenue) * 10000) / 100 : null;
    const inRed = marginBrl < 0;

    totalRevenue += a.revenue;
    totalCost += costBrl;
    if (inRed) accountsInRed++;

    return {
      ...a,
      cost_brl: Math.round(costBrl * 100) / 100,
      margin_brl: Math.round(marginBrl * 100) / 100,
      margin_pct: marginPct,
      in_red: inRed,
    };
  });

  res.json({
    accounts,
    totals: {
      total_revenue_brl: Math.round(totalRevenue * 100) / 100,
      total_cost_brl: Math.round(totalCost * 100) / 100,
      net_profit_brl: Math.round((totalRevenue - totalCost) * 100) / 100,
      accounts_in_red: accountsInRed,
    },
    cost_config: costConfig,
  });
});

// ── Dynamic Plans CRUD ──

// GET /portal/admin/plans-config — list all plans with viability scenarios
router.get('/admin/plans-config', requireAdmin, (req, res) => {
  const cc = getCostConfig();
  const plans = getPlans().map(p => ({
    ...p,
    scenarios: calculateScenarios(p, cc),
  }));
  res.json({
    plans,
    scenarioMix: getScenarioMix(),
    minMarginPct: getMinMargin(),
  });
});

// POST /portal/admin/plans-config — create plan (with viability check)
router.post('/admin/plans-config', requireAdmin, (req, res) => {
  const { force, ...data } = req.body || {};
  const plan = { ...data, price: Number(data.price) || 0, tokensMonth: Number(data.tokensMonth) || 0 };
  const cc = getCostConfig();
  const scenarios = calculateScenarios(plan, cc);

  // Viability check
  if (!force && scenarios.realistic.margin_pct !== null && scenarios.realistic.margin_pct < getMinMargin()) {
    return res.status(422).json({
      error: `Plano inviável: margem realista ${scenarios.realistic.margin_pct.toFixed(1)}% abaixo do mínimo ${getMinMargin()}%`,
      scenarios,
      blocked: true,
    });
  }

  const created = addPlan(data);
  const warning = scenarios.worstCase.margin_brl < 0 ? 'Atenção: margem negativa no pior caso' : null;
  res.json({ ok: true, plan: { ...created, scenarios }, warning });
});

// PUT /portal/admin/plans-config/:id — update plan
router.put('/admin/plans-config/:id', requireAdmin, (req, res) => {
  const { force, ...patch } = req.body || {};
  const existing = findPlan(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Plano não encontrado' });

  // Preview merged plan for viability
  const preview = { ...existing, ...patch };
  if (patch.price !== undefined) preview.price = Number(patch.price);
  if (patch.tokensMonth !== undefined) preview.tokensMonth = Number(patch.tokensMonth);
  const cc = getCostConfig();
  const scenarios = calculateScenarios(preview, cc);

  if (!force && scenarios.realistic.margin_pct !== null && scenarios.realistic.margin_pct < getMinMargin()) {
    return res.status(422).json({
      error: `Plano inviável: margem realista ${scenarios.realistic.margin_pct.toFixed(1)}% abaixo do mínimo ${getMinMargin()}%`,
      scenarios,
      blocked: true,
    });
  }

  const updated = updatePlan(req.params.id, patch);
  const warning = scenarios.worstCase.margin_brl < 0 ? 'Atenção: margem negativa no pior caso' : null;
  res.json({ ok: true, plan: { ...updated, scenarios }, warning });
});

// DELETE /portal/admin/plans-config/:id
router.delete('/admin/plans-config/:id', requireAdmin, (req, res) => {
  const ok = removePlan(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Plano não encontrado' });
  res.json({ ok: true });
});

// PUT /portal/admin/plans-scenarios — update scenario mix + min margin
router.put('/admin/plans-scenarios', requireAdmin, (req, res) => {
  const { scenarioMix: mix, minMarginPct: mm } = req.body || {};
  if (mix) setScenarioMix(mix);
  if (typeof mm === 'number') setMinMargin(mm);
  res.json({ ok: true, scenarioMix: getScenarioMix(), minMarginPct: getMinMargin() });
});

// ── Asaas admin: key management ──

// GET /portal/admin/asaas-keys
router.get('/admin/asaas-keys', requireAdmin, (req, res) => {
  const cfg = getAsaasConfig();
  res.json({
    enabled: cfg.enabled,
    keys: getKeysMasked(),
    rotationIndex: cfg.rotationIndex,
  });
});

// POST /portal/admin/asaas-keys — add key
router.post('/admin/asaas-keys', requireAdmin, (req, res) => {
  const { label, apiKey, webhookToken, sandbox, contaPF, enabled } = req.body || {};
  if (!label || !apiKey || !webhookToken) {
    return res.status(400).json({ error: 'label, apiKey e webhookToken são obrigatórios' });
  }
  const id = addKey(label, apiKey, webhookToken, sandbox !== false, contaPF !== false, enabled !== false);
  res.json({ ok: true, id });
});

// PUT /portal/admin/asaas-keys/:id — update key
router.put('/admin/asaas-keys/:id', requireAdmin, (req, res) => {
  const ok = updateKey(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'Chave não encontrada' });
  res.json({ ok: true });
});

// DELETE /portal/admin/asaas-keys/:id — remove key
router.delete('/admin/asaas-keys/:id', requireAdmin, (req, res) => {
  const ok = removeKey(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Chave não encontrada' });
  res.json({ ok: true });
});

// PUT /portal/admin/asaas-toggle — enable/disable global
router.put('/admin/asaas-toggle', requireAdmin, (req, res) => {
  const { enabled } = req.body || {};
  setAsaasConfig({ enabled: !!enabled });
  res.json({ ok: true, enabled: getAsaasConfig().enabled });
});

// ── Asaas webhook (PUBLIC, validated by keyId + webhookToken) ──
// URL: POST /portal/webhook/asaas/:keyId
// Security: validates asaas-access-token header against the key's webhookToken.
// PF safety: contaPF=true → only RECEIVED triggers confirmOrder (not CONFIRMED).
router.post('/webhook/asaas/:keyId', async (req, res) => {
  const { keyId } = req.params;
  const key = findKeyById(keyId);
  if (!key) return res.status(404).json({ error: 'Unknown key' });

  // Validate webhook token
  const incomingToken = req.headers['asaas-access-token'] || req.headers['x-webhook-token'] || '';
  if (!incomingToken || incomingToken !== key.webhookToken) {
    return res.status(403).json({ error: 'Invalid webhook token' });
  }

  const { event, payment } = req.body || {};
  if (!payment || !payment.id) return res.status(200).json({ ok: true });

  const paymentId = payment.id;
  const status = payment.status; // PENDING, RECEIVED, CONFIRMED, REFUNDED, OVERDUE...

  // Find order by asaas_payment_id or externalReference
  let order = queryOne('SELECT * FROM orders WHERE asaas_payment_id = ?', [paymentId]);
  if (!order && payment.externalReference) {
    order = queryOne('SELECT * FROM orders WHERE id = ?', [Number(payment.externalReference)]);
  }
  if (!order) return res.status(200).json({ ok: true, note: 'order not found' });

  // PF safety: CONFIRMED is provisional for PF accounts (72h antifraude)
  // Only confirm on RECEIVED for PF; PJ accepts both CONFIRMED and RECEIVED
  const isConfirmEvent = event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED';
  const shouldConfirm = (() => {
    if (status === 'RECEIVED') return true;
    if (status === 'CONFIRMED' && !key.contaPF) return true; // PJ: accept CONFIRMED
    return false;
  })();

  if (isConfirmEvent && shouldConfirm) {
    if (order.status === 'confirmed') return res.status(200).json({ ok: true, note: 'already confirmed' });
    try {
      confirmOrder(order.id);
    } catch (err) {
      console.error('[webhook/asaas] confirmOrder error:', err.message);
    }
  } else if (status === 'CONFIRMED' && key.contaPF) {
    // PF: CONFIRMED is provisional — do NOT confirm, just log
    // Payment is still under fraud analysis (up to 72h)
    // Will be confirmed when RECEIVED arrives
  } else if (['REFUNDED', 'REFUND_REQUESTED'].includes(status) || event === 'PAYMENT_REFUNDED') {
    if (order.status === 'confirmed') {
      run(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [order.id]);
      run(`UPDATE subscriptions SET active = 0 WHERE user_id = ? AND plan_id = ?`, [order.user_id, order.plan_id]);
      saveDB();
    }
  } else if (status === 'OVERDUE' || event === 'PAYMENT_OVERDUE') {
    if (order.status === 'pending') {
      run(`UPDATE orders SET status = 'expired', rejected_at = datetime('now') WHERE id = ?`, [order.id]);
      saveDB();
    }
  }

  res.status(200).json({ ok: true });
});

// ── Expiration check (run periodically) ──
setInterval(() => {
  try { expireSubscriptions(); } catch {}
}, 60 * 60 * 1000); // Every hour

// Run once on startup
try { expireSubscriptions(); } catch {}

export default router;
