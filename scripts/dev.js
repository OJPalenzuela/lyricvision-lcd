'use strict';

/**
 * Dev launcher: Vite renderer + Electron shell (plain Node, no deps).
 *
 * 1. Spawns `vite` (serves src/renderer on http://localhost:5173).
 * 2. Polls the dev server until it responds (timeout ~30s).
 * 3. Spawns `electron .` with ELECTRON_RENDERER_URL set so main.js
 *    loads the dev server instead of the built file.
 * Ctrl-C (or either child exiting) kills both children.
 *
 * Pure helpers (buildViteArgs, selectKillStrategy, taskkillArgs) and the
 * track()/killAll() seams are exported for unit tests; everything OS-facing
 * stays in thin wrappers.
 */

const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');

const VITE_URL = 'http://localhost:5173';
const START_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 500;

function buildViteArgs() {
  // --strictPort: without it, plain `vite` auto-increments past 5173 when the
  // port is taken, while VITE_URL stays hardcoded — Electron would then load
  // a stale (or wrong) server. Fail loudly instead of silently detaching.
  return ['vite', '--strictPort'];
}

function selectKillStrategy(platform) {
  // Win32 ignores SIGTERM sent via child.kill(), so a bare kill() leaves the
  // whole cmd.exe wrapper tree (shell: true) alive after Ctrl-C. POSIX
  // platforms honor the default SIGTERM, so plain kill() is correct there.
  // Unknown/future platform strings fall back to the portable signal path.
  return platform === 'win32' ? 'taskkill' : 'signal';
}

function taskkillArgs(pid) {
  // /T kills the whole tree (child.pid is the cmd.exe wrapper because both
  // spawns use shell: true, so killing just that PID would orphan vite/electron);
  // /F forces termination since Win32 won't deliver SIGTERM semantics.
  return ['/PID', String(pid), '/T', '/F'];
}

const children = new Set();

function track(child) {
  children.add(child);
  child.on('exit', () => {
    children.delete(child);
  });
}

// platform/runner are injectable so tests can observe the dispatch without
// touching a real OS; production callers (signal handlers, exit hook, error
// paths) omit both and keep the historical behaviour: process.platform for
// the strategy, spawnSync for taskkill.
function killAll({ platform = process.platform, runner = spawnSync } = {}) {
  const strategy = selectKillStrategy(platform);
  for (const child of [...children]) {
    try {
      if (strategy === 'taskkill' && child.pid) {
        runner('taskkill', taskkillArgs(child.pid), { stdio: 'ignore' });
      } else {
        child.kill();
      }
    } catch {
      // already gone — shutdown must never throw
    }
  }
}

function waitForServer(url, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
        } else {
          retryOrTimeout();
        }
      });
      req.on('error', retryOrTimeout);
      req.setTimeout(POLL_INTERVAL_MS, () => {
        req.destroy();
        retryOrTimeout();
      });
      function retryOrTimeout() {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`dev server did not respond at ${url} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, POLL_INTERVAL_MS);
      }
    };
    attempt();
  });
}

async function main() {
  const vite = spawn('npx', buildViteArgs(), {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  track(vite);

  let failed = false;
  vite.on('error', (err) => {
    console.error(`[dev] vite spawn failed: ${String((err && err.message) || err)}`);
    failed = true;
    killAll();
  });
  vite.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev] vite exited with code ${code}`);
      failed = true;
      killAll();
    }
  });

  try {
    await waitForServer(VITE_URL, START_TIMEOUT_MS);
  } catch (err) {
    console.error(`[dev] ${String((err && err.message) || err)}`);
    killAll();
    process.exitCode = 1;
    return;
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }

  const electron = spawn('npx', ['electron', '.'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ELECTRON_RENDERER_URL: VITE_URL },
  });
  track(electron);

  electron.on('exit', () => {
    killAll();
  });
  electron.on('error', (err) => {
    console.error(`[dev] electron spawn failed: ${String((err && err.message) || err)}`);
    killAll();
    process.exitCode = 1;
  });
}

function shutdown(signal) {
  void signal;
  killAll();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Node passes the exit code (a number) as the first argument to an 'exit'
// listener, so the handler is wrapped: the code must never land in killAll's
// options parameter during shutdown.
process.on('exit', () => killAll());

// Only launch when executed directly (`node scripts/dev.js` / `pnpm dev`).
// Requiring this file from a test must not spawn anything; the signal handlers
// above stay unconditional so Ctrl-C cleanup works regardless of entry point.
if (require.main === module) {
  main().catch((err) => {
    console.error(`[dev] ${String((err && err.stack) || err)}`);
    killAll();
    process.exitCode = 1;
  });
}

module.exports = {
  VITE_URL,
  START_TIMEOUT_MS,
  buildViteArgs,
  selectKillStrategy,
  taskkillArgs,
  track,
  killAll,
  waitForServer,
};
