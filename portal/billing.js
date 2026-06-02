import { queryAll, queryOne, run, saveDB } from './db.js';
import { generatePixQRCode } from './pix.js';
import { notifyNewOrder } from './notify.js';

// ── Planos ──
export const PLANS = {
  pro5x: {
    id: 'pro5x',
    name: 'Pro 5x',
    price: 124.99,
    tokensMonth: 35_000_000,
    rpm: 15,
    maxTokensReq: 4096,
    budgetDay: 4_000_000,
    throttleRange: [4_000_000, 6_000_000],
    blockAbove: 6_000_000,
  },
  max10x: {
    id: 'max10x',
    name: 'Max 10x',
    price: 249.99,
    tokensMonth: 90_000_000,
    rpm: 25,
    maxTokensReq: 8192,
    budgetDay: 8_000_000,
    throttleRange: [8_000_000, 12_000_000],
    blockAbove: 12_000_000,
  },
  max20x: {
    id: 'max20x',
    name: 'Max 20x',
    price: 499.99,
    tokensMonth: 225_000_000,
    rpm: 40,
    maxTokensReq: 16384,
    budgetDay: 12_000_000,
    throttleRange: [12_000_000, 18_000_000],
    blockAbove: 18_000_000,
  },
};

// Gera centavos aleatórios para identificar pagamento
function randomCents() {
  return Math.floor(Math.random() * 99 + 1) / 100;
}

// ── Criar pedido ──
export async function createOrder(userId, planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error('Plano inválido');
  const amount = plan.price + randomCents();

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
