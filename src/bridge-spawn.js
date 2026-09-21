'use strict';

/**
 * LyricVision LCD — sidecar spawn path (LV-05).
 *
 * Pure Node (no Electron imports) so the EXACT resolve+spawn path used by
 * main.js can be exercised headless by tests/test_shell_spawn.js.
 *
 * Dev:      `.venv/python bridge/lcd_bridge.py` with `python` PATH fallback.
 * Packaged: `<resources>/lcd_bridge.exe` (PyInstaller onefile).
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function repoRoot() {
  return path.join(__dirname, '..');
}

function bridgeScript() {
  return path.join(repoRoot(), 'bridge', 'lcd_bridge.py');
}

/**
 * Ordered python candidates for dev: project-local venv first,
 * bare `python` (PATH) as the documented fallback.
 */
function devPythonCandidates() {
  const venvDir = path.join(
    repoRoot(),
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin'
  );
  const ext = process.platform === 'win32' ? '.exe' : '';
  return [path.join(venvDir, `python${ext}`), 'python'];
}

/**
 * Resolve the exact command+args main.js will spawn.
 *
 * @param {object} opts
 * @param {object} [opts.app] - Electron app (only `isPackaged` is read).
 * @param {string} [opts.serial] - USB serial for `--serial` (omit = auto).
 * @param {number} [opts.once] - frame count for `--once` (tests only).
 * @returns {{command:string, args:string[], source:string}}
 */
function resolveBridgeCommand({ app, serial = null, once = null } = {}) {
  const extra = [];
  if (serial) extra.push('--serial', String(serial));
  if (once !== null && once !== undefined) extra.push('--once', String(once));

  if (app && app.isPackaged) {
    return {
      command: path.join(process.resourcesPath, 'lcd_bridge.exe'),
      args: extra,
      source: 'packaged',
    };
  }

  const script = bridgeScript();
  let command = 'python';
  let source = 'dev-fallback';
  for (const candidate of devPythonCandidates()) {
    if (!candidate.includes(path.sep)) continue; // PATH fallback, checked last
    try {
      if (fs.existsSync(candidate)) {
        command = candidate;
        source = 'dev-venv';
        break;
      }
    } catch {
      // ignore FS errors, fall through to PATH fallback
    }
  }
  return { command, args: [script, ...extra], source };
}

/**
 * Spawn the sidecar. Returns the ChildProcess (stdio: pipe/pipe/pipe).
 * Callers attach stdout (status/ack JSONL), stderr (human logs) and
 * `exit` (0 ok / 2 panel-unknown / 3 usb-busy-or-absent) handlers.
 */
function spawnBridge({ app, serial, once, spawnFn = spawn } = {}) {
  const { command, args, source } = resolveBridgeCommand({ app, serial, once });
  const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.__bridgeSource = source;
  return child;
}

module.exports = {
  repoRoot,
  bridgeScript,
  devPythonCandidates,
  resolveBridgeCommand,
  spawnBridge,
};
