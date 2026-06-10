import { queryAll, queryOne, run, saveDB } from './db.js';
import { generatePixQRCode } from './pix.js';
import { notifyNewOrder } from './notify.js';
import { getAbacateConfig, getNextKey, createAbacateCharge } from './abacate.js';

// ── Planos ──
export const PLANS = {
  pro5x: {
    id: 'pro5x',
    name: 'Pro 5x',
    price: 99.90,
    tokensMonth: 60_000_000,
    rpm: 15,
    maxTokensReq: 4096,
    budgetDay: 3_000_000,
    throttleRange: [3_000_000, 4_500_000],
    blockAbove: 4_500_000,
  },
  max10x: {
    id: 'max10x',
    name: 'Max 10x',
    price: 179.90,
    tokensMonth: 130_000_000,
    rpm: 25,
    maxTokensReq: 8192,
    budgetDay: 6_500_000,
    throttleRange: [6_500_000, 9_500_000],
    blockAbove: 9_500_000,
  },
  max20x: {
    id: 'max20x',
    name: 'Max 20x',
    price: 279.90,
    tokensMonth: 220_000_000,
    rpm: 40,
    maxTokensReq: 16384,
    budgetDay: 11_000_000,
    throttleRange: [11_000_000, 16_000_000],
    blockAbove: 16_000_000,
  },
};

// ── Top-up (pacote extra) ──
export const TOP_UP = {
  id: 'topup_15m',
  name: '+15M tokens',
  price: 29.90,
  tokens: 15_000_000,
};

// Plan ordering for upgrade-only logic
const PLAN_ORDER = ['pro5x', 'max10x', 'max20x'];

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
    const highestIdx = Math.max(...activeSubs.map(s => PLAN_ORDER.indexOf(s.plan_id)).filter(i => i >= 0));
    const requestedIdx = PLAN_ORDER.indexOf(planId);
    if (requestedIdx >= 0 && highestIdx >= 0 && requestedIdx < highestIdx) {
      throw new Error('Não é possível fazer downgrade enquanto houver assinatura ativa superior');
    }
  }

  const amount = plan.price + randomCents();

  // Try AbacatePay if enabled, else fallback to static PIX
  const abConfig = getAbacateConfig();
  if (abConfig.enabled) {
    const key = getNextKey();
    if (key) {
      try {
        // Insert order first to get ID for externalId
        const result = run(
          `INSERT INTO orders (user_id, plan_id, amount_brl, pix_payload, status) VALUES (?, ?, ?, ?, 'pending')`,
          [userId, planId, amount, '']
        );
        const orderId = result.lastInsertRowid;

        const charge = await createAbacateCharge(key, amount, orderId);

        // Update order with AbacatePay data
        run(`UPDATE orders SET pix_payload = ?, abacate_charge_id = ?, abacate_key_id = ? WHERE id = ?`,
          [charge.brCode, charge.chargeId, key.id, orderId]);
        saveDB();

        const order = queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
        const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
        notifyNewOrder(order, user).catch(() => {});

        return { order, qrDataUrl: charge.brCodeBase64, payload: charge.brCode };
      } catch (err) {
        console.error('[abacatepay] Charge creation failed, falling back to static PIX:', err.message);
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

  // Criar subscription (30 dias)
  const apiKey = genPortalApiKey();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  run(
    `INSERT INTO subscriptions (user_id, plan_id, api_key, starts_at, expires_at, active) VALUES (?, ?, ?, datetime('now'), ?, 1)`,
    [order.user_id, order.plan_id, apiKey, expiresAt]
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
