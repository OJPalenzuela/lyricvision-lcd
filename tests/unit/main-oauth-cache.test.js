// @vitest-environment node
'use strict';

/**
 * T8 — characterization tests for the T7 export-hook additions (part 1):
 * OAuth/PKCE helpers, the OAuth port fallback, and the LRCLIB cache +
 * search scoring.
 *
 * Same mechanism as tests/unit/main-process.test.js: `electron` is stubbed
 * via Module._load before the REAL src/main.js is required through the
 * native Node loader. No network, no Spotify calls, no USB, no
 * shell.openExternal at test time.
 *
 * TDD honesty: these are characterization tests over existing, already-
 * correct code, so they went straight to GREEN — there was no RED to
 * observe (see the task report). They pin the behaviour instead of
 * discovering it.
 */

import Module from 'node:module';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

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
const main = requireNative('../../src/main.js');

describe('base64url', () => {
  it('encodes without padding', () => {
    expect(main.base64url(Buffer.from('f'))).toBe('Zg');
    expect(main.base64url(Buffer.from('foobar'))).toBe('Zm9vYmFy');
  });

  it('uses the URL-safe alphabet (+ -> -, / -> _)', () => {
    // 0xFF 0xFF 0xFF is '////' in standard base64.
    expect(main.base64url(Buffer.from([0xff, 0xff, 0xff]))).toBe('____');
  });

  it('encodes empty input to empty output', () => {
    expect(main.base64url(Buffer.alloc(0))).toBe('');
  });
});

describe('PKCE S256 construction (RFC 7636 Appendix B vector)', () => {
  // src/main.js builds the pair inline in startSpotifyAuth (no named
  // helper): verifier = base64url(randomBytes(64)),
  // challenge = base64url(sha256(verifier)). This pins that exact
  // construction against the RFC's published vector.
  it('derives the RFC 7636 challenge from the RFC verifier', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = main.base64url(
      crypto.createHash('sha256').update(verifier).digest()
    );
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('produces the same shapes startSpotifyAuth uses (86/43/22 chars)', () => {
    const verifier = main.base64url(crypto.randomBytes(64));
    const challenge = main.base64url(
      crypto.createHash('sha256').update(verifier).digest()
    );
    const state = main.base64url(crypto.randomBytes(16));
    expect(verifier).toHaveLength(86);
    expect(challenge).toHaveLength(43);
    expect(state).toHaveLength(22);
    for (const s of [verifier, challenge, state]) {
      expect(s).not.toMatch(/[+/=]/);
    }
  });
});

describe('OAuth port fallback', () => {
  it('pins the fallback range 17321-17331', () => {
    expect(main.OAUTH_PORT_START).toBe(17321);
    expect(main.OAUTH_PORT_END).toBe(17331);
  });

  // NOTE (AGENTS.md gotcha): 17321 is dead in practice — the Spotify
  // desktop client typically holds it — so production almost always
  // enters the fallback. These tests NEVER bind a real socket and NEVER
  // assert 17321 itself is usable; they drive listenOnFirstFreePort with
  // scripted fake servers to prove the fallback advances.
  function fakeServer(script) {
    const handlers = {};
    return {
      handlers,
      calls: [],
      once(event, fn) {
        // Node once-semantics: auto-remove after firing (the real server
        // relies on this; without it one error emission would cascade
        // through every accumulated handler and exhaust the range).
        const wrap = (...args) => {
          this.removeListener(event, fn);
          fn(...args);
        };
        wrap.__orig = fn;
        handlers[event] = handlers[event] || [];
        handlers[event].push(wrap);
        return this;
      },
      removeListener(event, fn) {
        handlers[event] = (handlers[event] || []).filter(
          (h) => h !== fn && h.__orig !== fn
        );
        return this;
      },
      listen(port, host, cb) {
        this.calls.push({ port, host });
        const action = Object.hasOwn(script, port) ? script[port] : 'ok';
        queueMicrotask(() => {
          if (action === 'busy') {
            const err = new Error(`listen EADDRINUSE: 127.0.0.1:${port}`);
            err.code = 'EADDRINUSE';
            for (const h of handlers.error || []) h(err);
          } else if (action instanceof Error) {
            for (const h of handlers.error || []) h(action);
          } else {
            cb();
          }
        });
        return this;
      },
    };
  }

  it('advances past one busy port', async () => {
    const server = fakeServer({ 17321: 'busy' });
    await expect(main.listenOnFirstFreePort(server)).resolves.toBe(17322);
    expect(server.calls.map((c) => c.port)).toEqual([17321, 17322]);
    for (const c of server.calls) expect(c.host).toBe('127.0.0.1');
  });

  it('skips a run of busy ports', async () => {
    const server = fakeServer({ 17321: 'busy', 17322: 'busy', 17323: 'busy' });
    await expect(main.listenOnFirstFreePort(server)).resolves.toBe(17324);
  });

  it('rejects with an actionable error when the whole range is busy', async () => {
    const script = {};
    for (let p = main.OAUTH_PORT_START; p <= main.OAUTH_PORT_END; p += 1) {
      script[p] = 'busy';
    }
    const server = fakeServer(script);
    await expect(main.listenOnFirstFreePort(server)).rejects.toThrow(
      /no free OAuth callback port in 17321-17331/
    );
    await expect(
      main.listenOnFirstFreePort(fakeServer(script))
    ).rejects.toThrow(/another LyricVision instance/);
    expect(server.calls).toHaveLength(
      main.OAUTH_PORT_END - main.OAUTH_PORT_START + 1
    );
  });

  it('rejects a non-EADDRINUSE error instead of skipping it', async () => {
    const denied = Object.assign(new Error('listen EACCES: permission denied'), {
      code: 'EACCES',
    });
    await expect(main.listenOnFirstFreePort(fakeServer({ 17321: denied }))).rejects.toBe(
      denied
    );
  });

  it('removes the error listener once a port binds', async () => {
    const server = fakeServer({});
    await main.listenOnFirstFreePort(server);
    expect(server.handlers.error || []).toEqual([]);
  });
});

describe('closeOAuthServer', () => {
  it('is a safe no-op when no flow is in progress', () => {
    expect(main.closeOAuthServer()).toBeUndefined();
  });
});

describe('lyricsCacheKey', () => {
  it('buckets duration into 5s windows', () => {
    expect(main.lyricsCacheKey('Hello', 'Adele', 183000)).toBe('adele|hello|37');
    expect(main.lyricsCacheKey('Hello', 'Adele', 180000)).toBe('adele|hello|36');
  });

  it('is case-insensitive and trims', () => {
    expect(main.lyricsCacheKey('  HELLO ', ' ADELE ', 183000)).toBe(
      main.lyricsCacheKey('hello', 'adele', 183000)
    );
  });

  it('tolerates missing duration', () => {
    expect(main.lyricsCacheKey('T', 'A', 0)).toBe('a|t|0');
    expect(main.lyricsCacheKey('T', 'A', undefined)).toBe('a|t|0');
  });
});

describe('LRCLIB cache (LRU + TTL)', () => {
  const lines = [
    { startMs: 1000, text: 'line one' },
    { startMs: 5000, text: 'line two' },
  ];

  afterAll(() => {
    // cacheSet persists to the stub userData dir (os.tmpdir()); remove the
    // probe artifact so later runs start clean. A real app never writes
    // here (it uses %APPDATA%), so this cannot delete user data.
    try {
      fs.rmSync(path.join(os.tmpdir(), 'lyrics-cache.json'), { force: true });
    } catch {
      // cleanup is best-effort
    }
    vi.useRealTimers();
  });

  it('round-trips what cacheSet stored', () => {
    main.cacheSet('t8|roundtrip|1', lines);
    expect(main.cacheGet('t8|roundtrip|1')).toEqual(lines);
  });

  it('misses unknown keys', () => {
    expect(main.cacheGet('t8|no-such-key|0')).toBeNull();
  });

  it('evicts the oldest entry past capacity (LRU bound)', () => {
    // Fill to exactly capacity with known keys first, so leftovers from
    // earlier tests in this file cannot shift the eviction math.
    for (let i = 0; i < main.LYRICS_CACHE_MAX; i += 1) {
      main.cacheSet(`t8|lru-pre|${i}`, lines);
    }
    main.cacheSet('t8|lru|a', lines);
    main.cacheSet('t8|lru|b', lines);
    // Touch A so it is newer than B.
    expect(main.cacheGet('t8|lru|a')).toEqual(lines);
    // 199 more inserts evict everything older than B… then B itself, while
    // the touched A survives. That is LRU (not FIFO): without the touch,
    // A would be evicted before B.
    for (let i = 0; i < main.LYRICS_CACHE_MAX - 1; i += 1) {
      main.cacheSet(`t8|lru-fill|${i}`, lines);
    }
    expect(main.cacheGet('t8|lru|b')).toBeNull();
    expect(main.cacheGet('t8|lru|a')).toEqual(lines);
    expect(main.cacheGet(`t8|lru-fill|${main.LYRICS_CACHE_MAX - 2}`)).toEqual(lines);
  });

  it('expires stale entries and keeps fresh ones (TTL)', () => {
    const start = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(start);
      main.cacheSet('t8|ttl|stale', lines);
      // A sibling written after the TTL window is still fresh.
      vi.setSystemTime(start + main.LYRICS_CACHE_TTL_MS + 1000);
      main.cacheSet('t8|ttl|fresh', lines);
      expect(main.cacheGet('t8|ttl|stale')).toBeNull();
      expect(main.cacheGet('t8|ttl|fresh')).toEqual(lines);
      // The expired entry is gone, not just hidden.
      expect(main.cacheGet('t8|ttl|stale')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still serves entries just inside the TTL', () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      vi.setSystemTime(start);
      main.cacheSet('t8|ttl|edge', lines);
      vi.setSystemTime(start + main.LYRICS_CACHE_TTL_MS - 1000);
      expect(main.cacheGet('t8|ttl|edge')).toEqual(lines);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('scoreSearchResult', () => {
  it('rewards exact title + artist + close duration', () => {
    const item = {
      syncedLyrics: '[00:01.00] hi',
      trackName: 'Song',
      artistName: 'Band',
      duration: 180,
    };
    // 3 (title) + 3 (artist) + 2 (duration within 2s).
    expect(main.scoreSearchResult(item, 'Song', 'Band', 180000)).toBe(8);
  });

  it('is case-insensitive on the exact path', () => {
    const item = {
      syncedLyrics: '[00:01.00] hi',
      trackName: 'SONG',
      artistName: 'band',
      duration: 180,
    };
    expect(main.scoreSearchResult(item, 'song', 'BAND', 180000)).toBe(8);
  });

  it('rewards partial matches less than exact ones', () => {
    const item = {
      syncedLyrics: '[00:01.00] hi',
      trackName: 'Song (Remastered)',
      artistName: 'Band',
      duration: 183,
    };
    // 1 (partial title) + 3 (artist) + 1 (duration within 5s).
    const partial = main.scoreSearchResult(item, 'Song', 'Band', 180000);
    expect(partial).toBe(5);
    expect(partial).toBeLessThan(8);
  });

  it('penalizes a far-apart duration', () => {
    const item = {
      syncedLyrics: '[00:01.00] hi',
      trackName: 'Other',
      artistName: 'Else',
      duration: 300,
    };
    // 0 + 0 - 2 (diff > 15s).
    expect(main.scoreSearchResult(item, 'Song', 'Band', 180000)).toBe(-2);
  });

  it('rejects anything without synced lyrics (v0.1 drives synced only)', () => {
    expect(
      main.scoreSearchResult(
        { trackName: 'Song', artistName: 'Band', duration: 180 },
        'Song',
        'Band',
        180000
      )
    ).toBe(-1);
    expect(main.scoreSearchResult(null, 'Song', 'Band', 180000)).toBe(-1);
  });
});
