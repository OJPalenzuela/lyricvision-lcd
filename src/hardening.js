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

// ---------------------------------------------------------------------------
// Scene gate (S0-T1) — authoritative validator for the settings:save `scene`
// key. Mirrors the type guards in src/renderer/lib/scene.ts: the renderer copy
// gives the editor instant feedback, THIS copy gates input that never passed
// TypeScript. Policy: reject, never clamp/coerce — a bad value is a bug to
// surface, not to paper over. Stays pure (no fs, no electron).
// ---------------------------------------------------------------------------

const SCENE_VERSION = 1;
// Bounds per-frame overlay cost: every overlay is a live render node the
// bridge composites at LCD fps. Kept in lockstep with the renderer model.
const SCENE_OVERLAYS_CAP = 32;
// Blank portrait scene. src/renderer/lib/scene.ts keeps an identical copy —
// lockstep-tested in tests/renderer/scene.test.ts.
const DEFAULT_SCENE = { version: 1, background: { kind: 'none' }, overlays: [] };

const SCENE_KEYS = ['version', 'background', 'overlays'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Mirror of SCENE_MAX_TEXT_CHARS in bridge/lcd_bridge.py (render cap) and
// bridge/protocol.py (validation cap). The literal necessarily repeats here
// (this CommonJS gate cannot import a TS module); the duplication is pinned
// equal by tests/renderer/text-length-gate.test.ts, which reads the constant
// straight out of lcd_bridge.py.
const SCENE_MAX_TEXT_CHARS = 4096;

function sceneReject(field, error) {
  return { ok: false, field, error };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** First key of `value` outside `allowed` (null when the shape is clean). */
function firstUnknownKey(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

/**
 * First own enumerable key of an ARRAY that is not one of its canonical
 * index keys ("evil", "1.5", "007" all qualify). Object.keys skips holes, so
 * a hole is reported by the index loop in validateSceneShape instead.
 */
function firstNonIndexKey(value) {
  const length = value.length;
  for (const key of Object.keys(value)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      return key;
    }
  }
  return null;
}

function isHexColor(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUnitFraction(value) {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/**
 * Source gate: non-empty string, no NUL (C-level path APIs truncate there),
 * and no ".." SEGMENT across either separator — "smile..png" stays legal.
 */
function isSource(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.indexOf('\u0000') !== -1) return false;
  return !value.split(/[/\\]/).includes('..');
}

/** Allowed keys per background kind; null = unknown discriminant (reject). */
function backgroundKeys(kind) {
  switch (kind) {
    case 'none':
      return ['kind'];
    case 'color':
      return ['kind', 'color'];
    case 'image':
    case 'gif':
    case 'video':
      return ['kind', 'source', 'rotation', 'flipH', 'scale', 'panX', 'panY', 'fit'];
    default:
      return null;
  }
}

/** Allowed keys per overlay kind; null = unknown discriminant (reject). */
function overlayKeys(kind) {
  switch (kind) {
    case 'text':
      return ['kind', 'text', 'x', 'y', 'size', 'rotation', 'color'];
    case 'gpu-temp':
      return ['kind', 'x', 'y', 'size', 'rotation', 'color'];
    default:
      return null;
  }
}

/** @returns {{ok:true, value:object}|{ok:false, field:string, error:string}} */
function validateSceneBackground(value) {
  if (!isPlainObject(value)) return sceneReject('background', 'background must be an object');
  const allowed = backgroundKeys(value.kind);
  if (!allowed) return sceneReject('background.kind', `unknown background kind: ${String(value.kind)}`);
  const unknownKey = firstUnknownKey(value, allowed);
  if (unknownKey !== null) {
    return sceneReject(`background.${unknownKey}`, `unknown background key: ${unknownKey}`);
  }
  switch (value.kind) {
    case 'none':
      return { ok: true, value: { kind: 'none' } };
    case 'color':
      if (!isHexColor(value.color)) return sceneReject('background.color', 'color must match #rrggbb');
      return { ok: true, value: { kind: 'color', color: value.color } };
    case 'image':
    case 'gif':
    case 'video': {
      if (!isSource(value.source)) {
        return sceneReject('background.source', 'source must be a non-empty string without NUL or ".." segments');
      }
      if (!isFiniteNumber(value.rotation)) return sceneReject('background.rotation', 'rotation must be a finite number');
      if (typeof value.flipH !== 'boolean') return sceneReject('background.flipH', 'flipH must be a boolean');
      if (typeof value.scale !== 'number' || !Number.isFinite(value.scale) || value.scale <= 0) {
        return sceneReject('background.scale', 'scale must be a finite number greater than 0');
      }
      if (!isFiniteNumber(value.panX)) return sceneReject('background.panX', 'panX must be a finite number');
      if (!isFiniteNumber(value.panY)) return sceneReject('background.panY', 'panY must be a finite number');
      if (value.fit !== 'fit' && value.fit !== 'fill') return sceneReject('background.fit', "fit must be 'fit' or 'fill'");
      return {
        ok: true,
        value: {
          kind: value.kind,
          source: value.source,
          rotation: value.rotation,
          flipH: value.flipH,
          scale: value.scale,
          panX: value.panX,
          panY: value.panY,
          fit: value.fit,
        },
      };
    }
    default:
      // Unreachable: backgroundKeys() already rejected unknown discriminants.
      return sceneReject('background.kind', `unknown background kind: ${String(value.kind)}`);
  }
}

/** @returns {{ok:true, value:object}|{ok:false, field:string, error:string}} */
function validateSceneOverlay(value, index) {
  const at = `overlays[${index}]`;
  if (!isPlainObject(value)) return sceneReject(at, 'overlay must be an object');
  const allowed = overlayKeys(value.kind);
  if (!allowed) return sceneReject(`${at}.kind`, `unknown overlay kind: ${String(value.kind)}`);
  const unknownKey = firstUnknownKey(value, allowed);
  if (unknownKey !== null) {
    return sceneReject(`${at}.${unknownKey}`, `unknown overlay key: ${unknownKey}`);
  }
  if (value.kind === 'text' && typeof value.text !== 'string') {
    return sceneReject(`${at}.text`, 'text must be a string');
  }
  if (value.kind === 'text' && value.text.length > SCENE_MAX_TEXT_CHARS) {
    return sceneReject(`${at}.text`, `text exceeds ${SCENE_MAX_TEXT_CHARS} characters`);
  }
  if (!isUnitFraction(value.x)) return sceneReject(`${at}.x`, 'x must be a fraction in [0,1]');
  if (!isUnitFraction(value.y)) return sceneReject(`${at}.y`, 'y must be a fraction in [0,1]');
  if (!isUnitFraction(value.size)) return sceneReject(`${at}.size`, 'size must be a fraction in [0,1]');
  if (!isFiniteNumber(value.rotation)) return sceneReject(`${at}.rotation`, 'rotation must be a finite number');
  if (!isHexColor(value.color)) return sceneReject(`${at}.color`, 'color must match #rrggbb');
  const overlay =
    value.kind === 'text'
      ? {
          kind: 'text',
          text: value.text,
          x: value.x,
          y: value.y,
          size: value.size,
          rotation: value.rotation,
          color: value.color,
        }
      : {
          kind: 'gpu-temp',
          x: value.x,
          y: value.y,
          size: value.size,
          rotation: value.rotation,
          color: value.color,
        };
  return { ok: true, value: overlay };
}

/**
 * Validate untrusted scene JSON. Returns a sanitized copy on success (built
 * field-by-field from validated values — never spread from input) or the
 * offending field path (e.g. 'overlays[0].x', 'background.source') on reject.
 * TOTAL by contract: any internal exception (throwing getter, proxy) becomes
 * {ok:false, field:'<unknown>'} — a settings gate must never throw.
 * @returns {{ok:true, scene:object}|{ok:false, field:string, error:string}}
 */
function validateScene(input) {
  try {
    return validateSceneShape(input);
  } catch (err) {
    return sceneReject('<unknown>', `scene validation failed: ${String(err)}`);
  }
}

/** @returns {{ok:true, scene:object}|{ok:false, field:string, error:string}} */
function validateSceneShape(input) {
  if (!isPlainObject(input)) return sceneReject('<root>', 'scene must be an object');
  const unknownKey = firstUnknownKey(input, SCENE_KEYS);
  if (unknownKey !== null) return sceneReject(unknownKey, `unknown scene key: ${unknownKey}`);
  if (input.version !== SCENE_VERSION) return sceneReject('version', `version must be ${SCENE_VERSION}`);
  const background = validateSceneBackground(input.background);
  if (!background.ok) return background;
  if (!Array.isArray(input.overlays)) return sceneReject('overlays', 'overlays must be an array');
  // Unknown keys are rejected at EVERY level, the array included: an own
  // non-index property is drift (the renderer guard rejects it too — verdicts
  // must match). Reject outright instead of silently stripping it on rebuild.
  const extraKey = firstNonIndexKey(input.overlays);
  if (extraKey !== null) {
    return sceneReject('overlays', `overlays must not define own non-index property: ${extraKey}`);
  }
  if (input.overlays.length > SCENE_OVERLAYS_CAP) {
    return sceneReject('overlays', `overlays exceeds the cap of ${SCENE_OVERLAYS_CAP}`);
  }
  const overlays = [];
  for (let i = 0; i < input.overlays.length; i += 1) {
    const result = validateSceneOverlay(input.overlays[i], i);
    if (!result.ok) return result;
    overlays.push(result.value);
  }
  return {
    ok: true,
    scene: { version: input.version, background: background.value, overlays },
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
  // Scene gate (S0-T1): validator + shared constants for the settings `scene`
  // key. DEFAULT_SCENE/SCENE_OVERLAYS_CAP mirror src/renderer/lib/scene.ts.
  validateScene,
  SCENE_MAX_TEXT_CHARS,
  DEFAULT_SCENE,
  SCENE_OVERLAYS_CAP,
};
