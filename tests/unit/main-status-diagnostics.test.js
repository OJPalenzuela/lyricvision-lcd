// @vitest-environment node
'use strict';

/**
 * T8 — characterization tests for the T7 export-hook additions (part 2):
 * exclusivity detection, LCD status mapping, diagnostics, the track key,
 * and createTray / createWindow.
 *
 * Same mechanism as tests/unit/main-process.test.js: `electron` (here with
 * recording BrowserWindow/Tray/Menu fakes) and `child_process` (delegating
 * everything to the real module except a scripted execFile probe) are
 * stubbed via Module._load before the REAL src/main.js is required through
 * the native Node loader. No network, no Spotify calls, no USB, no
 * shell.openExternal at test time. In particular the tray "Refresh now"
 * click handler is NEVER invoked (it would start a real Spotify poll).
 *
 * TDD honesty: these are characterization tests over existing, already-
 * correct code, so no PRODUCT-code RED was observable — a red here would
 * have meant a real bug in src/main.js, and none was found. The REDs that
 * did occur were bugs in the tests' own harness, fixed in the tests.
 * createTray/createWindow are included
 * because the stub lets us assert genuinely meaningful behaviour (menu
 * template, dev-vs-prod URL routing, sandbox flags, popup denial), not
 * just "the stub was called".
 */

import Module from 'node:module';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const browserWindows = [];
const electronStub = {
  app: {
    requestSingleInstanceLock: () => true,
    on: () => {},
    whenReady: () => ({ then: () => {} }),
    getPath: () => os.tmpdir(),
    getVersion: () => '0.1.0-test',
    quitCalls: 0,
    quit() {
      this.quitCalls += 1;
    },
  },
  BrowserWindow: class {
    constructor(opts) {
      this.opts = opts;
      this.loadedURL = null;
      this.loadedFile = null;
      this.handlers = {};
      this.handler = null;
      this.shown = 0;
      this.hidden = 0;
      this.destroyed = false;
      // Recorded renderer IPC: lets a test assert WHAT the main process
      // pushes (e.g. exclusivityWarn), not merely that it pushed.
      this.sent = [];
      this.webContents = {
        send: (channel, payload) => {
          this.sent.push({ channel, payload });
        },
        setWindowOpenHandler: (fn) => {
          this.handler = fn;
        },
      };
      browserWindows.push(this);
    }
    loadURL(url) {
      this.loadedURL = url;
    }
    loadFile(file) {
      this.loadedFile = file;
    }
    on(event, fn) {
      this.handlers[event] = fn;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      const onClosed = this.handlers.closed;
      if (onClosed) onClosed(); // fires main.js' handler, clearing mainWindow
    }
    show() {
      this.shown += 1;
    }
    hide() {
      this.hidden += 1;
    }
    isVisible() {
      return false;
    }
    isMinimized() {
      return false;
    }
  },
  ipcMain: { handle: () => {} },
  Tray: class {
    constructor(icon) {
      this.icon = icon;
      this.menu = null;
      this.tooltip = null;
      this.clickHandler = null;
      electronStub.trayInstances.push(this);
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    setToolTip(tip) {
      this.tooltip = tip;
    }
    on(event, fn) {
      if (event === 'click') this.clickHandler = fn;
    }
  },
  trayInstances: [],
  Menu: {
    captured: null,
    buildFromTemplate(template) {
      this.captured = template;
      return { __menu: true };
    },
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createEmpty: () => ({ __empty: true }),
  },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => Buffer.alloc(0),
  },
};

const originalLoad = Module._load;
const realChildProcess = originalLoad.call(Module, 'child_process');

// Scripted tasklist probe: the test sets execMode before calling
// detectExclusivityHolders. Everything else in child_process stays real
// (bridge-spawn destructures `spawn` from it at load time).
let execMode = 'empty';
const execCalls = [];
function fakeExecFile(cmd, args, opts, cb) {
  execCalls.push({ cmd, args, opts });
  if (execMode === 'err') {
    queueMicrotask(() => cb(new Error('tasklist unavailable')));
    return;
  }
  let stdout =
    '"Image Name","PID","Session Name","Session#","Mem Usage"\n' +
    '"System Idle Process","0","Services","0","8 K"\n';
  if (execMode === 'holders') {
    stdout +=
      '"trcc.exe","4321","Console","1","12,000 K"\n' +
      '"SignalRGB.exe","8765","Console","1","45,000 K"\n';
  }
  queueMicrotask(() => cb(null, stdout, ''));
}
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  if (request === 'child_process') return { ...realChildProcess, execFile: fakeExecFile };
  return originalLoad.call(this, request, ...rest);
};

const requireNative = createRequire(import.meta.url);
const main = requireNative('../../src/main.js');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('detectExclusivityHolders', () => {
  afterEach(() => {
    execCalls.length = 0;
    execMode = 'empty';
  });

  it('greps the read-only tasklist (never touches the processes)', async () => {
    main.detectExclusivityHolders();
    await flush();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe('tasklist');
    expect(execCalls[0].args).toEqual(['/FO', 'CSV', '/NH']);
    expect(execCalls[0].opts).toEqual({ timeout: 8000 });
    // WARN ONLY: the only command ever issued is the read-only listing —
    // there is deliberately no taskkill/taskkill.exe anywhere.
    for (const c of execCalls) expect(c.cmd).not.toMatch(/kill/i);
  });

  it('matches TRCC + SignalRGB and surfaces the resulting warn', async () => {
    execMode = 'holders';
    delete process.env.ELECTRON_RENDERER_URL;
    main.createWindow();
    const win = browserWindows[browserWindows.length - 1];

    expect(() => main.detectExclusivityHolders()).not.toThrow();
    await flush();

    expect(execCalls).toHaveLength(1);
    // THE assertion that catches a broken detector. pushPlayerState runs
    // only when exclusivityWarn is truthy (src/main.js:1132), so a typo'd
    // or dropped match pattern (trcc.exe / signalrgb.exe / signarbg.exe)
    // leaves this array empty and fails this test outright.
    expect(win.sent).toHaveLength(1);
    expect(win.sent[0].channel).toBe('player-state');
    const payload = win.sent[0].payload;
    expect(payload.exclusivityWarn).toBe(
      'TRCC + SignalRGB is running and holds the LCD exclusively — quit it before claiming the panel'
    );
    // Renderer boundary: the warn rides the same push, which carries no token.
    expect(payload.spotify).not.toHaveProperty('accessToken');
    // Honest boundary, unchanged: headless there is no bridge child, so
    // computeLcdStatus short-circuits to offline at the !bridgeChild guard
    // (src/main.js:1076) before ever reaching the exclusivity branch — the
    // warn is observable through this renderer push, not through getLcdStatus.
    expect(payload.lcdStatus.status).toBe('offline');
    win.destroy();
  });

  it('clears the warn and pushes nothing when no holder matches', async () => {
    // Also proves the match result is recomputed on every probe: the holders
    // found in the previous case must not leak into this one.
    execMode = 'empty';
    delete process.env.ELECTRON_RENDERER_URL;
    main.createWindow();
    const win = browserWindows[browserWindows.length - 1];

    main.detectExclusivityHolders();
    await flush();

    expect(execCalls).toHaveLength(1);
    expect(win.sent).toHaveLength(0);
    win.destroy();
  });

  it('swallows detection errors (best-effort, never breaks the app)', async () => {
    execMode = 'err';
    expect(() => main.detectExclusivityHolders()).not.toThrow();
    await flush();
    expect(execCalls).toHaveLength(1);
  });
});

describe('LCD status mapping (main side)', () => {
  it('starts offline with no bridge running', () => {
    expect(main.bridgeStatusLine()).toBeNull();
    const status = main.computeLcdStatus();
    expect(status.status).toBe('offline');
    expect(status.reason).toBe('bridge not running');
    expect(typeof status.restarts).toBe('number');
  });

  it('getLcdStatus returns a copy, not an alias', () => {
    const first = main.getLcdStatus();
    first.status = 'tampered';
    expect(main.getLcdStatus().status).toBe('offline');
    expect(main.getLcdStatus()).toEqual(main.computeLcdStatus());
  });

  it('documents the headless boundary for the other five kinds', () => {
    // Cross-check: tests/renderer/App.test.tsx renders all six
    // LcdStatusKind values (ok, degraded, bridge-wedged, panel-unknown,
    // auth-error, offline) onto the header badge. On the main side only
    // `offline` is reachable headless: the exit-2 (panel-unknown),
    // exit-3 (offline/busy), wedged, degraded and auth-error branches all
    // read module-private state (lastBridgeExit, bridgeChild, watchdog,
    // exclusivityWarn, lastPollError) that is not writable from a test
    // without a live sidecar or network — and only the module.exports
    // block may change. exclusivityWarn IS written by
    // detectExclusivityHolders (asserted in the describe above through the
    // renderer push), but computeLcdStatus still returns offline at the
    // !bridgeChild guard before it reaches the exclusivity branch, so it
    // cannot surface here. Exporting handleBridgeLine (the lastBridgeStatus
    // writer) would unlock the status-driven branches; that is follow-up
    // work, not fabricated here.
    expect(main.computeLcdStatus().status).toBe('offline');
  });
});

describe('currentTrackKey', () => {
  it('joins title and artist', () => {
    expect(main.currentTrackKey({ track: { title: 'T', artist: 'A' } })).toBe('T — A');
  });

  it('tolerates a missing track', () => {
    expect(main.currentTrackKey({})).toBe(' — ');
    expect(main.currentTrackKey({ track: {} })).toBe(' — ');
  });
});

describe('diagnosticsFilePath', () => {
  it('lands in userData with a colon-free timestamped name', () => {
    const p = main.diagnosticsFilePath();
    expect(p.startsWith(os.tmpdir())).toBe(true);
    const base = path.basename(p);
    expect(base.startsWith('diagnostics-')).toBe(true);
    expect(base.endsWith('.json')).toBe(true);
    expect(base).not.toContain(':');
  });
});

describe('buildDiagnosticsPayload', () => {
  it('carries app/electron/bridge versions with null bridge by default', () => {
    const payload = main.buildDiagnosticsPayload();
    expect(payload.versions.app).toBe('0.1.0-test');
    expect(payload.versions.bridge).toBe('protocol-v1');
    expect(typeof payload.versions.electron).toBe('string');
    expect(payload.bridge).toBeNull();
    expect(Array.isArray(payload.ring) && payload.ring.length <= 200).toBe(true);
    expect(payload.settings).toMatchObject({ lcdFps: expect.any(Number) });
  });

  it('redacts a stored serial end-to-end (settings file -> payload)', () => {
    const settingsFile = path.join(os.tmpdir(), 'settings.json');
    const hadFile = fs.existsSync(settingsFile);
    const backup = hadFile ? fs.readFileSync(settingsFile, 'utf8') : null;
    try {
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({
          spotifyClientId: 'cid',
          lcdFps: 10,
          syncOffsetMs: 0,
          layout: 'lyrics',
          serial: 'SECRET123',
          runAtStartup: false,
        }),
        'utf8'
      );
      const payload = main.buildDiagnosticsPayload();
      expect(payload.settings.serial).toBe('<redacted>');
    } finally {
      if (hadFile) fs.writeFileSync(settingsFile, backup, 'utf8');
      else {
        try {
          fs.rmSync(settingsFile, { force: true });
        } catch {
          // cleanup is best-effort
        }
      }
    }
  });
});

describe('createWindow', () => {
  const savedUrl = process.env.ELECTRON_RENDERER_URL;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = savedUrl;
  });

  it('loads the dev URL when ELECTRON_RENDERER_URL is set', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/';
    main.createWindow();
    const win = browserWindows[browserWindows.length - 1];
    expect(win.loadedURL).toBe('http://localhost:5173/');
    expect(win.loadedFile).toBeNull();
  });

  it('loads the packaged file in production', () => {
    delete process.env.ELECTRON_RENDERER_URL;
    main.createWindow();
    const win = browserWindows[browserWindows.length - 1];
    expect(win.loadedURL).toBeNull();
    expect(String(win.loadedFile).replace(/\\/g, '/')).toContain(
      'dist/renderer/index.html'
    );
  });

  it('keeps the hardened web preferences and denies popups', () => {
    delete process.env.ELECTRON_RENDERER_URL;
    main.createWindow();
    const win = browserWindows[browserWindows.length - 1];
    expect(win.opts.title).toBe('LyricVision LCD');
    expect(win.opts.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    expect(typeof win.handler).toBe('function');
    expect(win.handler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  });
});

describe('createTray', () => {
  it('builds a menu with the expected items and tooltip', () => {
    const before = electronStub.trayInstances.length;
    main.createTray();
    expect(electronStub.trayInstances.length).toBe(before + 1);
    expect(electronStub.Menu.captured).not.toBeNull();
    const labels = electronStub.Menu.captured.map((item) =>
      item.type === 'separator' ? '<separator>' : item.label
    );
    expect(labels).toEqual(['Show', 'Hide', 'Refresh now', '<separator>', 'Quit']);
    const tray = electronStub.trayInstances[electronStub.trayInstances.length - 1];
    expect(tray.menu).toEqual({ __menu: true });
    expect(typeof tray.tooltip).toBe('string');
  });

  it('wires Show to the window and Quit to the app', () => {
    delete process.env.ELECTRON_RENDERER_URL;
    main.createWindow();
    main.createTray();
    const win = browserWindows[browserWindows.length - 1];
    const template = electronStub.Menu.captured;
    const shownBefore = win.shown;
    template[0].click(); // Show
    expect(win.shown).toBe(shownBefore + 1);
    const quitsBefore = electronStub.app.quitCalls;
    template[template.length - 1].click(); // Quit
    expect(electronStub.app.quitCalls).toBe(quitsBefore + 1);
    // "Refresh now" is deliberately NEVER clicked here: it starts a real
    // Spotify poll (network). Its presence in the template above is the
    // assertion; invoking it would violate the no-network constraint.
  });
});

describe('handleBridgeLine (WARNING 2 follow-up: the lastBridgeStatus writer)', () => {
  // TDD: this describe is the RED for a one-line export-hook addition.
  // Before `handleBridgeLine` joins the module.exports block every test
  // here fails (not a function); after, all pass with no production-
  // behavior change (additive export only).
  //
  // Honest boundary on THIS shared instance: no child is ever started here,
  // so the `!bridgeChild` guard (src/main.js:1076) fires first and
  // computeLcdStatus returns offline — exactly what the guard pin below
  // asserts, and what keeps a branch reorder from silently passing.
  //
  // That is a property of this instance, not a coverage limit. All 6
  // LcdStatusKind values are covered headless by the fresh-instance
  // describes further down: startBridge + a stubbed `./bridge-spawn` fake
  // child reaches every branch below the guard, with no USB and no network.
  // An earlier version of this comment claimed 5 kinds needed a real child,
  // a real panel or a real Spotify round-trip; that was refuted by reading
  // the writers — the additive exports at src/main.js:1528-1531
  // (startBridge, sendStateToBridge, pollNow, bridgeWatchdog) close them.

  it('is exposed through the module.exports test hook', () => {
    expect(typeof main.handleBridgeLine).toBe('function');
  });

  it('stores status lines so bridgeStatusLine + the renderer lcd payload carry panel fields', () => {
    delete process.env.ELECTRON_RENDERER_URL;
    main.createWindow();
    const win = browserWindows[browserWindows.length - 1];
    try {
      const before = win.sent.length;
      // Shape mirrors the sidecar's per-frame emit
      // (bridge/lcd_bridge.py: panel, pm/sub, fps, queue, frames).
      main.handleBridgeLine(
        JSON.stringify({
          type: 'status',
          panel: 'Vision MAX',
          pm: 'PM-TEST',
          sub: 'SUB-TEST',
          fps: 10,
          queue: 3,
          frames: 42,
        })
      );
      expect(main.bridgeStatusLine()).toMatchObject({
        type: 'status',
        panel: 'Vision MAX',
        queue: 3,
        frames: 42,
      });
      // The status path ends in pushPlayerState (~1 Hz is fine): the
      // renderer learns the panel identity with no USB in the test.
      expect(win.sent.length).toBe(before + 1);
      const pushed = win.sent[win.sent.length - 1];
      expect(pushed.channel).toBe('player-state');
      expect(pushed.payload.lcd).toMatchObject({
        panel: 'Vision MAX',
        fps: 10,
        queue: 3,
        frames: 42,
      });
      expect(pushed.payload.spotify).not.toHaveProperty('accessToken');
    } finally {
      win.destroy();
    }
  });

  it('ignores non-JSON stdout and lets acks pass without clobbering the status', () => {
    main.handleBridgeLine(
      JSON.stringify({
        type: 'status',
        panel: 'Vision MAX',
        pm: 'PM-TEST',
        sub: 'SUB-TEST',
        fps: 10,
        queue: 3,
        frames: 42,
      })
    );
    const stored = main.bridgeStatusLine();
    expect(() => main.handleBridgeLine('not json {{')).not.toThrow();
    expect(() => main.handleBridgeLine(JSON.stringify({ type: 'ack', seq: 3 }))).not.toThrow();
    expect(main.bridgeStatusLine()).toBe(stored);
    expect(main.bridgeStatusLine()).toMatchObject({ queue: 3, frames: 42 });
  });

  it('still reports offline headless: a degraded-shaped line cannot pass the !bridgeChild guard', () => {
    // queue 25 WOULD hit the degraded branch (src/main.js:1086) under a
    // live child; headless the guard at :1076 fires first. This pins the
    // boundary so a future branch reorder fails loudly instead of
    // silently claiming degraded coverage.
    main.handleBridgeLine(
      JSON.stringify({
        type: 'status',
        panel: 'Vision MAX',
        pm: 'PM-TEST',
        sub: 'SUB-TEST',
        fps: 10,
        queue: 25,
        frames: 100,
      })
    );
    expect(main.bridgeStatusLine()).toMatchObject({ queue: 25 });
    const status = main.computeLcdStatus();
    expect(status.status).toBe('offline');
    expect(status.reason).toBe('bridge not running');
  });
});

// ---------------------------------------------------------------------------
// computeLcdStatus: all six LcdStatusKind values, headless.
//
// Why fresh instances: the gates (bridgeChild, lastBridgeExit, authBroken,
// lastPollError, exclusivityWarn, watchdog) are module-scoped with no
// setters by design — resetting them from a test would mean production
// setters. Instead each test re-requires src/main.js (native Node loader,
// same Module._load stub style as above) after pointing ./bridge-spawn at a
// fake child factory. No network, no USB, no shell.openExternal. Every timer
// the module schedules (pollTimer, watchdog tick, restart backoff) is
// unref'd in production code, so stale instances cannot hang the run.
// ---------------------------------------------------------------------------
const { EventEmitter: BridgeTestEventEmitter } = requireNative('node:events');

// Mutable fake consulted ONLY while a fresh instance loads. Chained onto the
// existing Module._load patch above without touching its lines.
let bridgeSpawnStubFn = null;
const loadBeforeBridgeSpawnStub = Module._load;
Module._load = function (request, ...rest) {
  if (typeof request === 'string' && request.endsWith('bridge-spawn') && bridgeSpawnStubFn) {
    return { spawnBridge: bridgeSpawnStubFn };
  }
  return loadBeforeBridgeSpawnStub.call(this, request, ...rest);
};

// Fake sidecar child: EventEmitter surface startBridge() attaches to
// (stdout/stderr 'data', 'error'/'exit'), plus stdin/kill/exitCode which
// sendStateToBridge() and the watchdog onRestart path touch.
function makeFakeBridgeChild({ writeImpl } = {}) {
  const child = new BridgeTestEventEmitter();
  child.stdout = new BridgeTestEventEmitter();
  child.stderr = new BridgeTestEventEmitter();
  child.exitCode = null;
  child.spawnfile = 'fake-bridge';
  child.spawnargs = [];
  child.__bridgeSource = 'test-fake';
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  child.stdinWrites = [];
  child.stdin = {
    write: (line) => {
      child.stdinWrites.push(line);
      return writeImpl ? writeImpl(line) : true;
    },
    end: () => {},
  };
  return child;
}

function loadFreshMain(spawnImpl) {
  bridgeSpawnStubFn = spawnImpl;
  try {
    const freshPath = requireNative.resolve('../../src/main.js');
    delete requireNative.cache[freshPath];
    return requireNative('../../src/main.js');
  } finally {
    bridgeSpawnStubFn = null;
  }
}

describe('export seams for headless status coverage (RED: missing before the unlock)', () => {
  it('exposes startBridge (sole bridgeChild writer headless)', () => {
    const fresh = loadFreshMain(() => makeFakeBridgeChild());
    expect(typeof fresh.startBridge).toBe('function');
  });

  it('exposes sendStateToBridge (narrowest lastPollError writer without network)', () => {
    const fresh = loadFreshMain(() => makeFakeBridgeChild());
    expect(typeof fresh.sendStateToBridge).toBe('function');
  });

  it('exposes pollNow (sole authBroken writer)', () => {
    const fresh = loadFreshMain(() => makeFakeBridgeChild());
    expect(typeof fresh.pollNow).toBe('function');
  });

  it('exposes bridgeWatchdog (only deterministic route to isWedged without sleeps)', () => {
    const fresh = loadFreshMain(() => makeFakeBridgeChild());
    expect(fresh.bridgeWatchdog).toBeDefined();
    expect(typeof fresh.bridgeWatchdog.check).toBe('function');
    expect(typeof fresh.bridgeWatchdog.isWedged).toBe('function');
  });
});

describe('computeLcdStatus reaches all six kinds headless (fresh instance per test)', () => {
  afterEach(() => {
    execCalls.length = 0;
    execMode = 'empty';
  });

  it('reaches ok with a live fake child and no error state', () => {
    const kids = [];
    const fresh = loadFreshMain(() => {
      const c = makeFakeBridgeChild();
      kids.push(c);
      return c;
    });
    fresh.startBridge();
    expect(kids).toHaveLength(1);
    const status = fresh.computeLcdStatus();
    expect(status.status).toBe('ok');
    expect(status.reason).toBe('idle');
  });

  it('reaches degraded when the status queue >= 20', () => {
    const fresh = loadFreshMain(() => makeFakeBridgeChild());
    fresh.startBridge();
    // Shape mirrors the sidecar emit; handleBridgeLine is already exported.
    fresh.handleBridgeLine(
      JSON.stringify({
        type: 'status',
        panel: 'Vision MAX',
        pm: 'PM-TEST',
        sub: 'SUB-TEST',
        fps: 10,
        queue: 25,
        frames: 100,
      })
    );
    const status = fresh.computeLcdStatus();
    expect(status.status).toBe('degraded');
    expect(status.reason).toBe('bridge queue high (25)');
  });

  it('reaches degraded via exclusivityWarn once a child is live', async () => {
    // Headless the warn alone cannot surface (the !bridgeChild guard fires
    // first) — a live fake child moves compute past that guard.
    execMode = 'holders';
    try {
      const fresh = loadFreshMain(() => makeFakeBridgeChild());
      fresh.startBridge();
      fresh.detectExclusivityHolders();
      await flush();
      const status = fresh.computeLcdStatus();
      expect(status.status).toBe('degraded');
      expect(status.reason).toContain('holds the LCD exclusively');
    } finally {
      execMode = 'empty';
      execCalls.length = 0;
    }
  });

  it('reaches degraded via lastPollError from bridge backpressure', () => {
    // stdin.write -> false is the no-network route to lastPollError
    // (src/main.js:941); throwing would take the write-failed sibling.
    const fresh = loadFreshMain(() => makeFakeBridgeChild({ writeImpl: () => false }));
    fresh.startBridge();
    fresh.sendStateToBridge();
    const status = fresh.computeLcdStatus();
    expect(status.status).toBe('degraded');
    expect(status.reason).toBe('bridge backpressure (stdin buffer full)');
  });

  it('reaches bridge-wedged when the watchdog sees >5s of silence', () => {
    // check(futureMs) forces the episode synchronously — no real sleeps.
    // onRestart kills the fake child (killCalls 1) without emitting exit,
    // so bridgeChild stays truthy and the wedged branch is hit.
    const kids = [];
    const fresh = loadFreshMain(() => {
      const c = makeFakeBridgeChild();
      kids.push(c);
      return c;
    });
    fresh.startBridge();
    const fired = fresh.bridgeWatchdog.check(Date.now() + 6000);
    expect(fired.wedged).toBe(true);
    expect(kids[0].killCalls).toBe(1);
    const status = fresh.computeLcdStatus();
    expect(status.status).toBe('bridge-wedged');
    expect(status.reason).toContain('no bridge status/ack for >5s');
  });

  it('reaches panel-unknown when the fake child exits with code 2', () => {
    // No panel needed: the exit handler maps code 2 from any child.
    const kids = [];
    const fresh = loadFreshMain(() => {
      const c = makeFakeBridgeChild();
      kids.push(c);
      return c;
    });
    fresh.startBridge();
    expect(fresh.computeLcdStatus().status).toBe('ok');
    kids[0].emit('exit', 2, null);
    const status = fresh.computeLcdStatus();
    expect(status.status).toBe('panel-unknown');
    expect(status.reason).toBe('bridge refused an unknown panel (exit 2)');
  });

  it('reaches auth-error when pollNow cannot ensure a token (no network)', async () => {
    // Empty vault (memoryTokens null + safeStorage unavailable stub) makes
    // ensureAccessToken throw before any fetch, setting authBroken.
    const fresh = loadFreshMain(() => makeFakeBridgeChild());
    await fresh.pollNow();
    const status = fresh.computeLcdStatus();
    expect(status.status).toBe('auth-error');
    expect(status.reason).toContain('not connected');
  });
});
