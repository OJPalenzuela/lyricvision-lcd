'use strict';

/**
 * Smoke test for LV-08 sync tuning in src/main.js (headless-safe, plain node).
 *
 * Stubs `electron` before requiring the real main.js (same trick as the
 * module's own test hook), then asserts the pure helpers:
 * timestamp-based measuredAt, syncOffsetMs whitelist accept/reject, and
 * measuredAt+offsetMs on the bridge envelope.
 *
 * Run: node tests/test_sync_settings.js
 */

const Module = require('module');
const assert = require('assert');

const electronStub = {
  app: {
    requestSingleInstanceLock: () => true,
    on: () => {},
    whenReady: () => ({ then: () => {} }),
    getPath: () => require('os').tmpdir(),
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
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

const main = require('../src/main');

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

function check() {
  // 1. Adaptive poll: 2s playing / 15s idle.
  assert.strictEqual(main.POLL_PLAYING_MS, 2000, 'POLL_PLAYING_MS must be 2000');
  assert.strictEqual(main.POLL_IDLE_MS, 15000, 'POLL_IDLE_MS must stay 15000');

  // 2. Whitelist carries the new setting with its range constants.
  assert.strictEqual(main.SETTINGS_SCHEMA.syncOffsetMs, 'syncOffset');
  assert.strictEqual(main.DEFAULT_SYNC_OFFSET_MS, 0);
  assert.strictEqual(main.SYNC_OFFSET_MIN_MS, -2000);
  assert.strictEqual(main.SYNC_OFFSET_MAX_MS, 2000);
  assert.strictEqual(main.SYNC_OFFSET_STEP_MS, 100);

  // 3. clampSyncOffset: garbage -> default, out-of-range -> clamped.
  assert.strictEqual(main.clampSyncOffset('garbage'), 0);
  assert.strictEqual(main.clampSyncOffset(undefined), 0);
  assert.strictEqual(main.clampSyncOffset(5000), 2000);
  assert.strictEqual(main.clampSyncOffset(-5000), -2000);
  assert.strictEqual(main.clampSyncOffset(500), 500);

  // 4. Whitelist: in-range accepted (incl. boundaries), out-of-range and
  //    wrong types rejected, token keys still rejected.
  let r = main.validateSettingsPatch({ syncOffsetMs: 500 });
  assert.deepStrictEqual(r.accepted, { syncOffsetMs: 500 }, 'in-range offset accepted');
  assert.deepStrictEqual(r.rejected, []);
  for (const edge of [-2000, 2000, 0]) {
    r = main.validateSettingsPatch({ syncOffsetMs: edge });
    assert.deepStrictEqual(r.accepted, { syncOffsetMs: edge }, `boundary ${edge} accepted`);
  }
  for (const bad of [5000, -2500, 'abc', true, {}, NaN]) {
    r = main.validateSettingsPatch({ syncOffsetMs: bad });
    assert.deepStrictEqual(r.accepted, {}, `out-of-range/wrong-type ${JSON.stringify(bad)} not accepted`);
    assert.ok(r.rejected.includes('syncOffsetMs'), `out-of-range/wrong-type ${JSON.stringify(bad)} rejected`);
  }
  r = main.validateSettingsPatch({ accessToken: 'x', syncOffsetMs: 100 });
  assert.ok(r.rejected.includes('accessToken'), 'token keys still rejected');
  assert.deepStrictEqual(r.accepted, { syncOffsetMs: 100 });

  // 5. measuredAt: Spotify timestamp wins; missing timestamp falls back to
  //    the local receipt time (never undefined).
  let player = main.toPlayerState(playingData(), 1700000005000);
  assert.strictEqual(player.measuredAt, 1700000000000, 'timestamp is the base');
  assert.strictEqual(player.progressMs, 10000);
  player = main.toPlayerState(playingData({ timestamp: undefined }), 1700000005000);
  assert.strictEqual(player.measuredAt, 1700000005000, 'missing timestamp falls back to receipt time');
  player = main.toPlayerState(null, 1700000005000);
  assert.strictEqual(player.isPlaying, false);
  assert.strictEqual(player.measuredAt, 1700000005000, 'idle state still carries a base');

  // 6. Envelope carries measuredAt + offsetMs.
  const state = main.buildBridgeState(
    { ...player, progressMs: 10000, measuredAt: 1700000000000, isPlaying: true },
    { lcdFps: 10, syncOffsetMs: -300 }
  );
  assert.strictEqual(state.measuredAt, 1700000000000, 'state carries measuredAt');
  assert.strictEqual(state.offsetMs, -300, 'state carries offsetMs');
  const envelope = main.buildBridgeEnvelope(7, state);
  assert.strictEqual(envelope.v, 1);
  assert.strictEqual(envelope.seq, 7);
  assert.strictEqual(envelope.cmd, 'state');
  assert.strictEqual(envelope.state.measuredAt, 1700000000000);
  assert.strictEqual(envelope.state.offsetMs, -300);

  console.log('test_sync_settings: OK (2s poll + measuredAt base + whitelist + envelope)');
}

try {
  check();
} catch (err) {
  console.error(`RESULT fail: ${err.message || err}`);
  process.exit(1);
}
