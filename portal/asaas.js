/**
 * Asaas integration — multi-key rotation + webhook auto-confirm.
 *
 * Keys stored in config.json under config.asaas:
 *   { enabled: bool, keys: [{id, label, apiKey, webhookToken, sandbox, contaPF, enabled}], rotationIndex: int }
 *
 * Webhook: per-key URL /portal/webhook/asaas/:keyId
 * Validates asaas-access-token header against the key's webhookToken.
 *
 * PF safety: conta PF (contaPF=true) only confirms on RECEIVED (not CONFIRMED).
 * PJ accounts accept both CONFIRMED and RECEIVED.
 */

import crypto from 'crypto';

// ── In-memory state ──
let asaasConfig = {
  enabled: false,
  keys: [],        // [{id, label, apiKey, webhookToken, sandbox, contaPF, enabled}]
  rotationIndex: 0,
};

export function getAsaasConfig() { return asaasConfig; }
export function setAsaasConfig(cfg) { if (cfg) asaasConfig = { ...asaasConfig, ...cfg }; }

// Mask secrets
function maskSecret(s) {
  if (!s || s.length <= 4) return '****';
  return '****' + s.slice(-4);
}

export function getKeysMasked() {
  return asaasConfig.keys.map(k => ({
    ...k,
    apiKey: maskSecret(k.apiKey),
    webhookToken: maskSecret(k.webhookToken),
  }));
}

// Round-robin: next enabled key
export function getNextKey() {
  const enabled = asaasConfig.keys.filter(k => k.enabled);
  if (enabled.length === 0) return null;
  const idx = asaasConfig.rotationIndex % enabled.length;
  asaasConfig.rotationIndex = (idx + 1) % enabled.length;
  return enabled[idx];
}

export function findKeyById(keyId) {
  return asaasConfig.keys.find(k => k.id === keyId) || null;
}

// CRUD
export function addKey(label, apiKey, webhookToken, sandbox = true, contaPF = true, enabled = true) {
  const id = crypto.randomBytes(6).toString('hex');
  asaasConfig.keys.push({ id, label, apiKey, webhookToken, sandbox, contaPF, enabled });
  return id;
}

export function updateKey(keyId, patch) {
  const key = asaasConfig.keys.find(k => k.id === keyId);
  if (!key) return false;
  if (patch.label !== undefined) key.label = patch.label;
  if (patch.enabled !== undefined) key.enabled = patch.enabled;
  if (patch.apiKey !== undefined) key.apiKey = patch.apiKey;
  if (patch.webhookToken !== undefined) key.webhookToken = patch.webhookToken;
  if (patch.sandbox !== undefined) key.sandbox = patch.sandbox;
  if (patch.contaPF !== undefined) key.contaPF = patch.contaPF;
  return true;
}

export function removeKey(keyId) {
  const before = asaasConfig.keys.length;
  asaasConfig.keys = asaasConfig.keys.filter(k => k.id !== keyId);
  return asaasConfig.keys.length < before;
}

// ── Asaas API calls ──

function getBaseUrl(key) {
  return key.sandbox ? 'https://sandbox.asaas.com/api/v3' : 'https://api.asaas.com/v3';
}

function asaasFetch(key, path, options = {}) {
  const url = getBaseUrl(key) + path;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'access_token': key.apiKey,
      ...(options.headers || {}),
    },
  });
}

/**
 * Create or reuse a customer for a user.
 * Returns customerId string.
 */
export async function ensureCustomer(key, user) {
  const cpf = (user.cpf || '').replace(/\D/g, '');

  // Try to find existing customer by email
  const searchRes = await asaasFetch(key, `/customers?email=${encodeURIComponent(user.email)}`);
  if (searchRes.ok) {
    const data = await searchRes.json();
    if (data.data && data.data.length > 0) {
      const existing = data.data[0];
      // Update cpfCnpj if missing on existing customer
      if (cpf && !existing.cpfCnpj) {
        await asaasFetch(key, `/customers/${existing.id}`, {
          method: 'POST',
          body: JSON.stringify({ cpfCnpj: cpf }),
        });
      }
      return existing.id;
    }
  }

  // Create new customer with cpfCnpj
  const createRes = await asaasFetch(key, '/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: user.name || user.email.split('@')[0],
      email: user.email,
      cpfCnpj: cpf || undefined,
    }),
  });
  if (!createRes.ok) {
    const err = await createRes.text().catch(() => '');
    throw new Error(`Asaas create customer failed ${createRes.status}: ${err.slice(0, 200)}`);
  }
  const customer = await createRes.json();
  return customer.id;
}

/**
 * Create a PIX payment and return QR code data.
 */
export async function createAsaasPayment(key, customerId, amountBrl, orderId, description) {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const payRes = await asaasFetch(key, '/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: 'PIX',
      value: amountBrl,
      dueDate: tomorrow,
      externalReference: String(orderId),
      description: description || `Claude Bridge - Pedido #${orderId}`,
    }),
  });
  if (!payRes.ok) {
    const err = await payRes.text().catch(() => '');
    throw new Error(`Asaas create payment failed ${payRes.status}: ${err.slice(0, 200)}`);
  }
  const payment = await payRes.json();

  // Get PIX QR code
  const qrRes = await asaasFetch(key, `/payments/${payment.id}/pixQrCode`);
  if (!qrRes.ok) {
    throw new Error(`Asaas pixQrCode failed ${qrRes.status}`);
  }
  const qr = await qrRes.json();

  return {
    paymentId: payment.id,
    status: payment.status,
    brCode: qr.payload,
    qrDataUrl: 'data:image/png;base64,' + qr.encodedImage,
  };
}
