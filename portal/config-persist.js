/**
 * Config persistence registry — avoids circular imports.
 *
 * server.js registers a persist() callback on startup.
 * Any module can import and call persistNow() to save config immediately.
 * The 5s interval in server.js remains as a safety net.
 */

let _persist = null;

/**
 * Register the persist callback (called once from server.js).
 * The callback should sync all in-memory configs to disk.
 */
export function registerPersist(fn) {
  _persist = fn;
}

/**
 * Persist config NOW. Safe to call frequently — it's a sync write.
 * No-op if persist callback hasn't been registered yet (startup race).
 */
export function persistNow() {
  if (_persist) {
    try { _persist(); } catch (e) {
      console.error('[config-persist] Error:', e.message);
    }
  }
}
