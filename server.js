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
const envInt = (key, def) => {
  const v = process.env[key];
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
};

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
// 3. CONFIG PERSISTENCE
// ============================================================
const CONFIG_PATH = (() => {
  try {
    fs.accessSync("/app/config.json", fs.constants.W_OK);
    return "/app/config.json";
  } catch {
    return path.join(__dirname, "config.json");
  }
})();

const DEFAULT_CONFIG = {
  dashboardPassword: "admin",
  proxyApiKey: "",
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
    // fallback: legacy env vars
    const cfg = deepMerge({}, DEFAULT_CONFIG);
    if (process.env.PROXY_API_KEY) cfg.proxyApiKey = process.env.PROXY_API_KEY;
    if (process.env.DASHBOARD_PASSWORD) cfg.dashboardPassword = process.env.DASHBOARD_PASSWORD;
    if (process.env.UPSTREAM_URL) {
      cfg.upstreams = [{
        id: genId(),
        name: "default",
        baseUrl: process.env.UPSTREAM_URL.replace(/\/$/, ""),
        apiKey: process.env.UPSTREAM_API_KEY || "",
        enabled: true,
      }];
    }
    return cfg;
  }
};

const saveConfig = (cfg) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
};

let config = loadConfig();

const isConfigured = () =>
  config.upstreams.length > 0 && !!config.proxyApiKey && !!config.dashboardPassword;

const getEnabledUpstreams = () =>
  (config.upstreams || []).filter((u) => u.enabled !== false);

// ============================================================
// 4. EXPRESS APP, PORT, DNS, STARTED_AT
// ============================================================
const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT = envInt("PORT", 8787);

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
// 7. GUARDRAILS RUNTIME STATE
// ============================================================
const grState = {
  pii: {},
  maxTokens: {},
  budget: { day: dayKey(), usedUsd: 0 },
  modelSwap: {},
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
      metrics.guardrailBlocks++;
      return { blocked: true, reason: "max_tokens_exceeded", status: 400 };
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
// 11. FETCH UPSTREAM
// ============================================================
const fetchUpstream = async (url, options, reqCtx) => {
  const upstreams = reqCtx.upstreams || [];
  if (!upstreams.length) throw new Error("No upstreams configured");

  const retryCfg = config.retry;
  const circuitCfg = config.circuit;
  const timeoutMs = config.concurrency.timeoutMs || 180000;
  const infinite = retryCfg.infinite !== false;
  const maxAttempts = infinite ? Infinity : (retryCfg.attempts || 5);

  let attempt = 0;
  let upstreamIdx = 0;

  while (attempt < maxAttempts) {
    const upstream = upstreams[upstreamIdx % upstreams.length];
    const stat = getUpstreamStat(upstream.id);

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

      if (res.ok || isDefinitiveStatus(res.status)) {
        if (res.ok) {
          stat.success++;
          bridgeState.consecutiveFailures = 0;
        } else {
          const bodyText = await res.clone().text().catch(() => "");
          if (isDefinitiveText(bodyText)) {
            stat.errors++;
            pushErrorLog({
              type: "upstream_error",
              upstream: upstream.name,
              upstreamId: upstream.id,
              status: res.status,
              message: bodyText.slice(0, 300),
            });
            return res;
          }
        }
        return res;
      }

      // Retryable HTTP status
      const bodyText = await res.clone().text().catch(() => "");
      stat.errors++;
      stat.lastError = `HTTP ${res.status}`;
      stat.lastErrorTs = new Date().toISOString();
      bridgeState.consecutiveFailures++;

      pushErrorLog({
        type: "upstream_error",
        upstream: upstream.name,
        upstreamId: upstream.id,
        status: res.status,
        message: bodyText.slice(0, 300),
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

      const isTimeout = err.name === "AbortError";
      pushErrorLog({
        type: isTimeout ? "timeout" : "network_error",
        upstream: upstream.name,
        upstreamId: upstream.id,
        message: err.message,
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

  throw new Error("Max retry attempts reached");
};

// ============================================================
// 12. AUTH MIDDLEWARE
// ============================================================
const checkAuth = (req, res, next) => {
  if (!config.proxyApiKey) {
    return res.status(503).json({ error: { message: "Bridge not configured", type: "not_configured" } });
  }
  const auth = req.headers["authorization"] || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-api-key"] || "";
  if (key !== config.proxyApiKey) {
    return res.status(401).json({ error: { message: "Invalid API key", type: "invalid_request_error" } });
  }
  next();
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
  if (!metrics.byRoute[route]) metrics.byRoute[route] = { requests: 0, success: 0, errors: 0 };
  metrics.byRoute[route].requests++;
  const start = Date.now();
  res.on("finish", () => {
    const dur = Date.now() - start;
    if (res.statusCode < 400) {
      metrics.totalSuccess++;
      metrics.byRoute[route].success++;
    } else {
      metrics.totalErrors++;
      metrics.byRoute[route].errors++;
    }
    pushRecent({ route, status: res.statusCode, durationMs: dur });
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
    hasProxyKey: !!config.proxyApiKey,
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
  const { dashboardPassword, proxyApiKey, upstreams } = req.body || {};
  if (dashboardPassword) config.dashboardPassword = String(dashboardPassword).trim();
  if (proxyApiKey) config.proxyApiKey = String(proxyApiKey).trim();
  if (Array.isArray(upstreams)) {
    config.upstreams = upstreams.map((u) => ({
      id: u.id || genId(),
      name: String(u.name || "upstream").trim(),
      baseUrl: String(u.baseUrl || "").replace(/\/$/, "").trim(),
      apiKey: String(u.apiKey || "").trim(),
      enabled: u.enabled !== false,
    }));
  }
  saveConfig(config);
  res.json({ ok: true });
});

// GET /admin/config (dashboard auth)
app.get("/admin/config", checkDashboardAuth, (req, res) => {
  const masked = {
    ...config,
    proxyApiKey: maskKey(config.proxyApiKey),
    dashboardPassword: maskKey(config.dashboardPassword),
    upstreams: config.upstreams.map((u) => ({ ...u, apiKey: maskKey(u.apiKey) })),
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
      };
    });
    delete body.upstreams;
  }
  if (body.proxyApiKey && body.proxyApiKey.includes("...")) delete body.proxyApiKey;
  if (body.dashboardPassword && body.dashboardPassword.includes("...")) delete body.dashboardPassword;
  if (body.proxyApiKey) body.proxyApiKey = String(body.proxyApiKey).trim();
  if (body.dashboardPassword) body.dashboardPassword = String(body.dashboardPassword).trim();
  config = deepMerge(config, body);
  saveConfig(config);
  res.json({ ok: true });
});

// GET /admin/status (dashboard auth)
app.get("/admin/status", checkDashboardAuth, (req, res) => {
  res.json({
    configured: isConfigured(),
    startedAt: STARTED_AT,
    uptime: Math.floor((Date.now() - new Date(STARTED_AT).getTime()) / 1000),
    upstreams: config.upstreams.map((u) => ({
      ...u,
      apiKey: maskKey(u.apiKey),
      stats: getUpstreamStat(u.id),
    })),
    guardrails: {
      budget: { ...grState.budget },
    },
    error_log: errorLog.slice(-50),
    metrics,
    config: {
      ...config,
      proxyApiKey: maskKey(config.proxyApiKey),
      dashboardPassword: maskKey(config.dashboardPassword),
      upstreams: config.upstreams.map((u) => ({ ...u, apiKey: maskKey(u.apiKey) })),
    },
    versions: {
      node: process.version,
      bridge: "1.4.0-config-ui",
    },
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
  config.guardrails = deepMerge(config.guardrails, req.body || {});
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

  try {
    const upstreamRes = await fetchUpstream(
      "/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify(anthropicBody),
      },
      { upstreams, route: "/v1/chat/completions", method: "POST" }
    );

    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text().catch(() => "");
      return res.status(upstreamRes.status).json({ error: { message: errBody } });
    }

    if (isStream) {
      await sendOpenAIStream(upstreamRes, res, req.body.model || config.defaultModel);
    } else {
      const data = await upstreamRes.json();
      recordUsage(data.usage);
      res.json(convertAnthropicToOpenAI(data, req.body.model || config.defaultModel));
    }
  } catch (err) {
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
  try {
    const upstreamRes = await fetchUpstream(
      "/v1/messages",
      { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) },
      { upstreams, route: "/v1/messages", method: "POST" }
    );
    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text().catch(() => "");
      return res.status(upstreamRes.status).json({ error: { message: errBody } });
    }
    if (isStream && !forceNonStream) {
      copyAnthropicHeaders(upstreamRes, res);
      await sendUpstreamResponse(upstreamRes, res);
    } else if (forceNonStream && isStream) {
      const data = await upstreamRes.json();
      recordUsage(data.usage);
      await sendAnthropicStreamFromMessage(data, res);
    } else {
      const data = await upstreamRes.json();
      recordUsage(data.usage);
      copyAnthropicHeaders(upstreamRes, res);
      res.json(data);
    }
  } catch (err) {
    res.status(502).json({ error: { message: err.message } });
  }
});

// ============================================================
// 15. START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`Claude Bridge v1.4.0-config-ui listening on port ${PORT}`);
  console.log(`Config path: ${CONFIG_PATH}`);
  console.log(`Configured: ${isConfigured()}`);
});
