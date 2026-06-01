import express from "express";
import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   HELPERS (declared first so env constants can use them)
   ========================================================= */
function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return fallback;
  return ["1","true","yes","on"].includes(String(v).toLowerCase());
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function round4(n){ return Math.round(n * 10000) / 10000; }
function dayKey(d = new Date()){ return d.toISOString().slice(0, 10); }

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 8787;
const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL || "https://api.nuoda.vip").replace(/\/$/, "");
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-7";
const PROXY_API_KEY = process.env.PROXY_API_KEY;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || PROXY_API_KEY;
const UPSTREAM_INFINITE_RETRY = envBool("UPSTREAM_INFINITE_RETRY", true);

try { dns.setDefaultResultOrder("ipv4first"); } catch (_) {}

const STARTED_AT = Date.now();

/* =========================================================
   ERROR LOG — last 200 entries
   ========================================================= */
let errorLogIdSeq = 0;
const errorLog = [];

function pushErrorLog({ route, method, status, type, message, body_snippet, retries_taken, upstream_url, duration_ms }) {
  const entry = {
    id: ++errorLogIdSeq,
    at: new Date().toISOString(),
    route: route || "",
    method: method || "",
    status: status || 0,
    type: type || "bridge_error",
    message: String(message || ""),
    body_snippet: body_snippet ? String(body_snippet).slice(0, 500) : "",
    retries_taken: retries_taken || 0,
    upstream_url: upstream_url || "",
    duration_ms: duration_ms || 0
  };
  errorLog.unshift(entry);
  if (errorLog.length > 200) errorLog.length = 200;
  return entry.id;
}

const bridgeState = {
  active: 0,
  lastStart: 0,
  consecutiveFailures: 0,
  circuitUntil: 0
};

/* =========================================================
   GUARDRAILS — config padrão (override por env, mutável em runtime via /admin)
   ========================================================= */
const guardrails = {
  pii: {
    enabled: envBool("GR_PII_ENABLED", true),
    blocked: 0,
    lastBlockAt: null,
    patterns: [
      { name: "cpf",   re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g },
      { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
      { name: "card",  re: /\b(?:\d[ -]*?){13,19}\b/g },
      { name: "phone", re: /\(?\d{2}\)?\s?9?\d{4}-?\d{4}\b/g }
    ]
  },
  maxTokens: {
    enabled: envBool("GR_MAX_TOKENS_ENABLED", true),
    limit: envInt("GR_MAX_TOKENS_LIMIT", 8192),
    blocked: 0,
    lastBlockAt: null
  },
  budget: {
    enabled: envBool("GR_BUDGET_ENABLED", true),
    dailyUsd: Number(process.env.GR_BUDGET_DAILY_USD || 10),
    pricing: {
      inputPerMillion:  Number(process.env.PRICING_INPUT_PER_MILLION  || 15),
      outputPerMillion: Number(process.env.PRICING_OUTPUT_PER_MILLION || 75)
    },
    todayKey: dayKey(),
    todaySpentUsd: 0,
    totalSpentUsd: 0,
    history: [], // [{day,spentUsd}]
    blocked: 0,
    lastBlockAt: null
  },
  modelSwap: {
    enabled: envBool("GR_MODEL_SWAP_ENABLED", true),
    detected: 0,
    swaps: []    // últimos 100 [{at,route,requested,returned}]
  }
};

function rotateBudgetIfNeeded() {
  const today = dayKey();
  if (today !== guardrails.budget.todayKey) {
    guardrails.budget.history.unshift({
      day: guardrails.budget.todayKey,
      spentUsd: round4(guardrails.budget.todaySpentUsd)
    });
    if (guardrails.budget.history.length > 30) guardrails.budget.history.length = 30;
    guardrails.budget.todayKey = today;
    guardrails.budget.todaySpentUsd = 0;
  }
}

function estimateUsd(usage) {
  const inT = usage?.input_tokens || usage?.prompt_tokens || 0;
  const outT = usage?.output_tokens || usage?.completion_tokens || 0;
  const p = guardrails.budget.pricing;
  return (inT * p.inputPerMillion + outT * p.outputPerMillion) / 1_000_000;
}

function flattenMessageText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.map((m) => {
    if (typeof m?.content === "string") return m.content;
    if (Array.isArray(m?.content)) {
      return m.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join(" ");
    }
    return "";
  }).join("\n");
}

function detectPII(text) {
  if (!guardrails.pii.enabled) return null;
  for (const { name, re } of guardrails.pii.patterns) {
    re.lastIndex = 0;
    if (re.test(text)) return name;
  }
  return null;
}

function preflightGuardrails(body) {
  // PII
  const text = flattenMessageText(body?.messages);
  const piiHit = detectPII(text);
  if (piiHit) {
    guardrails.pii.blocked++;
    guardrails.pii.lastBlockAt = new Date().toISOString();
    return { blocked: true, by: "pii", reason: `PII detectado: ${piiHit}` };
  }
  // max_tokens
  if (guardrails.maxTokens.enabled) {
    const mt = Number(body?.max_tokens || body?.max_completion_tokens || 0);
    if (mt > guardrails.maxTokens.limit) {
      guardrails.maxTokens.blocked++;
      guardrails.maxTokens.lastBlockAt = new Date().toISOString();
      return { blocked: true, by: "max_tokens", reason: `max_tokens ${mt} > limite ${guardrails.maxTokens.limit}` };
    }
  }
  // budget
  if (guardrails.budget.enabled) {
    rotateBudgetIfNeeded();
    if (guardrails.budget.todaySpentUsd >= guardrails.budget.dailyUsd) {
      guardrails.budget.blocked++;
      guardrails.budget.lastBlockAt = new Date().toISOString();
      return { blocked: true, by: "budget", reason: `Orçamento diário atingido: $${guardrails.budget.todaySpentUsd.toFixed(4)} / $${guardrails.budget.dailyUsd}` };
    }
  }
  return { blocked: false };
}

function recordUsage({ requestedModel, returnedModel, usage, route }) {
  // budget
  if (guardrails.budget.enabled && usage) {
    rotateBudgetIfNeeded();
    const cost = estimateUsd(usage);
    guardrails.budget.todaySpentUsd += cost;
    guardrails.budget.totalSpentUsd += cost;
  }
  // model swap
  if (guardrails.modelSwap.enabled && requestedModel && returnedModel) {
    if (String(returnedModel).trim() !== String(requestedModel).trim()) {
      guardrails.modelSwap.detected++;
      guardrails.modelSwap.swaps.unshift({
        at: new Date().toISOString(),
        route,
        requested: requestedModel,
        returned: returnedModel
      });
      if (guardrails.modelSwap.swaps.length > 100) guardrails.modelSwap.swaps.length = 100;
    }
  }
}

/* =========================================================
   MÉTRICAS
   ========================================================= */
const metrics = {
  totalRequests: 0,
  totalSuccess: 0,
  totalErrors: 0,
  upstreamRetries: 0,
  circuitOpenedCount: 0,
  lastCircuitOpenAt: null,
  guardrailBlocks: 0,
  byRoute: {
    "/v1/chat/completions": { ok: 0, err: 0, totalMs: 0, count: 0 },
    "/v1/messages":         { ok: 0, err: 0, totalMs: 0, count: 0 },
    "/v1/models":           { ok: 0, err: 0, totalMs: 0, count: 0 }
  },
  recent: []
};

function pushRecent(entry) {
  metrics.recent.unshift({ ...entry, at: new Date().toISOString() });
  if (metrics.recent.length > 80) metrics.recent.length = 80;
}

/* =========================================================
   RETRY / CIRCUIT HELPERS
   ========================================================= */
function isRetryableStatus(s){ return [408,409,425,429,500,502,503,504,529].includes(s); }
function isDefinitiveStatus(s){ return [400,401,403,404,422].includes(s); }
function normalizeText(t){
  return String(t||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase();
}
function isRetryableText(text){
  const n = normalizeText(text);
  return n && (
    n.includes("service_temporarily_unavailable") ||
    n.includes("temporariamente indisponivel") ||
    n.includes("servidor sobrecarregado") ||
    n.includes("aguarde alguns segundos") ||
    n.includes("envie novamente") ||
    n.includes("overloaded_error") || n.includes("server overloaded") || n.includes("overloaded") ||
    n.includes("too busy") || n.includes("capacity") ||
    n.includes("rate_limit_error") || n.includes("rate limit") ||
    n.includes("eai_again") || n.includes("etimedout") || n.includes("econnreset") ||
    // padrões nuoda / new-api (chinês)
    text.includes("没有可用token") || text.includes("渠道异常") ||
    text.includes("无可用渠道") || text.includes("当前分组") ||
    n.includes("no available channel") || n.includes("channel error")
  );
}
function isDefinitiveText(text){
  const n = normalizeText(text);
  return n && (
    n.includes("auth_required") || n.includes("invalid_api_key") || n.includes("invalid api key") ||
    n.includes("invalid model") || n.includes("context_length_exceeded") ||
    n.includes("permission_error") || n.includes("authentication_error") ||
    n.includes("insufficient_quota") || n.includes("quota") && n.includes("exceeded")
  );
}

async function acquireUpstreamSlot(){
  const max = envInt("UPSTREAM_MAX_CONCURRENCY",1);
  const minI = envInt("UPSTREAM_MIN_INTERVAL_MS",1500);
  while (max>0 && bridgeState.active>=max) await sleep(100);
  if (minI>0){
    const wait = Math.max(0, bridgeState.lastStart+minI-Date.now());
    if (wait>0) await sleep(wait);
  }
  bridgeState.active++;
  bridgeState.lastStart = Date.now();
}
function releaseUpstreamSlot(){ bridgeState.active = Math.max(0,bridgeState.active-1); }

async function fetchWithTimeout(url, options, timeoutMs){
  if (!timeoutMs) return fetch(url, options);
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: c.signal }); }
  finally { clearTimeout(t); }
}

async function fetchUpstream(url, options = {}, _reqCtx = {}){
  const circuitFailures = envInt("UPSTREAM_CIRCUIT_FAILURES",3);
  const circuitCooldownMs = envInt("UPSTREAM_CIRCUIT_COOLDOWN_MS",60000);
  const inspectOkText = options.bridgeInspectOkText !== false;
  const fetchOptions = { ...options };
  delete fetchOptions.bridgeInspectOkText;

  if (circuitFailures>0 && Date.now()<bridgeState.circuitUntil){
    const wait = bridgeState.circuitUntil - Date.now();
    console.warn("[bridge-circuit] open, waiting", wait, "ms");
    await sleep(wait);
  }
  await acquireUpstreamSlot();

  const baseDelay = envInt("UPSTREAM_RETRY_BASE_DELAY_MS",1000);
  const maxDelay  = envInt("UPSTREAM_RETRY_MAX_DELAY_MS",20000);
  const jitter    = envInt("UPSTREAM_RETRY_JITTER_MS",750);
  const timeoutMs = envInt("UPSTREAM_TIMEOUT_MS",180000);
  const infinite  = UPSTREAM_INFINITE_RETRY;
  const maxAttempts = infinite ? Infinity : Math.max(1, envInt("UPSTREAM_RETRY_ATTEMPTS",5));

  let lastError;
  let attempt = 0;

  try {
    while (true) {
      attempt++;
      if (!infinite && attempt > maxAttempts) break;
      try {
        const upstream = await fetchWithTimeout(url, fetchOptions, timeoutMs);
        const ct = upstream.headers.get("content-type") || "";
        const isStream = ct.includes("text/event-stream");
        const inspect = !isStream && (!upstream.ok || inspectOkText);
        const text = inspect ? await upstream.clone().text().catch(()=> "") : "";

        const definitive = isDefinitiveStatus(upstream.status) || isDefinitiveText(text);
        const retryable = !definitive && (isRetryableStatus(upstream.status) || isRetryableText(text));

        if (!retryable) {
          bridgeState.consecutiveFailures = 0;
          return upstream;
        }

        lastError = new Error(`Retryable upstream: status=${upstream.status} body=${text.slice(0,300)}`);
        bridgeState.consecutiveFailures++;
        metrics.upstreamRetries++;

        if (circuitFailures>0 && bridgeState.consecutiveFailures>=circuitFailures){
          bridgeState.circuitUntil = Date.now()+circuitCooldownMs;
          metrics.circuitOpenedCount++;
          metrics.lastCircuitOpenAt = new Date().toISOString();
        }

        const j = jitter>0 ? Math.floor(Math.random()*jitter) : 0;
        const d = Math.min(maxDelay, baseDelay*Math.pow(2, Math.min(attempt-1, 10))) + j;
        console.warn("[bridge-retry]", attempt, upstream.status, "delay", d, "body:", text.slice(0,140));
        await sleep(d);

      } catch (err){
        lastError = err;
        bridgeState.consecutiveFailures++;
        metrics.upstreamRetries++;
        if (circuitFailures>0 && bridgeState.consecutiveFailures>=circuitFailures){
          bridgeState.circuitUntil = Date.now()+circuitCooldownMs;
          metrics.circuitOpenedCount++;
          metrics.lastCircuitOpenAt = new Date().toISOString();
        }
        const j = jitter>0 ? Math.floor(Math.random()*jitter) : 0;
        const d = Math.min(maxDelay, baseDelay*Math.pow(2, Math.min(attempt-1, 10))) + j;
        console.warn("[bridge-retry net]", attempt, err?.code || err?.name, "delay", d);
        await sleep(d);
      }
    }
    throw lastError;
  } finally {
    releaseUpstreamSlot();
  }
}

if (!UPSTREAM_API_KEY){ console.error("Missing UPSTREAM_API_KEY"); process.exit(1); }
if (!PROXY_API_KEY){ console.error("Missing PROXY_API_KEY"); process.exit(1); }

function checkAuth(req,res,next){
  const auth = req.headers.authorization || "";
  const xKey = req.headers["x-api-key"] || "";
  if (auth !== `Bearer ${PROXY_API_KEY}` && xKey !== PROXY_API_KEY){
    return res.status(401).json({ error: { message: "Unauthorized", type:"authentication_error" }});
  }
  next();
}
function checkDashboardAuth(req,res,next){
  if ((req.headers.authorization || "") !== `Bearer ${DASHBOARD_PASSWORD}`){
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
function instrument(req,res,next){
  const start = Date.now();
  const route = req.path.startsWith("/v1/chat/completions") ? "/v1/chat/completions"
              : req.path.startsWith("/v1/messages") ? "/v1/messages"
              : req.path.startsWith("/v1/models") ? "/v1/models" : null;
  metrics.totalRequests++;
  res.on("finish", () => {
    const ms = Date.now() - start;
    const ok = res.statusCode >= 200 && res.statusCode < 400;
    if (ok) metrics.totalSuccess++; else metrics.totalErrors++;
    if (route && metrics.byRoute[route]){
      metrics.byRoute[route].count++;
      metrics.byRoute[route].totalMs += ms;
      if (ok) metrics.byRoute[route].ok++; else metrics.byRoute[route].err++;
    }
    pushRecent({
      method: req.method,
      route: req.path,
      status: res.statusCode,
      ms,
      ok,
      blocked: res.locals.blocked || null,
      error_id: res.locals.error_id || null
    });
  });
  next();
}

app.get("/health", (req,res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname,"public")));

/* =========================================================
   /admin/*  protegidas pela DASHBOARD_PASSWORD
   ========================================================= */
app.post("/admin/login", express.json(), (req,res) => {
  const pwd = (req.body || {}).password;
  if (pwd && pwd === DASHBOARD_PASSWORD) return res.json({ ok:true, token: DASHBOARD_PASSWORD });
  res.status(401).json({ ok:false, error:"invalid_password" });
});

app.get("/admin/status", checkDashboardAuth, (req,res) => {
  rotateBudgetIfNeeded();
  const cfg = {
    upstream_base_url: UPSTREAM_BASE_URL,
    default_model: DEFAULT_MODEL,
    port: Number(PORT),
    upstream_api_key_set: Boolean(UPSTREAM_API_KEY),
    proxy_api_key_set: Boolean(PROXY_API_KEY),
    upstream_retry_attempts: envInt("UPSTREAM_RETRY_ATTEMPTS",5),
    upstream_max_concurrency: envInt("UPSTREAM_MAX_CONCURRENCY",1),
    upstream_min_interval_ms: envInt("UPSTREAM_MIN_INTERVAL_MS",1500),
    upstream_timeout_ms: envInt("UPSTREAM_TIMEOUT_MS",180000),
    upstream_circuit_failures: envInt("UPSTREAM_CIRCUIT_FAILURES",3),
    upstream_circuit_cooldown_ms: envInt("UPSTREAM_CIRCUIT_COOLDOWN_MS",60000),
    openclaw_force_non_stream_retry: process.env.OPENCLAW_FORCE_NON_STREAM_RETRY ?? "true",
    upstream_infinite_retry: UPSTREAM_INFINITE_RETRY,
    upstream_retry_max_delay_ms: envInt("UPSTREAM_RETRY_MAX_DELAY_MS",20000)
  };
  const circuitOpen = Date.now() < bridgeState.circuitUntil;
  const byRoute = {};
  for (const [k,v] of Object.entries(metrics.byRoute)){
    byRoute[k] = { ...v, avgMs: v.count ? Math.round(v.totalMs/v.count) : 0 };
  }
  res.json({
    started_at: new Date(STARTED_AT).toISOString(),
    uptime_ms: Date.now() - STARTED_AT,
    state: {
      active_upstream: bridgeState.active,
      consecutive_failures: bridgeState.consecutiveFailures,
      circuit_open: circuitOpen,
      circuit_remaining_ms: circuitOpen ? bridgeState.circuitUntil - Date.now() : 0
    },
    metrics: {
      total_requests: metrics.totalRequests,
      total_success: metrics.totalSuccess,
      total_errors: metrics.totalErrors,
      upstream_retries: metrics.upstreamRetries,
      circuit_opened_count: metrics.circuitOpenedCount,
      last_circuit_open_at: metrics.lastCircuitOpenAt,
      guardrail_blocks: metrics.guardrailBlocks,
      by_route: byRoute
    },
    guardrails: {
      pii: {
        enabled: guardrails.pii.enabled,
        blocked: guardrails.pii.blocked,
        last_block_at: guardrails.pii.lastBlockAt
      },
      max_tokens: {
        enabled: guardrails.maxTokens.enabled,
        limit: guardrails.maxTokens.limit,
        blocked: guardrails.maxTokens.blocked,
        last_block_at: guardrails.maxTokens.lastBlockAt
      },
      budget: {
        enabled: guardrails.budget.enabled,
        daily_usd: guardrails.budget.dailyUsd,
        today_spent_usd: round4(guardrails.budget.todaySpentUsd),
        total_spent_usd: round4(guardrails.budget.totalSpentUsd),
        today_key: guardrails.budget.todayKey,
        history: guardrails.budget.history,
        pricing: guardrails.budget.pricing,
        blocked: guardrails.budget.blocked,
        last_block_at: guardrails.budget.lastBlockAt
      },
      model_swap: {
        enabled: guardrails.modelSwap.enabled,
        detected: guardrails.modelSwap.detected,
        swaps: guardrails.modelSwap.swaps.slice(0, 50)
      }
    },
    recent: metrics.recent,
    error_log: errorLog.slice(0, 50),
    config: cfg,
    versions: { node: process.version, bridge: "1.3.0-infinite-retry" }
  });
});

app.post("/admin/reset", checkDashboardAuth, (req,res) => {
  metrics.totalRequests = metrics.totalSuccess = metrics.totalErrors = 0;
  metrics.upstreamRetries = metrics.circuitOpenedCount = 0;
  metrics.guardrailBlocks = 0;
  metrics.lastCircuitOpenAt = null;
  metrics.recent = [];
  for (const r of Object.values(metrics.byRoute)){ r.ok=0; r.err=0; r.totalMs=0; r.count=0; }
  errorLog.length = 0;
  res.json({ ok: true });
});

app.post("/admin/guardrails", checkDashboardAuth, (req,res) => {
  const b = req.body || {};
  if (b.pii && typeof b.pii.enabled === "boolean") guardrails.pii.enabled = b.pii.enabled;
  if (b.max_tokens){
    if (typeof b.max_tokens.enabled === "boolean") guardrails.maxTokens.enabled = b.max_tokens.enabled;
    if (Number.isFinite(Number(b.max_tokens.limit))) guardrails.maxTokens.limit = Number(b.max_tokens.limit);
  }
  if (b.budget){
    if (typeof b.budget.enabled === "boolean") guardrails.budget.enabled = b.budget.enabled;
    if (Number.isFinite(Number(b.budget.daily_usd))) guardrails.budget.dailyUsd = Number(b.budget.daily_usd);
    if (b.budget.pricing){
      if (Number.isFinite(Number(b.budget.pricing.input_per_million)))  guardrails.budget.pricing.inputPerMillion  = Number(b.budget.pricing.input_per_million);
      if (Number.isFinite(Number(b.budget.pricing.output_per_million))) guardrails.budget.pricing.outputPerMillion = Number(b.budget.pricing.output_per_million);
    }
  }
  if (b.model_swap && typeof b.model_swap.enabled === "boolean") guardrails.modelSwap.enabled = b.model_swap.enabled;
  res.json({ ok:true });
});

app.post("/admin/budget/reset", checkDashboardAuth, (req,res) => {
  guardrails.budget.todaySpentUsd = 0;
  guardrails.budget.totalSpentUsd = 0;
  guardrails.budget.history = [];
  guardrails.budget.blocked = 0;
  guardrails.budget.lastBlockAt = null;
  res.json({ ok:true });
});

app.post("/admin/swaps/clear", checkDashboardAuth, (req,res) => {
  guardrails.modelSwap.swaps = [];
  guardrails.modelSwap.detected = 0;
  res.json({ ok:true });
});

app.get("/admin/errors", checkDashboardAuth, (req,res) => {
  res.json({ errors: errorLog.slice(0, 200) });
});

app.delete("/admin/errors", checkDashboardAuth, (req,res) => {
  errorLog.length = 0;
  res.json({ ok:true });
});

/* =========================================================
   /v1/* — autenticação proxy + instrumentação
   ========================================================= */
app.use("/v1", instrument, checkAuth);

function copyAnthropicHeaders(req){
  const h = {
    Authorization: `Bearer ${UPSTREAM_API_KEY}`,
    "Content-Type": req.headers["content-type"] || "application/json",
    "anthropic-version": req.headers["anthropic-version"] || "2023-06-01"
  };
  if (req.headers["anthropic-beta"]) h["anthropic-beta"] = req.headers["anthropic-beta"];
  return h;
}

async function sendUpstreamResponse(upstream, res){
  res.status(upstream.status);
  const ct = upstream.headers.get("content-type"); if (ct) res.setHeader("Content-Type", ct);
  const cc = upstream.headers.get("cache-control"); if (cc) res.setHeader("Cache-Control", cc);
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  while (true){
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

function extractAnthropicText(message){
  const c = Array.isArray(message?.content) ? message.content : [];
  return c.map(p => typeof p === "string" ? p : (p?.type === "text" ? p.text : (p?.text || ""))).join("");
}

function sendAnthropicStreamFromMessage(res, message){
  const text = extractAnthropicText(message);
  const id = message?.id || `msg_${Date.now()}`;
  const model = message?.model || DEFAULT_MODEL;
  const usage = message?.usage || { input_tokens:0, output_tokens:0 };
  const stopReason = message?.stop_reason || "end_turn";

  res.status(200);
  res.setHeader("Content-Type","text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send("message_start", { type:"message_start", message:{ id, type:"message", role:"assistant", model, content:[], stop_reason:null, stop_sequence:null, usage:{ input_tokens: usage.input_tokens||0, output_tokens:0 }}});
  send("content_block_start", { type:"content_block_start", index:0, content_block:{ type:"text", text:"" }});
  if (text) send("content_block_delta", { type:"content_block_delta", index:0, delta:{ type:"text_delta", text }});
  send("content_block_stop", { type:"content_block_stop", index:0 });
  send("message_delta", { type:"message_delta", delta:{ stop_reason: stopReason, stop_sequence:null }, usage:{ output_tokens: usage.output_tokens || 0 }});
  send("message_stop", { type:"message_stop" });
  res.end();
}

app.get("/v1/models", async (req,res) => {
  try {
    const u = await fetchUpstream(`${UPSTREAM_BASE_URL}/v1/models`, { headers: { Authorization: `Bearer ${UPSTREAM_API_KEY}` }});
    return sendUpstreamResponse(u, res);
  } catch (e){
    res.status(500).json({ error:{ message: String(e), type:"bridge_error" }});
  }
});

/* OpenAI <-> Anthropic conversões */
function convertOpenAIContentToAnthropic(content){
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(p => p.type === "text" ? { type:"text", text: p.text || "" } : null).filter(Boolean);
  return String(content ?? "");
}
function convertMessages(messages = []){
  const out = []; const sys = [];
  for (const m of messages){
    if (m.role === "system"){ if (typeof m.content === "string") sys.push(m.content); continue; }
    if (m.role === "user"){ out.push({ role:"user", content: convertOpenAIContentToAnthropic(m.content) }); continue; }
    if (m.role === "assistant"){
      const c = [];
      if (m.content) c.push({ type:"text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
      if (Array.isArray(m.tool_calls)) for (const call of m.tool_calls) c.push({ type:"tool_use", id: call.id, name: call.function?.name, input: JSON.parse(call.function?.arguments || "{}") });
      out.push({ role:"assistant", content: c.length ? c : "" });
      continue;
    }
    if (m.role === "tool"){
      out.push({ role:"user", content: [{ type:"tool_result", tool_use_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }]});
    }
  }
  return { system: sys.join("\n\n") || undefined, messages: out };
}
function convertTools(tools = []){
  return tools.filter(t => t.type === "function" && t.function).map(t => ({
    name: t.function.name, description: t.function.description || "",
    input_schema: t.function.parameters || { type:"object", properties:{} }
  }));
}
function convertAnthropicToOpenAI(data, model){
  const txt = []; const tc = [];
  for (const b of data.content || []){
    if (b.type === "text") txt.push(b.text || "");
    if (b.type === "tool_use") tc.push({ id: b.id, type:"function", function:{ name: b.name, arguments: JSON.stringify(b.input || {}) }});
  }
  const message = { role:"assistant", content: txt.join("") };
  if (tc.length) message.tool_calls = tc;
  return {
    id: data.id || `chatcmpl_${Date.now()}`, object:"chat.completion",
    created: Math.floor(Date.now()/1000), model: data.model || model,
    choices: [{ index:0, message, finish_reason: tc.length ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens||0)+(data.usage?.output_tokens||0)
    }
  };
}
function sendOpenAIStream(res, r){
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  const ch = r.choices[0];
  const head = { id:r.id, object:"chat.completion.chunk", created:r.created, model:r.model, choices:[{ index:0, delta:{ role:"assistant" }, finish_reason:null }]};
  res.write(`data: ${JSON.stringify(head)}\n\n`);
  if (ch.message.content){
    res.write(`data: ${JSON.stringify({ id:r.id, object:"chat.completion.chunk", created:r.created, model:r.model, choices:[{ index:0, delta:{ content: ch.message.content }, finish_reason:null }]})}\n\n`);
  }
  if (ch.message.tool_calls?.length){
    res.write(`data: ${JSON.stringify({ id:r.id, object:"chat.completion.chunk", created:r.created, model:r.model, choices:[{ index:0, delta:{ tool_calls: ch.message.tool_calls.map((c,i)=>({ index:i, id:c.id, type:"function", function:{ name:c.function.name, arguments:c.function.arguments }})) }, finish_reason:null }]})}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ id:r.id, object:"chat.completion.chunk", created:r.created, model:r.model, choices:[{ index:0, delta:{}, finish_reason: ch.finish_reason || "stop" }]})}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

/* OpenAI-compatible */
app.post("/v1/chat/completions", async (req,res) => {
  const t0 = Date.now();
  const upstreamUrl = `${UPSTREAM_BASE_URL}/v1/messages`;
  try {
    const body = req.body;
    const model = body.model || DEFAULT_MODEL;

    const gr = preflightGuardrails(body);
    if (gr.blocked){
      metrics.guardrailBlocks++;
      res.locals.blocked = gr.by;
      const eid = pushErrorLog({ route:"/v1/chat/completions", method:"POST", status:403, type:"guardrail_block", message:`[guardrail:${gr.by}] ${gr.reason}`, upstream_url:upstreamUrl, duration_ms:Date.now()-t0 });
      res.locals.error_id = eid;
      return res.status(403).json({ error:{ message:`[guardrail:${gr.by}] ${gr.reason}`, type:"guardrail_block" }});
    }

    const conv = convertMessages(body.messages || []);
    const anth = { model, max_tokens: body.max_tokens || body.max_completion_tokens || 4096, messages: conv.messages };
    if (conv.system) anth.system = conv.system;
    const tools = convertTools(body.tools || []); if (tools.length) anth.tools = tools;
    if (body.temperature !== undefined) anth.temperature = body.temperature;

    const retriesBefore = metrics.upstreamRetries;
    const upstream = await fetchUpstream(upstreamUrl, {
      method:"POST",
      headers:{ Authorization:`Bearer ${UPSTREAM_API_KEY}`, "anthropic-version":"2023-06-01", "Content-Type":"application/json" },
      body: JSON.stringify(anth)
    });
    const retriesTaken = metrics.upstreamRetries - retriesBefore;
    const text = await upstream.text();
    if (!upstream.ok){
      const eid = pushErrorLog({ route:"/v1/chat/completions", method:"POST", status:upstream.status, type:"upstream_error", message:`Upstream error ${upstream.status}`, body_snippet:text, retries_taken:retriesTaken, upstream_url:upstreamUrl, duration_ms:Date.now()-t0 });
      res.locals.error_id = eid;
      return res.status(upstream.status).type("application/json").send(text);
    }

    const anthResp = JSON.parse(text);
    recordUsage({ requestedModel: model, returnedModel: anthResp.model, usage: anthResp.usage, route: "/v1/chat/completions" });

    const openai = convertAnthropicToOpenAI(anthResp, model);
    if (body.stream) return sendOpenAIStream(res, openai);
    res.json(openai);
  } catch (e){
    const eid = pushErrorLog({ route:"/v1/chat/completions", method:"POST", status:500, type: e?.name === "AbortError" ? "timeout" : "network_error", message:String(e), upstream_url:upstreamUrl, duration_ms:Date.now()-t0 });
    res.locals.error_id = eid;
    res.status(500).json({ error:{ message:String(e), type:"bridge_error" }});
  }
});

/* Anthropic-compatible (OpenClaw) */
app.post("/v1/messages", async (req,res) => {
  const t0 = Date.now();
  const upstreamUrl = `${UPSTREAM_BASE_URL}/v1/messages`;
  try {
    const body = req.body || {};
    const requestedModel = body.model || DEFAULT_MODEL;

    const gr = preflightGuardrails(body);
    if (gr.blocked){
      metrics.guardrailBlocks++;
      res.locals.blocked = gr.by;
      const eid = pushErrorLog({ route:"/v1/messages", method:"POST", status:403, type:"guardrail_block", message:`[guardrail:${gr.by}] ${gr.reason}`, upstream_url:upstreamUrl, duration_ms:Date.now()-t0 });
      res.locals.error_id = eid;
      return res.status(403).json({ error:{ message:`[guardrail:${gr.by}] ${gr.reason}`, type:"guardrail_block" }});
    }

    const clientStream = body.stream === true;
    const force = envBool("OPENCLAW_FORCE_NON_STREAM_RETRY", true);
    const upstreamBody = { ...body };
    if (clientStream && force) upstreamBody.stream = false;

    const retriesBefore = metrics.upstreamRetries;
    const upstream = await fetchUpstream(upstreamUrl, {
      method:"POST",
      headers: copyAnthropicHeaders(req),
      body: JSON.stringify(upstreamBody),
      bridgeInspectOkText: true
    });
    const retriesTaken = metrics.upstreamRetries - retriesBefore;

    if (clientStream && force){
      const text = await upstream.text();
      if (!upstream.ok){
        const eid = pushErrorLog({ route:"/v1/messages", method:"POST", status:upstream.status, type:"upstream_error", message:`Upstream error ${upstream.status}`, body_snippet:text, retries_taken:retriesTaken, upstream_url:upstreamUrl, duration_ms:Date.now()-t0 });
        res.locals.error_id = eid;
        return res.status(upstream.status).type("application/json").send(text);
      }
      const message = JSON.parse(text);
      recordUsage({ requestedModel, returnedModel: message.model, usage: message.usage, route: "/v1/messages" });
      return sendAnthropicStreamFromMessage(res, message);
    }

    // se não força non-stream e a resposta não é stream, ainda tentamos auditar
    const ct = upstream.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream") && upstream.ok){
      const txt = await upstream.text();
      try {
        const m = JSON.parse(txt);
        recordUsage({ requestedModel, returnedModel: m.model, usage: m.usage, route: "/v1/messages" });
      } catch (_) {}
      res.status(upstream.status); if (ct) res.setHeader("Content-Type", ct);
      return res.send(txt);
    }
    return sendUpstreamResponse(upstream, res);
  } catch (e){
    const eid = pushErrorLog({ route:"/v1/messages", method:"POST", status:500, type: e?.name === "AbortError" ? "timeout" : "network_error", message:String(e), upstream_url:upstreamUrl, duration_ms:Date.now()-t0 });
    res.locals.error_id = eid;
    res.status(500).json({ error:{ message:String(e), type:"bridge_error" }});
  }
});

app.listen(PORT, () => {
  console.log(`Claude bridge v1.3.0-infinite-retry running on port ${PORT}`);
  console.log(`Infinite retry mode: ${UPSTREAM_INFINITE_RETRY}`);
  console.log("Dashboard:                 GET  /");
  console.log("OpenAI-compatible route:   POST /v1/chat/completions");
  console.log("Anthropic-compatible route:POST /v1/messages");
});
