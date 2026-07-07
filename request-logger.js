// ============================================================
// REQUEST LOGGER — Sistema de rastreabilidade completo
// ============================================================
// Grava todas as requisições em SQLite com detalhes de IP, headers,
// modelo, tokens, custo, latência e payload samples.
// Limpeza automática de logs > 7 dias.
// ============================================================

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import { randomBytes } from 'crypto';

// ============================================================
// 1. CONFIGURAÇÃO E INICIALIZAÇÃO
// ============================================================

const DB_PATH = (() => {
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    return '/data/bridge-logs.db';
  } catch {
    try {
      fs.accessSync('/app', fs.constants.W_OK);
      return '/app/bridge-logs.db';
    } catch {
      return path.join(process.cwd(), 'bridge-logs.db');
    }
  }
})();

const RETENTION_DAYS = 7;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5000;

let db = null;
let logBuffer = [];
let flushTimer = null;

// ============================================================
// 2. INICIALIZAÇÃO DO BANCO
// ============================================================

export async function initRequestLogger() {
  if (db) return db;

  const SQL = await initSqlJs();

  // Carrega banco existente ou cria novo
  let buffer = null;
  try {
    if (fs.existsSync(DB_PATH)) {
      buffer = fs.readFileSync(DB_PATH);
    }
  } catch (err) {
    console.error('[request-logger] Failed to read existing DB:', err.message);
  }

  db = buffer ? new SQL.Database(buffer) : new SQL.Database();

  // Cria tabela de logs
  db.run(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT UNIQUE NOT NULL,
      timestamp TEXT NOT NULL,

      -- Key info
      key_id TEXT,
      key_name TEXT,

      -- Request details
      method TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      client_ip TEXT,
      user_agent TEXT,
      referer TEXT,

      -- Model & usage
      provider TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cost_brl REAL DEFAULT 0,

      -- Response
      status_code INTEGER,
      success INTEGER DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      error_message TEXT,

      -- Payload samples (opcional)
      request_body_sample TEXT,
      response_body_sample TEXT,

      -- Metadata
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Índices para queries rápidas
  db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_key_id ON request_logs(key_id, timestamp DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model, timestamp DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status_code, timestamp DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_request_logs_success ON request_logs(success, timestamp DESC)`);

  // Salva no disco
  saveDB();

  console.log('[request-logger] Initialized SQLite database at', DB_PATH);

  // Inicia timer de flush periódico
  startFlushTimer();

  // Agenda limpeza diária
  scheduleCleanup();

  return db;
}

// ============================================================
// 3. GRAVAÇÃO DE LOGS (ASSÍNCRONA COM BATCHING)
// ============================================================

export function logRequest(entry) {
  if (!db) {
    console.warn('[request-logger] DB not initialized, dropping log entry');
    return;
  }

  logBuffer.push(entry);

  // Flush imediato se buffer lotou
  if (logBuffer.length >= BATCH_SIZE) {
    flushLogs();
  }
}

function flushLogs() {
  if (!db || logBuffer.length === 0) return;

  const batch = logBuffer.splice(0, logBuffer.length);

  try {
    const stmt = db.prepare(`
      INSERT INTO request_logs (
        request_id, timestamp, key_id, key_name, method, endpoint,
        client_ip, user_agent, referer, provider, model,
        input_tokens, output_tokens, total_tokens, cost_brl,
        status_code, success, latency_ms, error_message,
        request_body_sample, response_body_sample
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const entry of batch) {
      stmt.run([
        entry.requestId || generateRequestId(),
        entry.timestamp || new Date().toISOString(),
        entry.keyId || null,
        entry.keyName || null,
        entry.method || 'UNKNOWN',
        entry.endpoint || '/',
        entry.clientIp || null,
        entry.userAgent || null,
        entry.referer || null,
        entry.provider || null,
        entry.model || null,
        entry.inputTokens || 0,
        entry.outputTokens || 0,
        entry.totalTokens || 0,
        entry.costBrl || 0,
        entry.statusCode || 0,
        entry.success ? 1 : 0,
        entry.latencyMs || 0,
        entry.errorMessage || null,
        entry.requestBodySample || null,
        entry.responseBodySample || null,
      ]);
    }

    stmt.free();
    saveDB();
  } catch (err) {
    console.error('[request-logger] Failed to flush logs:', err.message);
    // Re-adiciona entries ao buffer para não perder
    logBuffer.unshift(...batch);
  }
}

function startFlushTimer() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => {
    if (logBuffer.length > 0) {
      flushLogs();
    }
  }, FLUSH_INTERVAL_MS);
}

function saveDB() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    console.error('[request-logger] Failed to save DB:', err.message);
  }
}

// ============================================================
// 4. CONSULTAS
// ============================================================

export function queryLogs(filters = {}) {
  if (!db) return [];

  const {
    keyId,
    model,
    statusCode,
    success,
    fromDate,
    toDate,
    limit = 100,
    offset = 0,
  } = filters;

  let sql = 'SELECT * FROM request_logs WHERE 1=1';
  const params = [];

  if (keyId) {
    sql += ' AND key_id = ?';
    params.push(keyId);
  }

  if (model) {
    sql += ' AND model = ?';
    params.push(model);
  }

  if (statusCode !== undefined) {
    sql += ' AND status_code = ?';
    params.push(statusCode);
  }

  if (success !== undefined) {
    sql += ' AND success = ?';
    params.push(success ? 1 : 0);
  }

  if (fromDate) {
    sql += ' AND timestamp >= ?';
    params.push(fromDate);
  }

  if (toDate) {
    sql += ' AND timestamp <= ?';
    params.push(toDate);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);

    const rows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      row.success = Boolean(row.success);
      rows.push(row);
    }
    stmt.free();

    return rows;
  } catch (err) {
    console.error('[request-logger] Query failed:', err.message);
    return [];
  }
}

export function getLogById(requestId) {
  if (!db) return null;

  try {
    const stmt = db.prepare('SELECT * FROM request_logs WHERE request_id = ?');
    stmt.bind([requestId]);

    let row = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
      row.success = Boolean(row.success);
    }
    stmt.free();

    return row;
  } catch (err) {
    console.error('[request-logger] getLogById failed:', err.message);
    return null;
  }
}

export function getLogsSummary(filters = {}) {
  if (!db) return {};

  const { keyId, fromDate, toDate } = filters;

  let sql = `
    SELECT
      COUNT(*) as total_requests,
      SUM(success) as total_success,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as total_errors,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(cost_brl) as total_cost_brl,
      AVG(latency_ms) as avg_latency_ms,
      MIN(timestamp) as first_request,
      MAX(timestamp) as last_request
    FROM request_logs
    WHERE 1=1
  `;

  const params = [];

  if (keyId) {
    sql += ' AND key_id = ?';
    params.push(keyId);
  }

  if (fromDate) {
    sql += ' AND timestamp >= ?';
    params.push(fromDate);
  }

  if (toDate) {
    sql += ' AND timestamp <= ?';
    params.push(toDate);
  }

  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);

    let summary = {};
    if (stmt.step()) {
      summary = stmt.getAsObject();
    }
    stmt.free();

    return summary;
  } catch (err) {
    console.error('[request-logger] getLogsSummary failed:', err.message);
    return {};
  }
}

// ============================================================
// 5. LIMPEZA AUTOMÁTICA
// ============================================================

function cleanupOldLogs() {
  if (!db) return;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoffISO = cutoffDate.toISOString();

  try {
    const result = db.exec(`DELETE FROM request_logs WHERE timestamp < '${cutoffISO}'`);
    saveDB();

    const deleted = result[0]?.values?.length || 0;
    if (deleted > 0) {
      console.log(`[request-logger] Cleaned up ${deleted} logs older than ${RETENTION_DAYS} days`);
    }
  } catch (err) {
    console.error('[request-logger] Cleanup failed:', err.message);
  }
}

function scheduleCleanup() {
  // Roda a cada 24 horas
  setInterval(() => {
    cleanupOldLogs();
  }, 24 * 60 * 60 * 1000);

  // Roda imediatamente na inicialização também
  cleanupOldLogs();
}

// ============================================================
// 6. HELPERS
// ============================================================

function generateRequestId() {
  return randomBytes(16).toString('hex');
}

export function sanitizeBodySample(body, maxLen = 500) {
  if (!body) return null;

  try {
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + '...';
  } catch {
    return '[invalid body]';
  }
}

// ============================================================
// 7. SHUTDOWN GRACIOSO
// ============================================================

export function shutdownRequestLogger() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Flush final
  flushLogs();

  console.log('[request-logger] Shutdown complete');
}

process.on('SIGTERM', shutdownRequestLogger);
process.on('SIGINT', shutdownRequestLogger);
