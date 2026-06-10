import { queryAll, queryOne, run, saveDB } from './db.js';
import { generatePixQRCode } from './pix.js';
import { notifyNewOrder } from './notify.js';
import { getAsaasConfig, getNextKey, ensureCustomer, createAsaasPayment } from './asaas.js';

import { getPlansDict, getPlanOrder } from './plans-store.js';

// ── Dynamic Plans (read from config via plans-store) ──
// PLANS is a getter that returns current plan dict
export function getPLANS() { return getPlansDict(); }
// Backward compat: PLANS as a proxy-like object that always reads fresh
export const PLANS = new Proxy({}, {
  get(_, prop) { return getPlansDict()[prop]; },
  has(_, prop) { return prop in getPlansDict(); },
  ownKeys() { return Object.keys(getPlansDict()); },
  getOwnPropertyDescriptor(_, prop) {
    const dict = getPlansDict();
    if (prop in dict) return { value: dict[prop], enumerable: true, configurable: true };
  },
});

// ── Top-up (pacote extra) ──
export const TOP_UP = {
  id: 'topup_15m',
  name: '+15M tokens',
  price: 29.90,
  tokens: 15_000_000,
};

// Plan ordering: dynamic, sorted by price ascending
function getPLAN_ORDER() { return getPlanOrder(); }

// Gera centavos aleatórios para identificar pagamento
function randomCents() {
  return Math.floor(Math.random() * 99 + 1) / 100;
}

// ── Criar pedido ──
export async function createOrder(userId, planId) {
  // Top-up handling
  if (planId === 'topup_15m') {
    const activeSub = queryOne(
      `SELECT * FROM subscriptions WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    if (!activeSub) throw new Error('Você precisa ter uma assinatura ativa para comprar pacotes extras');
    const amount = TOP_UP.price + randomCents();
    const { payload, qrDataUrl } = await generatePixQRCode(amount);
    const result = run(
      `INSERT INTO orders (user_id, plan_id, amount_brl, pix_payload, status) VALUES (?, ?, ?, ?, 'pending')`,
      [userId, 'topup_15m', amount, payload]
    );
    const order = queryOne('SELECT * FROM orders WHERE id = ?', [result.lastInsertRowid]);
    saveDB();
    const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
    notifyNewOrder(order, user).catch(() => {});
    return { order, qrDataUrl, payload };
  }

  const plan = PLANS[planId];
  if (!plan) throw new Error('Plano inválido');

  // Upgrade-only: reject downgrade (check highest active plan)
  const activeSubs = queryAll(
    `SELECT plan_id FROM subscriptions WHERE user_id = ? AND active = 1`,
    [userId]
  );
  if (activeSubs.length > 0) {
    const highestIdx = Math.max(...activeSubs.map(s => getPLAN_ORDER().indexOf(s.plan_id)).filter(i => i >= 0));
    const requestedIdx = getPLAN_ORDER().indexOf(planId);
    if (requestedIdx >= 0 && highestIdx >= 0 && requestedIdx < highestIdx) {
      throw new Error('Não é possível fazer downgrade enquanto houver assinatura ativa superior');
    }
  }

  const amount = plan.price + randomCents();

  // Try Asaas if enabled, else fallback to static PIX
  const asaasConfig = getAsaasConfig();
  if (asaasConfig.enabled) {
    const key = getNextKey();
    if (key) {
      try {
        const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
        const customerId = await ensureCustomer(key, user);

        // Create a temporary order ID for externalReference
        const tempResult = run(
          `INSERT INTO orders (user_id, plan_id, amount_brl, pix_payload, status) VALUES (?, ?, ?, '', 'pending')`,
          [userId, planId, amount]
        );
        const orderId = tempResult.lastInsertRowid;

        const payment = await createAsaasPayment(key, customerId, amount, orderId);

        // Update order with Asaas data
        run(`UPDATE orders SET pix_payload = ?, asaas_payment_id = ?, asaas_key_id = ? WHERE id = ?`,
          [payment.brCode, payment.paymentId, key.id, orderId]);
        saveDB();

        const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
        notifyNewOrder(order, user).catch(() => {});

        return { order, qrDataUrl: payment.qrDataUrl, payload: payment.brCode };
      } catch (err) {
        console.error('[asaas] Payment creation failed, falling back to static PIX:', err.message);
        // Delete the dangling order if it was created
        try { const lastId = queryOne("SELECT id FROM orders WHERE user_id = ? AND pix_payload = '' AND status = 'pending' ORDER BY id DESC LIMIT 1", [userId]); if (lastId) run('DELETE FROM orders WHERE id = ?', [lastId.id]); } catch {}
        // Fall through to static PIX
      }
    }
  }

  // Fallback: static PIX
  const { payload, qrDataUrl } = await generatePixQRCode(amount);

  const result = run(
    `INSERT INTO orders (user_id, plan_id, amount_brl, pix_payload, status) VALUES (?, ?, ?, ?, 'pending')`,
    [userId, planId, amount, payload]
  );
  const order = queryOne('SELECT * FROM orders WHERE id = ?', [result.lastInsertRowid]);
  saveDB();

  // Notify admin
  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  notifyNewOrder(order, user).catch(() => {});

  return { order, qrDataUrl, payload };
}

// ── Gerar API key ──
function genPortalApiKey() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const rand = Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * 62)]).join('');
  return `sk-bridge-${rand}`;
}

// ── Confirmar pagamento ──
export function confirmOrder(orderId) {
  const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error('Pedido não encontrado');
  if (order.status !== 'pending') throw new Error('Pedido não está pendente');

  run(`UPDATE orders SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?`, [orderId]);

  // Top-up: add tokens to current month, don't create new subscription
  if (order.plan_id === 'topup_15m') {
    run(
      `INSERT INTO topups (user_id, tokens, confirmed_at) VALUES (?, ?, datetime('now'))`,
      [order.user_id, TOP_UP.tokens]
    );
    saveDB();
    return { apiKey: null, expiresAt: null, topup: true, tokens: TOP_UP.tokens };
  }

  // Criar subscription (30 dias) with plan snapshot
  const apiKey = genPortalApiKey();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const plan = PLANS[order.plan_id];
  const snapshot = plan ? JSON.stringify({
    tokensMonth: plan.tokensMonth, rpm: plan.rpm,
    maxTokensReq: plan.maxTokensReq, price: plan.price, name: plan.name,
  }) : null;
  run(
    `INSERT INTO subscriptions (user_id, plan_id, api_key, starts_at, expires_at, active, plan_snapshot) VALUES (?, ?, ?, datetime('now'), ?, 1, ?)`,
    [order.user_id, order.plan_id, apiKey, expiresAt, snapshot]
  );
  saveDB();

  return { apiKey, expiresAt };
}

// ── Rejeitar pedido ──
export function rejectOrder(orderId) {
  run(`UPDATE orders SET status = 'rejected', rejected_at = datetime('now') WHERE id = ?`, [orderId]);
  saveDB();
}

// ── Verificar expiração ──
export function expireSubscriptions() {
  const now = new Date().toISOString();
  run(`UPDATE subscriptions SET active = 0 WHERE expires_at < ? AND active = 1`, [now]);
  saveDB();
}

// ── Buscar subscription ativa por API key ──
export function getActiveSubscription(apiKey) {
  return queryOne(
    `SELECT s.*, u.email, u.name as user_name FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE s.api_key = ? AND s.active = 1`,
    [apiKey]
  );
}

// ── Pedidos pendentes ──
export function getPendingOrders() {
  return queryAll(
    `SELECT o.*, u.email, u.name as user_name FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.status = 'pending' ORDER BY o.created_at DESC`
  );
}

// ── Pedidos recentes confirmados ──
export function getRecentConfirmed(limit = 20) {
  return queryAll(
    `SELECT o.*, u.email, u.name as user_name FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.status = 'confirmed' ORDER BY o.confirmed_at DESC LIMIT ?`,
    [limit]
  );
}

// ── Top-ups do mês para um usuário ──
export function getTopupsThisMonth(userId) {
  const d = new Date(); d.setUTCDate(1); d.setUTCHours(0,0,0,0);
  const monthStart = d.toISOString();
  const row = queryOne(
    `SELECT COALESCE(SUM(tokens), 0) as total FROM topups WHERE user_id = ? AND confirmed_at >= ?`,
    [userId, monthStart]
  );
  return row?.total || 0;
}

// ── Backfill plan_snapshot for existing subscriptions ──
export function backfillSnapshots() {
  try {
    const subs = queryAll(`SELECT id, plan_id FROM subscriptions WHERE plan_snapshot IS NULL AND active = 1`);
    for (const sub of subs) {
      const plan = PLANS[sub.plan_id];
      if (plan) {
        const snapshot = JSON.stringify({
          tokensMonth: plan.tokensMonth, rpm: plan.rpm,
          maxTokensReq: plan.maxTokensReq, price: plan.price, name: plan.name,
        });
        run(`UPDATE subscriptions SET plan_snapshot = ? WHERE id = ?`, [snapshot, sub.id]);
      }
    }
    saveDB();
  } catch (e) {
    console.error('[billing] backfillSnapshots error:', e.message);
  }
}
