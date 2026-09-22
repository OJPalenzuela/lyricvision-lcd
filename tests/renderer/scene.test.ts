/**
 * Scene model contract (S0-T1): normalized glass-space coordinates,
 * discriminated unions, and type guards. Pure data — no network, no USB,
 * no shell access.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCENE,
  SCENE_OVERLAYS_CAP,
  isBackground,
  isOverlay,
  isScene,
  type Background,
  type Overlay,
  type Scene,
  type Transform,
} from '@/lib/scene';

// The main-process copy of the defaults is CommonJS: require() it natively
// so Vitest's ESM pipeline stays out of the CommonJS graph (same reason
// tests/unit/main-process.test.js uses createRequire).
const requireCjs = createRequire(import.meta.url);
const hardening: {
  DEFAULT_SCENE: Scene;
  SCENE_OVERLAYS_CAP: number;
} = requireCjs('../../src/hardening.js');

/**
 * Shared shape corpus (tests/fixtures/scene-shapes.json): one file, two
 * verdicts. Every entry states the expected verdict explicitly, so the TS
 * guard and the CommonJS gate can never silently drift — a change to either
 * copy that flips a verdict fails at least one of the two suites.
 */
interface SceneShapeEntry {
  name: string;
  expect: 'valid' | 'invalid';
  field?: string;
  shape: unknown;
  materialize?: {
    deleteOverlays?: number[];
    extraOverlayProps?: Record<string, unknown>;
  };
}

const SCENE_SHAPES: SceneShapeEntry[] = requireCjs('../fixtures/scene-shapes.json').shapes;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON text cannot express array holes or non-index own properties on an
 * array; those entries declare the two mutations so BOTH suites materialize
 * the exact same shape before judging it.
 */
function materialize(entry: SceneShapeEntry): unknown {
  const hints = entry.materialize;
  if (hints === undefined) return entry.shape;
  const shape = entry.shape;
  if (!isRecord(shape) || !Array.isArray(shape['overlays'])) return shape;
  const overlays = shape['overlays'];
  for (const index of hints.deleteOverlays ?? []) delete overlays[index];
  if (hints.extraOverlayProps !== undefined) {
    Object.assign(overlays, hints.extraOverlayProps);
  }
  return shape;
}

const MEDIA_TRANSFORM: Transform = {
  rotation: 0,
  flipH: false,
  scale: 1,
  panX: 0,
  panY: 0,
  fit: 'fit',
};

const ALL_BACKGROUNDS: Background[] = [
  { kind: 'none' },
  { kind: 'color', color: '#102030' },
  { kind: 'image', source: 'C:/media/bg.png', ...MEDIA_TRANSFORM },
  { kind: 'gif', source: 'data:image/gif;base64,R0lGODlhAQABA', ...MEDIA_TRANSFORM },
  { kind: 'video', source: 'C:/media/clip.mp4', ...MEDIA_TRANSFORM },
];

const TEXT_OVERLAY: Overlay = {
  kind: 'text',
  text: 'Hello',
  x: 0.5,
  y: 0.5,
  size: 0.1,
  rotation: 0,
  color: '#ffffff',
};

const GPU_OVERLAY: Overlay = {
  kind: 'gpu-temp',
  x: 0.2,
  y: 0.1,
  size: 0.08,
  rotation: 0,
  color: '#00ff00',
};

function sceneWith(background: Background, overlays: Overlay[] = []): Scene {
  return { version: 1, background, overlays };
}

function manyGpuTemp(count: number): Overlay[] {
  const out: Overlay[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ kind: 'gpu-temp', x: 0.5, y: 0.5, size: 0.1, rotation: 0, color: '#ffffff' });
  }
  return out;
}

describe('Scene model (S0-T1)', () => {
  it('DEFAULT_SCENE validates as a plain blank scene', () => {
    expect(isScene(DEFAULT_SCENE)).toBe(true);
    expect(DEFAULT_SCENE.version).toBe(1);
    expect(DEFAULT_SCENE.background).toEqual({ kind: 'none' });
    expect(DEFAULT_SCENE.overlays).toEqual([]);
  });

  it('validates a full scene for each of the five background kinds', () => {
    for (const background of ALL_BACKGROUNDS) {
      const scene = sceneWith(background, [TEXT_OVERLAY, GPU_OVERLAY]);
      expect(isBackground(background)).toBe(true);
      expect(isScene(scene)).toBe(true);
    }
  });

  it('rejects an out-of-range x (1.5) instead of clamping it', () => {
    expect(
      isOverlay({ kind: 'gpu-temp', x: 1.5, y: 0.5, size: 0.1, rotation: 0, color: '#ffffff' })
    ).toBe(false);
    expect(
      isScene({
        version: 1,
        background: { kind: 'none' },
        overlays: [{ kind: 'gpu-temp', x: 1.5, y: 0.5, size: 0.1, rotation: 0, color: '#ffffff' }],
      })
    ).toBe(false);
  });

  it('rejects an out-of-range y (-0.1) instead of clamping it', () => {
    expect(
      isOverlay({ kind: 'gpu-temp', x: 0.5, y: -0.1, size: 0.1, rotation: 0, color: '#ffffff' })
    ).toBe(false);
  });

  it('rejects a NaN size', () => {
    expect(
      isOverlay({
        kind: 'text',
        text: 'hi',
        x: 0.5,
        y: 0.5,
        size: Number.NaN,
        rotation: 0,
        color: '#ffffff',
      })
    ).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(
      isScene({ version: 1, background: { kind: 'none' }, overlays: [], evil: true })
    ).toBe(false);
  });

  it('rejects an unknown nested key', () => {
    expect(
      isOverlay({
        kind: 'gpu-temp',
        x: 0.5,
        y: 0.5,
        size: 0.1,
        rotation: 0,
        color: '#ffffff',
        extra: 1,
      })
    ).toBe(false);
    expect(
      isScene({
        version: 1,
        background: { kind: 'none' },
        overlays: [
          { kind: 'gpu-temp', x: 0.5, y: 0.5, size: 0.1, rotation: 0, color: '#ffffff', extra: 1 },
        ],
      })
    ).toBe(false);
  });

  it('rejects a source containing a path-traversal segment', () => {
    expect(isBackground({ kind: 'image', source: 'a/../b.png', ...MEDIA_TRANSFORM })).toBe(false);
    expect(isBackground({ kind: 'video', source: '..\\..\\clip.mp4', ...MEDIA_TRANSFORM })).toBe(false);
    expect(isBackground({ kind: 'image', source: '..', ...MEDIA_TRANSFORM })).toBe(false);
    // A double dot inside a single segment is a legal filename, not traversal.
    expect(isBackground({ kind: 'image', source: 'smile..png', ...MEDIA_TRANSFORM })).toBe(true);
  });

  it('rejects a source containing a NUL byte or an empty string', () => {
    const nulSource = 'a' + String.fromCharCode(0) + 'b';
    expect(isBackground({ kind: 'gif', source: nulSource, ...MEDIA_TRANSFORM })).toBe(false);
    expect(isBackground({ kind: 'gif', source: '', ...MEDIA_TRANSFORM })).toBe(false);
  });

  it('enforces the overlays cap', () => {
    expect(isScene(sceneWith({ kind: 'none' }, manyGpuTemp(SCENE_OVERLAYS_CAP)))).toBe(true);
    expect(isScene(sceneWith({ kind: 'none' }, manyGpuTemp(SCENE_OVERLAYS_CAP + 1)))).toBe(false);
  });

  it('rejects invalid discriminants, versions and field values', () => {
    expect(isScene({ version: 2, background: { kind: 'none' }, overlays: [] })).toBe(false);
    expect(isScene(null)).toBe(false);
    expect(isScene('scene')).toBe(false);
    expect(
      isOverlay({ kind: 'needle', x: 0.5, y: 0.5, size: 0.1, rotation: 0, color: '#ffffff' })
    ).toBe(false);
    expect(
      isOverlay({ kind: 'gpu-temp', x: 0.5, y: 0.5, size: 0.1, rotation: 0, color: 'blue' })
    ).toBe(false);
    expect(isBackground({ kind: 'color', color: 'red' })).toBe(false);
    expect(isBackground({ kind: 'image', source: 'bg.png', ...MEDIA_TRANSFORM, fit: 'stretch' })).toBe(false);
    expect(isBackground({ kind: 'image', source: 'bg.png', ...MEDIA_TRANSFORM, scale: 0 })).toBe(false);
    expect(
      isBackground({ kind: 'image', source: 'bg.png', ...MEDIA_TRANSFORM, rotation: Number.NaN })
    ).toBe(false);
    expect(isBackground({ kind: 'unknown' })).toBe(false);
  });

  it('keeps the TS and main-process defaults in lockstep', () => {
    expect(hardening.DEFAULT_SCENE).toEqual(DEFAULT_SCENE);
    expect(hardening.SCENE_OVERLAYS_CAP).toBe(SCENE_OVERLAYS_CAP);
  });
});

describe('shared shape corpus (pins both copies to one verdict)', () => {
  for (const entry of SCENE_SHAPES) {
    it(`${entry.name} -> ${entry.expect}`, () => {
      expect(isScene(materialize(entry))).toBe(entry.expect === 'valid');
    });
  }
});

describe('regressions: guard/gate agreement (S0-T1 verification)', () => {
  it('rejects a sparse overlays array (hole at index 1)', () => {
    // Array.prototype.every SKIPS holes, which once let a sparse array pass
    // isScene while hardening.validateScene (index loop) rejected it.
    const overlays: Overlay[] = [GPU_OVERLAY];
    overlays[2] = GPU_OVERLAY;
    expect(isScene({ version: 1, background: { kind: 'none' }, overlays })).toBe(false);
  });

  it('rejects own non-index properties on the overlays array', () => {
    const overlays: Overlay[] = [GPU_OVERLAY, TEXT_OVERLAY];
    Object.assign(overlays, { evil: 1 });
    expect(isScene({ version: 1, background: { kind: 'none' }, overlays })).toBe(false);
  });

  it('returns false instead of throwing when a field getter throws', () => {
    const overlay: Overlay = { ...GPU_OVERLAY };
    Object.defineProperty(overlay, 'x', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    expect(isScene({ version: 1, background: { kind: 'none' }, overlays: [overlay] })).toBe(false);
  });
});
