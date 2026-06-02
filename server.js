// ============================================================
// 1. IMPORTS
// ============================================================
import express from "express";
import dns from "dns";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 2. HELPERS
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const round4 = (n) => Math.round(n * 10000) / 10000;

const dayKey = () => new Date().toISOString().slice(0, 10);

let _idSeq = 0;
const genId = () => `${Date.now().toString(36)}-${(++_idSeq).toString(36)}`;

const maskKey = (key) => {
  if (!key || key.length < 8) return "***";
  return key.slice(0, 4) + "..." + key.slice(-4);
};

// ============================================================
// 2b. MURMURHASH3 (sticky routing)
// ============================================================
const murmurhash3 = (str, seed = 0) => {
  let h = seed ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

// ============================================================
// 3. CONFIG PERSISTENCE
// ============================================================
const CONFIG_PATH = (() => {
  // Prefere /data (volume persistente no Docker/EasyPanel).
  // /data sobrevive redeploy — config nunca se perde.
  try {
    fs.accessSync("/data", fs.constants.W_OK);
    return "/data/config.json";
  } catch {
    // Fallback: /app (dev local ou container sem volume)
    try {
      fs.accessSync("/app", fs.constants.W_OK);
      return "/app/config.json";
    } catch {
      return path.join(__dirname, "config.json");
    }
  }
})();

const DEFAULT_CONFIG = {
  dashboardPassword: "admin",
  apiKeys: [],
  defaultModel: "claude-opus-4-7",
  upstreams: [],
  retry: { infinite: true, attempts: 5, baseDelayMs: 1000, maxDelayMs: 20000, jitterMs: 750 },
  concurrency: { maxConcurrency: 1, minIntervalMs: 1500, timeoutMs: 180000 },
  circuit: { failures: 3, cooldownMs: 60000 },
  openclawForceNonStreamRetry: true,
  guardrails: {
    pii: { enabled: true },
    maxTokens: { enabled: true, limit: 8192 },
    budget: { enabled: true, dailyUsd: 10, inputPerMillion: 15, outputPerMillion: 75 },
    modelSwap: { enabled: true },
  },
};

const deepMerge = (target, source) => {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
};

const loadConfig = () => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    // Sem config.json — retorna defaults. Tudo é configurado pelo dashboard.
    return deepMerge({}, DEFAULT_CONFIG);
  }
};

const saveConfig = (cfg) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
};

let config = loadConfig();

const isConfigured = () =>
  config.upstreams.length > 0 && !!config.dashboardPassword;

const getEnabledUpstreams = () =>
  (config.upstreams || []).filter((u) => u.enabled !== false);

// ---- API keys (rastreabilidade) ----
const genApiKey = () => {
  const rand = Array.from({ length: 32 }, () =>
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]
  ).join("");
  return `sk-bridge-${rand}`;
};

const findApiKey = (raw) => {
  const k = (raw || "").trim();
  if (!k) return null;
  return (config.apiKeys || []).find((a) => a.key === k && a.enabled !== false) || null;
};

const touchApiKey = (keyObj, isError) => {
  if (!keyObj) return;
  keyObj.requests = (keyObj.requests || 0) + 1;
  if (isError) keyObj.errors = (keyObj.errors || 0) + 1;
  keyObj.lastUsed = new Date().toISOString();
};

// ============================================================
// 4. EXPRESS APP, PORT, DNS, STARTED_AT
// ============================================================
const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT = Number(process.env.PORT) || 8787;

dns.setDefaultResultOrder("ipv4first");

const STARTED_AT = new Date().toISOString();

// ============================================================
// 5. ERROR LOG
// ============================================================
let errorLogIdSeq = 0;
const errorLog = [];

const pushErrorLog = (entry) => {
  errorLog.push({
    id: ++errorLogIdSeq,
    ts: new Date().toISOString(),
    ...entry,
  });
  if (errorLog.length > 500) errorLog.splice(0, errorLog.length - 500);
};

// ============================================================
// 6. BRIDGE STATE
// ============================================================
const bridgeState = {
  active: 0,
  lastStart: null,
  consecutiveFailures: 0,
  circuitUntil: 0,
};

const upstreamStats = {};

const getUpstreamStat = (id) => {
  if (!upstreamStats[id]) {
    upstreamStats[id] = {
      requests: 0,
      success: 0,
      errors: 0,
      retries: 0,
      lastUsed: null,
      lastError: null,
      lastErrorTs: null,
    };
  }
  return upstreamStats[id];
};

// ============================================================
// 6b. HEALTH CHECK STATE
// ============================================================
const healthState = {}; // keyed by upstream.id

const getHealthState = (id) => {
  if (!healthState[id]) {
    healthState[id] = {
      healthy: true,
      consecutiveFailures: 0,
      lastCheckAt: null,
      lastCheckOk: null,
      lastCheckMs: null,
    };
  }
  return healthState[id];
};

const runHealthCheck = async (upstream) => {
  const hs = getHealthState(upstream.id);
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${upstream.baseUrl}/v1/models`, {
      headers: { "x-api-key": upstream.apiKey, Authorization: `Bearer ${upstream.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    // 200 = alive, 401 = alive (requires key but server responded)
    if (res.status === 200 || res.status === 401) {
      hs.consecutiveFailures = 0;
      hs.healthy = true;
      hs.lastCheckOk = true;
    } else {
      hs.consecutiveFailures++;
      hs.lastCheckOk = false;
      if (hs.consecutiveFailures >= 3) hs.healthy = false;
    }
  } catch {
    hs.consecutiveFailures++;
    hs.lastCheckOk = false;
    if (hs.consecutiveFailures >= 3) hs.healthy = false;
  }
  hs.lastCheckAt = new Date().toISOString();
  hs.lastCheckMs = Date.now() - start;
};

const runAllHealthChecks = async () => {
  const upstreams = getEnabledUpstreams();
  await Promise.allSettled(upstreams.map((u) => runHealthCheck(u)));
};

const startHealthCheckLoop = () => {
  // Run immediately on startup
  setTimeout(() => runAllHealthChecks(), 2000);
  // Then every 30 seconds
  setInterval(() => runAllHealthChecks(), 30000);
};

// ============================================================
// 7. GUARDRAILS RUNTIME STATE
// ============================================================
const grState = {
  pii: { blocked: 0, lastBlockAt: null },
  maxTokens: { blocked: 0, clamped: 0, lastBlockAt: null },
  budget: { day: dayKey(), usedUsd: 0, totalUsd: 0, blocked: 0, lastBlockAt: null, history: [] },
  modelSwap: { detected: 0, swaps: [] },
};

const rotateBudgetIfNeeded = () => {
  const today = dayKey();
  if (grState.budget.day !== today) {
    grState.budget.day = today;
    grState.budget.usedUsd = 0;
  }
};

const estimateUsd = (inputTokens, outputTokens) => {
  const g = config.guardrails.budget;
  const inCost = (inputTokens / 1_000_000) * (g.inputPerMillion || 15);
  const outCost = (outputTokens / 1_000_000) * (g.outputPerMillion || 75);
  return round4(inCost + outCost);
};

const flattenMessageText = (messages) => {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content))
        return m.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(" ");
      return "";
    })
    .join(" ");
};

const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
  /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/,
];

const detectPII = (text) => PII_PATTERNS.some((p) => p.test(text));

// Extrai o "request id: ..." que provedores como Nuoda devolvem em erros.
const parseUpstreamRequestId = (text) => {
  if (!text) return null;
  const m = String(text).match(/request[_\s-]?id[:\s"]+([a-zA-Z0-9_-]{8,})/i);
  return m ? m[1] : null;
};

const preflightGuardrails = (body, route) => {
  const gr = config.guardrails;
  const messages = body.messages || [];

  if (gr.pii?.enabled) {
    const text = flattenMessageText(messages);
    if (detectPII(text)) {
      metrics.guardrailBlocks++;
      return { blocked: true, reason: "pii_detected", status: 400 };
    }
  }

  if (gr.maxTokens?.enabled) {
    const limit = gr.maxTokens.limit || 8192;
    const requested = body.max_tokens || body.maxTokens || 0;
    if (requested > limit) {
      // Clamp em vez de bloquear: muitos clientes (Claude Code, OpenClaw, Cursor)
      // enviam max_tokens alto por padrão. Bloquear quebraria toda requisição.
      metrics.guardrailClamps = (metrics.guardrailClamps || 0) + 1;
      grState.maxTokens.lastClampedAt = new Date().toISOString();
      grState.maxTokens.lastClampedFrom = requested;
      grState.maxTokens.lastClampedTo = limit;
      if (body.max_tokens !== undefined) body.max_tokens = limit;
      if (body.maxTokens !== undefined) body.maxTokens = limit;
    }
  }

  if (gr.budget?.enabled) {
    rotateBudgetIfNeeded();
    const daily = gr.budget.dailyUsd || 10;
    if (grState.budget.usedUsd >= daily) {
      metrics.guardrailBlocks++;
      return { blocked: true, reason: "budget_exceeded", status: 429 };
    }
  }

  return { blocked: false };
};

const recordUsage = (usage) => {
  if (!usage) return;
  const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
  rotateBudgetIfNeeded();
  grState.budget.usedUsd = round4(
    grState.budget.usedUsd + estimateUsd(inputTokens, outputTokens)
  );
  grState.budget.totalUsd = round4((grState.budget.totalUsd || 0) + estimateUsd(inputTokens, outputTokens));
};

// Detecta quando o upstream devolve um modelo diferente do solicitado.
const detectModelSwap = (requested, returned, route) => {
  if (!config.guardrails?.modelSwap?.enabled) return;
  if (!requested || !returned) return;
  // Normaliza: ignora diferença só de sufixo de data (ex: -20250514)
  const norm = (m) => String(m).toLowerCase().replace(/-\d{8}$/, "").trim();
  if (norm(requested) === norm(returned)) return;
  grState.modelSwap.detected = (grState.modelSwap.detected || 0) + 1;
  grState.modelSwap.swaps = grState.modelSwap.swaps || [];
  grState.modelSwap.swaps.unshift({
    at: new Date().toISOString(),
    route: route || null,
    requested,
    returned,
  });
  if (grState.modelSwap.swaps.length > 50) grState.modelSwap.swaps.length = 50;
};

// ============================================================
// 8. METRICS
// ============================================================
const metrics = {
  totalRequests: 0,
  totalSuccess: 0,
  totalErrors: 0,
  upstreamRetries: 0,
  circuitOpenedCount: 0,
  lastCircuitOpenAt: null,
  guardrailBlocks: 0,
  byRoute: {},
  recent: [],
};

const pushRecent = (entry) => {
  metrics.recent.unshift({ ts: new Date().toISOString(), ...entry });
  if (metrics.recent.length > 100) metrics.recent.length = 100;
};

// ============================================================
// 9. RETRY HELPERS
// ============================================================
const isRetryableStatus = (status) =>
  [429, 500, 502, 503, 504].includes(status);

const isDefinitiveStatus = (status) =>
  status >= 400 && status < 500 && status !== 429;

const normalizeText = (t) => (t || "").toLowerCase();

const isRetryableText = (text) => {
  const t = normalizeText(text);
  return (
    t.includes("rate limit") ||
    t.includes("overloaded") ||
    t.includes("capacity") ||
    t.includes("try again") ||
    t.includes("timeout") ||
    t.includes("connection") ||
    t.includes("econnreset") ||
    t.includes("econnrefused") ||
    t.includes("socket hang up") ||
    t.includes("no account is available") ||
    t.includes("no available account") ||
    t.includes("account is available") ||
    t.includes("没有可用token") ||
    t.includes("渠道异常") ||
    t.includes("无可用渠道") ||
    t.includes("当前分组")
  );
};

const isDefinitiveText = (text) => {
  const t = normalizeText(text);
  return (
    t.includes("invalid api key") ||
    t.includes("authentication") ||
    t.includes("unauthorized") ||
    t.includes("not found") ||
    t.includes("invalid request")
  );
};

// ============================================================
// 10. UPSTREAM SLOT
// ============================================================
let _activeSlots = 0;
let _lastRequestAt = 0;

const acquireUpstreamSlot = async () => {
  const maxC = config.concurrency.maxConcurrency || 1;
  const minInterval = config.concurrency.minIntervalMs || 1500;
  while (_activeSlots >= maxC) {
    await sleep(100);
  }
  const now = Date.now();
  const wait = minInterval - (now - _lastRequestAt);
  if (wait > 0) await sleep(wait);
  _activeSlots++;
  _lastRequestAt = Date.now();
};

const releaseUpstreamSlot = () => {
  _activeSlots = Math.max(0, _activeSlots - 1);
};

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
};

// ============================================================
// 11. FETCH UPSTREAM (priority + sticky + cross-vendor fallback)
// ============================================================

// Sort upstreams by priority (lower = cheaper/preferred)
const sortByPriority = (upstreams) =>
  [...upstreams].sort((a, b) => (a.priority || 10) - (b.priority || 10));

// Get healthy upstreams of a specific vendor, sorted by priority
const getHealthyByVendor = (upstreams, vendor) =>
  sortByPriority(upstreams.filter((u) => {
    const v = u.vendor || "anthropic";
    const hs = getHealthState(u.id);
    return v === vendor && hs.healthy && u.enabled !== false;
  }));

// Pick sticky upstream for a user identifier
const pickStickyUpstream = (upstreams, userId) => {
  if (!userId || !upstreams.length) return upstreams[0] || null;
  const sorted = sortByPriority(upstreams);
  const healthy = sorted.filter((u) => getHealthState(u.id).healthy);
  const pool = healthy.length > 0 ? healthy : sorted;
  const idx = murmurhash3(userId) % pool.length;
  return pool[idx];
};

// Convert Anthropic request to OpenAI format for cross-vendor fallback
const convertAnthropicRequestToOpenAI = (anthropicBody, fallbackModel) => {
  const messages = [];
  if (anthropicBody.system) {
    messages.push({ role: "system", content: anthropicBody.system });
  }
  for (const m of (anthropicBody.messages || [])) {
    messages.push({ role: m.role, content: m.content });
  }
  return {
    model: fallbackModel,
    messages,
    max_tokens: anthropicBody.max_tokens || 4096,
    temperature: anthropicBody.temperature,
    top_p: anthropicBody.top_p,
    stream: anthropicBody.stream || false,
  };
};

// Convert OpenAI response back to Anthropic format
const convertOpenAIResponseToAnthropic = (openaiData, originalModel) => {
  const choice = (openaiData.choices || [])[0] || {};
  const msg = choice.message || {};
  return {
    id: openaiData.id || genId(),
    type: "message",
    role: "assistant",
    model: originalModel,
    content: [{ type: "text", text: msg.content || "" }],
    stop_reason: choice.finish_reason || "end_turn",
    usage: {
      input_tokens: openaiData.usage?.prompt_tokens || 0,
      output_tokens: openaiData.usage?.completion_tokens || 0,
    },
  };
};

const fetchUpstream = async (url, options, reqCtx) => {
  const allUpstreams = reqCtx.upstreams || [];
  if (!allUpstreams.length) throw new Error("No upstreams configured");

  const retryCfg = config.retry;
  const circuitCfg = config.circuit;
  const timeoutMs = config.concurrency.timeoutMs || 180000;
  const infinite = retryCfg.infinite !== false;
  const maxAttempts = infinite ? Infinity : (retryCfg.attempts || 5);

  // --- Priority + Sticky routing ---
  // Filter to same-vendor upstreams first (anthropic for /v1/messages)
  const requestVendor = reqCtx.requestVendor || "anthropic";
  const sameVendor = sortByPriority(
    allUpstreams.filter((u) => (u.vendor || "anthropic") === requestVendor)
  );
  const healthySameVendor = sameVendor.filter((u) => getHealthState(u.id).healthy);

  // Sticky: hash user to a preferred upstream
  const userId = reqCtx.userId || reqCtx.apiKeyName || null;
  const stickyTarget = pickStickyUpstream(
    healthySameVendor.length > 0 ? healthySameVendor : sameVendor,
    userId
  );

  // Build ordered attempt list: sticky first, then rest by priority
  const orderedUpstreams = [stickyTarget, ...sameVendor.filter((u) => u.id !== stickyTarget?.id)];

  let attempt = 0;
  let upstreamIdx = 0;

  while (attempt < maxAttempts) {
    // If we've exhausted same-vendor upstreams, break to cross-vendor fallback
    if (upstreamIdx >= orderedUpstreams.length && attempt > 0) break;

    const upstream = orderedUpstreams[upstreamIdx % orderedUpstreams.length];
    if (!upstream) break;
    const stat = getUpstreamStat(upstream.id);
    const hs = getHealthState(upstream.id);

    // Skip unhealthy on first pass (allow on last resort)
    if (!hs.healthy && upstreamIdx < orderedUpstreams.length - 1 && attempt < 3) {
      upstreamIdx++;
      continue;
    }

    // Circuit breaker check
    if (bridgeState.circuitUntil > Date.now()) {
      metrics.circuitOpenedCount++;
      metrics.lastCircuitOpenAt = new Date().toISOString();
      pushErrorLog({
        type: "circuit_open",
        upstream: upstream.name,
        upstreamId: upstream.id,
        message: "Circuit breaker open",
      });
      const waitMs = bridgeState.circuitUntil - Date.now();
      await sleep(Math.min(waitMs, 5000));
      attempt++;
      upstreamIdx++;
      continue;
    }

    const targetUrl = upstream.baseUrl + url;
    const apiKey = (upstream.apiKey || "").trim();
    const headers = {
      ...(options.headers || {}),
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
    };

    stat.requests++;
    stat.lastUsed = new Date().toISOString();

    try {
      await acquireUpstreamSlot();
      let res;
      try {
        res = await fetchWithTimeout(targetUrl, { ...options, headers }, timeoutMs);
      } finally {
        releaseUpstreamSlot();
      }

      if (res.ok) {
        stat.success++;
        bridgeState.consecutiveFailures = 0;
        hs.consecutiveFailures = 0;
        hs.healthy = true;
        return res;
      }

      const bodyText = await res.clone().text().catch(() => "");
      const reqId = parseUpstreamRequestId(bodyText);
      const retryableByText = isRetryableText(bodyText);

      if (isDefinitiveStatus(res.status) && !retryableByText) {
        stat.errors++;
        stat.lastError = `HTTP ${res.status}`;
        stat.lastErrorTs = new Date().toISOString();
        pushErrorLog({
          type: isDefinitiveText(bodyText) ? "client_error" : "upstream_error",
          upstream: upstream.name, upstreamId: upstream.id,
          status: res.status, message: bodyText.slice(0, 500),
          upstreamRequestId: reqId, apiKeyName: reqCtx.apiKeyName || null,
          model: reqCtx.model || null, route: reqCtx.route || null,
          attempt: attempt + 1, definitive: true,
        });
        return res;
      }

      // Retryable
      stat.errors++;
      stat.lastError = `HTTP ${res.status}`;
      stat.lastErrorTs = new Date().toISOString();
      bridgeState.consecutiveFailures++;
      hs.consecutiveFailures++;
      if (hs.consecutiveFailures >= 3) hs.healthy = false;

      pushErrorLog({
        type: "upstream_retry",
        upstream: upstream.name, upstreamId: upstream.id,
        status: res.status, message: bodyText.slice(0, 500),
        upstreamRequestId: reqId, apiKeyName: reqCtx.apiKeyName || null,
        model: reqCtx.model || null, route: reqCtx.route || null,
        attempt: attempt + 1, retryReason: retryableByText ? "retryable_text" : "retryable_status",
      });

      if (bridgeState.consecutiveFailures >= (circuitCfg.failures || 3)) {
        bridgeState.circuitUntil = Date.now() + (circuitCfg.cooldownMs || 60000);
        metrics.circuitOpenedCount++;
        metrics.lastCircuitOpenAt = new Date().toISOString();
      }

      metrics.upstreamRetries++;
      attempt++;
      upstreamIdx++;

      const delay = Math.min(
        (retryCfg.baseDelayMs || 1000) * Math.pow(2, attempt - 1) +
          Math.random() * (retryCfg.jitterMs || 750),
        retryCfg.maxDelayMs || 20000
      );
      await sleep(delay);
    } catch (err) {
      releaseUpstreamSlot();
      stat.errors++;
      stat.lastError = err.message;
      stat.lastErrorTs = new Date().toISOString();
      bridgeState.consecutiveFailures++;
      hs.consecutiveFailures++;
      if (hs.consecutiveFailures >= 3) hs.healthy = false;

      const isTimeout = err.name === "AbortError";
      pushErrorLog({
        type: isTimeout ? "timeout" : "network_error",
        upstream: upstream.name, upstreamId: upstream.id,
        message: err.message, apiKeyName: reqCtx.apiKeyName || null,
        model: reqCtx.model || null, route: reqCtx.route || null,
        attempt: attempt + 1,
      });

      if (bridgeState.consecutiveFailures >= (circuitCfg.failures || 3)) {
        bridgeState.circuitUntil = Date.now() + (circuitCfg.cooldownMs || 60000);
        metrics.circuitOpenedCount++;
        metrics.lastCircuitOpenAt = new Date().toISOString();
      }

      metrics.upstreamRetries++;
      attempt++;
      upstreamIdx++;

      const delay = Math.min(
        (retryCfg.baseDelayMs || 1000) * Math.pow(2, attempt - 1) +
          Math.random() * (retryCfg.jitterMs || 750),
        retryCfg.maxDelayMs || 20000
      );
      await sleep(delay);
    }
  }

  // ── Cross-vendor emergency fallback ──
  const crossVendorUpstreams = sortByPriority(
    allUpstreams.filter((u) => {
      const v = u.vendor || "anthropic";
      return v !== requestVendor && u.enabled !== false && getHealthState(u.id).healthy;
    })
  );

  if (crossVendorUpstreams.length > 0) {
    const fallbackUp = crossVendorUpstreams[0];
    const fallbackModel = fallbackUp.fallbackModel || "gpt-5.5";
    const stat = getUpstreamStat(fallbackUp.id);

    pushErrorLog({
      type: "cross_vendor_fallback",
      upstream: fallbackUp.name, upstreamId: fallbackUp.id,
      message: `All ${requestVendor} upstreams failed. Falling back to ${fallbackUp.vendor}/${fallbackModel}`,
      apiKeyName: reqCtx.apiKeyName || null,
      model: reqCtx.model || null, route: reqCtx.route || null,
    });

    // Convert request format if going from Anthropic → OpenAI
    let fallbackUrl = url;
    let fallbackOptions = { ...options };
    const originalBody = JSON.parse(options.body || "{}");

    if (requestVendor === "anthropic" && (fallbackUp.vendor === "openai")) {
      fallbackUrl = "/v1/chat/completions";
      const openaiBody = convertAnthropicRequestToOpenAI(originalBody, fallbackModel);
      fallbackOptions.body = JSON.stringify(openaiBody);
      fallbackOptions.headers = { ...fallbackOptions.headers, "content-type": "application/json" };
      delete fallbackOptions.headers["anthropic-version"];
    }

    const targetUrl = fallbackUp.baseUrl + fallbackUrl;
    const apiKey = (fallbackUp.apiKey || "").trim();
    const headers = {
      ...fallbackOptions.headers,
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
    };

    stat.requests++;
    stat.lastUsed = new Date().toISOString();

    try {
      await acquireUpstreamSlot();
      let res;
      try {
        res = await fetchWithTimeout(targetUrl, { ...fallbackOptions, headers }, timeoutMs);
      } finally {
        releaseUpstreamSlot();
      }

      if (res.ok) {
        stat.success++;
        // Mark response as fallback so client knows
        const originalRes = res;
        // If we need to convert response format (OpenAI → Anthropic)
        if (requestVendor === "anthropic" && fallbackUp.vendor === "openai") {
          const openaiData = await res.json();
          const anthropicData = convertOpenAIResponseToAnthropic(openaiData, reqCtx.model || "claude-opus-4-7");
          anthropicData._bridge_fallback = true;
          anthropicData._bridge_fallback_model = fallbackModel;
          anthropicData._bridge_fallback_vendor = fallbackUp.vendor;
          // Return a synthetic Response-like object
          return {
            ok: true,
            status: 200,
            headers: new Map([["x-bridge-fallback", "true"], ["x-bridge-fallback-model", fallbackModel]]),
            json: async () => anthropicData,
            text: async () => JSON.stringify(anthropicData),
            clone: () => ({ text: async () => JSON.stringify(anthropicData), json: async () => anthropicData }),
            body: null,
            _isFallback: true,
          };
        }
        return res;
      }
      stat.errors++;
    } catch (err) {
      releaseUpstreamSlot();
      stat.errors++;
    }
  }

  throw new Error("All upstreams failed (including cross-vendor fallback)");
};

// ============================================================
// 12. AUTH MIDDLEWARE
// ============================================================
const checkAuth = (req, res, next) => {
  if (!config.dashboardPassword) {
    return res.status(503).json({ error: { message: "Bridge not configured — set a password in the dashboard", type: "not_configured" } });
  }
  const auth = req.headers["authorization"] || "";
  const key = (auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-api-key"] || "").trim();

  // Aceita a senha do dashboard (chave "master") OU qualquer API key habilitada.
  if (key === config.dashboardPassword.trim()) {
    req.apiKeyObj = null;
    req.apiKeyName = "master";
    return next();
  }
  const keyObj = findApiKey(key);
  if (keyObj) {
    req.apiKeyObj = keyObj;
    req.apiKeyName = keyObj.name;
    return next();
  }
  console.warn('[auth] 401 — key mismatch (len recv=' + key.length + ')');
  return res.status(401).json({ error: { message: "Invalid API key", type: "invalid_request_error" } });
};

const checkDashboardAuth = (req, res, next) => {
  const token = req.headers["x-dashboard-token"] || req.headers["authorization"]?.replace("Bearer ", "") || "";
  if (!config.dashboardPassword || token !== config.dashboardPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const instrument = (route) => (req, res, next) => {
  metrics.totalRequests++;
  if (!metrics.byRoute[route]) metrics.byRoute[route] = { requests: 0, success: 0, errors: 0, totalMs: 0 };
  metrics.byRoute[route].requests++;
  const start = Date.now();
  res.on("finish", () => {
    const dur = Date.now() - start;
    metrics.byRoute[route].totalMs = (metrics.byRoute[route].totalMs || 0) + dur;
    if (res.statusCode < 400) {
      metrics.totalSuccess++;
      metrics.byRoute[route].success++;
    } else {
      metrics.totalErrors++;
      metrics.byRoute[route].errors++;
    }
    pushRecent({ route, method: req.method, status: res.statusCode, durationMs: dur });
  });
  next();
};

// ============================================================
// 13. CONVERSION HELPERS
// ============================================================
const convertOpenAIContentToAnthropic = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (c.type === "text") return { type: "text", text: c.text };
      if (c.type === "image_url") {
        const url = c.image_url?.url || "";
        if (url.startsWith("data:")) {
          const [meta, data] = url.split(",");
          const mediaType = meta.replace("data:", "").replace(";base64", "");
          return { type: "image", source: { type: "base64", media_type: mediaType, data } };
        }
        return { type: "image", source: { type: "url", url } };
      }
      return c;
    });
  }
  return content;
};

const convertMessages = (messages) => {
  const result = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    result.push({ role: m.role, content: convertOpenAIContentToAnthropic(m.content) });
  }
  return result;
};

const convertTools = (tools) => {
  if (!tools) return undefined;
  return tools.map((t) => {
    if (t.type === "function") {
      return {
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} },
      };
    }
    return t;
  });
};

const convertOpenAIToAnthropic = (body) => {
  const messages = body.messages || [];
  const systemMsg = messages.find((m) => m.role === "system");
  const system = systemMsg
    ? typeof systemMsg.content === "string"
      ? systemMsg.content
      : flattenMessageText([systemMsg])
    : undefined;
  const converted = {
    model: body.model || config.defaultModel,
    max_tokens: body.max_tokens || 4096,
    messages: convertMessages(messages),
  };
  if (system) converted.system = system;
  if (body.temperature !== undefined) converted.temperature = body.temperature;
  if (body.top_p !== undefined) converted.top_p = body.top_p;
  if (body.stop) converted.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.tools) converted.tools = convertTools(body.tools);
  if (body.stream) converted.stream = body.stream;
  return converted;
};

const convertAnthropicToOpenAI = (data, model) => {
  const content = data.content || [];
  const textBlock = content.find((c) => c.type === "text");
  const toolBlock = content.find((c) => c.type === "tool_use");
  const message = { role: "assistant", content: textBlock ? textBlock.text : null };
  if (toolBlock) {
    message.tool_calls = [{
      id: toolBlock.id || genId(),
      type: "function",
      function: { name: toolBlock.name, arguments: JSON.stringify(toolBlock.input || {}) },
    }];
  }
  return {
    id: data.id || genId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || data.model || config.defaultModel,
    choices: [{ index: 0, message, finish_reason: data.stop_reason || "stop" }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
};

const sendOpenAIStream = async (upstreamRes, res, model) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { res.write("data: [DONE]\n\n"); continue; }
        try {
          const evt = JSON.parse(data);
          const chunk = { id: evt.message?.id || genId(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [] };
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            chunk.choices = [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }];
          } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
            chunk.choices = [{ index: 0, delta: {}, finish_reason: evt.delta.stop_reason }];
          } else { continue; }
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        } catch { /* skip */ }
      }
    }
  } finally { reader.releaseLock(); res.end(); }
};

const sendAnthropicStreamFromMessage = async (data, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (evt, payload) => res.write(`event: ${evt}\ndata: ${JSON.stringify(payload)}\n\n`);
  send("message_start", { type: "message_start", message: { id: data.id, type: "message", role: "assistant", content: [], model: data.model, usage: data.usage } });
  const content = data.content || [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    send("content_block_start", { type: "content_block_start", index: i, content_block: block.type === "text" ? { type: "text", text: "" } : block });
    if (block.type === "text") {
      const chunkSize = 20;
      for (let j = 0; j < block.text.length; j += chunkSize) {
        send("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text.slice(j, j + chunkSize) } });
      }
    }
    send("content_block_stop", { type: "content_block_stop", index: i });
  }
  send("message_delta", { type: "message_delta", delta: { stop_reason: data.stop_reason || "end_turn", stop_sequence: null }, usage: { output_tokens: data.usage?.output_tokens || 0 } });
  send("message_stop", { type: "message_stop" });
  res.end();
};

const copyAnthropicHeaders = (upstreamRes, res) => {
  const headers = ["anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining", "request-id", "x-request-id"];
  for (const h of headers) { const v = upstreamRes.headers.get(h); if (v) res.setHeader(h, v); }
};

const sendUpstreamResponse = async (upstreamRes, res) => {
  const contentType = upstreamRes.headers.get("content-type") || "text/event-stream";
  res.setHeader("Content-Type", contentType);
  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally { reader.releaseLock(); res.end(); }
};

// ============================================================
// 14. ROUTES
// ============================================================

// GET /health
app.get("/health", (req, res) => res.json({ ok: true }));

// Static files
app.use(express.static(path.join(__dirname, "public")));

// POST /admin/login
app.post("/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!config.dashboardPassword || password !== config.dashboardPassword) {
    return res.status(401).json({ error: "Invalid password" });
  }
  res.json({ token: config.dashboardPassword });
});

// GET /admin/setup-status (no auth)
app.get("/admin/setup-status", (req, res) => {
  res.json({
    configured: isConfigured(),
    upstreamCount: config.upstreams.length,
    hasDashboardPassword: !!config.dashboardPassword,
  });
});

// POST /admin/setup (no auth when not configured)
app.post("/admin/setup", (req, res) => {
  if (isConfigured()) {
    const token = req.headers["x-dashboard-token"] || req.headers["authorization"]?.replace("Bearer ", "") || "";
    if (token !== config.dashboardPassword) {
      return res.status(401).json({ error: "Already configured. Provide dashboard auth." });
    }
  }
  const { dashboardPassword, upstreams } = req.body || {};
  if (dashboardPassword) config.dashboardPassword = String(dashboardPassword).trim();
  if (Array.isArray(upstreams)) {
    config.upstreams = upstreams.map((u) => ({
      id: u.id || genId(),
      name: String(u.name || "upstream").trim(),
      baseUrl: String(u.baseUrl || "").replace(/\/$/, "").trim(),
      apiKey: String(u.apiKey || "").trim(),
      enabled: u.enabled !== false,
      priority: Number(u.priority) || 10,
      vendor: u.vendor || "anthropic",
      fallbackModel: u.fallbackModel || null,
    }));
  }
  saveConfig(config);
  res.json({ ok: true });
});

// GET /admin/config (dashboard auth)
app.get("/admin/config", checkDashboardAuth, (req, res) => {
  const masked = {
    ...config,
    dashboardPassword: maskKey(config.dashboardPassword),
    upstreams: config.upstreams.map((u) => ({ ...u, apiKey: maskKey(u.apiKey) })),
    apiKeys: (config.apiKeys || []).map((a) => ({ ...a, key: maskKey(a.key) })),
  };
  res.json(masked);
});

// POST /admin/config (dashboard auth)
app.post("/admin/config", checkDashboardAuth, (req, res) => {
  const body = req.body || {};
  if (body.upstreams !== undefined) {
    config.upstreams = body.upstreams.map((u) => {
      const existing = config.upstreams.find((e) => e.id === u.id);
      const apiKey = u.apiKey && u.apiKey.includes("...") && existing
        ? existing.apiKey
        : String(u.apiKey || (existing ? existing.apiKey : "")).trim();
      return {
        id: u.id || genId(),
        name: String(u.name || "upstream").trim(),
        baseUrl: String(u.baseUrl || "").replace(/\/$/, "").trim(),
        apiKey,
        enabled: u.enabled !== false,
        priority: Number(u.priority) || (existing?.priority || 10),
        vendor: u.vendor || (existing?.vendor || "anthropic"),
        fallbackModel: u.fallbackModel || (existing?.fallbackModel || null),
      };
    });
    delete body.upstreams;
  }
  if (body.dashboardPassword && body.dashboardPassword.includes("...")) delete body.dashboardPassword;
  if (body.dashboardPassword) body.dashboardPassword = String(body.dashboardPassword).trim();
  config = deepMerge(config, body);
  saveConfig(config);
  res.json({ ok: true });
});

// GET /admin/status (dashboard auth)
app.get("/admin/status", checkDashboardAuth, (req, res) => {
  const now = Date.now();
  const activeUpstream = (getEnabledUpstreams()[0] || {}).name || "—";
  const gr = config.guardrails || {};

  // Health state per upstream
  const upstreamHealth = getEnabledUpstreams().map((u) => {
    const hs = getHealthState(u.id);
    const st = getUpstreamStat(u.id);
    return {
      id: u.id, name: u.name, priority: u.priority || 10, vendor: u.vendor || "anthropic",
      healthy: hs.healthy, lastCheckAt: hs.lastCheckAt, lastCheckMs: hs.lastCheckMs,
      consecutiveFailures: hs.consecutiveFailures,
      requests: st.requests, success: st.success, errors: st.errors, lastUsed: st.lastUsed,
    };
  });

  // by_route no formato que o frontend espera (count/ok/err/avgMs)
  const byRoute = {};
  for (const [route, r] of Object.entries(metrics.byRoute || {})) {
    byRoute[route] = {
      count: r.requests || 0,
      ok: r.success || 0,
      err: r.errors || 0,
      avgMs: r.totalMs && r.requests ? Math.round(r.totalMs / r.requests) : 0,
    };
  }

  res.json({
    configured: isConfigured(),
    uptime_ms: now - new Date(STARTED_AT).getTime(),
    state: {
      active_upstream: activeUpstream,
      consecutive_failures: bridgeState.consecutiveFailures,
      circuit_open: bridgeState.circuitUntil > now,
      circuit_remaining_ms: Math.max(0, bridgeState.circuitUntil - now),
    },
    metrics: {
      total_requests: metrics.totalRequests,
      total_success: metrics.totalSuccess,
      total_errors: metrics.totalErrors,
      upstream_retries: metrics.upstreamRetries,
      circuit_opened_count: metrics.circuitOpenedCount,
      by_route: byRoute,
    },
    recent: (metrics.recent || []).map((e) => ({
      at: e.ts,
      method: e.method || "POST",
      route: e.route,
      status: e.status,
      ms: e.durationMs,
      ok: e.status < 400,
      blocked: e.blocked || null,
      error_id: e.errorId || null,
    })),
    error_log: errorLog.slice(-50).reverse().map((e) => ({
      id: e.id,
      at: e.ts,
      route: e.route || null,
      type: e.type,
      status: e.status || null,
      message: e.message || "",
      retries_taken: e.attempt || 0,
      duration_ms: e.durationMs || null,
      request_id: e.upstreamRequestId || null,
      api_key: e.apiKeyName || null,
      model: e.model || null,
      upstream: e.upstream || null,
      body_snippet: e.body_snippet || e.message || "",
    })),
    guardrails: {
      pii: { enabled: gr.pii?.enabled !== false, blocked: grState.pii.blocked || 0, last_block_at: grState.pii.lastBlockAt },
      max_tokens: { enabled: gr.maxTokens?.enabled !== false, blocked: grState.maxTokens.blocked || 0, limit: gr.maxTokens?.limit || 8192, last_block_at: grState.maxTokens.lastBlockAt },
      budget: { enabled: gr.budget?.enabled !== false, blocked: grState.budget.blocked || 0, last_block_at: grState.budget.lastBlockAt, today_spent_usd: grState.budget.usedUsd || 0, daily_usd: gr.budget?.dailyUsd || 10, total_spent_usd: grState.budget.totalUsd || 0, history: grState.budget.history || [] },
      model_swap: { enabled: gr.modelSwap?.enabled !== false, detected: grState.modelSwap.detected || 0, swaps: grState.modelSwap.swaps || [] },
    },
    apiKeys: (config.apiKeys || []).map((a) => ({
      id: a.id, name: a.name, key: maskKey(a.key), enabled: a.enabled !== false,
      createdAt: a.createdAt, lastUsed: a.lastUsed || null, requests: a.requests || 0, errors: a.errors || 0,
    })),
    config: {
      defaultModel: config.defaultModel,
      upstream_base_url: (getEnabledUpstreams()[0] || {}).baseUrl || "—",
      default_model: config.defaultModel,
      upstream_max_concurrency: config.concurrency?.maxConcurrency,
      upstream_min_interval_ms: config.concurrency?.minIntervalMs,
      upstream_timeout_ms: config.concurrency?.timeoutMs,
      upstream_infinite_retry: config.retry?.infinite !== false,
      upstream_retry_max_delay_ms: config.retry?.maxDelayMs,
      upstream_retry_attempts: config.retry?.attempts,
      openclaw_force_non_stream_retry: config.openclawForceNonStreamRetry === true,
    },
    versions: { node: process.version, bridge: "2.0.0-smart-routing" },
    upstream_health: upstreamHealth,
  });
});

// POST /admin/reset (dashboard auth)
app.post("/admin/reset", checkDashboardAuth, (req, res) => {
  metrics.totalRequests = 0;
  metrics.totalSuccess = 0;
  metrics.totalErrors = 0;
  metrics.upstreamRetries = 0;
  metrics.circuitOpenedCount = 0;
  metrics.lastCircuitOpenAt = null;
  metrics.guardrailBlocks = 0;
  metrics.byRoute = {};
  metrics.recent = [];
  errorLog.length = 0;
  res.json({ ok: true });
});

// POST /admin/guardrails (dashboard auth)
app.post("/admin/guardrails", checkDashboardAuth, (req, res) => {
  const body = req.body || {};
  // O frontend envia snake_case (max_tokens, model_swap) mas o config usa
  // camelCase (maxTokens, modelSwap). Normaliza antes do merge para não
  // criar chaves fantasma que ninguém lê.
  const normalized = {};
  if (body.pii !== undefined) normalized.pii = body.pii;
  if (body.budget !== undefined) {
    normalized.budget = { ...body.budget };
    if (body.budget.daily_usd !== undefined) normalized.budget.dailyUsd = body.budget.daily_usd;
  }
  if (body.max_tokens !== undefined || body.maxTokens !== undefined) {
    const mt = body.max_tokens || body.maxTokens;
    normalized.maxTokens = { ...mt };
  }
  if (body.model_swap !== undefined || body.modelSwap !== undefined) {
    normalized.modelSwap = body.model_swap || body.modelSwap;
  }
  config.guardrails = deepMerge(config.guardrails, normalized);
  saveConfig(config);
  res.json({ ok: true });
});

// POST /admin/budget/reset (dashboard auth)
app.post("/admin/budget/reset", checkDashboardAuth, (req, res) => {
  grState.budget.usedUsd = 0;
  grState.budget.day = dayKey();
  res.json({ ok: true });
});

// POST /admin/swaps/clear (dashboard auth)
app.post("/admin/swaps/clear", checkDashboardAuth, (req, res) => {
  grState.modelSwap = {};
  res.json({ ok: true });
});

// GET /admin/errors (dashboard auth)
app.get("/admin/errors", checkDashboardAuth, (req, res) => {
  res.json(errorLog);
});

// DELETE /admin/errors (dashboard auth)
app.delete("/admin/errors", checkDashboardAuth, (req, res) => {
  errorLog.length = 0;
  res.json({ ok: true });
});

// GET /admin/keys (dashboard auth) — lista chaves com stats, valor mascarado
app.get("/admin/keys", checkDashboardAuth, (req, res) => {
  res.json((config.apiKeys || []).map((a) => ({
    id: a.id,
    name: a.name,
    key: maskKey(a.key),
    enabled: a.enabled !== false,
    createdAt: a.createdAt,
    lastUsed: a.lastUsed || null,
    requests: a.requests || 0,
    errors: a.errors || 0,
  })));
});

// POST /admin/keys (dashboard auth) — cria nova chave, retorna valor COMPLETO uma vez
app.post("/admin/keys", checkDashboardAuth, (req, res) => {
  const name = String((req.body && req.body.name) || "").trim() || "Sem nome";
  const newKey = {
    id: genId(),
    name,
    key: genApiKey(),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastUsed: null,
    requests: 0,
    errors: 0,
  };
  if (!Array.isArray(config.apiKeys)) config.apiKeys = [];
  config.apiKeys.push(newKey);
  saveConfig(config);
  // Retorna o valor completo só nesta resposta — depois fica mascarado.
  res.json({ ok: true, id: newKey.id, name: newKey.name, key: newKey.key });
});

// PATCH /admin/keys/:id (dashboard auth) — habilita/desabilita ou renomeia
app.patch("/admin/keys/:id", checkDashboardAuth, (req, res) => {
  const k = (config.apiKeys || []).find((a) => a.id === req.params.id);
  if (!k) return res.status(404).json({ error: "Key not found" });
  if (req.body.enabled !== undefined) k.enabled = !!req.body.enabled;
  if (req.body.name !== undefined) k.name = String(req.body.name).trim() || k.name;
  saveConfig(config);
  res.json({ ok: true });
});

// DELETE /admin/keys/:id (dashboard auth) — revoga (remove) a chave
app.delete("/admin/keys/:id", checkDashboardAuth, (req, res) => {
  const before = (config.apiKeys || []).length;
  config.apiKeys = (config.apiKeys || []).filter((a) => a.id !== req.params.id);
  if (config.apiKeys.length === before) return res.status(404).json({ error: "Key not found" });
  saveConfig(config);
  res.json({ ok: true });
});

// GET /v1/models (proxy auth)
app.get("/v1/models", instrument("/v1/models"), checkAuth, async (req, res) => {
  const upstreams = getEnabledUpstreams();
  if (!upstreams.length) return res.status(503).json({ error: { message: "No upstreams available" } });
  try {
    const upstream = upstreams[0];
    const response = await fetchWithTimeout(
      `${upstream.baseUrl}/v1/models`,
      { headers: { "x-api-key": upstream.apiKey, Authorization: `Bearer ${upstream.apiKey}` } },
      config.concurrency.timeoutMs || 180000
    );
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: { message: err.message } });
  }
});

// POST /v1/chat/completions (proxy auth)
app.post("/v1/chat/completions", instrument("/v1/chat/completions"), checkAuth, async (req, res) => {
  const guard = preflightGuardrails(req.body, "/v1/chat/completions");
  if (guard.blocked) {
    return res.status(guard.status).json({ error: { message: guard.reason, type: "guardrail_block" } });
  }

  const upstreams = getEnabledUpstreams();
  if (!upstreams.length) return res.status(503).json({ error: { message: "No upstreams available" } });

  const anthropicBody = convertOpenAIToAnthropic(req.body);
  const isStream = req.body.stream === true;
  const reqModel = req.body.model || config.defaultModel;

  try {
    const upstreamRes = await fetchUpstream(
      "/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify(anthropicBody),
      },
      { upstreams, route: "/v1/chat/completions", method: "POST", apiKeyName: req.apiKeyName, model: reqModel, userId: req.headers["x-user-id"] || req.apiKeyName, requestVendor: "anthropic" }
    );

    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text().catch(() => "");
      touchApiKey(req.apiKeyObj, true);
      return res.status(upstreamRes.status).json({ error: { message: errBody } });
    }
    touchApiKey(req.apiKeyObj, false);

    if (isStream) {
      await sendOpenAIStream(upstreamRes, res, reqModel);
    } else {
      const data = await upstreamRes.json();
      recordUsage(data.usage);
      detectModelSwap(reqModel, data.model, "/v1/chat/completions");
      res.json(convertAnthropicToOpenAI(data, reqModel));
    }
  } catch (err) {
    touchApiKey(req.apiKeyObj, true);
    res.status(502).json({ error: { message: err.message } });
  }
});

// POST /v1/messages (proxy auth)
app.post("/v1/messages", instrument("/v1/messages"), checkAuth, async (req, res) => {
  const guard = preflightGuardrails(req.body, "/v1/messages");
  if (guard.blocked) {
    return res.status(guard.status).json({ error: { message: guard.reason, type: "guardrail_block" } });
  }
  const upstreams = getEnabledUpstreams();
  if (!upstreams.length) return res.status(503).json({ error: { message: "No upstreams available" } });
  const isStream = req.body.stream === true;
  const forceNonStream = config.openclawForceNonStreamRetry === true && isStream;
  const body = forceNonStream ? { ...req.body, stream: false } : req.body;
  const reqModel = req.body.model || config.defaultModel;
  try {
    const upstreamRes = await fetchUpstream(
      "/v1/messages",
      { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) },
      { upstreams, route: "/v1/messages", method: "POST", apiKeyName: req.apiKeyName, model: reqModel, userId: req.headers["x-user-id"] || req.body.metadata?.user_id || req.apiKeyName, requestVendor: "anthropic" }
    );
    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text().catch(() => "");
      touchApiKey(req.apiKeyObj, true);
      return res.status(upstreamRes.status).json({ error: { message: errBody } });
    }
    touchApiKey(req.apiKeyObj, false);
    // Cross-vendor fallback headers
    if (upstreamRes._isFallback) {
      res.setHeader("x-bridge-fallback", "true");
      res.setHeader("x-bridge-fallback-model", upstreamRes.headers?.get?.("x-bridge-fallback-model") || "unknown");
    }
    if (isStream && !forceNonStream) {
      copyAnthropicHeaders(upstreamRes, res);
      await sendUpstreamResponse(upstreamRes, res);
    } else if (forceNonStream && isStream) {
      const data = await upstreamRes.json();
      recordUsage(data.usage);
      detectModelSwap(reqModel, data.model, "/v1/messages");
      await sendAnthropicStreamFromMessage(data, res);
    } else {
      const data = await upstreamRes.json();
      recordUsage(data.usage);
      detectModelSwap(reqModel, data.model, "/v1/messages");
      copyAnthropicHeaders(upstreamRes, res);
      res.json(data);
    }
  } catch (err) {
    touchApiKey(req.apiKeyObj, true);
    res.status(502).json({ error: { message: err.message } });
  }
});

// ============================================================
// 15. START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`Claude Bridge v2.0.0-smart-routing listening on port ${PORT}`);
  console.log(`Config path: ${CONFIG_PATH}`);
  console.log(`Configured: ${isConfigured()}`);
  console.log(`Upstreams: ${getEnabledUpstreams().length} enabled`);
  startHealthCheckLoop();
});
