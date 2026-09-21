'use strict';

/**
 * LyricVision LCD — hardening helpers (LV-06).
 *
 * Pure Node (no Electron imports) so tests/test_hardening.js exercises the
 * EXACT logic main.js runs with: central redact(), in-memory ring log,
 * bridge watchdog with backoff, redacted settings + diagnostics payload.
 *
 * Privacy rule: tokens / client secrets / OAuth codes / USB serials are
 * redacted by redact() before they reach the ring, the console, or the
 * diagnostics file. Nothing PII hits disk outside the in-memory ring.
 */

const RING_CAP = 200;
const WATCHDOG_TIMEOUT_MS = 5000; // sidecar is late at ~1Hz (status + ack)
const WATCHDOG_BACKOFF_CAP_MS = 30000;

/**
 * Central redaction. Full `<redacted>` for known secret shapes, partial
 * first4…last2 mask as a fallback for long secret-looking runs.
 * Non-strings pass through untouched.
 */
function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  // OAuth authorization codes: ?code=… / &code=… / "code": "…"
  out = out.replace(/([?&]code=)([^&\s"'`]+)/gi, '$1<redacted>');
  out = out.replace(/(["']code["']\s*[:=]\s*["']?)([^"'`\s&;,}]+)/gi, '$1<redacted>');
  // OAuth client secrets (quoted JSON keys or bare form).
  out = out.replace(/((?:client[_-]?secret)["']?\s*[:=]\s*["']?)([^"'`\s&;,}]+)/gi, '$1<redacted>');
  // Tokens: access_token / refresh_token / id_token (+ Bearer scheme).
  out = out.replace(
    /((?:access[_-]?token|refresh[_-]?token|id[_-]?token)["']?\s*[:=]\s*["']?)([^"'`\s&;,}]+)/gi,
    '$1<redacted>'
  );
  out = out.replace(/(Bearer\s+)[^\s"'`]+/gi, '$1<redacted>');
  // USB serials: serial=… / "serial": "…" / --serial … (spawn args get logged).
  out = out.replace(/((?:serial)["']?\s*[:=]\s*["']?)([^"'`\s&;,}]+)/gi, '$1<redacted>');
  out = out.replace(/(--serial\s+)([^\s"'`]+)/gi, '$1<redacted>');
  // Fallback: long secret-looking runs (>= 20 chars of the token alphabet).
  // Deliberately NOT short runs: normal words ("streaming", "authorization")
  // must survive logging untouched.
  out = out.replace(/([A-Za-z0-9_-]{4})[A-Za-z0-9._~+/-]{16,}([A-Za-z0-9_-]{2})/g, '$1…$2');
  return out;
}

/**
 * In-memory ring log: capped buffer of {ts, level, msg} (oldest-first).
 * Messages are redacted on entry. Never persisted to disk by itself.
 */
class RingLog {
  constructor(cap = RING_CAP) {
    this.cap = Math.max(1, Math.floor(Number(cap) || RING_CAP));
    this.buf = [];
  }

  push(level, msg) {
    const entry = { ts: Date.now(), level: String(level || 'info'), msg: redact(String(msg)) };
    this.buf.push(entry);
    while (this.buf.length > this.cap) this.buf.shift();
    return entry;
  }

  entries() {
    return this.buf.slice();
  }

  get size() {
    return this.buf.length;
  }

  clear() {
    this.buf.length = 0;
  }
}

/**
 * Restart backoff: 1s, 2s, 4s, … capped at 30s.
 * @param {number} restarts - 1-based consecutive-restart count
 */
function watchdogBackoffMs(restarts) {
  const n = Math.max(1, Math.floor(Number(restarts) || 1));
  return Math.min(WATCHDOG_BACKOFF_CAP_MS, 1000 * 2 ** (n - 1));
}

/**
 * Bridge watchdog (pure; the child is mocked in tests — no spawns here).
 *
 * The sidecar emits status ~1Hz plus an ack per rendered frame. While a
 * stream is expected, >timeoutMs without EITHER means the child is wedged:
 * check() fires onRestart exactly once per episode (no restart storms);
 * a heartbeat() recovers back to ok/degraded. Crash-loop escalation comes
 * from noteRestart() (1s/2s/4s… cap 30s); heartbeats reset the counter.
 */
function createBridgeWatchdog({ onRestart = () => {}, timeoutMs = WATCHDOG_TIMEOUT_MS, nowFn = () => Date.now() } = {}) {
  let lastActivityMs = nowFn();
  let expecting = false;
  let wedged = false;
  let restarts = 0;
  let lastDelayMs = 0;

  function heartbeat(atMs) {
    lastActivityMs = typeof atMs === 'number' ? atMs : nowFn();
    const recovered = wedged;
    wedged = false;
    restarts = 0; // sustained activity resets the backoff
    return recovered;
  }

  function setExpecting(value) {
    expecting = value === true;
    if (!expecting) wedged = false;
  }

  function noteRestart() {
    restarts += 1;
    lastDelayMs = watchdogBackoffMs(restarts);
    return lastDelayMs;
  }

  function check(atMs) {
    const now = typeof atMs === 'number' ? atMs : nowFn();
    if (!expecting || wedged) return { wedged, restarts, restarted: false };
    if (now - lastActivityMs > timeoutMs) {
      wedged = true;
      const delayMs = watchdogBackoffMs(restarts + 1);
      lastDelayMs = delayMs;
      try {
        onRestart({ delayMs, silentMs: now - lastActivityMs });
      } catch {
        // restart scheduling must never throw into the tick
      }
      return { wedged: true, restarts, restarted: true, delayMs };
    }
    return { wedged: false, restarts, restarted: false };
  }

  function isWedged() {
    return wedged;
  }

  function getState() {
    return { expecting, wedged, restarts, lastActivityMs, lastDelayMs };
  }

  return { heartbeat, setExpecting, noteRestart, check, isWedged, getState };
}

/**
 * Renderer/file-safe settings: serial is PII (mask by key — short serials
 * would dodge the generic long-run fallback), client ID goes through the
 * central redact, the rest are plain numbers/booleans.
 */
function redactSettings(settings) {
  const src = settings && typeof settings === 'object' ? settings : {};
  const out = { ...src };
  if (typeof out.serial === 'string' && out.serial) out.serial = '<redacted>';
  if (typeof out.spotifyClientId === 'string' && out.spotifyClientId) {
    out.spotifyClientId = redact(out.spotifyClientId);
  }
  return out;
}

/**
 * Diagnostics payload (written by main's `diagnostics:export`, never with
 * raw secrets — settings and ring entries are redacted).
 */
function buildDiagnostics({ settings, lcdStatus, ringEntries, versions, bridge } = {}) {
  return {
    ts: new Date().toISOString(),
    versions: {
      app: (versions && versions.app) || '',
      electron: (versions && versions.electron) || '',
      bridge: (versions && versions.bridge) || '',
    },
    settings: redactSettings(settings),
    lcdStatus: lcdStatus && typeof lcdStatus === 'object' ? { ...lcdStatus } : null,
    bridge: bridge && typeof bridge === 'object' ? { ...bridge } : null,
    ring: Array.isArray(ringEntries) ? ringEntries.slice(-RING_CAP) : [],
  };
}

module.exports = {
  RING_CAP,
  WATCHDOG_TIMEOUT_MS,
  WATCHDOG_BACKOFF_CAP_MS,
  redact,
  RingLog,
  watchdogBackoffMs,
  createBridgeWatchdog,
  redactSettings,
  buildDiagnostics,
};
