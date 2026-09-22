/**
 * Scene model (S0-T1) — the typed contract for what the LCD paints.
 *
 * COORDINATE CONTRACT (invariant): every position/size value in this model
 * (x, y, size, panX, panY) is a UNIT FRACTION of the 480×854 portrait glass
 * canvas, never of the physical panel. The panel registry rotates the
 * finished frame 90° CW (854×480) AFTER rendering, inside the Python sidecar
 * — that rotation must never be baked into this model, or every layout would
 * need a second, panel-specific variant.
 *
 * VALIDATION POLICY: reject, never clamp or coerce. An out-of-range value is
 * a bug in whatever produced it; silently fixing it would hide the bug and
 * render a layout nobody approved.
 *
 * These guards give the editor instant feedback. The authoritative gate on
 * untrusted input is hardening.validateScene (src/hardening.js): the same
 * rules in pure CommonJS, run by settings:save on data that never passed
 * TypeScript. tests/renderer/scene.test.ts and tests/unit/scene-validation.test.js
 * exercise both copies with the same fixtures.
 *
 * Pure data + predicates: no network, no USB, no shell access.
 */

/** Scene schema version. Reject anything else — no in-place migrations. */
export const SCENE_VERSION = 1;

/**
 * Max overlays per scene. Every overlay is a live render node composited at
 * LCD fps, so the cap bounds per-frame cost coming from untrusted settings JSON.
 */
export const SCENE_OVERLAYS_CAP = 32;

/**
 * Cap on one text overlay's `text`, in characters. Mirrors
 * SCENE_MAX_TEXT_CHARS in bridge/lcd_bridge.py and bridge/protocol.py; the
 * cross-language pin in tests/renderer/text-length-gate.test.ts fails if any
 * of the copies drifts apart.
 */
export const SCENE_MAX_TEXT_CHARS = 4096;

export type BackgroundFit = 'fit' | 'fill';

/** Render transform for media backgrounds, applied in glass space. */
export interface Transform {
  rotation: number; // degrees, finite
  flipH: boolean;
  scale: number; // finite, > 0
  panX: number; // unit-fraction offsets (see coordinate contract)
  panY: number;
  fit: BackgroundFit;
}

export interface NoneBackground {
  kind: 'none';
}

export interface ColorBackground {
  kind: 'color';
  color: string; // #rrggbb
}

export interface ImageBackground extends Transform {
  kind: 'image';
  source: string; // path / data URI, gated by isSource()
}

export interface GifBackground extends Transform {
  kind: 'gif';
  source: string;
}

export interface VideoBackground extends Transform {
  kind: 'video';
  source: string;
}

export type Background =
  | NoneBackground
  | ColorBackground
  | ImageBackground
  | GifBackground
  | VideoBackground;

/** Shared placement fields for every overlay — unit fractions (see contract). */
export interface OverlayPlacement {
  x: number;
  y: number;
  size: number;
  rotation: number; // degrees, finite
  color: string; // #rrggbb
}

export interface TextOverlay extends OverlayPlacement {
  kind: 'text';
  text: string;
}

export interface GpuTempOverlay extends OverlayPlacement {
  kind: 'gpu-temp';
}

export type Overlay = TextOverlay | GpuTempOverlay;

export interface Scene {
  version: typeof SCENE_VERSION;
  background: Background;
  overlays: Overlay[];
}

/** Blank portrait scene. Treat as immutable — build new objects to edit. */
export const DEFAULT_SCENE: Scene = {
  version: SCENE_VERSION,
  background: { kind: 'none' },
  overlays: [],
};

type BackgroundKind = Background['kind'];
type OverlayKind = Overlay['kind'];

const SCENE_KEYS: readonly string[] = ['version', 'background', 'overlays'];
const NONE_BACKGROUND_KEYS: readonly string[] = ['kind'];
const COLOR_BACKGROUND_KEYS: readonly string[] = ['kind', 'color'];
const MEDIA_BACKGROUND_KEYS: readonly string[] = [
  'kind',
  'source',
  'rotation',
  'flipH',
  'scale',
  'panX',
  'panY',
  'fit',
];
const TEXT_OVERLAY_KEYS: readonly string[] = [
  'kind',
  'text',
  'x',
  'y',
  'size',
  'rotation',
  'color',
];
const GPU_TEMP_OVERLAY_KEYS: readonly string[] = [
  'kind',
  'x',
  'y',
  'size',
  'rotation',
  'color',
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function assertNever(value: never): never {
  // Exhaustiveness: adding a union member without handling it must not compile.
  throw new Error(`Unhandled scene variant: ${JSON.stringify(value)}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * First own enumerable key of an ARRAY that is not one of its canonical
 * index keys ("evil", "1.5", "007" all qualify). Object.keys skips holes, so
 * a hole is reported by the index loop in isScene instead.
 */
function firstNonIndexKey(value: unknown[]): string | null {
  const length = value.length;
  for (const key of Object.keys(value)) {
    const index = Number(key);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= length ||
      String(index) !== key
    ) {
      return key;
    }
  }
  return null;
}

/** First key of `value` outside `allowed` (null when the shape is clean). */
function firstUnknownKey(
  value: Record<string, unknown>,
  allowed: readonly string[]
): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUnitFraction(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

/**
 * Source gate: non-empty string, no NUL (C-level path APIs truncate there),
 * and no ".." SEGMENT across either separator — "smile..png" stays legal.
 */
function isSource(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\u0000')) return false;
  return !value.split(/[/\\]/).includes('..');
}

function isBackgroundKind(value: unknown): value is BackgroundKind {
  return (
    value === 'none' ||
    value === 'color' ||
    value === 'image' ||
    value === 'gif' ||
    value === 'video'
  );
}

function isOverlayKind(value: unknown): value is OverlayKind {
  return value === 'text' || value === 'gpu-temp';
}

/** Allowed keys per background kind — exhaustive over Background['kind']. */
function backgroundKeys(kind: BackgroundKind): readonly string[] {
  switch (kind) {
    case 'none':
      return NONE_BACKGROUND_KEYS;
    case 'color':
      return COLOR_BACKGROUND_KEYS;
    case 'image':
    case 'gif':
    case 'video':
      return MEDIA_BACKGROUND_KEYS;
    default:
      return assertNever(kind);
  }
}

/** Allowed keys per overlay kind — exhaustive over Overlay['kind']. */
function overlayKeys(kind: OverlayKind): readonly string[] {
  switch (kind) {
    case 'text':
      return TEXT_OVERLAY_KEYS;
    case 'gpu-temp':
      return GPU_TEMP_OVERLAY_KEYS;
    default:
      return assertNever(kind);
  }
}

/** Full transform field set for image/gif/video backgrounds. */
function isMediaFields(value: Record<string, unknown>): boolean {
  const scale = value['scale'];
  return (
    isSource(value['source']) &&
    isFiniteNumber(value['rotation']) &&
    typeof value['flipH'] === 'boolean' &&
    isFiniteNumber(scale) &&
    scale > 0 &&
    isFiniteNumber(value['panX']) &&
    isFiniteNumber(value['panY']) &&
    (value['fit'] === 'fit' || value['fit'] === 'fill')
  );
}

/** Placement field set shared by all overlays. */
function isPlacementFields(value: Record<string, unknown>): boolean {
  return (
    isUnitFraction(value['x']) &&
    isUnitFraction(value['y']) &&
    isUnitFraction(value['size']) &&
    isFiniteNumber(value['rotation']) &&
    isHexColor(value['color'])
  );
}

export function isBackground(value: unknown): value is Background {
  if (!isPlainObject(value)) return false;
  const kind = value['kind'];
  if (!isBackgroundKind(kind)) return false;
  if (firstUnknownKey(value, backgroundKeys(kind)) !== null) return false;
  switch (kind) {
    case 'none':
      return true;
    case 'color':
      return isHexColor(value['color']);
    case 'image':
    case 'gif':
    case 'video':
      return isMediaFields(value);
    default:
      return assertNever(kind);
  }
}

export function isOverlay(value: unknown): value is Overlay {
  if (!isPlainObject(value)) return false;
  const kind = value['kind'];
  if (!isOverlayKind(kind)) return false;
  if (firstUnknownKey(value, overlayKeys(kind)) !== null) return false;
  switch (kind) {
    case 'text': {
      const text = value['text'];
      return (
        typeof text === 'string' &&
        text.length <= SCENE_MAX_TEXT_CHARS &&
        isPlacementFields(value)
      );
    }
    case 'gpu-temp':
      return isPlacementFields(value);
    default:
      return assertNever(kind);
  }
}

export function isScene(value: unknown): value is Scene {
  // Total predicate: a guard feeding live editor feedback must return a
  // verdict, never throw. Exotic hosts (throwing getters, proxies) become
  // `false` — the same verdict hardening.validateScene reaches by wrapping
  // its whole body — so the two copies agree for every shape.
  try {
    return isSceneShape(value);
  } catch {
    return false;
  }
}

function isSceneShape(value: unknown): value is Scene {
  if (!isPlainObject(value)) return false;
  if (firstUnknownKey(value, SCENE_KEYS) !== null) return false;
  if (value['version'] !== SCENE_VERSION) return false;
  if (!isBackground(value['background'])) return false;
  const overlays = value['overlays'];
  if (!isUnknownArray(overlays)) return false;
  if (firstNonIndexKey(overlays) !== null) return false;
  if (overlays.length > SCENE_OVERLAYS_CAP) return false;
  // Index loop, NOT .every(): every() SKIPS HOLES, so a sparse array would
  // pass here while the CommonJS gate (which indexes) rejects it with
  // overlays[i]. Reading a hole yields undefined, which isOverlay rejects —
  // same verdict as the gate, for every shape.
  for (let i = 0; i < overlays.length; i += 1) {
    if (!isOverlay(overlays[i])) return false;
  }
  return true;
}
