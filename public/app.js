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
  const key = $("#setupProxyKey").value.trim();
  const err = $("#setupError");
  if (!pass) { err.textContent = "Senha obrigatória."; err.classList.remove("hidden"); return; }
  if (!key) { err.textContent = "PROXY_API_KEY obrigatória."; err.classList.remove("hidden"); return; }
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
        proxyApiKey: $("#setupProxyKey").value.trim(),
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
    $("#tabSettings").classList.toggle("hidden", tab !== "tabSettings");
    if (tab === "tabSettings") refreshSettings();
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
    ["Método", error.method], ["Tipo", errorTypeBadge(error.type)], ["Status HTTP", error.status],
    ["Retries", error.retries_taken], ["Duração", error.duration_ms ? error.duration_ms + " ms" : "—"],
    ["Upstream URL", error.upstream_url], ["Mensagem", error.message]
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
  $("#cfgProxyKey").value = "";
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
        <div class="upstream-item-name">${escHtml(u.name)} ${u.enabled===false?'<span class="pill pill-warn">desativado</span>':''}</div>
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
  } else {
    $("#ufTitle").textContent = "Novo upstream";
    $("#ufId").value = "";
    $("#ufName").value = "";
    $("#ufUrl").value = "";
    $("#ufKey").value = "";
    $("#ufKey").placeholder = "sk-...";
    $("#ufEnabled").checked = true;
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
  if (!name || !baseUrl) return;
  let upstreams = [...(_cfg?.upstreams || [])];
  if (id) {
    upstreams = upstreams.map(u => {
      if (u.id !== id) return u;
      const updated = { ...u, name, baseUrl, enabled };
      if (apiKey) updated.apiKey = apiKey;
      return updated;
    });
  } else {
    upstreams.push({ name, baseUrl, apiKey: apiKey || "", enabled });
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
  const pk = $("#cfgProxyKey").value.trim();
  if (pk) data.proxyApiKey = pk;
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

/* ---- Auto-refresh ---- */
let timer = null;
function startTimer() { if (timer) clearInterval(timer); timer = setInterval(refresh, 5000); }

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