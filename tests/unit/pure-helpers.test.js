// @vitest-environment node
'use strict';

/**
 * T5 — NEW RED-first tests for exported pure helpers that the two legacy
 * suites never exercise (verified by reading them: no normalizeLayout,
 * pickBestArtworkUrl, toPlayerState artwork edges, buildBridgeState
 * sentinel/clamp branches, layout patch rules, redactSettings,
 * diagnostics edges, RingLog management, or backoff/watchdog edges).
 *
 * Helpers that are NOT exported (parseLrc, activeLyric, scoreSearchResult)
 * cannot be reached without editing src/main.js, so they stay untested —
 * see the report. Requires the same electron stub as main-process.test.js
 * because src/main.js is required for real.
 */

import Module from 'node:module';
import { createRequire } from 'node:module';
import os from 'node:os';
import { describe, expect, it } from 'vitest';

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

const requireNative = createRequire(import.meta.url);
const hardening = requireNative('../../src/hardening.js');
const main = requireNative('../../src/main.js');

describe('normalizeLayout', () => {
  it('accepts the two compat values exactly', () => {
    expect(main.normalizeLayout('lyrics')).toBe('lyrics');
    expect(main.normalizeLayout('cover')).toBe('cover');
  });

  it('falls back to lyrics for anything else', () => {
    for (const bad of ['grid', '', ' ', 'LYRICS', 'Cover', 'lyrics ', null, undefined, 123, true, [], {}]) {
      expect(main.normalizeLayout(bad)).toBe('lyrics');
    }
  });
});

describe('pickBestArtworkUrl', () => {
  it('picks the largest area', () => {
    expect(
      main.pickBestArtworkUrl([
        { url: 'small', width: 64, height: 64 },
        { url: 'big', width: 300, height: 300 },
        { url: 'mid', width: 200, height: 200 },
      ])
    ).toBe('big');
  });

  it('skips entries without a usable url', () => {
    expect(
      main.pickBestArtworkUrl([
        { width: 640, height: 640 },
        { url: '', width: 640, height: 640 },
        { url: 'only', width: 64, height: 64 },
      ])
    ).toBe('only');
  });

  it('falls back to the first url when no dimensions are known', () => {
    expect(main.pickBestArtworkUrl([{ url: 'a' }, { url: 'b' }])).toBe('a');
  });

  it('returns empty string for unusable input', () => {
    for (const bad of [[], null, undefined, 'x', 42, [{ width: 1 }]]) {
      expect(main.pickBestArtworkUrl(bad)).toBe('');
    }
  });
});

describe('clamp extras', () => {
  it('clampFps rounds and coerces strings, garbage -> default', () => {
    expect(main.clampFps(10.6)).toBe(11);
    expect(main.clampFps('15')).toBe(15);
    expect(main.clampFps(NaN)).toBe(10);
    expect(main.clampFps(Infinity)).toBe(10);
    expect(main.clampFps(4.4)).toBe(5);
  });

  it('clampSyncOffset rounds and coerces strings', () => {
    expect(main.clampSyncOffset(100.6)).toBe(101);
    expect(main.clampSyncOffset('-300')).toBe(-300);
    expect(main.clampSyncOffset(null)).toBe(0);
  });
});

describe('validateSettingsPatch uncovered keys', () => {
  it('accepts layout exactly, rejects anything else', () => {
    expect(main.validateSettingsPatch({ layout: 'cover' }).accepted).toEqual({
      layout: 'cover',
    });
    for (const bad of ['grid', 'LYRICS', '', 123]) {
      const r = main.validateSettingsPatch({ layout: bad });
      expect(r.accepted).toEqual({});
      expect(r.rejected).toContain('layout');
    }
  });

  it('accepts booleans/strings with the right type, rejects the rest', () => {
    expect(
      main.validateSettingsPatch({ runAtStartup: true }).accepted
    ).toEqual({ runAtStartup: true });
    expect(
      main.validateSettingsPatch({ runAtStartup: 'yes' }).rejected
    ).toContain('runAtStartup');
    expect(
      main.validateSettingsPatch({ spotifyClientId: 'cid' }).accepted
    ).toEqual({ spotifyClientId: 'cid' });
    expect(
      main.validateSettingsPatch({ spotifyClientId: 123 }).rejected
    ).toContain('spotifyClientId');
    expect(main.validateSettingsPatch({ serial: 'S1' }).accepted).toEqual({
      serial: 'S1',
    });
  });

  it('rejects a non-object patch', () => {
    expect(main.validateSettingsPatch(null).rejected).toEqual([
      '<non-object>',
    ]);
  });
});

describe('toPlayerState uncovered branches', () => {
  function item(overrides = {}) {
    return {
      name: 'T',
      duration_ms: 180000,
      artists: [{ name: 'A' }, { name: 'B' }],
      album: {
        name: 'Al',
        images: [
          { url: 'small', width: 64, height: 64 },
          { url: 'big', width: 640, height: 640 },
        ],
      },
      ...overrides,
    };
  }

  it('joins artists and plumbs the best artwork url', () => {
    const p = main.toPlayerState(
      { is_playing: true, progress_ms: 1, timestamp: 1000, item: item() },
      2000
    );
    expect(p.track.artist).toBe('A, B');
    expect(p.track.album).toBe('Al');
    expect(p.track.artworkUrl).toBe('big');
  });

  it('tolerates missing artists and missing album', () => {
    const p = main.toPlayerState(
      {
        is_playing: false,
        progress_ms: 0,
        timestamp: 1000,
        item: item({ artists: undefined, album: null }),
      },
      2000
    );
    expect(p.track.artist).toBe('');
    expect(p.track.album).toBe('');
    expect(p.track.artworkUrl).toBe('');
  });

  it('falls back to Unknown Track when the name is missing', () => {
    const p = main.toPlayerState(
      { is_playing: true, progress_ms: 0, timestamp: 5, item: item({ name: '' }) },
      6
    );
    expect(p.track.title).toBe('Unknown Track');
  });
});

describe('buildBridgeState uncovered branches', () => {
  it('replaces the epoch-0 sentinel with the current time', () => {
    const before = Date.now();
    const s = main.buildBridgeState(
      { progressMs: 10000, measuredAt: 0, isPlaying: true },
      {}
    );
    expect(s.measuredAt).toBeGreaterThan(1000000000000);
    expect(s.measuredAt).toBeGreaterThanOrEqual(before);
    expect(s.measuredAt).toBeLessThanOrEqual(Date.now());
  });

  it('clamps the offset instead of rejecting (user-file path)', () => {
    const s = main.buildBridgeState(
      { progressMs: 0, measuredAt: 1000, isPlaying: false },
      { syncOffsetMs: 5000, lcdFps: 99 }
    );
    expect(s.offsetMs).toBe(2000);
    expect(s.settings.lcdFps).toBe(30);
  });

  it('maps the legacy artwork_url key onto artworkUrl', () => {
    const s = main.buildBridgeState(
      {
        track: { title: 'T', artist: 'A', artwork_url: 'legacy-url' },
        measuredAt: 1000,
      },
      {}
    );
    expect(s.track.artworkUrl).toBe('legacy-url');
  });

  it('fills defaults for an empty player', () => {
    const s = main.buildBridgeState({}, {});
    expect(s.progressMs).toBe(0);
    expect(s.isPlaying).toBe(false);
    expect(s.lyric).toEqual({ current_line: '', next_line: '' });
    expect(s.track.title).toBe('Unknown Track');
    expect(s.layout).toBe('lyrics');
  });

  it('keeps an accepted compat layout on the state', () => {
    const s = main.buildBridgeState({ measuredAt: 1000 }, { layout: 'cover' });
    expect(s.layout).toBe('cover');
    expect(s.settings.layout).toBe('cover');
  });
});

describe('redactSettings', () => {
  it('masks short serials by key and redacts the client id centrally', () => {
    const out = hardening.redactSettings({
      spotifyClientId: 'cid',
      lcdFps: 10,
      serial: 'AB',
    });
    expect(out.serial).toBe('<redacted>');
    expect(out.lcdFps).toBe(10);
  });

  it('returns an empty object for non-objects and leaves empties alone', () => {
    expect(hardening.redactSettings(null)).toEqual({});
    expect(hardening.redactSettings(undefined)).toEqual({});
    const out = hardening.redactSettings({ serial: '', lcdFps: 10 });
    expect(out.serial).toBe('');
  });
});

describe('buildDiagnostics edges', () => {
  it('defaults every section when called empty', () => {
    const d = hardening.buildDiagnostics({});
    expect(typeof d.ts).toBe('string');
    expect(d.versions).toEqual({ app: '', electron: '', bridge: '' });
    expect(d.lcdStatus).toBe(null);
    expect(d.bridge).toBe(null);
    expect(d.ring).toEqual([]);
  });

  it('keeps only the last 200 ring entries', () => {
    const ring = Array.from({ length: 250 }, (_, i) => ({
      ts: i,
      level: 'info',
      msg: `m${i}`,
    }));
    const d = hardening.buildDiagnostics({ ringEntries: ring });
    expect(d.ring.length).toBe(200);
    expect(d.ring[0].msg).toBe('m50');
  });

  it('copies lcdStatus instead of aliasing it', () => {
    const status = { status: 'ok' };
    const d = hardening.buildDiagnostics({ lcdStatus: status });
    expect(d.lcdStatus).toEqual(status);
    expect(d.lcdStatus).not.toBe(status);
  });
});

describe('RingLog management', () => {
  it('clear() empties and entries() returns a copy', () => {
    const ring = new hardening.RingLog(10);
    ring.push('info', 'a');
    expect(ring.size).toBe(1);
    const copy = ring.entries();
    copy.push({ ts: 0, level: 'x', msg: 'fake' });
    expect(ring.size).toBe(1);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.entries()).toEqual([]);
  });

  it('floors degenerate caps', () => {
    expect(new hardening.RingLog(0).cap).toBe(200);
    expect(new hardening.RingLog(-5).cap).toBe(1);
    expect(new hardening.RingLog(3).cap).toBe(3);
  });
});

describe('watchdog edges', () => {
  it('coerces degenerate backoff inputs to 1s', () => {
    expect(hardening.watchdogBackoffMs(0)).toBe(1000);
    expect(hardening.watchdogBackoffMs(NaN)).toBe(1000);
    expect(hardening.watchdogBackoffMs(2.7)).toBe(2000);
    expect(hardening.watchdogBackoffMs('3')).toBe(4000);
  });

  it('a throwing onRestart never breaks the tick', () => {
    let now = 5000;
    const wd = hardening.createBridgeWatchdog({
      onRestart: () => {
        throw new Error('scheduler down');
      },
      nowFn: () => now,
      timeoutMs: 1000,
    });
    wd.setExpecting(true);
    now += 2000;
    const r = wd.check();
    expect(r.restarted).toBe(true);
    expect(wd.isWedged()).toBe(true);
  });

  it('setExpecting(false) clears the wedge; idle heartbeat reports no recovery', () => {
    let now = 7000;
    const wd = hardening.createBridgeWatchdog({
      nowFn: () => now,
      timeoutMs: 1000,
    });
    wd.setExpecting(true);
    now += 2000;
    wd.check();
    expect(wd.isWedged()).toBe(true);
    wd.setExpecting(false);
    expect(wd.isWedged()).toBe(false);
    expect(wd.getState().expecting).toBe(false);
    expect(wd.heartbeat()).toBe(false);
  });

  it('noteRestart records the delay used on the next check', () => {
    let now = 9000;
    const wd = hardening.createBridgeWatchdog({
      nowFn: () => now,
      timeoutMs: 1000,
    });
    expect(wd.noteRestart()).toBe(1000);
    expect(wd.getState().lastDelayMs).toBe(1000);
  });
});
