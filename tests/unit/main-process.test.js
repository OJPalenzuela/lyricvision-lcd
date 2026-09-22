// @vitest-environment node
'use strict';

/**
 * Migrated from tests/test_hardening.js + tests/test_sync_settings.js
 * (LV-06 hardening + LV-08 sync tuning, headless-safe).
 *
 * Same mechanism as the originals: `electron` is stubbed via Module._load
 * before the REAL src/main.js is required through the native Node loader
 * (createRequire keeps Vitest's ESM pipeline out of the CommonJS graph),
 * then every original assertion runs unchanged under Vitest.
 *
 * The legacy scripts are kept runnable as-is (`node tests/test_*.js`);
 * this file is the runner-integrated mirror (identical stub shape and
 * identical expectations). If an assertion here ever disagrees with its
 * legacy twin, the legacy script wins — report it, do not weaken either side.
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

// NOTE: the stub shape matches the legacy scripts exactly (sync tmpdir);
// main.js only calls getPath lazily for settings paths, which no assertion
// below exercises.
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};

const requireNative = createRequire(import.meta.url);
const hardening = requireNative('../../src/hardening.js');
const main = requireNative('../../src/main.js');

function playingData(overrides = {}) {
  return {
    is_playing: true,
    progress_ms: 10000,
    timestamp: 1700000000000,
    item: {
      name: 'Sync Test',
      duration_ms: 180000,
      artists: [{ name: 'LyricVision' }],
      album: { name: 'Smokes' },
    },
    ...overrides,
  };
}

describe('redact (from test_hardening.js)', () => {
  it('redacts Bearer tokens but keeps the scheme marker', () => {
    const bearer = 'Authorization: Bearer abc.def.ghi-jkl_mno1234567890';
    const out = hardening.redact(bearer);
    expect(out.includes('abc.def.ghi')).toBe(false);
    expect(out.includes('Bearer <redacted>')).toBe(true);
  });

  it('redacts access/refresh tokens in query form', () => {
    const out = hardening.redact(
      'refresh_token=BQABCDEF1234567890abcdef&access_token=xyz'
    );
    expect(out.includes('BQABCDEF1234567890abcdef')).toBe(false);
    expect(out.includes('<redacted>')).toBe(true);
  });

  it('redacts client secrets in form and JSON shapes', () => {
    for (const secret of [
      'client_secret=supersecretvalue123',
      '{"client_secret":"supersecretvalue123"}',
    ]) {
      expect(hardening.redact(secret).includes('supersecretvalue123')).toBe(
        false
      );
    }
  });

  it('redacts OAuth codes but preserves state', () => {
    const out = hardening.redact(
      'http://127.0.0.1:17321/callback?code=authcode123456&state=zzz'
    );
    expect(out.includes('authcode123456')).toBe(false);
    expect(out.includes('state=zzz')).toBe(true);
    expect(hardening.redact('{"code":"abc123xyz"}').includes('abc123xyz')).toBe(
      false
    );
  });

  it('redacts USB serials in settings and spawn-arg form', () => {
    expect(hardening.redact('serial=ABC123XYZ').includes('ABC123XYZ')).toBe(
      false
    );
    const out = hardening.redact(
      'bridge spawned (dev-venv): python bridge/lcd_bridge.py --serial 1234ABCD'
    );
    expect(out.includes('1234ABCD')).toBe(false);
    expect(out.includes('--serial <redacted>')).toBe(true);
  });

  it('masks long secret-looking runs, leaves plain words alone', () => {
    expect(
      hardening
        .redact('token BQABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd end')
        .includes('BQABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd')
    ).toBe(false);
    for (const plain of [
      'streaming',
      'idle ok',
      'authorization started',
      'bridge queue high (3)',
    ]) {
      expect(hardening.redact(plain)).toBe(plain);
    }
  });

  it('passes non-strings through untouched', () => {
    expect(hardening.redact(42)).toBe(42);
    expect(hardening.redact(null)).toBe(null);
    expect(hardening.redact(undefined)).toBe(undefined);
  });
});

describe('RingLog (from test_hardening.js)', () => {
  it('caps at 200 entries, oldest-first, with ts/level/msg shape', () => {
    const ring = new hardening.RingLog(200);
    for (let i = 0; i < 250; i += 1) ring.push('info', `msg-${i}`);
    const entries = ring.entries();
    expect(entries.length).toBe(200);
    expect(entries[0].msg).toBe('msg-50');
    expect(entries[199].msg).toBe('msg-249');
    for (const e of entries) {
      expect(typeof e.ts).toBe('number');
      expect(e.level).toBe('info');
      expect(typeof e.msg).toBe('string');
    }
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i].ts >= entries[i - 1].ts).toBe(true);
    }
  });

  it('redacts secrets on entry and exposes RING_CAP 200', () => {
    const ring = new hardening.RingLog(200);
    ring.push('error', 'bridge spawn --serial 1234ABCD failed');
    const last = ring.entries()[ring.size - 1];
    expect(last.msg.includes('1234ABCD')).toBe(false);
    expect(hardening.RING_CAP).toBe(200);
  });
});

describe('bridge watchdog (from test_hardening.js)', () => {
  it('fires exactly once after 6s silence with 1s backoff', () => {
    let now = 1000000;
    const calls = [];
    const wd = hardening.createBridgeWatchdog({
      onRestart: (info) => calls.push(info),
      nowFn: () => now,
    });
    wd.setExpecting(true);
    wd.heartbeat();

    now += 6000;
    const fired = wd.check();
    expect(fired.restarted).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].delayMs).toBe(1000);
    expect(wd.isWedged()).toBe(true);

    now += 1000;
    expect(wd.check().restarted).toBe(false);
    expect(calls.length).toBe(1);
  });

  it('recovers on heartbeat and stays quiet when idle', () => {
    let now = 1000000;
    const calls = [];
    const wd = hardening.createBridgeWatchdog({
      onRestart: (info) => calls.push(info),
      nowFn: () => now,
    });
    wd.setExpecting(true);
    wd.heartbeat();
    now += 6000;
    wd.check();

    expect(wd.heartbeat()).toBe(true);
    expect(wd.isWedged()).toBe(false);
    now += 2000;
    expect(wd.check().restarted).toBe(false);
    expect(calls.length).toBe(1);

    const idle = hardening.createBridgeWatchdog({
      onRestart: () => calls.push('idle'),
      nowFn: () => now,
    });
    now += 60000;
    expect(idle.check().restarted).toBe(false);
  });

  it('escalates backoff 1s/2s/4s… capped at 30s, reset by heartbeat', () => {
    let now = 1000000;
    const wd2 = hardening.createBridgeWatchdog({ nowFn: () => now });
    expect([
      wd2.noteRestart(),
      wd2.noteRestart(),
      wd2.noteRestart(),
      wd2.noteRestart(),
      wd2.noteRestart(),
    ]).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(wd2.noteRestart()).toBe(30000);
    expect(wd2.noteRestart()).toBe(30000);
    expect(hardening.watchdogBackoffMs(1)).toBe(1000);
    expect(hardening.watchdogBackoffMs(99)).toBe(30000);
    wd2.heartbeat();
    expect(wd2.getState().restarts).toBe(0);
    expect(wd2.noteRestart()).toBe(1000);
  });
});

describe('parte1 constants + whitelist (from test_hardening.js)', () => {
  it('pins fetch timeout and retry constants', () => {
    expect(main.FETCH_TIMEOUT_MS).toBe(8000);
    expect(main.LRC_RETRIES).toBe(2);
  });

  it('carries lcdFps + syncOffsetMs in the whitelist with types', () => {
    expect(main.SETTINGS_SCHEMA.lcdFps).toBe('fps');
    expect(main.SETTINGS_SCHEMA.syncOffsetMs).toBe('syncOffset');
  });

  it('clamps fps 5–30 (default 10) and offset ±2000 (default 0)', () => {
    expect(main.clampFps(500)).toBe(30);
    expect(main.clampFps(0)).toBe(5);
    expect(main.clampFps('nope')).toBe(10);
    expect(main.clampSyncOffset(9999)).toBe(2000);
    expect(main.clampSyncOffset(-9999)).toBe(-2000);
  });

  it('rejects unknown + token keys, clamps fps, accepts offset', () => {
    const r = main.validateSettingsPatch({
      lcdFps: 99,
      syncOffsetMs: 100,
      evil: 1,
      accessToken: 'x',
      refreshToken: 'y',
      token: 'z',
      expiresAt: 1,
    });
    expect(r.accepted).toEqual({ lcdFps: 30, syncOffsetMs: 100 });
    for (const k of [
      'evil',
      'accessToken',
      'refreshToken',
      'token',
      'expiresAt',
    ]) {
      expect(r.rejected.includes(k)).toBe(true);
    }
    const r2 = main.validateSettingsPatch({ lcdFps: 'high' });
    expect(r2.accepted).toEqual({ lcdFps: 10 });
  });

  it('builds redacted diagnostics with PM/SUB and a bounded ring', () => {
    const payload = hardening.buildDiagnostics({
      settings: {
        spotifyClientId: 'cid',
        lcdFps: 10,
        syncOffsetMs: 0,
        serial: 'SECRET123',
        runAtStartup: false,
      },
      lcdStatus: { status: 'ok', reason: 'streaming', restarts: 0 },
      ringEntries: [{ ts: 1, level: 'info', msg: 'x' }],
      versions: { app: '0.1.0', electron: '44', bridge: 'protocol-v1' },
      bridge: { panel: 'Vision MAX', pm: 11, sub: 5 },
    });
    expect(payload.settings.serial).toBe('<redacted>');
    expect(payload.bridge.pm).toBe(11);
    expect(payload.bridge.sub).toBe(5);
    expect(payload.versions.bridge).toBe('protocol-v1');
    expect(Array.isArray(payload.ring) && payload.ring.length <= 200).toBe(
      true
    );
  });

  it('exposes the central redact through main.redact', () => {
    expect(main.redact('serial=ABC123XYZ')).toBe(
      hardening.redact('serial=ABC123XYZ')
    );
  });
});

describe('sync tuning (from test_sync_settings.js)', () => {
  it('pins adaptive poll 2s playing / 15s idle', () => {
    expect(main.POLL_PLAYING_MS).toBe(2000);
    expect(main.POLL_IDLE_MS).toBe(15000);
  });

  it('carries syncOffsetMs with its range constants', () => {
    expect(main.SETTINGS_SCHEMA.syncOffsetMs).toBe('syncOffset');
    expect(main.DEFAULT_SYNC_OFFSET_MS).toBe(0);
    expect(main.SYNC_OFFSET_MIN_MS).toBe(-2000);
    expect(main.SYNC_OFFSET_MAX_MS).toBe(2000);
    expect(main.SYNC_OFFSET_STEP_MS).toBe(100);
  });

  it('clampSyncOffset: garbage -> default, out-of-range -> clamped', () => {
    expect(main.clampSyncOffset('garbage')).toBe(0);
    expect(main.clampSyncOffset(undefined)).toBe(0);
    expect(main.clampSyncOffset(5000)).toBe(2000);
    expect(main.clampSyncOffset(-5000)).toBe(-2000);
    expect(main.clampSyncOffset(500)).toBe(500);
  });

  it('whitelist: boundaries accepted, out-of-range/wrong-type rejected', () => {
    let r = main.validateSettingsPatch({ syncOffsetMs: 500 });
    expect(r.accepted).toEqual({ syncOffsetMs: 500 });
    expect(r.rejected).toEqual([]);
    for (const edge of [-2000, 2000, 0]) {
      r = main.validateSettingsPatch({ syncOffsetMs: edge });
      expect(r.accepted).toEqual({ syncOffsetMs: edge });
    }
    for (const bad of [5000, -2500, 'abc', true, {}, NaN]) {
      r = main.validateSettingsPatch({ syncOffsetMs: bad });
      expect(r.accepted).toEqual({});
      expect(r.rejected.includes('syncOffsetMs')).toBe(true);
    }
    r = main.validateSettingsPatch({ accessToken: 'x', syncOffsetMs: 100 });
    expect(r.rejected.includes('accessToken')).toBe(true);
    expect(r.accepted).toEqual({ syncOffsetMs: 100 });
  });

  it('measuredAt: Spotify timestamp wins, receipt time is the fallback', () => {
    let player = main.toPlayerState(playingData(), 1700000005000);
    expect(player.measuredAt).toBe(1700000000000);
    expect(player.progressMs).toBe(10000);
    player = main.toPlayerState(playingData({ timestamp: undefined }), 1700000005000);
    expect(player.measuredAt).toBe(1700000005000);
    player = main.toPlayerState(null, 1700000005000);
    expect(player.isPlaying).toBe(false);
    expect(player.measuredAt).toBe(1700000005000);
  });

  it('envelope carries measuredAt + offsetMs', () => {
    const player = main.toPlayerState(null, 1700000005000);
    const state = main.buildBridgeState(
      { ...player, progressMs: 10000, measuredAt: 1700000000000, isPlaying: true },
      { lcdFps: 10, syncOffsetMs: -300 }
    );
    expect(state.measuredAt).toBe(1700000000000);
    expect(state.offsetMs).toBe(-300);
    const envelope = main.buildBridgeEnvelope(7, state);
    expect(envelope.v).toBe(1);
    expect(envelope.seq).toBe(7);
    expect(envelope.cmd).toBe('state');
    expect(envelope.state.measuredAt).toBe(1700000000000);
    expect(envelope.state.offsetMs).toBe(-300);
  });
});
