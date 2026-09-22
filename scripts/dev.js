'use strict';

/**
 * Dev launcher: Vite renderer + Electron shell (plain Node, no deps).
 *
 * 1. Spawns `vite` (serves src/renderer on http://localhost:5173).
 * 2. Polls the dev server until it responds (timeout ~30s).
 * 3. Spawns `electron .` with ELECTRON_RENDERER_URL set so main.js
 *    loads the dev server instead of the built file.
 * Ctrl-C (or either child exiting) kills both children.
 */

const { spawn } = require('node:child_process');
const http = require('node:http');

const VITE_URL = 'http://localhost:5173';
const START_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 500;

const children = new Set();

function track(child) {
  children.add(child);
  child.on('exit', () => {
    children.delete(child);
  });
}

function killAll() {
  for (const child of [...children]) {
    try {
      child.kill();
    } catch {
      // already gone
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
  const vite = spawn('npx', ['vite'], {
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
process.on('exit', killAll);

main().catch((err) => {
  console.error(`[dev] ${String((err && err.stack) || err)}`);
  killAll();
  process.exitCode = 1;
});
