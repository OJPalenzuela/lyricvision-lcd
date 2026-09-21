'use strict';

/**
 * Spawn-path verification for the LV-05 shell (headless-safe, plain node).
 *
 * Uses the EXACT resolve+spawn path from src/bridge-spawn.js (the same
 * module main.js spawns through): launches the real bridge with `--once 3`,
 * pipes versioned state envelopes through stdin and asserts 3 acks.
 *
 * Device present + TRCC closed is assumed. If the device is busy/absent the
 * bridge exits 3: this script reports `blocked` with the exact message
 * instead of failing the ack assertion.
 *
 * Run: node tests/test_shell_spawn.js
 */

const path = require('path');

const { resolveBridgeCommand, spawnBridge } = require('../src/bridge-spawn');

const FRAMES = 3;
const TIMEOUT_MS = 90000;

function demoState(seq) {
  return {
    v: 1,
    seq,
    cmd: 'state',
    state: {
      track: { title: 'Spawn test', artist: 'LyricVision' },
      lyric: { current_line: `ack line ${seq}`, next_line: 'next' },
      progressMs: seq * 1000,
      durationMs: 180000,
      isPlaying: true,
      settings: { lcdFps: 30 }, // fast frames so --once 3 finishes quickly
    },
  };
}

async function main() {
  const resolved = resolveBridgeCommand({ app: { isPackaged: false }, once: FRAMES });
  console.log(`spawn-path: ${resolved.command} ${resolved.args.join(' ')} [${resolved.source}]`);

  const scriptIdx = resolved.args.findIndex((a) => String(a).endsWith('lcd_bridge.py'));
  if (scriptIdx < 0) throw new Error('resolved args do not target bridge/lcd_bridge.py');

  const child = spawnBridge({ app: { isPackaged: false }, once: FRAMES });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => {
    stdout += c.toString('utf8');
  });
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });

  // Pipe several versioned states immediately (handshake precedes rendering,
  // so at least one state is queued before the first frame drains).
  for (let seq = 1; seq <= FRAMES + 3; seq += 1) {
    child.stdin.write(`${JSON.stringify(demoState(seq))}\n`);
  }

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      reject(new Error(`bridge did not exit within ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const acks = [];
  let lastStatus = null;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg && msg.type === 'ack' && typeof msg.seq === 'number') acks.push(msg.seq);
      if (msg && msg.type === 'status') lastStatus = msg;
    } catch {
      // ignore non-JSON stdout
    }
  }

  if (code === 3) {
    const message = (lastStatus && (lastStatus.message || lastStatus.status)) || stderr.trim() || 'unknown';
    console.log(`RESULT blocked: exit 3 — ${message}`);
    console.log(`(status line: ${JSON.stringify(lastStatus)})`);
    return;
  }
  if (code === 2) {
    console.log(`RESULT panel-unknown: exit 2 — ${JSON.stringify(lastStatus)}`);
    throw new Error('expected the known Vision MAX panel, got exit 2 (panel-unknown)');
  }
  if (code !== 0) {
    console.log(`stderr tail: ${stderr.trim().split('\n').slice(-5).join('\n')}`);
    throw new Error(`expected exit 0, got ${code}`);
  }
  if (acks.length !== FRAMES) {
    throw new Error(`expected ${FRAMES} acks, got ${acks.length} (seqs: ${acks.join(',')})`);
  }
  console.log(`RESULT ok: exit 0, ${acks.length} acks (seqs ${acks.join(',')}), ${path.basename(resolved.command)} [${resolved.source}]`);
}

main().catch((err) => {
  console.error(`RESULT fail: ${err.message || err}`);
  process.exit(1);
});
