// @vitest-environment node
'use strict';

/**
 * Scene settings gate (S0-T1): hardening.validateScene is the untrusted-input
 * validator for the settings:save `scene` key; main.validateSettingsPatch must
 * accept or reject it without changing any existing key's behavior.
 *
 * Electron is stubbed before the real src/main.js is required through the
 * native Node loader — same mechanism as main-process.test.js. Hardware-free:
 * no network, no USB, no shell.openExternal.
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
const hardening = requireNative('../../src/hardening.js');
const main = requireNative('../../src/main.js');

const MEDIA = { rotation: 0, flipH: false, scale: 1, panX: 0, panY: 0, fit: 'fit' };
// NUL built via fromCharCode: no literal control characters in the file.
const NUL_SOURCE = 'a' + String.fromCharCode(0) + 'b';

function textOverlay(overrides = {}) {
  return {
    kind: 'text',
    text: 'hi',
    x: 0.5,
    y: 0.5,
    size: 0.1,
    rotation: 0,
    color: '#ffffff',
    ...overrides,
  };
}

function gpuTempOverlay(overrides = {}) {
  return {
    kind: 'gpu-temp',
    x: 0.5,
    y: 0.5,
    size: 0.1,
    rotation: 0,
    color: '#ffffff',
    ...overrides,
  };
}

function sceneWith(background, overlays = []) {
  return { version: 1, background, overlays };
}

function manyOverlays(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(gpuTempOverlay());
  return out;
}

// Shared shape corpus (tests/fixtures/scene-shapes.json): the SAME fixtures
// pin hardening.validateScene and the renderer's isScene to one explicit
// verdict per shape, so dual-copy drift fails at least one suite. JSON cannot
// express NaN/Infinity or accessor properties — those regressions stay inline.
const SCENE_SHAPES = requireNative('../fixtures/scene-shapes.json').shapes;

/**
 * JSON text cannot express array holes or non-index own properties on an
 * array; those entries declare the two mutations so BOTH suites materialize
 * the exact same shape before judging it.
 */
function materialize(entry) {
  const hints = entry.materialize;
  if (hints === undefined) return entry.shape;
  const shape = entry.shape;
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) return shape;
  if (!Array.isArray(shape.overlays)) return shape;
  for (const index of hints.deleteOverlays ?? []) delete shape.overlays[index];
  if (hints.extraOverlayProps !== undefined) {
    Object.assign(shape.overlays, hints.extraOverlayProps);
  }
  return shape;
}

describe('validateScene (S0-T1 scene gate)', () => {
  it('exposes the validator, cap and default', () => {
    expect(typeof hardening.validateScene).toBe('function');
    expect(hardening.SCENE_OVERLAYS_CAP).toBe(32);
    expect(hardening.DEFAULT_SCENE).toEqual({
      version: 1,
      background: { kind: 'none' },
      overlays: [],
    });
  });

  it('accepts DEFAULT_SCENE', () => {
    const r = hardening.validateScene(hardening.DEFAULT_SCENE);
    expect(r.ok).toBe(true);
    expect(r.scene).toEqual({ version: 1, background: { kind: 'none' }, overlays: [] });
  });

  it('accepts a full valid scene for each of the five background kinds', () => {
    const backgrounds = [
      { kind: 'none' },
      { kind: 'color', color: '#102030' },
      { kind: 'image', source: 'C:/media/bg.png', ...MEDIA },
      { kind: 'gif', source: 'data:image/gif;base64,R0lGODlhAQABA', ...MEDIA },
      { kind: 'video', source: 'C:/media/clip.mp4', ...MEDIA },
    ];
    for (const background of backgrounds) {
      const scene = sceneWith(background, [textOverlay(), gpuTempOverlay()]);
      const r = hardening.validateScene(scene);
      expect(r.ok).toBe(true);
      expect(r.scene).toEqual(scene);
    }
  });

  it('rejects an out-of-range x (1.5) with the offending field', () => {
    const r = hardening.validateScene(
      sceneWith({ kind: 'none' }, [gpuTempOverlay({ x: 1.5 })])
    );
    expect(r.ok).toBe(false);
    expect(r.field).toBe('overlays[0].x');
  });

  it('rejects an out-of-range y (-0.1) with the offending field', () => {
    const r = hardening.validateScene(
      sceneWith({ kind: 'none' }, [gpuTempOverlay({ y: -0.1 })])
    );
    expect(r.ok).toBe(false);
    expect(r.field).toBe('overlays[0].y');
  });

  it('rejects a NaN size with the offending field', () => {
    const r = hardening.validateScene(
      sceneWith({ kind: 'none' }, [gpuTempOverlay({ size: NaN })])
    );
    expect(r.ok).toBe(false);
    expect(r.field).toBe('overlays[0].size');
  });

  it('rejects an unknown top-level key', () => {
    const r = hardening.validateScene({
      ...sceneWith({ kind: 'none' }),
      evil: true,
    });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('evil');
  });

  it('rejects an unknown nested key', () => {
    const r = hardening.validateScene(
      sceneWith({ kind: 'none' }, [gpuTempOverlay({ extra: 1 })])
    );
    expect(r.ok).toBe(false);
    expect(r.field).toBe('overlays[0].extra');
  });

  it('rejects a source containing a path-traversal segment', () => {
    const posix = hardening.validateScene(
      sceneWith({ kind: 'image', source: 'a/../b.png', ...MEDIA })
    );
    expect(posix.ok).toBe(false);
    expect(posix.field).toBe('background.source');
    const windows = hardening.validateScene(
      sceneWith({ kind: 'video', source: '..\\..\\clip.mp4', ...MEDIA })
    );
    expect(windows.ok).toBe(false);
    expect(windows.field).toBe('background.source');
  });

  it('rejects a source containing a NUL byte or an empty string', () => {
    const nul = hardening.validateScene(
      sceneWith({ kind: 'gif', source: NUL_SOURCE, ...MEDIA })
    );
    expect(nul.ok).toBe(false);
    expect(nul.field).toBe('background.source');
    const empty = hardening.validateScene(
      sceneWith({ kind: 'gif', source: '', ...MEDIA })
    );
    expect(empty.ok).toBe(false);
    expect(empty.field).toBe('background.source');
  });

  it('rejects more than the overlays cap (32)', () => {
    const over = hardening.validateScene(
      sceneWith({ kind: 'none' }, manyOverlays(33))
    );
    expect(over.ok).toBe(false);
    expect(over.field).toBe('overlays');
    const atCap = hardening.validateScene(
      sceneWith({ kind: 'none' }, manyOverlays(32))
    );
    expect(atCap.ok).toBe(true);
  });

  it('rejects a wrong version and non-object input', () => {
    const version = hardening.validateScene({
      version: 2,
      background: { kind: 'none' },
      overlays: [],
    });
    expect(version.ok).toBe(false);
    expect(version.field).toBe('version');
    expect(hardening.validateScene(null).ok).toBe(false);
    expect(hardening.validateScene('scene').ok).toBe(false);
  });
});

describe('settings: save accepts a validated scene (S0-T1)', () => {
  it('carries scene in the whitelist with the "scene" kind', () => {
    expect(main.SETTINGS_SCHEMA.scene).toBe('scene');
  });

  it('accepts a valid scene patch and returns the sanitized copy', () => {
    const valid = sceneWith({ kind: 'color', color: '#a1b2c3' }, [textOverlay()]);
    const r = main.validateSettingsPatch({ scene: valid });
    expect(r.rejected).toEqual([]);
    expect(r.accepted.scene).toEqual(valid);
  });

  it('rejects an invalid scene as a whole key', () => {
    const bad = sceneWith({ kind: 'color', color: '#a1b2c3' }, [
      gpuTempOverlay({ x: 5 }),
    ]);
    const r = main.validateSettingsPatch({ scene: bad });
    expect(r.accepted).toEqual({});
    expect(r.rejected).toContain('scene');
    const wrongType = main.validateSettingsPatch({ scene: 'nope' });
    expect(wrongType.rejected).toContain('scene');
  });

  it('keeps existing whitelist behavior unchanged next to scene', () => {
    const r = main.validateSettingsPatch({
      lcdFps: 99,
      evil: 1,
      accessToken: 'x',
      scene: sceneWith({ kind: 'none' }),
    });
    expect(r.accepted).toEqual({
      lcdFps: 30,
      scene: sceneWith({ kind: 'none' }),
    });
    expect(r.rejected).toContain('evil');
    expect(r.rejected).toContain('accessToken');
  });
});

describe('shared shape corpus (pins both copies to one verdict)', () => {
  for (const entry of SCENE_SHAPES) {
    it(`${entry.name} -> ${entry.expect}`, () => {
      const r = hardening.validateScene(materialize(entry));
      expect(r.ok).toBe(entry.expect === 'valid');
      if (entry.field !== undefined) expect(r.field).toBe(entry.field);
    });
  }
});

describe('regressions: gate totalness & array shape (S0-T1 verification)', () => {
  it('rejects a sparse overlays array (hole at index 1) with the offending index', () => {
    const overlays = [gpuTempOverlay()];
    overlays[2] = gpuTempOverlay();
    const r = hardening.validateScene(sceneWith({ kind: 'none' }, overlays));
    expect(r.ok).toBe(false);
    expect(r.field).toBe('overlays[1]');
  });

  it('rejects own non-index properties on the overlays array instead of stripping them', () => {
    const overlays = Object.assign([gpuTempOverlay(), gpuTempOverlay()], { evil: 1 });
    const r = hardening.validateScene(sceneWith({ kind: 'none' }, overlays));
    expect(r.ok).toBe(false);
    expect(r.field).toBe('overlays');
  });

  it('returns {ok:false} instead of throwing when a field getter throws', () => {
    const overlay = gpuTempOverlay();
    Object.defineProperty(overlay, 'x', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const r = hardening.validateScene(sceneWith({ kind: 'none' }, [overlay]));
    expect(r.ok).toBe(false);
    expect(r.field).toBe('<unknown>');
  });
});
