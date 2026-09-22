'use strict';

/**
 * LyricVision LCD — sidecar spawn path (LV-05).
 *
 * Pure Node (no Electron imports) so the EXACT resolve+spawn path used by
 * main.js can be exercised headless by tests/test_shell_spawn.js.
 *
 * Dev:      `.venv/python bridge/lcd_bridge.py` with `python` PATH fallback.
 * Packaged: `<resources>/lcd_bridge.exe` (PyInstaller onefile).
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { validateScene } = require('./hardening');

function repoRoot() {
  return path.join(__dirname, '..');
}

function bridgeScript() {
  return path.join(repoRoot(), 'bridge', 'lcd_bridge.py');
}

/**
 * Ordered python candidates for dev: project-local venv first,
 * bare `python` (PATH) as the documented fallback.
 */
function devPythonCandidates() {
  const venvDir = path.join(
    repoRoot(),
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin'
  );
  const ext = process.platform === 'win32' ? '.exe' : '';
  return [path.join(venvDir, `python${ext}`), 'python'];
}

/**
 * Resolve the exact command+args main.js will spawn.
 *
 * @param {object} opts
 * @param {object} [opts.app] - Electron app (only `isPackaged` is read).
 * @param {string} [opts.serial] - USB serial for `--serial` (omit = auto).
 * @param {number} [opts.once] - frame count for `--once` (tests only).
 * @returns {{command:string, args:string[], source:string}}
 */
function resolveBridgeCommand({ app, serial = null, once = null } = {}) {
  const extra = [];
  if (serial) extra.push('--serial', String(serial));
  if (once !== null && once !== undefined) extra.push('--once', String(once));

  if (app && app.isPackaged) {
    return {
      command: path.join(process.resourcesPath, 'lcd_bridge.exe'),
      args: extra,
      source: 'packaged',
    };
  }

  const script = bridgeScript();
  let command = 'python';
  let source = 'dev-fallback';
  for (const candidate of devPythonCandidates()) {
    if (!candidate.includes(path.sep)) continue; // PATH fallback, checked last
    try {
      if (fs.existsSync(candidate)) {
        command = candidate;
        source = 'dev-venv';
        break;
      }
    } catch {
      // ignore FS errors, fall through to PATH fallback
    }
  }
  return { command, args: [script, ...extra], source };
}

/**
 * Spawn the sidecar. Returns the ChildProcess (stdio: pipe/pipe/pipe).
 * Callers attach stdout (status/ack JSONL), stderr (human logs) and
 * `exit` (0 ok / 2 panel-unknown / 3 usb-busy-or-absent) handlers.
 */
function spawnBridge({ app, serial, once, spawnFn = spawn } = {}) {
  const { command, args, source } = resolveBridgeCommand({ app, serial, once });
  const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.__bridgeSource = source;
  return child;
}

// ---------------------------------------------------------------------------
// Versioned preview envelope (S0-T2).
//
// Wire shape mirrors src/main.js buildBridgeEnvelope: {"v":1,"cmd":...,...}.
// There is no version handshake between shell and sidecar — both hardcode 1
// (bridge/protocol.py PROTOCOL_VERSION) — so preview traffic is added as a
// NEW cmd inside v:1; bumping v would break the shipped state pairing.
// ---------------------------------------------------------------------------

const PREVIEW_PROTOCOL_VERSION = 1;
// Reduced-resolution cap: the base64 image crosses the SAME stdin/stdout
// JSONL pipe that carries playback state every 2s while playing, so a full
// 480x854 JPEG would stall state delivery behind a multi-hundred-KB line.
// Half-scale of the portrait glass => a quarter of the pixels (tens of KB).
// Pinned to 240x427 in BOTH suites so the copies cannot drift apart.
const PREVIEW_MAX_WIDTH = 480 / 2; // 240
const PREVIEW_MAX_HEIGHT = Math.floor(854 / 2); // 427

const PREVIEW_MEDIA_TYPES = ['image/jpeg', 'image/png'];

// Closed vocabulary mirrored from bridge/protocol.py PREVIEW_ERROR_REASONS.
const PREVIEW_ERROR_REASONS = [
  'invalid_request',
  'preview_unavailable',
  'render_failed',
  'version_mismatch',
  'unknown_cmd',
];

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

let lastPreviewReqId = 0;

function isPositiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nextPreviewReqId() {
  lastPreviewReqId += 1;
  return lastPreviewReqId;
}

/**
 * Build a validated preview_request envelope. NEVER returns a `line` for a
 * scene or hint that failed validation — callers may write `line` to the
 * child's stdin only when `ok` is true (see writePreviewRequest).
 *
 * @param {object} scene - S0-T1 scene (normalized 0-1 coords, 480x854 glass).
 * @param {object} [opts]
 * @param {number} [opts.reqId] - explicit correlation id (auto-assigned otherwise).
 * @param {number} [opts.maxWidth] - output width hint, capped at PREVIEW_MAX_WIDTH.
 * @param {number} [opts.maxHeight] - output height hint, capped at PREVIEW_MAX_HEIGHT.
 * @returns {{ok:true, reqId:number, envelope:object, line:string}
 *          |{ok:false, field:string, error:string}}
 */
function buildPreviewRequest(scene, opts = {}) {
  // The scene is untrusted: delegate to the hardened S0-T1 gate so shell and
  // sidecar apply the exact same verdict (src/hardening.js is the authority).
  const validated = validateScene(scene);
  if (!validated.ok) return { ok: false, field: validated.field, error: validated.error };

  const reqId = opts.reqId === undefined ? nextPreviewReqId() : opts.reqId;
  if (!isPositiveInt(reqId)) {
    return { ok: false, field: 'reqId', error: 'reqId must be a positive integer' };
  }

  const maxWidth = opts.maxWidth === undefined ? PREVIEW_MAX_WIDTH : opts.maxWidth;
  if (!isPositiveInt(maxWidth) || maxWidth > PREVIEW_MAX_WIDTH) {
    return { ok: false, field: 'maxWidth', error: `maxWidth must be an integer in [1,${PREVIEW_MAX_WIDTH}]` };
  }
  const maxHeight = opts.maxHeight === undefined ? PREVIEW_MAX_HEIGHT : opts.maxHeight;
  if (!isPositiveInt(maxHeight) || maxHeight > PREVIEW_MAX_HEIGHT) {
    return { ok: false, field: 'maxHeight', error: `maxHeight must be an integer in [1,${PREVIEW_MAX_HEIGHT}]` };
  }

  const envelope = {
    v: PREVIEW_PROTOCOL_VERSION,
    cmd: 'preview_request',
    reqId,
    maxWidth,
    maxHeight,
    scene: validated.scene,
  };
  return { ok: true, reqId, envelope, line: `${JSON.stringify(envelope)}\n` };
}

/**
 * Validate first, write second: the child's stdin only ever sees a line that
 * passed buildPreviewRequest, and a rejected request never reaches the pipe.
 *
 * @param {{stdin?:{write:Function}}|null} child - spawned sidecar (spawnBridge result).
 * @param {object} scene
 * @param {object} [opts] - see buildPreviewRequest.
 * @returns {{ok:true, reqId:number, envelope:object, line:string}
 *          |{ok:false, field:string, error:string}}
 */
function writePreviewRequest(child, scene, opts = {}) {
  const built = buildPreviewRequest(scene, opts);
  if (!built.ok) return built;
  const stdin = child && child.stdin;
  if (!stdin || typeof stdin.write !== 'function') {
    return { ok: false, field: '<child>', error: 'bridge child stdin is not writable' };
  }
  try {
    stdin.write(built.line);
  } catch (err) {
    return {
      ok: false,
      field: '<child>',
      error: `bridge stdin write failed: ${String((err && err.message) || err)}`,
    };
  }
  return built;
}

/**
 * Parse and validate one preview_response line from the sidecar.
 *
 * The sidecar constructs these, but the shell still validates: a truncated or
 * foreign line must become a typed {ok:false, field} verdict, never an
 * exception inside the response path. `expectedReqId` correlates the line to
 * the request that is still awaiting an answer.
 *
 * @param {string} line - one stdout JSONL line.
 * @param {number} [expectedReqId] - reqId of the request awaiting a response.
 * @returns {{ok:true, reqId:number, image:string, mediaType:string, width:number, height:number}
 *          |{ok:true, reqId:number, error:{reason:string, message:string, field?:string}}
 *          |{ok:false, field:string, error:string}}
 */
function parsePreviewResponse(line, expectedReqId) {
  let msg;
  try {
    msg = JSON.parse(String(line).trim());
  } catch {
    return { ok: false, field: '<line>', error: 'preview response is not JSON' };
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, field: '<line>', error: 'preview response must be an object' };
  }
  if (msg.v !== PREVIEW_PROTOCOL_VERSION) {
    return { ok: false, field: 'v', error: `version must be ${PREVIEW_PROTOCOL_VERSION}` };
  }
  if (msg.cmd !== 'preview_response') {
    return { ok: false, field: 'cmd', error: 'not a preview_response' };
  }
  if (!Number.isInteger(msg.reqId)) {
    return { ok: false, field: 'reqId', error: 'reqId must be an integer' };
  }
  if (expectedReqId !== undefined && msg.reqId !== expectedReqId) {
    return {
      ok: false,
      field: 'reqId',
      error: `response reqId ${msg.reqId} does not match request ${expectedReqId}`,
    };
  }
  if (msg.error !== undefined) {
    const typed = msg.error;
    if (typed === null || typeof typed !== 'object' || Array.isArray(typed)) {
      return { ok: false, field: 'error', error: 'error must be an object' };
    }
    if (!PREVIEW_ERROR_REASONS.includes(typed.reason)) {
      return { ok: false, field: 'error.reason', error: 'unknown error reason' };
    }
    if (typeof typed.message !== 'string') {
      return { ok: false, field: 'error.message', error: 'error message must be a string' };
    }
    const parsed = { ok: true, reqId: msg.reqId, error: { reason: typed.reason, message: typed.message } };
    if (typeof typed.field === 'string') parsed.error.field = typed.field;
    return parsed;
  }
  if (typeof msg.image !== 'string' || !BASE64_RE.test(msg.image)) {
    return { ok: false, field: 'image', error: 'image must be a base64 string' };
  }
  if (typeof msg.mediaType !== 'string' || !PREVIEW_MEDIA_TYPES.includes(msg.mediaType)) {
    return { ok: false, field: 'mediaType', error: 'unsupported preview media type' };
  }
  if (!isPositiveInt(msg.width) || msg.width > PREVIEW_MAX_WIDTH) {
    return { ok: false, field: 'width', error: `width must be an integer in [1,${PREVIEW_MAX_WIDTH}]` };
  }
  if (!isPositiveInt(msg.height) || msg.height > PREVIEW_MAX_HEIGHT) {
    return { ok: false, field: 'height', error: `height must be an integer in [1,${PREVIEW_MAX_HEIGHT}]` };
  }
  return {
    ok: true,
    reqId: msg.reqId,
    image: msg.image,
    mediaType: msg.mediaType,
    width: msg.width,
    height: msg.height,
  };
}

module.exports = {
  repoRoot,
  bridgeScript,
  devPythonCandidates,
  resolveBridgeCommand,
  spawnBridge,
  // Preview envelope (S0-T2).
  PREVIEW_PROTOCOL_VERSION,
  PREVIEW_MAX_WIDTH,
  PREVIEW_MAX_HEIGHT,
  PREVIEW_MEDIA_TYPES,
  PREVIEW_ERROR_REASONS,
  buildPreviewRequest,
  writePreviewRequest,
  parsePreviewResponse,
};
