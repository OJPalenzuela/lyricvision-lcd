// @vitest-environment node
'use strict';

/**
 * Dev-loop correctness for scripts/dev.js (ROADMAP: dev-loop correctness).
 *
 * Decisions pinned here so they can be unit-tested without touching an OS
 * or a real Vite server:
 *
 * 1. buildViteArgs() must pass `--strictPort` — plain `vite` auto-increments
 *    the port when 5173 is taken, while VITE_URL stays hardcoded, so Electron
 *    can attach to the wrong server.
 * 2. selectKillStrategy()/taskkillArgs() — `child.kill()` sends SIGTERM,
 *    which Win32 ignores, leaving orphaned vite/electron trees after Ctrl-C;
 *    on Windows the whole tree must be force-killed via `taskkill /T /F`
 *    (both spawns use `shell: true`, so child.pid is the cmd.exe wrapper and
 *    a tree kill is required, not a single-process kill).
 * 3. killAll() dispatch itself, not just its helpers: a child seeded into the
 *    tracked set through the real track() must reach `taskkill /PID <pid>
 *    /T /F` on win32 (observed through an injected runner) and fall back to
 *    child.kill() with no runner call elsewhere — deleting the taskkill
 *    branch from killAll() fails these tests.
 *
 * Same stubbing technique as main-process.test.js: `child_process` (and
 * `http`, so no real polling happens) are intercepted through Module._load
 * before the REAL scripts/dev.js is required through the native Node loader
 * (createRequire keeps Vitest's ESM pipeline out of the CommonJS graph).
 * The interceptors record every spawn call, which doubles as the
 * "requiring the module must not spawn anything" side-effect assertion.
 */

import Module from 'node:module';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const spawnCalls = [];
const spawnSyncCalls = [];

const fakeChild = () => {
  const child = {
    pid: 4242,
    on: () => child,
    kill: () => true,
  };
  return child;
};

// Stubs for every OS-facing primitive scripts/dev.js touches. Recording the
// calls is what lets the tests assert side effects (or their absence).
const childProcessStub = {
  spawn: (...args) => {
    spawnCalls.push(args);
    return fakeChild();
  },
  spawnSync: (...args) => {
    spawnSyncCalls.push(args);
    return { status: 0, stdout: Buffer.alloc(0) };
  },
};

// A 200-OK immediate response keeps waitForServer() from polling the network
// while the module body runs under test (RED path only; the GREEN path never
// reaches it because main() is guarded by require.main === module).
const httpStub = {
  get: (_url, cb) => {
    const req = {
      on: () => req,
      setTimeout: () => req,
      destroy: () => {},
    };
    cb({ statusCode: 200, resume: () => {} });
    return req;
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node:child_process' || request === 'child_process') {
    return childProcessStub;
  }
  if (request === 'node:http' || request === 'http') {
    return httpStub;
  }
  return originalLoad.call(this, request, ...rest);
};

const requireNative = createRequire(import.meta.url);
const dev = requireNative('../../scripts/dev.js');
// Restore as soon as the module under test is loaded: dev.js captured its
// destructured spawn/spawnSync refs already, and later loads must be real.
Module._load = originalLoad;

describe('buildViteArgs', () => {
  it('returns the vite command with --strictPort', () => {
    expect(dev.buildViteArgs()).toEqual(['vite', '--strictPort']);
  });
});

describe('selectKillStrategy', () => {
  it('uses taskkill on win32', () => {
    expect(dev.selectKillStrategy('win32')).toBe('taskkill');
  });

  it('uses signal on linux and darwin', () => {
    expect(dev.selectKillStrategy('linux')).toBe('signal');
    expect(dev.selectKillStrategy('darwin')).toBe('signal');
  });

  it('falls back to signal for an unknown platform string', () => {
    expect(dev.selectKillStrategy('some-future-platform')).toBe('signal');
    expect(dev.selectKillStrategy('')).toBe('signal');
    expect(dev.selectKillStrategy(undefined)).toBe('signal');
  });
});

describe('taskkillArgs', () => {
  it('builds /PID <pid> /T /F in that exact order', () => {
    expect(dev.taskkillArgs(1234)).toEqual(['/PID', '1234', '/T', '/F']);
    expect(dev.taskkillArgs(0)).toEqual(['/PID', '0', '/T', '/F']);
  });

  it('stringifies the pid', () => {
    for (const arg of dev.taskkillArgs(99)) {
      expect(typeof arg).toBe('string');
    }
  });
});

// Seeds a fake child into the module-global children Set through the real
// track(), and hands back the exit handler track() registered — firing that
// handler is exactly how production removes a child, so cleanup goes through
// the real removal path instead of reaching into the Set from outside.
const trackFakeChild = (pid, kill = () => true) => {
  const exitHandlers = [];
  const child = {
    pid,
    on(event, handler) {
      if (event === 'exit') exitHandlers.push(handler);
      return child;
    },
    kill,
  };
  dev.track(child);
  return () => {
    for (const handler of exitHandlers) {
      handler();
    }
  };
};

describe('killAll dispatch', () => {
  it('runs taskkill /PID <pid> /T /F through the injected runner on win32', () => {
    const runnerCalls = [];
    const release = trackFakeChild(4242);
    try {
      dev.killAll({ platform: 'win32', runner: (...args) => runnerCalls.push(args) });
      // Pins pid stringification, the tree flag (/T), the force flag (/F)
      // and the ignored stdio, in exactly that argument order.
      expect(runnerCalls).toEqual([
        ['taskkill', ['/PID', '4242', '/T', '/F'], { stdio: 'ignore' }],
      ]);
      // The injected runner must fully replace the default spawnSync seam,
      // not run in addition to it.
      expect(spawnSyncCalls.length).toBe(0);
    } finally {
      release();
    }
    // release() fired track()'s exit handler, so the child must be gone and
    // a repeat run must not reach the runner again.
    const rerunCalls = [];
    dev.killAll({ platform: 'win32', runner: (...args) => rerunCalls.push(args) });
    expect(rerunCalls).toEqual([]);
  });

  it('kills the child directly and never touches the runner off win32', () => {
    const runnerCalls = [];
    let killCalls = 0;
    const release = trackFakeChild(777, () => {
      killCalls += 1;
      return true;
    });
    try {
      dev.killAll({ platform: 'linux', runner: (...args) => runnerCalls.push(args) });
      expect(runnerCalls).toEqual([]);
      expect(killCalls).toBe(1);
    } finally {
      release();
    }
  });
});

describe('module surface', () => {
  it('exports killAll, waitForServer, VITE_URL and START_TIMEOUT_MS', () => {
    expect(typeof dev.killAll).toBe('function');
    expect(typeof dev.waitForServer).toBe('function');
    expect(dev.VITE_URL).toBe('http://localhost:5173');
    expect(dev.START_TIMEOUT_MS).toBe(30000);
  });

  it('killAll() never throws with an empty child set', () => {
    expect(() => dev.killAll()).not.toThrow();
  });

  it('requiring the module spawns nothing (main() is guarded)', () => {
    // The module body has already run above; if main() executed at load
    // time, spawnCalls would be non-empty (vite + electron).
    expect(spawnCalls.length).toBe(0);
  });
});
