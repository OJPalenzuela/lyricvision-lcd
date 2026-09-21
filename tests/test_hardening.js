'use strict';

/**
 * Hardening tests for LV-06 (headless-safe, plain node).
 *
 * - redact() covers token / client_secret / OAuth code / USB serial, leaves
 *   normal words alone, passes non-strings through.
 * - RingLog caps at 200 entries, oldest-first order, {ts, level, msg} shape.
 * - Bridge watchdog (src/hardening.js, child mocked — no spawns): 6s without
 *   heartbeat while a stream is expected -> exactly 1 restart with 1s
 *   backoff; no restart storm; heartbeat recovers; backoff escalates
 *   1s/2s/4s… capped at 30s and resets on heartbeat.
 * - Parte 1 (no network): fetch timeout + retry constants, settings
 *   whitelist (lcdFps + syncOffsetMs), clamps, token-key rejection.
 *
 * Run: node tests/test_hardening.js
 */

const Module = require('module');
const assert = require('assert');

const electronStub = {
  app: {
    requestSingleInstanceLock: () => true,
    on: () => {},
    whenReady: () => ({ then: () => {} }),
    getPath: () => require('os').tmpdir(),
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
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

const hardening = require('../src/hardening');
const main = require('../src/main');

function checkRedact() {
  // Bearer token.
  const bearer = 'Authorization: Bearer abc.def.ghi-jkl_mno1234567890';
  const bearerOut = hardening.redact(bearer);
  assert.ok(!bearerOut.includes('abc.def.ghi'), 'bearer token redacted');
  assert.ok(bearerOut.includes('Bearer <redacted>'), 'bearer keeps scheme marker');

  // access_token / refresh_token in query form.
  const tokens = 'refresh_token=BQABCDEF1234567890abcdef&access_token=xyz';
  const tokensOut = hardening.redact(tokens);
  assert.ok(!tokensOut.includes('BQABCDEF1234567890abcdef'), 'refresh_token redacted');
  assert.ok(tokensOut.includes('<redacted>'), 'token marker present');

  // Client secret (form + JSON shapes).
  for (const secret of ['client_secret=supersecretvalue123', '{"client_secret":"supersecretvalue123"}']) {
    const out = hardening.redact(secret);
    assert.ok(!out.includes('supersecretvalue123'), `client secret redacted (${secret})`);
  }

  // OAuth code (query + JSON), state must survive.
  const cb = 'http://127.0.0.1:17321/callback?code=authcode123456&state=zzz';
  const cbOut = hardening.redact(cb);
  assert.ok(!cbOut.includes('authcode123456'), 'oauth code redacted');
  assert.ok(cbOut.includes('state=zzz'), 'oauth state preserved');
  assert.ok(!hardening.redact('{"code":"abc123xyz"}').includes('abc123xyz'), 'json code redacted');

  // USB serials (settings form + --serial spawn-arg form).
  assert.ok(!hardening.redact('serial=ABC123XYZ').includes('ABC123XYZ'), 'serial= redacted');
  const spawnLine = 'bridge spawned (dev-venv): python bridge/lcd_bridge.py --serial 1234ABCD';
  const spawnOut = hardening.redact(spawnLine);
  assert.ok(!spawnOut.includes('1234ABCD'), '--serial arg redacted');
  assert.ok(spawnOut.includes('--serial <redacted>'), 'serial marker present');

  // Long secret-looking run gets masked, normal words survive untouched.
  const longRun = 'token BQABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd end';
  assert.ok(!hardening.redact(longRun).includes('BQABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'), 'long run masked');
  for (const plain of ['streaming', 'idle ok', 'authorization started', 'bridge queue high (3)']) {
    assert.strictEqual(hardening.redact(plain), plain, `plain words untouched (${plain})`);
  }

  // Non-strings pass through.
  assert.strictEqual(hardening.redact(42), 42);
  assert.strictEqual(hardening.redact(null), null);
  assert.strictEqual(hardening.redact(undefined), undefined);
}

function checkRing() {
  const ring = new hardening.RingLog(200);
  for (let i = 0; i < 250; i += 1) ring.push('info', `msg-${i}`);
  const entries = ring.entries();
  assert.strictEqual(entries.length, 200, 'ring caps at 200');
  assert.strictEqual(entries[0].msg, 'msg-50', 'oldest entries evicted first');
  assert.strictEqual(entries[199].msg, 'msg-249', 'newest entry last');
  for (const e of entries) {
    assert.strictEqual(typeof e.ts, 'number', 'entry carries ts');
    assert.strictEqual(e.level, 'info', 'entry carries level');
    assert.strictEqual(typeof e.msg, 'string', 'entry carries msg');
  }
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok(entries[i].ts >= entries[i - 1].ts, 'ring ordered oldest-first');
  }
  // Secrets never enter the buffer in the clear.
  ring.push('error', 'bridge spawn --serial 1234ABCD failed');
  const last = ring.entries()[ring.size - 1];
  assert.ok(!last.msg.includes('1234ABCD'), 'ring entries redacted on entry');
  assert.strictEqual(hardening.RING_CAP, 200, 'RING_CAP is 200');
}

function checkWatchdog() {
  let now = 1000000;
  const calls = [];
  const wd = hardening.createBridgeWatchdog({
    onRestart: (info) => calls.push(info),
    nowFn: () => now,
  });
  wd.setExpecting(true);
  wd.heartbeat(); // t=0 baseline (spawn moment)

  // 6s of silence while a stream is expected -> exactly 1 restart, 1s backoff.
  now += 6000;
  const fired = wd.check();
  assert.strictEqual(fired.restarted, true, 'watchdog fires after 6s silence');
  assert.strictEqual(calls.length, 1, 'restart called exactly once');
  assert.strictEqual(calls[0].delayMs, 1000, 'first backoff is 1s');
  assert.strictEqual(wd.isWedged(), true, 'wedged flag set');

  // No restart storm while still silent.
  now += 1000;
  assert.strictEqual(wd.check().restarted, false, 'no second restart without recovery');
  assert.strictEqual(calls.length, 1, 'still exactly one restart call');

  // Heartbeat recovers; near-term silence does not refire.
  assert.strictEqual(wd.heartbeat(), true, 'heartbeat reports recovery from wedge');
  assert.strictEqual(wd.isWedged(), false, 'wedge cleared');
  now += 2000;
  assert.strictEqual(wd.check().restarted, false, 'quiet after recovery');
  assert.strictEqual(calls.length, 1, 'no new restart after recovery');

  // Not expecting a stream -> silence is fine (idle, no child).
  const idle = hardening.createBridgeWatchdog({ onRestart: () => calls.push('idle'), nowFn: () => now });
  now += 60000;
  assert.strictEqual(idle.check().restarted, false, 'idle watchdog stays quiet');

  // Backoff escalates 1s/2s/4s… and caps at 30s; heartbeat resets it.
  const wd2 = hardening.createBridgeWatchdog({ nowFn: () => now });
  assert.deepStrictEqual(
    [wd2.noteRestart(), wd2.noteRestart(), wd2.noteRestart(), wd2.noteRestart(), wd2.noteRestart()],
    [1000, 2000, 4000, 8000, 16000],
    'backoff doubles'
  );
  assert.strictEqual(wd2.noteRestart(), 30000, 'backoff caps at 30s');
  assert.strictEqual(wd2.noteRestart(), 30000, 'cap holds');
  assert.strictEqual(hardening.watchdogBackoffMs(1), 1000);
  assert.strictEqual(hardening.watchdogBackoffMs(99), 30000);
  wd2.heartbeat();
  assert.strictEqual(wd2.getState().restarts, 0, 'heartbeat resets backoff counter');
  assert.strictEqual(wd2.noteRestart(), 1000, 'backoff restarts at 1s after recovery');
}

function checkPart1() {
  // Timeouts on every fetch path: single chokepoint with AbortSignal.timeout.
  assert.strictEqual(main.FETCH_TIMEOUT_MS, 8000, 'fetch timeout is 8s');
  assert.strictEqual(main.LRC_RETRIES, 2, 'lrclib retries = 2 (+initial = 3 tries)');

  // Whitelist carries lcdFps + syncOffsetMs with types.
  assert.strictEqual(main.SETTINGS_SCHEMA.lcdFps, 'fps');
  assert.strictEqual(main.SETTINGS_SCHEMA.syncOffsetMs, 'syncOffset');

  // Clamps: fps 5-30 (default 10), offset -2000..2000 (default 0).
  assert.strictEqual(main.clampFps(500), 30, 'fps clamps high');
  assert.strictEqual(main.clampFps(0), 5, 'fps clamps low');
  assert.strictEqual(main.clampFps('nope'), 10, 'fps garbage -> default');
  assert.strictEqual(main.clampSyncOffset(9999), 2000, 'offset clamps high');
  assert.strictEqual(main.clampSyncOffset(-9999), -2000, 'offset clamps low');

  // Whitelist: unknown + token keys rejected, fps accepted+clamped.
  let r = main.validateSettingsPatch({
    lcdFps: 99,
    syncOffsetMs: 100,
    evil: 1,
    accessToken: 'x',
    refreshToken: 'y',
    token: 'z',
    expiresAt: 1,
  });
  assert.deepStrictEqual(r.accepted, { lcdFps: 30, syncOffsetMs: 100 }, 'fps clamped+accepted, offset accepted');
  for (const k of ['evil', 'accessToken', 'refreshToken', 'token', 'expiresAt']) {
    assert.ok(r.rejected.includes(k), `${k} rejected`);
  }
  r = main.validateSettingsPatch({ lcdFps: 'high' });
  assert.deepStrictEqual(r.accepted, { lcdFps: 10 }, 'non-numeric fps -> default via clamp');

  // Diagnostics payload: settings redacted, PM/SUB carried, ring bounded.
  const payload = hardening.buildDiagnostics({
    settings: { spotifyClientId: 'cid', lcdFps: 10, syncOffsetMs: 0, serial: 'SECRET123', runAtStartup: false },
    lcdStatus: { status: 'ok', reason: 'streaming', restarts: 0 },
    ringEntries: [{ ts: 1, level: 'info', msg: 'x' }],
    versions: { app: '0.1.0', electron: '44', bridge: 'protocol-v1' },
    bridge: { panel: 'Vision MAX', pm: 11, sub: 5 },
  });
  assert.strictEqual(payload.settings.serial, '<redacted>', 'diagnostics mask serial');
  assert.strictEqual(payload.bridge.pm, 11, 'diagnostics carry PM');
  assert.strictEqual(payload.bridge.sub, 5, 'diagnostics carry SUB');
  assert.strictEqual(payload.versions.bridge, 'protocol-v1', 'diagnostics carry bridge version');
  assert.ok(Array.isArray(payload.ring) && payload.ring.length <= 200, 'ring bounded in payload');

  // main.redact is the same central function main.js logs through.
  assert.strictEqual(main.redact('serial=ABC123XYZ'), hardening.redact('serial=ABC123XYZ'));
}

try {
  checkRedact();
  checkRing();
  checkWatchdog();
  checkPart1();
  console.log('test_hardening: OK (redact + ring200 + watchdog + parte1)');
} catch (err) {
  console.error(`RESULT fail: ${err.message || err}`);
  process.exit(1);
}
