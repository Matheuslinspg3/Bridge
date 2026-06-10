/**
 * AbacatePay integration — multi-key rotation + webhook confirmation.
 *
 * Keys are stored in config.json under config.abacatePay:
 *   { enabled: bool, keys: [{id, label, apiKey, webhookSecret, enabled}], rotationIndex: int }
 *
 * Webhook validation: uses per-key URL pattern /portal/webhook/abacatepay/:keyId
 * The keyId in the URL identifies which key's webhookSecret to validate against.
 * AbacatePay sends the secret in a header or we validate via the URL-bound key.
 */

import crypto from 'crypto';

// ── In-memory state (loaded from config.json) ──
let abacateConfig = {
  enabled: false,
  keys: [],        // [{id, label, apiKey, webhookSecret, enabled}]
  rotationIndex: 0,
};

export function getAbacateConfig() { return abacateConfig; }
export function setAbacateConfig(cfg) { if (cfg) abacateConfig = { ...abacateConfig, ...cfg }; }

// Mask secrets for display (show last 4 only)
function maskSecret(s) {
  if (!s || s.length <= 4) return '****';
  return '****' + s.slice(-4);
}

// Get keys list with secrets masked
export function getKeysMasked() {
  return abacateConfig.keys.map(k => ({
    ...k,
    apiKey: maskSecret(k.apiKey),
    webhookSecret: maskSecret(k.webhookSecret),
  }));
}

// Get next enabled key (round-robin) and advance index
export function getNextKey() {
  const enabled = abacateConfig.keys.filter(k => k.enabled);
  if (enabled.length === 0) return null;
  const idx = abacateConfig.rotationIndex % enabled.length;
  abacateConfig.rotationIndex = (idx + 1) % enabled.length;
  return enabled[idx];
}

// Find key by id (unmasked, internal use)
export function findKeyById(keyId) {
  return abacateConfig.keys.find(k => k.id === keyId) || null;
}

// Add key
export function addKey(label, apiKey, webhookSecret, enabled = true) {
  const id = crypto.randomBytes(6).toString('hex');
  abacateConfig.keys.push({ id, label, apiKey, webhookSecret, enabled });
  return id;
}

// Update key
export function updateKey(keyId, patch) {
  const key = abacateConfig.keys.find(k => k.id === keyId);
  if (!key) return false;
  if (patch.label !== undefined) key.label = patch.label;
  if (patch.enabled !== undefined) key.enabled = patch.enabled;
  if (patch.apiKey !== undefined) key.apiKey = patch.apiKey;
  if (patch.webhookSecret !== undefined) key.webhookSecret = patch.webhookSecret;
  return true;
}

// Remove key
export function removeKey(keyId) {
  const before = abacateConfig.keys.length;
  abacateConfig.keys = abacateConfig.keys.filter(k => k.id !== keyId);
  return abacateConfig.keys.length < before;
}

// ── AbacatePay API call ──
export async function createAbacateCharge(key, amountBrl, pedidoId, description) {
  const amountCents = Math.round(amountBrl * 100);
  const body = {
    method: 'PIX',
    data: {
      amount: amountCents,
      description: description || `Plano Claude Bridge - Pedido #${pedidoId}`,
      expiresIn: 3600,
      externalId: String(pedidoId),
      metadata: { pedidoId: String(pedidoId) },
    },
  };

  const res = await fetch('https://api.abacatepay.com/v2/transparents/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AbacatePay error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!json.success || !json.data) {
    throw new Error('AbacatePay: unexpected response');
  }

  return {
    chargeId: json.data.id,
    brCode: json.data.brCode,
    brCodeBase64: json.data.brCodeBase64,
    status: json.data.status,
  };
}
