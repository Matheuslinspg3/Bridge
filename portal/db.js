import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = (() => {
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    return '/data/claudbridge.db';
  } catch {
    return path.join(process.cwd(), 'claudbridge.db');
  }
})();

let db = null;

// Initialize DB (must be called before use)
export async function initDB() {
  if (db) return db;
  const SQL = await initSqlJs();

  // Load existing DB file if exists
  let buffer = null;
  try {
    if (fs.existsSync(DB_PATH)) {
      buffer = fs.readFileSync(DB_PATH);
    }
  } catch {}

  db = buffer ? new SQL.Database(buffer) : new SQL.Database();

  // Create schema
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      enabled INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_id TEXT NOT NULL,
      amount_brl REAL NOT NULL,
      pix_payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT,
      rejected_at TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_id TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      starts_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key TEXT NOT NULL,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      logged_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Save periodically
  setInterval(() => saveDB(), 30000);

  return db;
}

export function saveDB() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('[portal/db] Save error:', e.message);
  }
}

export function getDB() {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  return db;
}

// Helper: run a query and return rows as objects
export function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Helper: get single row
export function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

// Helper: run statement (INSERT/UPDATE/DELETE)
export function run(sql, params = []) {
  db.run(sql, params);
  // For inserts, get last id
  const result = db.exec('SELECT last_insert_rowid() as id');
  const lastId = result[0]?.values[0]?.[0] || 0;
  return { lastInsertRowid: lastId };
}

export { DB_PATH };
