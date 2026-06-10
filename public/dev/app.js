/* ============================================================
   Claude Bridge Dashboard — app.js  v2.0.0
   ============================================================ */

/* ---- Helpers ---- */
const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");

const TOKEN_KEY = "cb_token";
function getToken()  { return localStorage.getItem(TOKEN_KEY) || ""; }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken(){ localStorage.removeItem(TOKEN_KEY); }

function showScreen(name) {
  $("#setup").classList.toggle("hidden", name !== "setup");
  $("#login").classList.toggle("hidden", name !== "login");
  $("#app").classList.toggle("hidden", name !== "app");
}

function humanUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m ${ss}s`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

function humanDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { hour12: false });
}

function humanTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("pt-BR", { hour12: false });
}

function errorTypeBadge(type) {
  const labels = { upstream_error:"upstream", network_error:"network", circuit_open:"circuit", guardrail_block:"guardrail", bridge_error:"bridge", timeout:"timeout" };
  const label = labels[type] || type || "?";
  return `<span class="error-type-badge badge-${type}">${label}</span>`;
}

function escHtml(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function maskKeyClient(k) {
  if (!k || k.length < 8) return "***";
  return k.slice(0, 4) + "..." + k.slice(-4);
}

/* ---- Init flow ---- */
async function init() {
  const status = await fetch("/admin/setup-status").then(r => r.json()).catch(() => ({configured:false}));
  if (!status.configured) { showScreen("setup"); return; }
  if (getToken()) {
    const ok = await fetchStatus();
    if (ok) { showScreen("app"); refresh(); startTimer(); return; }
  }
  showScreen("login");
}
init();

/* ---- Setup handlers ---- */
$("#setupNext1Btn").addEventListener("click", () => {
  const pass = $("#setupDashPass").value.trim();
  const err = $("#setupError");
  if (!pass) { err.textContent = "Senha obrigatória."; err.classList.remove("hidden"); return; }
  err.classList.add("hidden");
  $("#setupStep1").classList.add("hidden");
  $("#setupStep2").classList.remove("hidden");
});

$("#setupBackBtn").addEventListener("click", () => {
  $("#setupStep2").classList.add("hidden");
  $("#setupStep1").classList.remove("hidden");
});

$("#setupFinishBtn").addEventListener("click", async () => {
  const err = $("#setupError");
  const name = $("#setupUpName").value.trim();
  const baseUrl = $("#setupUpUrl").value.trim();
  const apiKey = $("#setupUpKey").value.trim();
  if (!name || !baseUrl || !apiKey) { err.textContent = "Preencha todos os campos do upstream."; err.classList.remove("hidden"); return; }
  err.classList.add("hidden");
  try {
    const r = await fetch("/admin/setup", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        dashboardPassword: $("#setupDashPass").value.trim(),
        upstreams: [{name, baseUrl, apiKey}]
      })
    });
    if (!r.ok) { const d = await r.json().catch(()=>({})); throw new Error(d.error || "Falha no setup"); }
    const data = await r.json();
    setToken(data.token || $("#setupDashPass").value.trim());
    init();
  } catch(e) { err.textContent = e.message; err.classList.remove("hidden"); }
});

/* ---- Login ---- */
$("#loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("#loginError");
  err.classList.add("hidden");
  try {
    const r = await fetch("/admin/login", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ password: $("#password").value })
    });
    if (!r.ok) throw new Error("Senha inválida");
    const data = await r.json();
    setToken(data.token);
    init();
  } catch(e) { err.textContent = "Senha inválida."; err.classList.remove("hidden"); }
});

/* ---- Tab switching ---- */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $("#tabMain").classList.toggle("hidden", tab !== "tabMain");
    $("#tabKeys").classList.toggle("hidden", tab !== "tabKeys");
    $("#tabUsage").classList.toggle("hidden", tab !== "tabUsage");
    $("#tabSettings").classList.toggle("hidden", tab !== "tabSettings");
    if (tab === "tabSettings") refreshSettings();
    if (tab === "tabKeys") refreshKeys();
    if (tab === "tabUsage") refreshUsage();
  });
});

/* ---- Auth fetch helper ---- */
async function fetchStatus() {
  const r = await fetch("/admin/status", { headers: { Authorization: `Bearer ${getToken()}` } });
  if (r.status === 401) { clearToken(); showScreen("login"); return null; }
  if (!r.ok) return null;
  return r.json();
}

/* ---- Status pill ---- */
function statusPill(circuitOpen) {
  const el = $("#statusPill");
  if (circuitOpen) { el.textContent = "circuit aberto"; el.className = "pill pill-warn"; }
  else { el.textContent = "online"; el.className = "pill pill-ok"; }
}

/* ---- Render KPIs ---- */
function renderKPIs(m) {
  $("#kpiTotal").textContent = fmt(m.total_requests);
  $("#kpiOk").textContent = fmt(m.total_success);
  $("#kpiErr").textContent = fmt(m.total_errors);
  $("#kpiRetries").textContent = fmt(m.upstream_retries);
}

/* ---- Render State ---- */
function renderState(state, m) {
  $("#stActive").textContent = state.active_upstream;
  $("#stFails").textContent = state.consecutive_failures;
  const c = $("#stCircuit");
  if (state.circuit_open) { c.textContent = "aberto"; c.className = "pill pill-bad"; }
  else { c.textContent = "fechado"; c.className = "pill pill-ok"; }
  $("#stCooldown").textContent = state.circuit_remaining_ms + " ms";
  $("#stOpens").textContent = m.circuit_opened_count;
}

/* ---- Render Routes ---- */
function renderRoutes(byRoute) {
  const tbody = $("#routeTable");
  tbody.innerHTML = "";
  for (const [route, r] of Object.entries(byRoute)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><code>${route}</code></td><td>${fmt(r.count)}</td><td class="good">${fmt(r.ok)}</td><td class="bad">${fmt(r.err)}</td><td>${r.avgMs ? r.avgMs+" ms":"—"}</td>`;
    tbody.appendChild(tr);
  }
}

/* ---- Render Config ---- */
function renderConfig(cfg, versions) {
  $("#cfgUpstream").textContent = cfg.upstream_base_url;
  $("#cfgModel").textContent = cfg.default_model;
  $("#cfgConc").textContent = cfg.upstream_max_concurrency;
  $("#cfgMin").textContent = cfg.upstream_min_interval_ms + " ms";
  $("#cfgTimeout2").textContent = cfg.upstream_timeout_ms + " ms";
  const retryMode = cfg.upstream_infinite_retry ? `infinito (max delay ${cfg.upstream_retry_max_delay_ms}ms)` : `${cfg.upstream_retry_attempts} tentativas`;
  $("#cfgRetryMode").textContent = retryMode;
  $("#cfgOpenClaw").textContent = String(cfg.openclaw_force_non_stream_retry);
  $("#cfgNode").textContent = versions.node + " · bridge " + versions.bridge;
}

/* ---- Render Recent ---- */
function renderRecent(recent) {
  const tbody = $("#recentTable");
  tbody.innerHTML = "";
  for (const e of recent) {
    const tr = document.createElement("tr");
    const cls = e.ok ? "good" : "bad";
    let badges = "";
    if (e.blocked) badges += `<span class="badge-blocked">${e.blocked}</span> `;
    if (e.error_id) badges += `<span class="badge-error-link" data-error-id="${e.error_id}">#${e.error_id}</span>`;
    tr.innerHTML = `<td>${humanTime(e.at)}</td><td>${e.method}</td><td><code>${e.route}</code></td><td class="${cls}">${e.status}</td><td>${e.ms} ms</td><td>${badges}</td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".badge-error-link").forEach(el => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.errorId);
      const err = _lastErrorLog.find(e => e.id === id);
      if (err) openErrorModal(err);
    });
  });
}

/* ---- Error Log ---- */
let _lastErrorLog = [];
function renderErrorLog(errors) {
  _lastErrorLog = errors || [];
  const tbody = $("#errorLogTable");
  const empty = $("#errorLogEmpty");
  const count = $("#errorLogCount");
  tbody.innerHTML = "";
  count.textContent = errors.length ? `(${errors.length})` : "";
  if (!errors.length) { empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  for (const e of errors) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${humanTime(e.at)}</td><td><code>${e.route||"—"}</code></td><td>${errorTypeBadge(e.type)}</td><td class="${e.status>=500?"bad":e.status>=400?"warn":""}">${e.status||"—"}</td><td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(e.message||"").replace(/"/g,"&quot;")}">${e.message||"—"}</td><td>${e.retries_taken||0}</td><td>${e.duration_ms?e.duration_ms+" ms":"—"}</td>`;
    tr.addEventListener("click", () => openErrorModal(e));
    tbody.appendChild(tr);
  }
}

/* ---- Guardrails ---- */
let _lastGuardrails = null;
function renderGuardrails(gr) {
  _lastGuardrails = gr;
  $("#grPiiEnabled").checked = gr.pii.enabled;
  $("#grPiiBlocked").textContent = gr.pii.blocked;
  $("#grPiiLast").textContent = gr.pii.last_block_at ? "Último bloqueio: " + humanDate(gr.pii.last_block_at) : "Nenhum bloqueio";
  $("#grMaxTokensEnabled").checked = gr.max_tokens.enabled;
  $("#grMaxTokensBlocked").textContent = gr.max_tokens.blocked;
  $("#grMaxTokensLimit").value = gr.max_tokens.limit;
  $("#grMaxTokensLast").textContent = gr.max_tokens.last_block_at ? "Último bloqueio: " + humanDate(gr.max_tokens.last_block_at) : "Nenhum bloqueio";
  $("#grBudgetEnabled").checked = gr.budget.enabled;
  $("#grBudgetBlocked").textContent = gr.budget.blocked;
  $("#grBudgetLast").textContent = gr.budget.last_block_at ? "Último bloqueio: " + humanDate(gr.budget.last_block_at) : "Nenhum bloqueio";
  $("#grModelSwapEnabled").checked = gr.model_swap.enabled;
  $("#grModelSwapDetected").textContent = gr.model_swap.detected;
}

/* ---- Budget ---- */
function renderBudget(budget) {
  const spent = budget.today_spent_usd || 0;
  const cap = budget.daily_usd || 10;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const fill = $("#budgetGaugeFill");
  fill.style.width = pct.toFixed(1) + "%";
  fill.className = "budget-gauge-fill" + (pct >= 100 ? " bad" : pct >= 75 ? " warn" : "");
  $("#budgetGaugePct").textContent = pct.toFixed(1) + "%";
  $("#budgetToday").textContent = "$" + spent.toFixed(4);
  $("#budgetTotal").textContent = "$" + (budget.total_spent_usd || 0).toFixed(4);
  $("#budgetDailyCap").value = cap;
  const tbody = $("#budgetHistoryTable");
  tbody.innerHTML = "";
  const hist = (budget.history || []).slice(0, 7);
  if (!hist.length) { tbody.innerHTML = `<tr><td colspan="2" class="muted center">Sem histórico</td></tr>`; }
  else { for (const h of hist) { tbody.innerHTML += `<tr><td>${h.day}</td><td>$${Number(h.spentUsd||0).toFixed(4)}</td></tr>`; } }
}

/* ---- Model Swaps ---- */
function renderModelSwaps(modelSwap) {
  const tbody = $("#swapTable");
  const empty = $("#swapEmpty");
  const total = $("#swapTotal");
  const swaps = modelSwap.swaps || [];
  total.textContent = modelSwap.detected ? `(${modelSwap.detected} total)` : "";
  tbody.innerHTML = "";
  if (!swaps.length) { empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  for (const s of swaps) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${humanTime(s.at)}</td><td><code>${s.route||"—"}</code></td><td class="muted">${s.requested||"—"}</td><td class="warn">${s.returned||"—"}</td>`;
    tbody.appendChild(tr);
  }
}

/* ---- Modal ---- */
function openErrorModal(error) {
  const body = $("#modalBody");
  const fields = [
    ["ID", error.id], ["Hora", humanDate(error.at)], ["Rota", error.route],
    ["Tipo", errorTypeBadge(error.type)], ["Status HTTP", error.status],
    ["Request ID (upstream)", error.request_id], ["Chave de API", error.api_key],
    ["Modelo", error.model], ["Upstream", error.upstream],
    ["Retries", error.retries_taken], ["Duração", error.duration_ms ? error.duration_ms + " ms" : "—"],
    ["Mensagem", error.message]
  ];
  let html = "";
  for (const [label, val] of fields) {
    html += `<div class="modal-field"><div class="modal-field-label">${label}</div><div class="modal-field-value">${val ?? "—"}</div></div>`;
  }
  if (error.body_snippet) {
    html += `<div class="modal-field"><div class="modal-field-label">Body snippet (upstream)</div><pre class="modal-snippet">${escHtml(error.body_snippet)}</pre></div>`;
  }
  body.innerHTML = html;
  $("#errorModal").classList.remove("hidden");
}
function closeErrorModal() { $("#errorModal").classList.add("hidden"); }

/* ---- Connect panel ---- */
let _connectProvider = "n8n";
let _connectBaseUrl = "";
let _connectModel = "";

function renderConnectPanel() {
  const base = _connectBaseUrl || window.location.origin;
  const key  = getToken() || "<sua-senha>";
  const model = _connectModel || "claude-opus-4-7";
  const providers = {
    n8n: {
      label: "n8n",
      rows: [
        { label: "Tipo de credencial", value: "OpenAI API" },
        { label: "Base URL", value: `${base}/v1` },
        { label: "API Key", value: key },
        { label: "Nó recomendado", value: "OpenAI Chat Model" },
        { label: "Model (by ID)", value: model },
      ],
      note: "Em Credentials → OpenAI API, preencha Base URL e API Key acima. No nó, selecione <b>Define Below</b> e cole o Model."
    },
    openai: {
      label: "OpenAI compat",
      rows: [
        { label: "Base URL", value: `${base}/v1` },
        { label: "API Key", value: key },
        { label: "Model", value: model },
      ],
      code: `from openai import OpenAI\nclient = OpenAI(\n    base_url="${base}/v1",\n    api_key="${key}",\n)\nresp = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role":"user","content":"Olá!"}]\n)`,
      note: "Funciona com qualquer SDK OpenAI (Python, Node, Go, etc.) — só troque a <b>base_url</b> e a <b>api_key</b>."
    },
    anthropic: {
      label: "Anthropic compat",
      rows: [
        { label: "Base URL", value: `${base}` },
        { label: "API Key (x-api-key)", value: key },
        { label: "Model", value: model },
      ],
      code: `import anthropic\nclient = anthropic.Anthropic(\n    base_url="${base}",\n    api_key="${key}",\n)\nmsg = client.messages.create(\n    model="${model}",\n    max_tokens=1024,\n    messages=[{"role":"user","content":"Olá!"}]\n)`,
      note: "Use o endpoint <code>/v1/messages</code>. Funciona com o SDK oficial da Anthropic."
    },
    openclaw: {
      label: "OpenClaw",
      rows: [
        { label: "baseUrl", value: base },
        { label: "apiKey", value: key },
        { label: "api", value: "anthropic-messages" },
        { label: "model id", value: model },
      ],
      code: `openclaw config set models.providers.bridge '{\n  "baseUrl": "${base}",\n  "apiKey":  "${key}",\n  "api":     "anthropic-messages",\n  "models": [{"id":"${model}","name":"Claude via Bridge","reasoning":true,"input":["text","image"],"contextWindow":200000,"maxTokens":8192}]\n}' --strict-json --replace`,
      note: "Cole o comando acima no terminal com o OpenClaw CLI instalado."
    },
    cursor: {
      label: "Cursor / VS Code",
      rows: [
        { label: "Provider", value: "OpenAI Compatible" },
        { label: "Base URL", value: `${base}/v1` },
        { label: "API Key", value: key },
        { label: "Model", value: model },
      ],
      note: "Em Cursor: <b>Settings → Models → Add Model</b>. Selecione <b>openai-compatible</b>, cole a Base URL e a API Key. Em VS Code com Copilot, adicione em <code>settings.json</code>:<br><code>\"github.copilot.advanced\": {\"debug.overrideEngine\": \"${model}\", \"debug.overrideChatEngine\": \"${model}\"}</code>"
    }
  };

  const p = providers[_connectProvider] || providers.n8n;
  const baseEl = $("#connectBaseUrl");
  if (baseEl) baseEl.textContent = base;

  const panel = $("#connectPanel");
  if (!panel) return;

  const rowsHtml = p.rows.map(r => `
    <div class="connect-row" title="Clique para copiar" onclick="copyText(this,'${escAttr(r.value)}')">
      <span class="connect-row-label">${r.label}</span>
      <span class="connect-row-value"><code>${escHtml(r.value)}</code></span>
      <span class="connect-copy-icon">⧉</span>
    </div>`).join("");

  const codeHtml = p.code ? `
    <div class="connect-code-wrap">
      <button class="connect-copy-btn" onclick="copyText(this,${JSON.stringify(p.code)})">Copiar código</button>
      <pre class="codeblock" style="margin-top:8px">${escHtml(p.code)}</pre>
    </div>` : "";

  panel.innerHTML = `
    <div class="connect-rows">${rowsHtml}</div>
    ${codeHtml}
    <p class="muted small connect-note" style="margin:10px 0 0">${p.note}</p>`;
}

function escAttr(s) { return String(s).replace(/'/g, "\\'"); }

window.copyText = function(el, text) {
  navigator.clipboard.writeText(text).catch(() => {});
  const orig = el.querySelector(".connect-copy-icon");
  if (orig) { orig.textContent = "✓"; setTimeout(() => orig.textContent = "⧉", 1500); }
  else { const prev = el.textContent; el.textContent = "✓ Copiado!"; setTimeout(() => el.textContent = prev, 1500); }
};

document.querySelectorAll(".connect-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".connect-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    _connectProvider = btn.dataset.provider;
    renderConnectPanel();
  });
});

/* ---- Main refresh ---- */
async function refresh() {
  try {
    const data = await fetchStatus();
    if (!data) return;
    $("#uptime").textContent = "uptime " + humanUptime(data.uptime_ms);
    statusPill(data.state.circuit_open);
    renderKPIs(data.metrics);
    renderState(data.state, data.metrics);
    renderRoutes(data.metrics.by_route);
    renderRecent(data.recent || []);
    renderErrorLog(data.error_log || []);
    renderGuardrails(data.guardrails);
    renderBudget(data.guardrails.budget);
    renderModelSwaps(data.guardrails.model_swap);
    renderConfig(data.config, data.versions);
    _connectModel = data.config?.defaultModel || "claude-opus-4-7";
    _connectBaseUrl = window.location.origin;
    renderConnectPanel();
  } catch(e) { console.error("[refresh]", e); }
}

/* ---- Test runner ---- */
async function runTest() {
  const out = $("#testOut");
  out.textContent = "enviando...";
  const endpoint = $("#testEndpoint").value;
  const model = $("#testModel").value.trim();
  const prompt = $("#testPrompt").value;
  const stream = $("#testStream").checked;
  const isAnthropic = endpoint === "/v1/messages";
  const body = { model, max_tokens: 256, stream, messages: [{ role: "user", content: prompt }] };
  const headers = { "Content-Type": "application/json" };
  if (isAnthropic) { headers["x-api-key"] = getToken(); headers["anthropic-version"] = "2023-06-01"; }
  else { headers["Authorization"] = "Bearer " + getToken(); }
  try {
    const r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    const ct = r.headers.get("content-type") || "";
    let text;
    if (ct.includes("text/event-stream")) text = await r.text();
    else if (ct.includes("application/json")) text = JSON.stringify(await r.json(), null, 2);
    else text = await r.text();
    out.textContent = `HTTP ${r.status}\n\n${text}`;
  } catch(e) { out.textContent = "erro: " + String(e); }
  finally { refresh(); }
}

/* ---- Admin actions ---- */
async function resetMetrics() {
  if (!confirm("Zerar todas as métricas e o error log?")) return;
  await fetch("/admin/reset", { method:"POST", headers:{Authorization:`Bearer ${getToken()}`} });
  refresh();
}
async function saveGuardrails(data) {
  await fetch("/admin/guardrails", { method:"POST", headers:{Authorization:`Bearer ${getToken()}`,"Content-Type":"application/json"}, body:JSON.stringify(data) });
  refresh();
}
async function resetBudget() {
  if (!confirm("Resetar contadores de budget?")) return;
  await fetch("/admin/budget/reset", { method:"POST", headers:{Authorization:`Bearer ${getToken()}`} });
  refresh();
}
async function clearSwaps() {
  if (!confirm("Limpar log de model swaps?")) return;
  await fetch("/admin/swaps/clear", { method:"POST", headers:{Authorization:`Bearer ${getToken()}`} });
  refresh();
}
async function clearErrors() {
  if (!confirm("Limpar error log?")) return;
  await fetch("/admin/errors", { method:"DELETE", headers:{Authorization:`Bearer ${getToken()}`} });
  refresh();
}

/* ---- Settings Tab ---- */
async function fetchConfig() {
  const r = await fetch("/admin/config", { headers: { Authorization: `Bearer ${getToken()}` } });
  return r.json();
}
async function postConfig(data) {
  const r = await fetch("/admin/config", {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return r.json();
}

let _cfg = null;

async function refreshSettings() {
  _cfg = await fetchConfig();
  renderUpstreamsList(_cfg.upstreams || []);
  $("#cfgDefaultModel").value = _cfg.defaultModel || "";
  $("#cfgInfiniteRetry").checked = _cfg.retry?.infinite !== false;
  $("#cfgMaxDelay").value = _cfg.retry?.maxDelayMs || 20000;
  $("#cfgMaxConc").value = _cfg.concurrency?.maxConcurrency || 1;
  $("#cfgMinInterval").value = _cfg.concurrency?.minIntervalMs || 1500;
  $("#cfgTimeout").value = _cfg.concurrency?.timeoutMs || 180000;
  $("#cfgCircuitFail").value = _cfg.circuit?.failures || 3;
  $("#cfgCircuitCool").value = _cfg.circuit?.cooldownMs || 60000;
}

function renderUpstreamsList(upstreams) {
  const el = $("#upstreamsList");
  if (!upstreams.length) { el.innerHTML = '<p class="muted small">Nenhum upstream configurado.</p>'; return; }
  el.innerHTML = upstreams.map(u => `
    <div class="upstream-item">
      <div class="upstream-item-info">
        <div class="upstream-item-name">${escHtml(u.name)} ${u.enabled===false?'<span class="pill pill-warn">desativado</span>':''}
          <span class="pill pill-ok small">#${u.priority||10}</span>
          <span class="pill small">${u.vendor||'anthropic'}</span>
          ${u.fallbackModel?'<span class="pill pill-warn small">fallback: '+escHtml(u.fallbackModel)+'</span>':''}
        </div>
        <div class="upstream-item-url muted small">${escHtml(u.baseUrl)}</div>
        <div class="upstream-item-key muted small">Key: ${escHtml(u.apiKey || "")}</div>
      </div>
      <div class="upstream-item-actions">
        <button class="btn-sm" onclick="editUpstream('${u.id}')">Editar</button>
        <button class="btn-sm danger" onclick="deleteUpstream('${u.id}')">Excluir</button>
      </div>
    </div>
  `).join("");
}

function showUpstreamForm(upstream) {
  const form = $("#upstreamForm");
  if (upstream) {
    $("#ufTitle").textContent = "Editar upstream";
    $("#ufId").value = upstream.id;
    $("#ufName").value = upstream.name;
    $("#ufUrl").value = upstream.baseUrl;
    $("#ufKey").value = "";
    $("#ufKey").placeholder = upstream.apiKey || "sk-...";
    $("#ufEnabled").checked = upstream.enabled !== false;
    $("#ufPriority").value = upstream.priority || 10;
    $("#ufVendor").value = upstream.vendor || "anthropic";
    $("#ufFallbackModel").value = upstream.fallbackModel || "";
  } else {
    $("#ufTitle").textContent = "Novo upstream";
    $("#ufId").value = "";
    $("#ufName").value = "";
    $("#ufUrl").value = "";
    $("#ufKey").value = "";
    $("#ufKey").placeholder = "sk-...";
    $("#ufEnabled").checked = true;
    $("#ufPriority").value = 10;
    $("#ufVendor").value = "anthropic";
    $("#ufFallbackModel").value = "";
  }
  form.classList.remove("hidden");
}
/* PLACEHOLDER_SETTINGS_ACTIONS */

window.editUpstream = (id) => {
  const u = (_cfg?.upstreams || []).find(x => x.id === id);
  if (u) showUpstreamForm(u);
};

window.deleteUpstream = async (id) => {
  if (!confirm("Excluir este upstream?")) return;
  const upstreams = (_cfg?.upstreams || []).filter(u => u.id !== id);
  await postConfig({ upstreams });
  refreshSettings();
};

$("#addUpstreamBtn").addEventListener("click", () => showUpstreamForm(null));
$("#ufCancelBtn").addEventListener("click", () => $("#upstreamForm").classList.add("hidden"));

$("#ufSaveBtn").addEventListener("click", async () => {
  const id = $("#ufId").value;
  const name = $("#ufName").value.trim();
  const baseUrl = $("#ufUrl").value.trim();
  const apiKey = $("#ufKey").value.trim();
  const enabled = $("#ufEnabled").checked;
  const priority = Number($("#ufPriority").value) || 10;
  const vendor = $("#ufVendor").value || "anthropic";
  const fallbackModel = $("#ufFallbackModel").value.trim() || null;
  if (!name || !baseUrl) return;
  let upstreams = [...(_cfg?.upstreams || [])];
  if (id) {
    upstreams = upstreams.map(u => {
      if (u.id !== id) return u;
      const updated = { ...u, name, baseUrl, enabled, priority, vendor, fallbackModel };
      if (apiKey) updated.apiKey = apiKey;
      return updated;
    });
  } else {
    upstreams.push({ name, baseUrl, apiKey: apiKey || "", enabled, priority, vendor, fallbackModel });
  }
  await postConfig({ upstreams });
  $("#upstreamForm").classList.add("hidden");
  refreshSettings();
});

$("#saveBridgeCfgBtn").addEventListener("click", async () => {
  const data = {
    defaultModel: $("#cfgDefaultModel").value.trim(),
    retry: { infinite: $("#cfgInfiniteRetry").checked, maxDelayMs: Number($("#cfgMaxDelay").value) },
    concurrency: { maxConcurrency: Number($("#cfgMaxConc").value), minIntervalMs: Number($("#cfgMinInterval").value), timeoutMs: Number($("#cfgTimeout").value) },
    circuit: { failures: Number($("#cfgCircuitFail").value), cooldownMs: Number($("#cfgCircuitCool").value) }
  };
  await postConfig(data);
  $("#bridgeCfgMsg").textContent = "Salvo!";
  setTimeout(() => { $("#bridgeCfgMsg").textContent = ""; }, 3000);
});

$("#savePassBtn").addEventListener("click", async () => {
  const pass = $("#cfgNewPass").value.trim();
  if (!pass) return;
  await postConfig({ dashboardPassword: pass });
  $("#passCfgMsg").textContent = "Senha alterada. Faça login novamente.";
  clearToken();
  setTimeout(() => init(), 1500);
});

/* ---- Keys Tab ---- */
async function refreshKeys() {
  try {
    const r = await fetch("/admin/keys", { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!r.ok) return;
    const keys = await r.json();
    renderKeysList(keys);
  } catch(e) { console.error("[keys]", e); }
  // Also refresh the detailed error log
  try {
    const r = await fetch("/admin/errors", { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!r.ok) return;
    const errors = await r.json();
    renderDetailErrors(errors);
  } catch(e) { console.error("[detail-errors]", e); }
}

function renderKeysList(keys) {
  const el = $("#keysList");
  if (!keys.length) {
    el.innerHTML = '<p class="muted small center">Nenhuma chave criada. Use a senha master ou crie chaves para rastrear uso.</p>';
    return;
  }
  el.innerHTML = keys.map(k => `
    <div class="key-item">
      <div class="key-item-info">
        <span class="key-item-name">${escHtml(k.name)}</span>
        <code class="key-item-value">${escHtml(k.key)}</code>
        <span class="muted small">${k.enabled ? '✓ ativa' : '✗ desabilitada'}</span>
      </div>
      <div class="key-item-stats muted small">
        <span>${k.requests} reqs</span> · <span class="bad">${k.errors} erros</span> · <span>último uso: ${k.lastUsed ? humanDate(k.lastUsed) : '—'}</span>
      </div>
      <div class="key-item-actions">
        <button class="btn-sm" onclick="toggleKey('${k.id}',${!k.enabled})">${k.enabled ? 'Desabilitar' : 'Habilitar'}</button>
        <button class="btn-sm danger" onclick="revokeKey('${k.id}')">Revogar</button>
      </div>
    </div>
  `).join("");
}

function renderDetailErrors(errors) {
  const tbody = $("#detailErrorTable");
  const empty = $("#detailErrorEmpty");
  const count = $("#detailErrorCount");
  if (!tbody) return;
  tbody.innerHTML = "";
  count.textContent = errors.length ? `(${errors.length})` : "";
  if (!errors.length) { empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  const recent = errors.slice(-100).reverse();
  for (const e of recent) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${humanTime(e.ts)}</td>
      <td><code>${escHtml(e.apiKeyName || '—')}</code></td>
      <td>${escHtml(e.model || '—')}</td>
      <td><code>${escHtml(e.route || '—')}</code></td>
      <td class="${(e.status||0)>=500?'bad':(e.status||0)>=400?'warn':''}">${e.status || '—'}</td>
      <td>${escHtml(e.upstream || '—')}</td>
      <td><code class="small">${escHtml(e.upstreamRequestId || '—')}</code></td>
      <td>${e.attempt || '—'}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(e.message||'')}">${escHtml((e.message||'').slice(0,80))}</td>`;
    tbody.appendChild(tr);
  }
}

window.toggleKey = async (id, enabled) => {
  await fetch(`/admin/keys/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  refreshKeys();
};

window.revokeKey = async (id) => {
  if (!confirm("Revogar esta chave? Ela deixará de funcionar imediatamente.")) return;
  await fetch(`/admin/keys/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${getToken()}` }
  });
  refreshKeys();
};

$("#createKeyBtn").addEventListener("click", async () => {
  const name = prompt("Nome da chave (ex: n8n-prod, cursor-matheus):");
  if (!name) return;
  const r = await fetch("/admin/keys", {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  const data = await r.json();
  if (data.key) {
    $("#newKeyValue").textContent = data.key;
    $("#newKeyResult").classList.remove("hidden");
  }
  refreshKeys();
});

/* ---- Usage Tab ---- */
async function refreshUsage() {
  try {
    const r = await fetch("/admin/usage", { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!r.ok) return;
    const data = await r.json();
    renderUsageSummary(data.summary);
    renderUsageByKey(data.byKey);
    renderUsageLog(data.log);
  } catch(e) { console.error("[usage]", e); }
}

function renderUsageSummary(s) {
  $("#usageTodayCost").textContent = "$" + (s.todayCostUsd || 0).toFixed(4);
  $("#usageMonthCost").textContent = "$" + (s.monthCostUsd || 0).toFixed(4);
  $("#usageTotalTokens").textContent = fmt((s.totalTokensIn || 0) + (s.totalTokensOut || 0));
  $("#usageTodayReqs").textContent = fmt(s.todayRequests || 0);
  $("#usageAvgCost").textContent = "$" + (s.avgCostPerReq || 0).toFixed(6);
}

function renderUsageByKey(byKey) {
  const tbody = $("#usageByKeyTable");
  const empty = $("#usageByKeyEmpty");
  tbody.innerHTML = "";
  if (!byKey || !byKey.length) { empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  for (const k of byKey) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><code>${escHtml(k.name)}</code></td><td>${fmt(k.requests)}</td><td>${fmt(k.tokensIn)}</td><td>${fmt(k.tokensOut)}</td><td>$${(k.costUsd||0).toFixed(4)}</td><td>${humanDate(k.lastUsed)}</td><td class="bad">${k.errors||0}</td><td>${k.avgMs||0} ms</td>`;
    tbody.appendChild(tr);
  }
}

function renderUsageLog(log) {
  const tbody = $("#usageLogTable");
  const empty = $("#usageLogEmpty");
  tbody.innerHTML = "";
  if (!log || !log.length) { empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  for (const e of log) {
    const tr = document.createElement("tr");
    const statusCls = e.ok ? "good" : "bad";
    const statusTxt = e.ok ? "ok" : "erro";
    tr.innerHTML = `<td>${humanTime(e.at)}</td><td><code>${escHtml(e.keyName||'\u2014')}</code></td><td>${escHtml(e.model||'\u2014')}</td><td><code>${escHtml(e.route||'\u2014')}</code></td><td>${escHtml(e.upstream||'\u2014')}</td><td>${fmt(e.tokensIn||0)}</td><td>${fmt(e.tokensOut||0)}</td><td>$${(e.costUsd||0).toFixed(4)}</td><td>${e.durationMs||0} ms</td><td class="${statusCls}">${statusTxt}</td><td><code class="small">${escHtml(e.requestId||'\u2014')}</code></td>`;
    tbody.appendChild(tr);
  }
}

/* ---- Auto-refresh ---- */
let timer = null;
function startTimer() { if (timer) clearInterval(timer); timer = setInterval(() => { refresh(); if (!$("#tabUsage").classList.contains("hidden")) refreshUsage(); }, 5000); }

/* ---- Event listeners (main tab) ---- */
$("#refreshBtn").addEventListener("click", refresh);
$("#resetBtn").addEventListener("click", resetMetrics);
$("#logoutBtn").addEventListener("click", () => { clearToken(); location.reload(); });
$("#testRunBtn").addEventListener("click", runTest);
$("#clearErrorsBtn").addEventListener("click", clearErrors);
$("#resetBudgetBtn").addEventListener("click", resetBudget);
$("#budgetDailyCap").addEventListener("change", () => { const v = Number($("#budgetDailyCap").value); if (v > 0) saveGuardrails({ budget: { daily_usd: v } }); });
$("#budgetDailyCap").addEventListener("keydown", (e) => { if (e.key === "Enter") { const v = Number($("#budgetDailyCap").value); if (v > 0) saveGuardrails({ budget: { daily_usd: v } }); } });
$("#clearSwapsBtn").addEventListener("click", clearSwaps);

["grPiiEnabled","grMaxTokensEnabled","grBudgetEnabled","grModelSwapEnabled"].forEach(id => {
  $("#" + id).addEventListener("change", () => {
    saveGuardrails({
      pii: { enabled: $("#grPiiEnabled").checked },
      max_tokens: { enabled: $("#grMaxTokensEnabled").checked },
      budget: { enabled: $("#grBudgetEnabled").checked },
      model_swap: { enabled: $("#grModelSwapEnabled").checked }
    });
  });
});

$("#grMaxTokensSave").addEventListener("click", () => { const v = Number($("#grMaxTokensLimit").value); if (v > 0) saveGuardrails({ max_tokens: { limit: v } }); });
$("#grMaxTokensLimit").addEventListener("keydown", (e) => { if (e.key === "Enter") { const v = Number($("#grMaxTokensLimit").value); if (v > 0) saveGuardrails({ max_tokens: { limit: v } }); } });

/* ---- Modal ---- */
$("#modalCloseBtn").addEventListener("click", closeErrorModal);
$("#errorModal").addEventListener("click", (e) => { if (e.target === $("#errorModal")) closeErrorModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeErrorModal(); });
/* ---- Payments Tab ---- */
async function loadPayments() {
  const token = getToken();
  try {
    const res = await fetch("/portal/admin/payments", {
      headers: { "x-dashboard-token": token }
    });
    if (!res.ok) {
      $("#pendingPayments").innerHTML = '<p class="muted">Sem acesso (verifique permissão admin)</p>';
      return;
    }
    const data = await res.json();
    renderPendingPayments(data.pending || []);
    renderRecentPayments(data.recent || []);
  } catch (e) {
    $("#pendingPayments").innerHTML = `<p class="muted">Erro: ${escHtml(e.message)}</p>`;
  }
}

function renderPendingPayments(orders) {
  if (!orders.length) {
    $("#pendingPayments").innerHTML = '<p class="muted">Nenhum pedido pendente 🎉</p>';
    return;
  }
  const rows = orders.map(o => `
    <tr>
      <td>#${o.id}</td>
      <td>${escHtml(o.email || '')}</td>
      <td>${escHtml(o.name || '')}</td>
      <td><span class="badge">${o.plan_id}</span></td>
      <td>R$ ${Number(o.amount_brl || 0).toFixed(2)}</td>
      <td>${humanDate(o.created_at)}</td>
      <td>
        <button class="btn-sm btn-ok" onclick="confirmPayment(${o.id})">✓ Confirmar</button>
        <button class="btn-sm btn-danger" onclick="rejectPayment(${o.id})">✗ Rejeitar</button>
      </td>
    </tr>
  `).join('');
  $("#pendingPayments").innerHTML = `
    <div class="table-scroll">
      <table class="mini"><thead><tr><th>ID</th><th>Email</th><th>Nome</th><th>Plano</th><th>Valor</th><th>Data</th><th>Ações</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
}

function renderRecentPayments(orders) {
  if (!orders.length) {
    $("#recentPayments").innerHTML = '<p class="muted">Nenhum confirmado recente</p>';
    return;
  }
  const rows = orders.map(o => `
    <tr>
      <td>#${o.id}</td>
      <td>${escHtml(o.email || '')}</td>
      <td>${o.plan_id}</td>
      <td>R$ ${Number(o.amount_brl || 0).toFixed(2)}</td>
      <td>${humanDate(o.confirmed_at || o.created_at)}</td>
    </tr>
  `).join('');
  $("#recentPayments").innerHTML = `
    <div class="table-scroll">
      <table class="mini"><thead><tr><th>ID</th><th>Email</th><th>Plano</th><th>Valor</th><th>Confirmado</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>`;
}

async function confirmPayment(id) {
  const token = getToken();
  try {
    const res = await fetch(`/portal/admin/payments/${id}/confirm`, {
      method: "POST",
      headers: { "x-dashboard-token": token }
    });
    const data = await res.json();
    if (data.ok) {
      alert(`✓ Confirmado! API Key: ${data.api_key}\nExpira: ${data.expires_at}`);
      loadPayments();
    } else {
      alert(`Erro: ${data.error}`);
    }
  } catch (e) { alert(`Erro: ${e.message}`); }
}

async function rejectPayment(id) {
  if (!confirm("Rejeitar este pagamento?")) return;
  const token = getToken();
  try {
    const res = await fetch(`/portal/admin/payments/${id}/reject`, {
      method: "POST",
      headers: { "x-dashboard-token": token }
    });
    const data = await res.json();
    if (data.ok) { loadPayments(); }
    else { alert(`Erro: ${data.error}`); }
  } catch (e) { alert(`Erro: ${e.message}`); }
}

// Hook into tab switching to load payments
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'tabPayments') loadPayments();
  });
});

/* ---- Profit/Loss Tab ---- */
async function loadProfit() {
  const token = getToken();
  try {
    const res = await fetch("/portal/admin/profit", {
      headers: { "x-dashboard-token": token }
    });
    if (!res.ok) { document.getElementById('profitTable').innerHTML = '<tr><td colspan="10">Erro ao carregar</td></tr>'; return; }
    const data = await res.json();

    // Populate cost config inputs from backend
    if (data.cost_config) {
      const cc = data.cost_config;
      if (document.getElementById('rcInput')) document.getElementById('rcInput').value = cc.inputPriceYuanPerM;
      if (document.getElementById('rcOutput')) document.getElementById('rcOutput').value = cc.outputPriceYuanPerM;
      if (document.getElementById('rcCacheWrite')) document.getElementById('rcCacheWrite').value = cc.cacheWritePriceYuanPerM;
      if (document.getElementById('rcCacheRead')) document.getElementById('rcCacheRead').value = cc.cacheReadPriceYuanPerM;
      if (document.getElementById('rcFx')) document.getElementById('rcFx').value = cc.fxCnyToBrl;
    }

    // Render table from pre-calculated backend values
    const rows = data.accounts.map(a => {
      const marginPct = a.margin_pct !== null ? a.margin_pct.toFixed(1) : '-';
      const cls = a.in_red ? 'style="background:rgba(239,68,68,0.1)"' : '';
      return `<tr ${cls}><td>${escHtml(a.email)}</td><td>${a.plan_id||'-'}</td><td>${a.revenue.toFixed(2)}</td><td>${fmt(a.tokens_input)}</td><td>${fmt(a.tokens_output)}</td><td>${fmt(a.tokens_cache_write)}</td><td>${fmt(a.tokens_cache_read)}</td><td>${a.cost_brl.toFixed(2)}</td><td>${a.margin_brl.toFixed(2)}</td><td>${marginPct}%</td></tr>`;
    }).join('');

    document.getElementById('profitTable').innerHTML = rows || '<tr><td colspan="10">Nenhuma conta</td></tr>';

    // Totals from backend
    const t = data.totals;
    document.getElementById('profitRevenue').textContent = 'R$ ' + t.total_revenue_brl.toFixed(2);
    document.getElementById('profitCost').textContent = 'R$ ' + t.total_cost_brl.toFixed(2);
    document.getElementById('profitNet').textContent = 'R$ ' + t.net_profit_brl.toFixed(2);
    document.getElementById('profitNet').style.color = t.net_profit_brl >= 0 ? '#22c55e' : '#ef4444';
    document.getElementById('profitRedAccounts').textContent = t.accounts_in_red;
  } catch (e) { console.error(e); }
}

// Hook: load profit when tab opens
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => { if (btn.dataset.tab === 'tabProfit') loadProfit(); });
});

/* ---- Quota Config ---- */
async function loadQuotaConfig() {
  const token = getToken();
  try {
    const res = await fetch("/portal/admin/quota-config", { headers: { "x-dashboard-token": token } });
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.tetoDiarioDivisor !== undefined) document.getElementById('qcTetoDiario').value = cfg.tetoDiarioDivisor;
    if (cfg.throttleThreshold !== undefined) document.getElementById('qcThrottle').value = cfg.throttleThreshold;
    if (cfg.pesoUltimaSemana !== undefined) document.getElementById('qcPesoUltima').value = cfg.pesoUltimaSemana;
    if (cfg.forfeitSemana1 !== undefined) document.getElementById('qcForfeit1').value = cfg.forfeitSemana1;
    if (cfg.forfeitSemanasMeio !== undefined) document.getElementById('qcForfeitMeio').value = cfg.forfeitSemanasMeio;
  } catch {}
}

async function saveQuotaConfig() {
  const token = getToken();
  const cfg = {
    tetoDiarioDivisor: Number(document.getElementById('qcTetoDiario').value) || 5,
    throttleThreshold: Number(document.getElementById('qcThrottle').value) || 0.70,
    pesoUltimaSemana: Number(document.getElementById('qcPesoUltima').value) || 1.5,
    forfeitSemana1: Number(document.getElementById('qcForfeit1').value) || 1.0,
    forfeitSemanasMeio: Number(document.getElementById('qcForfeitMeio').value) || 0.5,
  };
  try {
    const res = await fetch("/portal/admin/quota-config", {
      method: "PUT", headers: { "x-dashboard-token": token, "Content-Type": "application/json" },
      body: JSON.stringify(cfg)
    });
    const data = await res.json();
    document.getElementById('qcStatus').textContent = data.ok ? '✓ Salvo' : '✗ Erro';
    setTimeout(() => document.getElementById('qcStatus').textContent = '', 3000);
  } catch (e) { document.getElementById('qcStatus').textContent = '✗ ' + e.message; }
}

// Load quota config when profit tab opens
document.querySelectorAll('.tab-btn').forEach(btn => {
  const orig = btn._profitListener;
  btn.addEventListener('click', () => { if (btn.dataset.tab === 'tabProfit') loadQuotaConfig(); });
});


/* ---- Cost Config ---- */
async function saveCostConfig() {
  const token = getToken();
  const cfg = {
    inputPriceYuanPerM: Number(document.getElementById('rcInput').value) || 1.5,
    outputPriceYuanPerM: Number(document.getElementById('rcOutput').value) || 7.5,
    cacheWritePriceYuanPerM: Number(document.getElementById('rcCacheWrite').value) || 1.875,
    cacheReadPriceYuanPerM: Number(document.getElementById('rcCacheRead').value) || 0.15,
    fxCnyToBrl: Number(document.getElementById('rcFx').value) || 0.76,
  };
  try {
    await fetch("/portal/admin/cost-config", {
      method: "PUT", headers: { "x-dashboard-token": token, "Content-Type": "application/json" },
      body: JSON.stringify(cfg)
    });
    loadProfit(); // Reload with new config
  } catch (e) { console.error(e); }
}
