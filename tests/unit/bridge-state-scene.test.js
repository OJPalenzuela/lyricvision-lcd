// @vitest-environment node
'use strict';

/**
 * S1-T7a — the composed live loop reads the scene from
 * `state.settings.scene`, so buildBridgeState is the last mile that carries
 * it from settings.json to the sidecar. A valid scene must round-trip
 * (including through JSON.stringify, the actual wire encoding); an invalid
 * one must be omitted entirely so the sidecar falls back to the lyrics view.
 * Same electron stub as the other main.js suites (src/main.js required for
 * real); hardware-free: no USB, no network, no shell.openExternal.
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
const main = requireNative('../../src/main.js');

const VALID_SCENE = {
  version: 1,
  background: { kind: 'color', color: '#123456' },
  overlays: [
    { kind: 'text', text: 'Hi', x: 0.5, y: 0.5, size: 0.1, rotation: 0, color: '#ffffff' },
  ],
};

const INVALID_SCENES = [
  { version: 2, background: { kind: 'none' }, overlays: [] },
  { background: { kind: 'none' }, overlays: [] },
  { version: 1, background: { kind: 'telepathy' }, overlays: [] },
  { version: 1, background: { kind: 'none' }, overlays: [], extra: 1 },
  'not-an-object',
  42,
  null,
];

describe('buildBridgeState scene plumbing', () => {
  it('carries a valid scene into settings.scene', () => {
    const s = main.buildBridgeState({ measuredAt: 1000 }, { scene: VALID_SCENE });
    expect(s.settings.scene).toEqual(VALID_SCENE);
  });

  it('survives the JSON wire encoding unchanged', () => {
    const s = main.buildBridgeState({ measuredAt: 1000 }, { scene: VALID_SCENE });
    const wire = JSON.parse(JSON.stringify({ v: 1, cmd: 'state', state: s }));
    expect(wire.state.settings.scene).toEqual(VALID_SCENE);
  });

  it.each(INVALID_SCENES.map((scene, i) => [i, scene]))(
    'omits invalid scene #%i so the sidecar falls back to lyrics view',
    (_i, scene) => {
      const s = main.buildBridgeState({ measuredAt: 1000 }, { scene });
      expect(Object.prototype.hasOwnProperty.call(s.settings, 'scene')).toBe(false);
      const wire = JSON.parse(JSON.stringify(s));
      expect(Object.prototype.hasOwnProperty.call(wire.settings, 'scene')).toBe(false);
    }
  );

  it('omits scene when settings carry none', () => {
    const s = main.buildBridgeState({ measuredAt: 1000 }, {});
    expect(Object.prototype.hasOwnProperty.call(s.settings, 'scene')).toBe(false);
  });

  it('keeps the existing settings fields untouched', () => {
    const s = main.buildBridgeState(
      { measuredAt: 1000 },
      { lcdFps: 24, layout: 'cover', scene: VALID_SCENE }
    );
    expect(s.settings.lcdFps).toBe(24);
    expect(s.settings.layout).toBe('cover');
    expect(s.settings.scene).toEqual(VALID_SCENE);
  });
});
