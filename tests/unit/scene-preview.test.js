// @vitest-environment node
'use strict';

/**
 * S2-T8 — the scene editor's preview round-trip over the LIVE sidecar pipe.
 *
 * Three seams, hardware-free (no USB, no network, no shell.openExternal):
 *   1. src/preview-correlator.js — reqId correlation: success, a typed
 *      rejection for EVERY PREVIEW_ERROR_REASONS member, 3 s timeout with
 *      late-reply discard, unmatched reqId, concurrency, sidecar-gone, and
 *      no pending entry left behind after any outcome.
 *   2. src/main.js stdout routing — a preview_response line reaches the
 *      pending map FIRST and never falls through to the ack/status path.
 *   3. Scene fan-out — settings.scene crosses the pipe only when its
 *      content digest changed; the first push and every push after a
 *      sidecar (re)start always carry it.
 *
 * Same electron stub as tests/unit/bridge-state-scene.test.js: src/main.js
 * is required for real; its app.whenReady never resolves, so no IPC, spawn
 * or window is created by loading it.
 */

import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireNative = createRequire(import.meta.url);
const {
  createPreviewCorrelator,
  DEFAULT_PREVIEW_TIMEOUT_MS,
  PREVIEW_REASON,
} = requireNative('../../src/preview-correlator.js');
const { PREVIEW_ERROR_REASONS } = requireNative('../../src/bridge-spawn.js');

// --- electron stub (pattern pinned by bridge-state-scene.test.js) ---
const electronStub = {
  app: {
    requestSingleInstanceLock: () => true,
    on: () => {},
    whenReady: () => ({ then: () => {} }),
    getPath: () => os.tmpdir(),
    getVersion: () => '0.1.0-test',
    quit: () => {},
  },
  BrowserWindow: function () {},
  ipcMain: { handle: () => {} },
  Tray: function () {},
  Menu: { buildFromTemplate: () => ({}) },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => Buffer.alloc(0),
  },
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};
const main = requireNative('../../src/main.js');

const MAIN_SRC = fs.readFileSync(
  fileURLToPath(new URL('../../src/main.js', import.meta.url)),
  'utf8'
);

const DATA_URL = 'data:image/png;base64,aGVsbG8=';
const VALID_SCENE = {
  version: 1,
  background: { kind: 'color', color: '#123456' },
  overlays: [],
};

function okLine(reqId) {
  return JSON.stringify({
    v: 1,
    cmd: 'preview_response',
    reqId,
    mediaType: 'image/png',
    width: 240,
    height: 427,
    image: 'aGVsbG8=',
  });
}

function engineLine(reqId, reason) {
  return JSON.stringify({
    v: 1,
    cmd: 'preview_response',
    reqId,
    error: { reason, message: `engine said no: ${reason}` },
  });
}

function fakeChild() {
  const writes = [];
  return {
    writes,
    child: {
      exitCode: null,
      stdin: {
        write: (line) => {
          writes.push(line);
          return true;
        },
      },
    },
  };
}

const hasScene = (state) =>
  Object.prototype.hasOwnProperty.call(state.settings, 'scene');

// ---------------------------------------------------------------- seam
describe('preview correlation seam (src/preview-correlator.js)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the matching reqId to a data: URL', async () => {
    const c = createPreviewCorrelator();
    const reply = c.wait(7);
    expect(c.pendingCount()).toBe(1);
    expect(c.handleLine(okLine(7))).toBe(true);
    await expect(reply).resolves.toBe(DATA_URL);
    expect(c.pendingCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a response whose reqId matches nothing pending', () => {
    const c = createPreviewCorrelator();
    // Consumed by the pending-map dispatch (never junk, never the state path).
    expect(c.handleLine(okLine(999))).toBe(true);
    expect(c.pendingCount()).toBe(0);
  });

  it('rejects on the documented 3 s timeout and leaks no pending entry', async () => {
    expect(DEFAULT_PREVIEW_TIMEOUT_MS).toBe(3000);
    const c = createPreviewCorrelator();
    const reply = c.wait(1);
    vi.advanceTimersByTime(3000);
    await expect(reply).rejects.toThrow(/preview_timeout/);
    expect(c.pendingCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(c.isDiscarded(1)).toBe(true);
  });

  it('discards the late reply after timeout so it cannot settle the next request', async () => {
    const c = createPreviewCorrelator();
    const first = c.wait(1);
    vi.advanceTimersByTime(3000);
    await expect(first).rejects.toThrow(/preview_timeout/);

    const second = c.wait(2);
    expect(c.handleLine(okLine(1))).toBe(true); // late reply: consumed + dropped
    expect(c.pendingCount()).toBe(1); // the NEXT request is still pending
    expect(c.isDiscarded(1)).toBe(false); // graveyard entry consumed
    c.handleLine(okLine(2));
    await expect(second).resolves.toBe(DATA_URL);
    expect(c.pendingCount()).toBe(0);
  });

  it('maps every PREVIEW_ERROR_REASONS member to a typed rejection', async () => {
    const c = createPreviewCorrelator();
    let reqId = 100;
    for (const reason of PREVIEW_ERROR_REASONS) {
      const reply = c.wait(reqId);
      expect(c.handleLine(engineLine(reqId, reason))).toBe(true);
      await expect(reply).rejects.toThrow(`${PREVIEW_REASON.ENGINE}: ${reason}`);
      expect(c.pendingCount()).toBe(0);
      reqId += 1;
    }
  });

  it('rejects a malformed response that still matches a pending reqId', async () => {
    const c = createPreviewCorrelator();
    const reply = c.wait(5);
    const line = JSON.stringify({
      v: 1,
      cmd: 'preview_response',
      reqId: 5,
      image: 'not base64!!',
    });
    expect(c.handleLine(line)).toBe(true);
    await expect(reply).rejects.toThrow(/preview_malformed_response/);
    expect(c.pendingCount()).toBe(0);
  });

  it('resolves two concurrent requests independently, in any arrival order', async () => {
    const c = createPreviewCorrelator();
    const earlier = c.wait(11);
    const later = c.wait(12);
    expect(c.pendingCount()).toBe(2);
    c.handleLine(okLine(12));
    await expect(later).resolves.toBe(DATA_URL);
    expect(c.pendingCount()).toBe(1);
    c.handleLine(engineLine(11, 'render_failed'));
    await expect(earlier).rejects.toThrow(`${PREVIEW_REASON.ENGINE}: render_failed`);
    expect(c.pendingCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejectAll (sidecar gone) rejects every pending entry and clears state', async () => {
    const c = createPreviewCorrelator();
    const one = c.wait(1);
    const two = c.wait(2);
    c.rejectAll(new Error(`${PREVIEW_REASON.EXITED}: sidecar exited before answering`));
    await expect(one).rejects.toThrow(/preview_sidecar_exited/);
    await expect(two).rejects.toThrow(/preview_sidecar_exited/);
    expect(c.pendingCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// -------------------------------------------------------- main: routing
describe('main stdout routing: preview_response before the state path', () => {
  it('dispatches to the pending map and returns "preview" (never ack/status)', async () => {
    const { child, writes } = fakeChild();
    const reply = main.handlePreviewRequest(VALID_SCENE, child);
    expect(writes).toHaveLength(1);
    const reqId = JSON.parse(writes[0]).reqId;
    expect(main.handleBridgeLine(okLine(reqId))).toBe('preview');
    await expect(reply).resolves.toBe(DATA_URL);
  });

  it('consumes an unmatched preview_response instead of dropping it as junk', () => {
    expect(main.handleBridgeLine(okLine(4242))).toBe('preview');
  });

  it('keeps ack and status lines on their own path', () => {
    expect(main.handleBridgeLine(JSON.stringify({ type: 'ack', seq: 1 }))).toBe('ack');
    expect(
      main.handleBridgeLine(JSON.stringify({ type: 'status', status: 'ok' }))
    ).toBe('status');
    expect(main.handleBridgeLine('not json at all')).toBeUndefined();
  });
});

// ------------------------------------------- main: scene:preview seam
describe('scene:preview request handling', () => {
  it('rejects cleanly when the sidecar is absent or already exited', async () => {
    await expect(main.handlePreviewRequest(VALID_SCENE, null)).rejects.toThrow(
      /preview_sidecar_absent/
    );
    await expect(
      main.handlePreviewRequest(VALID_SCENE, { exitCode: 1 })
    ).rejects.toThrow(/preview_sidecar_absent/);
  });

  it('re-validates the scene before anything reaches the pipe', async () => {
    const { child, writes } = fakeChild();
    const bad = {
      version: 1,
      background: { kind: 'none' },
      overlays: [
        { kind: 'text', text: 'x', x: 5, y: 0.5, size: 0.1, rotation: 0, color: '#ffffff' },
      ],
    };
    await expect(main.handlePreviewRequest(bad, child)).rejects.toThrow(
      /preview_invalid_scene: overlays\[0\]\.x/
    );
    expect(writes).toHaveLength(0); // unvalidated scenes are never forwarded
  });
});

// ---------------------------------------------------------- fan-out
describe('scene fan-out: settings.scene only when it changed', () => {
  const sceneA = { version: 1, background: { kind: 'color', color: '#111111' }, overlays: [] };
  const sceneB = { version: 1, background: { kind: 'color', color: '#222222' }, overlays: [] };
  // Same content, different key insertion order: the digest must not care.
  const reorderedA = { overlays: [], background: { color: '#111111', kind: 'color' }, version: 1 };
  const push = (scene) => ({
    settings: { lcdFps: 10, layout: 'lyrics', ...(scene ? { scene } : {}) },
  });

  it('first push carries the scene', () => {
    const fan = main.createSceneFanout();
    expect(hasScene(fan.apply(push(sceneA)))).toBe(true);
  });

  it('an unchanged scene is not re-sent on the next push', () => {
    const fan = main.createSceneFanout();
    fan.apply(push(sceneA));
    expect(hasScene(fan.apply(push(sceneA)))).toBe(false);
    expect(hasScene(fan.apply(push(reorderedA)))).toBe(false);
  });

  it('a changed scene is carried on the very next push (no waiting)', () => {
    const fan = main.createSceneFanout();
    fan.apply(push(sceneA));
    fan.apply(push(sceneA));
    const third = fan.apply(push(sceneB));
    expect(hasScene(third)).toBe(true);
    expect(third.settings.scene).toEqual(sceneB);
  });

  it('reset() (first connect / sidecar restart) re-carries the scene', () => {
    const fan = main.createSceneFanout();
    fan.apply(push(sceneA));
    fan.apply(push(sceneA));
    fan.reset();
    expect(hasScene(fan.apply(push(sceneA)))).toBe(true);
  });

  it('a push without a scene forgets the digest so a returning scene is re-sent', () => {
    const fan = main.createSceneFanout();
    fan.apply(push(sceneA));
    fan.apply(push(null)); // invalid-scene fail-safe: scene omitted entirely
    expect(hasScene(fan.apply(push(sceneA)))).toBe(true);
  });
});

describe('scene:save stays prompt; startBridge arms fan-out and previews (source guards)', () => {
  it('settings:save pushes to the sidecar when the scene changed', () => {
    const start = MAIN_SRC.indexOf("ipcMain.handle('settings:save'");
    const end = MAIN_SRC.indexOf("ipcMain.handle('spotify:connect'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = MAIN_SRC.slice(start, end);
    expect(block).toMatch(/accepted\.scene !== undefined/);
    expect(block).toMatch(/sendStateToBridge\(\)/);
  });

  it('startBridge resets the fan-out and kills pending previews on exit/error', () => {
    const start = MAIN_SRC.indexOf('function startBridge()');
    const end = MAIN_SRC.indexOf('function scheduleBridgeRestart');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = MAIN_SRC.slice(start, end);
    expect(block).toMatch(/sceneFanout\.reset\(\)/);
    // child.on('error') AND child.on('exit') must both fail pending previews.
    expect(block.match(/previewCorrelator\.rejectAll\(/g)).toHaveLength(2);
  });
});

// ------------------------------------------------------------- no any
describe('renderer stays free of any / as any', () => {
  /**
   * Strip comments AND string/template literals (including `${...}`
   * expressions) with a state machine BEFORE matching, so `// no any here`
   * or the word "any" in UI copy can neither mask a violation nor fake one.
   * Regex literals are treated as code (the renderer has none containing
   * quotes or comment markers; noted so a future one is a deliberate act).
   */
  function stripNonCode(src) {
    let out = '';
    let i = 0;
    let mode = 'code';
    const exprDepth = []; // `${` ... `}` nesting inside template literals
    while (i < src.length) {
      const c = src[i];
      const d = i + 1 < src.length ? src[i + 1] : '';
      if (mode === 'code') {
        if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
        if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
        if (c === "'" || c === '"' || c === '`') { mode = c; i += 1; out += ' '; continue; }
        if (c === '}' && exprDepth.length > 0) {
          if (exprDepth[exprDepth.length - 1] === 0) {
            exprDepth.pop();
            mode = '`';
            i += 1;
            out += ' ';
            continue;
          }
          exprDepth[exprDepth.length - 1] -= 1;
        }
        if (c === '{' && exprDepth.length > 0) exprDepth[exprDepth.length - 1] += 1;
        out += c;
        i += 1;
        continue;
      }
      if (mode === 'line') {
        if (c === '\n') { mode = 'code'; out += c; }
        i += 1;
        continue;
      }
      if (mode === 'block') {
        if (c === '*' && d === '/') { mode = 'code'; i += 2; continue; }
        i += 1;
        continue;
      }
      // string modes: ' " `
      if (c === '\\') { i += 2; continue; }
      if (c === '$' && d === '{' && mode === '`') {
        exprDepth.push(0);
        mode = 'code';
        i += 2;
        out += ' ';
        continue;
      }
      if (c === mode) { mode = 'code'; i += 1; out += ' '; continue; }
      i += 1;
    }
    return out;
  }

  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('src/renderer/**/*.ts(x) contains no any outside comments and strings', () => {
    const root = fileURLToPath(new URL('../../src/renderer', import.meta.url));
    const files = walk(root);
    expect(files.length).toBeGreaterThan(0); // never a vacuous pass
    const violations = [];
    for (const file of files) {
      const cleaned = stripNonCode(fs.readFileSync(file, 'utf8'));
      if (/\bany\b/.test(cleaned)) violations.push(path.relative(root, file));
    }
    expect(violations).toEqual([]);
  });
});
