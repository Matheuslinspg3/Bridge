import { Router } from 'express';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import { initDB, queryAll, queryOne, run, saveDB } from './db.js';
import { hashPassword, comparePassword, createToken, requireAuth } from './auth.js';
import {
  PLANS, createOrder, confirmOrder, rejectOrder,
  getPendingOrders, getRecentConfirmed,
  expireSubscriptions
} from './billing.js';
import { getDailyUsage, getMonthlyUsage } from './ratelimit.js';

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
  res.json(Object.values(PLANS));
});

// POST /portal/orders
router.post('/orders', requireAuth, async (req, res) => {
  try {
    const { plan_id } = req.body || {};
    if (!PLANS[plan_id])
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

// ── Expiration check (run periodically) ──
setInterval(() => {
  try { expireSubscriptions(); } catch {}
}, 60 * 60 * 1000); // Every hour

// Run once on startup
try { expireSubscriptions(); } catch {}

export default router;
