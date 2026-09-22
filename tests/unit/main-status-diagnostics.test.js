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
