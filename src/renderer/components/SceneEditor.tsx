import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errMessage, type LyricvisionBridge } from "@/lib/bridge";
import {
  SCENE_MAX_TEXT_CHARS,
  SCENE_OVERLAYS_CAP,
  type Background,
  type MediaBackgroundKind,
  type Scene,
} from "@/lib/scene";

/**
 * Scene editor (S2-T8): WYSIWYG surface whose every committed value is
 * previewed live on the connected panel (scene:preview IPC over the live
 * sidecar pipe) and persisted through saveSettings({scene}).
 *
 * STATE SPLIT (why): the scene lives in App state — it must survive this
 * component unmounting and feeds Save/Reset. Everything else is ephemeral
 * editor UI state kept local on purpose: numeric drafts (typing must not be
 * interrupted by round-trips), overlay selection, preview bytes, and status
 * messages never leak into settings.
 *
 * MEDIA IMPORT (S2-T8b): Image/GIF buttons ask MAIN to open the file dialog
 * and embed the picked file as a data: URL — the renderer never sees a file
 * path, and main's rejection tokens are mapped to actionable copy here.
 *
 * TRANSFORM COMMIT RULE: the schema binds rotation/scale/pan/flip/fit to
 * media backgrounds, so they commit into the scene ONLY while an image/gif
 * background is active; on none/color they stay staged local drafts with an
 * explicit hint (committing them there would fail hardening.validateScene).
 * Staged drafts are carried into the first imported media background.
 *
 * DIRECT MANIPULATION (S2-T9): overlays are selected by click (preview or
 * list) and moved/rotated/resized with pointer events. During a gesture only
 * a local ghost — a CSS transform on the widget wrapper — updates; scene
 * state (and therefore the debounced scene:preview IPC) does not move until
 * pointerup, when the gesture-clamped values commit exactly once and the
 * engine PNG follows. The renderer composes no pixels: the ghost is
 * positioning guidance, the preview <img> stays the sidecar's output.
 */

const PREVIEW_DEBOUNCE_MS = 250;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const COLOR_FALLBACK = "#000000";

type UnitField = "x" | "y" | "size" | "rotation";
type TransformField = "rotation" | "scale" | "panX" | "panY";

const EMPTY_UNIT_DRAFTS: Record<UnitField, string> = {
  x: "0.5",
  y: "0.5",
  size: "0.1",
  rotation: "0",
};

const INITIAL_TRANSFORM: Record<TransformField, string> = {
  rotation: "0",
  scale: "1",
  panX: "0",
  panY: "0",
};

const TRANSFORM_RANGES: Record<TransformField, readonly [number, number]> = {
  rotation: [-360, 360],
  scale: [0.1, 10],
  panX: [-1, 1],
  panY: [-1, 1],
};

/**
 * Per-field clamp ranges for the overlay inspector. x/y/size mirror the
 * validator's [0,1] unit-fraction rule; rotation uses the same declared
 * [-360,360] range as the background transform so the drag path and the
 * numeric path commit through ONE gate.
 */
const UNIT_RANGES: Record<UnitField, readonly [number, number]> = {
  x: [0, 1],
  y: [0, 1],
  size: [0, 1],
  rotation: [-360, 360],
};

/** Declared overlay rotation range — inspector and rotation handle share it. */
const OVERLAY_ROTATION_RANGE: readonly [number, number] = [-360, 360];

/**
 * Gesture-time floor for resize. The validator accepts size in [0,1], but a
 * 0-size widget is invisible and ungrabbable, so the drag clamps at 0.01 —
 * still inside the validator's range.
 */
const MIN_OVERLAY_SIZE = 0.01;

/**
 * Draft-record pattern: unparseable input ("" or a trailing ".") stays a
 * draft so typing is not interrupted; a parsed number is clamped into range
 * and only rewritten into the input when the clamp actually changed it.
 * Returns null when nothing should be committed.
 */
function stagedNumber(
  raw: string,
  min: number,
  max: number
): { draft: string; commit: number } | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.endsWith(".")) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const clamped = Math.min(max, Math.max(min, parsed));
  return { draft: clamped === parsed ? raw : String(clamped), commit: clamped };
}

/** Parsed draft value, or the schema's default when the draft is incomplete. */
function stagedValue(
  raw: string,
  range: readonly [number, number],
  fallback: number
): number {
  const result = stagedNumber(raw, range[0], range[1]);
  return result ? result.commit : fallback;
}

/** Transform fields are schema-bound to these kinds (video stays out of S2-T8b). */
function isMediaKind(background: Background): background is Extract<Background, { kind: "image" | "gif" }> {
  return background.kind === "image" || background.kind === "gif";
}

// ---------------------------------------------------------------- gestures

// S2-T9 direct manipulation. The ghost is a CSS transform evaluated on every
// pointermove (0 ms, zero IPC); the engine PNG is requested only when scene
// state changes — i.e. on release. Coordinates stay 0-1 normalized in
// glass/portrait space; every px delta converts through the stage's MEASURED
// rect, so a differently-sized preview (or DPR) maps correctly.

type GestureMode = "move" | "resize" | "rotate";

interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface GestureState {
  index: number;
  mode: GestureMode;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  /** Stage rect measured once at pointerdown; deltas never re-measure. */
  rect: StageRect;
  originX: number;
  originY: number;
  originSize: number;
  originRotation: number;
}

interface OverlayPlacement {
  x: number;
  y: number;
  size: number;
  rotation: number;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Ghost math: current pointer -> placement, clamped DURING the gesture so
 * neither the ghost nor the released scene can leave the ranges
 * hardening.validateScene enforces (x/y/size in [0,1], rotation finite and
 * inside the declared [-360,360]). Pure: called on every render while a
 * gesture is live.
 */
function gesturePlacement(g: GestureState): OverlayPlacement {
  const { rect, originX, originY, originSize, originRotation } = g;
  const dx = g.clientX - g.startClientX;
  const dy = g.clientY - g.startClientY;
  if (g.mode === "move") {
    // Clamp the PIXEL delta against the origin first so the ghost transform
    // stays pixel-exact against the measured rect, then clamp the unit value
    // again: float rounding at the edge could otherwise emit
    // 1.0000000000000002 and fail the gate on release.
    const dxPx = clampNumber(dx, -originX * rect.width, (1 - originX) * rect.width);
    const dyPx = clampNumber(dy, -originY * rect.height, (1 - originY) * rect.height);
    return {
      x: clampNumber(originX + dxPx / rect.width, 0, 1),
      y: clampNumber(originY + dyPx / rect.height, 0, 1),
      size: originSize,
      rotation: originRotation,
    };
  }
  if (g.mode === "resize") {
    // `size` is a fraction of CANVAS HEIGHT (the engine renders
    // font_px = size * h), so normalize both axes in stage units and average
    // them: the corner handle tracks the pointer on either axis.
    const delta = (dx / rect.width + dy / rect.height) / 2;
    return {
      x: originX,
      y: originY,
      size: clampNumber(originSize + delta, MIN_OVERLAY_SIZE, 1),
      rotation: originRotation,
    };
  }
  // rotate: angle of the pointer around the widget anchor (the engine centers
  // every overlay at (x, y)); +90 converts atan2's 0=right into 0=up, giving
  // degrees that are clockwise-positive like the engine's Pillow
  // rotate(-rotation). Delta is unwrapped past ±180 so crossing the top
  // never snaps the ghost the long way around.
  const cx = rect.left + originX * rect.width;
  const cy = rect.top + originY * rect.height;
  const angleAt = (px: number, py: number): number =>
    Math.atan2(py - cy, px - cx) * (180 / Math.PI) + 90;
  let delta = angleAt(g.clientX, g.clientY) - angleAt(g.startClientX, g.startClientY);
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return {
    x: originX,
    y: originY,
    size: originSize,
    rotation: clampNumber(
      originRotation + delta,
      OVERLAY_ROTATION_RANGE[0],
      OVERLAY_ROTATION_RANGE[1]
    ),
  };
}

/**
 * The ghost IS this string: the wrapper's static placement (left/top/height,
 * from committed scene state) never moves mid-gesture — only the transform
 * does. Zero deltas render the plain centering transform, so a released
 * gesture leaves no residue behind.
 */
function overlayBoxTransform(
  dxPx: number,
  dyPx: number,
  rotation: number,
  scale: number
): string {
  const parts = ["translate(-50%, -50%)"];
  if (dxPx !== 0 || dyPx !== 0) parts.push(`translate(${dxPx}px, ${dyPx}px)`);
  if (rotation !== 0) parts.push(`rotate(${rotation}deg)`);
  if (scale !== 1) parts.push(`scale(${scale})`);
  return parts.join(" ");
}

// Keep in sync with the mediaImportError tokens in src/main.js (main process).
const MEDIA_IMPORT_REASONS = [
  "media_kind_unsupported",
  "media_type_unsupported",
  "media_file_too_large",
  "media_gif_dimensions_exceeded",
  "media_gif_frames_exceeded",
  "media_unreadable",
] as const;
type MediaImportReason = (typeof MEDIA_IMPORT_REASONS)[number];

/**
 * Electron wraps main-process rejections
 * ("Error invoking remote method 'media:import': Error: media_file_too_large: …"),
 * so the token is SEARCHED anywhere in the message (same technique as
 * splitPreviewError). Details from main contain sizes/limits only — main
 * guarantees no file path ever rides along.
 */
function splitMediaImportError(error: unknown): {
  reason: MediaImportReason | null;
  detail: string;
} {
  const raw = error instanceof Error ? error.message : String(error);
  for (const candidate of MEDIA_IMPORT_REASONS) {
    const index = raw.indexOf(candidate);
    if (index !== -1) {
      return {
        reason: candidate,
        detail: raw.slice(index + candidate.length).replace(/^:\s*/, ""),
      };
    }
  }
  return { reason: null, detail: "" };
}

/** Reason token -> copy that always states the next step. */
function mapMediaImportError(error: unknown, kind: MediaBackgroundKind): string {
  const { reason, detail } = splitMediaImportError(error);
  switch (reason) {
    case "media_kind_unsupported":
      return "This background type cannot be imported. Pick an image or GIF file.";
    case "media_type_unsupported":
      return kind === "gif"
        ? "This file is not a GIF. Pick a GIF file and try again."
        : "This file is not a PNG, JPEG, or GIF. Pick a supported file and try again.";
    case "media_file_too_large":
      return `This file is too large to embed (${detail}). Pick a smaller file.`;
    case "media_gif_dimensions_exceeded":
      return `This GIF exceeds the panel size limit (${detail}). Pick a smaller GIF.`;
    case "media_gif_frames_exceeded":
      return `This GIF has too many frames (${detail}). Pick a shorter animation.`;
    case "media_unreadable":
      return `This file could not be imported (${detail}). Pick another file and try again.`;
    default:
      return "The import could not finish. Close other dialogs and try again.";
  }
}

/**
 * In-use summary derived ONLY from the data: URL (the renderer never sees
 * a picked filename/path — a non-embedded legacy source must not leak one).
 * Size is base64-derived and rounded, hence "about N KB".
 */
function describeMediaSource(source: string): string {
  const match = /^data:image\/(png|jpeg|gif);base64,(.*)$/.exec(source);
  if (!match) return "media file"; // path-style source: label only, never echo it
  const label = match[1] === "jpeg" ? "JPEG" : match[1].toUpperCase();
  const bytes = Math.ceil((match[2].length * 3) / 4);
  return `${label}, about ${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Keep in sync with PREVIEW_REASON in src/preview-correlator.js (main process).
const PREVIEW_REASONS = [
  "preview_invalid_scene",
  "preview_sidecar_absent",
  "preview_sidecar_exited",
  "preview_timeout",
  "preview_write_failed",
  "preview_malformed_response",
  "preview_engine_error",
] as const;
type PreviewReason = (typeof PREVIEW_REASONS)[number];

/**
 * Main-process rejections arrive wrapped by Electron
 * ("Error invoking remote method 'scene:preview': Error: preview_timeout: …"),
 * so the reason token is SEARCHED anywhere in the message, never assumed to
 * be the first segment. Every branch tells the user the next step, and an
 * unknown shape still renders actionable copy instead of crashing.
 */
function splitPreviewError(error: unknown): {
  reason: PreviewReason | null;
  detail: string;
} {
  const raw = error instanceof Error ? error.message : String(error);
  for (const candidate of PREVIEW_REASONS) {
    const index = raw.indexOf(candidate);
    if (index !== -1) {
      return {
        reason: candidate,
        detail: raw.slice(index + candidate.length).replace(/^:\s*/, ""),
      };
    }
  }
  return { reason: null, detail: "" };
}

function mapPreviewError(error: unknown): string {
  const { reason, detail } = splitPreviewError(error);
  switch (reason) {
    case "preview_sidecar_absent":
      return "No live panel connection. Connect the LCD and keep LyricVision open — the preview resumes on your next change.";
    case "preview_sidecar_exited":
      return "The panel connection dropped. Reconnect the LCD to resume the preview.";
    case "preview_timeout":
      return "Preview timed out. The panel may be busy — change a value to retry.";
    case "preview_write_failed":
      return "Could not reach the panel process. Retry, or restart LyricVision if it keeps failing.";
    case "preview_malformed_response":
      return "The panel sent an unreadable preview reply. Retry, or restart LyricVision if it keeps failing.";
    case "preview_invalid_scene":
      return detail
        ? `Scene value not allowed (${detail}). Fix it and try again.`
        : "Scene value not allowed. Fix it and try again.";
    case "preview_engine_error":
      return detail
        ? `Engine rejected the scene (${detail}). Fix the value and try again.`
        : "Engine rejected the scene. Fix the value and try again.";
    default:
      return detail
        ? `Preview failed: ${detail}. Fix the value and try again.`
        : "Preview failed. Check the scene values and try again.";
  }
}

/**
 * settings:save reports only the KEY it refused, but the field path lives in
 * the same hardening.validateScene verdict the preview gate produces - so ask
 * that gate (scene:preview re-validates BEFORE a byte reaches the pipe) and
 * read the detail through splitPreviewError: one extraction path, never a
 * second copy that could drift from the preview banner.
 */
async function sceneRejectionDetail(
  bridge: LyricvisionBridge,
  scene: Scene
): Promise<string> {
  try {
    await bridge.previewScene(scene);
  } catch (err) {
    const { detail } = splitPreviewError(err);
    if (detail) {
      return `Could not save the scene: ${detail}. Fix the value and try again.`;
    }
  }
  return "Scene value not allowed. Fix it and try again.";
}

interface SceneEditorProps {
  scene: Scene;
  onSceneChange: (scene: Scene) => void;
  onReset: () => void;
  /** Called after a successful save so App can refresh its reset baseline. */
  onSaved?: (scene: Scene) => void;
}

export default function SceneEditor({
  scene,
  onSceneChange,
  onReset,
  onSaved,
}: SceneEditorProps) {
  // Ephemeral editor-local state (see file header).
  const [selected, setSelected] = useState<number | null>(0);
  // Gesture bookkeeping: the ref is the source of truth for the window
  // listeners (no stale closures); state only drives the ghost re-render.
  const [gesture, setGestureState] = useState<GestureState | null>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Teardown for the in-flight gesture's window listeners (unmount-safe).
  const endGestureTracking = useRef<(() => void) | null>(null);
  const setGesture = (next: GestureState | null) => {
    gestureRef.current = next;
    setGestureState(next);
  };
  useEffect(
    () => () => {
      endGestureTracking.current?.();
    },
    []
  );
  const [unitDrafts, setUnitDrafts] = useState<Record<UnitField, string>>(
    EMPTY_UNIT_DRAFTS
  );
  const [transform, setTransform] =
    useState<Record<TransformField, string>>(INITIAL_TRANSFORM);
  const [flipH, setFlipH] = useState(false);
  const [fit, setFit] = useState<"fit" | "fill">("fit");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Refs, not state: debounce timers and stale-reply guards must not trigger
  // re-renders or capture stale closures.
  const seqRef = useRef(0);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const overlays = scene.overlays;
  const safeIndex =
    selected === null ? -1 : Math.min(selected, Math.max(0, overlays.length - 1));
  const selectedOverlay = safeIndex >= 0 ? (overlays[safeIndex] ?? null) : null;
  // Recomputed per render while a gesture is live; pure (see gesturePlacement).
  const ghost = gesture !== null ? gesturePlacement(gesture) : null;
  const backgroundKind = scene.background.kind;
  const backgroundColor =
    scene.background.kind === "color" ? scene.background.color : COLOR_FALLBACK;
  const mediaBackground = isMediaKind(scene.background) ? scene.background : null;
  const atCap = overlays.length >= SCENE_OVERLAYS_CAP;

  // Keep drafts aligned with the selected overlay whenever the scene or the
  // selection changes (add/remove/switch/Reset all flow through here).
  useEffect(() => {
    const overlay =
      safeIndex >= 0 ? scene.overlays[safeIndex] ?? null : null;
    setUnitDrafts(
      overlay
        ? {
            x: String(overlay.x),
            y: String(overlay.y),
            size: String(overlay.size),
            rotation: String(overlay.rotation),
          }
        : EMPTY_UNIT_DRAFTS
    );
  }, [scene, safeIndex]);

  // Media backgrounds own the transform values: mirror them back into the
  // drafts whenever scene state changes (Reset, external load, own commits),
  // so the inputs never drift from what the panel renders. On none/color the
  // drafts are intentionally NOT touched — they stay staged for the next
  // imported media background (import carries them forward).
  useEffect(() => {
    const bg = scene.background;
    if (!isMediaKind(bg)) return;
    setTransform({
      rotation: String(bg.rotation),
      scale: String(bg.scale),
      panX: String(bg.panX),
      panY: String(bg.panY),
    });
    setFlipH(bg.flipH);
    setFit(bg.fit);
  }, [scene]);

  const schedulePreview = useCallback((next: Scene) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      const bridge = window.lyricvision;
      if (!bridge) {
        setPreviewError(
          mapPreviewError("preview_sidecar_absent: preload bridge unavailable")
        );
        return;
      }
      bridge
        .previewScene(next)
        .then((url) => {
          if (seqRef.current !== seq) return; // stale reply from a previous scene
          setPreviewUrl(url);
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          setPreviewError(mapPreviewError(err));
        });
    }, PREVIEW_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    schedulePreview(scene);
    return () => {
      seqRef.current += 1; // invalidate in-flight replies from the previous scene
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [scene, schedulePreview]);

  const setUnitDraft = (field: UnitField, value: string) =>
    setUnitDrafts((prev) => {
      const next: Record<UnitField, string> = {
        x: prev.x,
        y: prev.y,
        size: prev.size,
        rotation: prev.rotation,
      };
      next[field] = value;
      return next;
    });

  const setTransformDraft = (field: TransformField, value: string) =>
    setTransform((prev) => {
      const next: Record<TransformField, string> = {
        rotation: prev.rotation,
        scale: prev.scale,
        panX: prev.panX,
        panY: prev.panY,
      };
      next[field] = value;
      return next;
    });

  const commitOverlays = (next: Scene["overlays"]) =>
    onSceneChange({ ...scene, overlays: next });

  /**
   * pointerdown -> capture -> window pointermove/pointerup. Selection
   * happens here (a tap IS a selection); scene state changes only in
   * finish(true), so every move costs zero scene:preview requests and the
   * release commits exactly once (one debounced preview follows). The
   * `scene` closure is the snapshot from the render that saw pointerdown —
   * safe because no other commit can run while a gesture holds the pointer.
   */
  const beginGesture = (
    index: number,
    mode: GestureMode,
    e: ReactPointerEvent<HTMLElement>
  ) => {
    if (gestureRef.current) return; // one gesture at a time
    if (e.button !== 0) return; // primary button / touch only
    const overlay = scene.overlays[index];
    const stage = stageRef.current;
    if (!overlay) return;
    setSelected(index);
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    // No measurable stage (no layout yet): px->unit is undefined, so fall
    // back to selection-only instead of committing NaN.
    if (!(rect.width > 0) || !(rect.height > 0)) return;

    setGesture({
      index,
      mode,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      clientX: e.clientX,
      clientY: e.clientY,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      originX: overlay.x,
      originY: overlay.y,
      originSize: overlay.size,
      originRotation: overlay.rotation,
    });

    // Capture keeps retargeting to the pressed element; the window listeners
    // below are the delivery path (and the only one jsdom implements).
    const captureTarget = e.currentTarget;
    try {
      captureTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // capture is a progressive enhancement; listeners still receive moves
    }
    const releaseCapture = () => {
      try {
        if (captureTarget.hasPointerCapture?.(e.pointerId)) {
          captureTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // pointercancel may have released the capture before this ran
      }
    };

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      endGestureTracking.current = null;
    };
    const finish = (commit: boolean) => {
      const g = gestureRef.current;
      releaseCapture();
      detach();
      setGesture(null);
      if (!commit || !g) return;
      const placement = gesturePlacement(g);
      if (
        placement.x === g.originX &&
        placement.y === g.originY &&
        placement.size === g.originSize &&
        placement.rotation === g.originRotation
      ) {
        return; // a plain tap selects but must not dirty the scene
      }
      commitOverlays(
        scene.overlays.map((o, i) => (i === g.index ? { ...o, ...placement } : o))
      );
      setSavedNote(null);
    };
    const onMove = (ev: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      if (!Number.isFinite(ev.clientX) || !Number.isFinite(ev.clientY)) return;
      setGesture({ ...g, clientX: ev.clientX, clientY: ev.clientY });
    };
    const onUp = () => finish(true);
    // Cancel reverts: the ghost disappears, nothing commits.
    const onCancel = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    endGestureTracking.current = () => {
      releaseCapture();
      detach();
      setGesture(null);
    };
  };

  const handleUnit = (field: UnitField, raw: string) => {
    const [min, max] = UNIT_RANGES[field];
    const result = stagedNumber(raw, min, max);
    setUnitDraft(field, result ? result.draft : raw);
    if (!result || safeIndex < 0 || safeIndex >= overlays.length) return;
    const overlaysNext = overlays.map((overlay, i) => {
      if (i !== safeIndex) return overlay;
      return {
        ...overlay,
        x: field === "x" ? result.commit : overlay.x,
        y: field === "y" ? result.commit : overlay.y,
        size: field === "size" ? result.commit : overlay.size,
        rotation: field === "rotation" ? result.commit : overlay.rotation,
      };
    });
    commitOverlays(overlaysNext);
    setSavedNote(null);
  };

  const handleTransform = (field: TransformField, raw: string) => {
    const [min, max] = TRANSFORM_RANGES[field];
    const result = stagedNumber(raw, min, max);
    setTransformDraft(field, result ? result.draft : raw);
    // Commit ONLY into an image/gif background: the schema binds transform
    // keys to media kinds, so on none/color the value stays staged (with
    // the hint below the section) instead of failing validateScene.
    const current = scene.background;
    if (!result || !isMediaKind(current)) return;
    onSceneChange({
      ...scene,
      background: { ...current, [field]: result.commit },
    });
    setSavedNote(null);
  };

  const commitFlip = (next: boolean) => {
    setFlipH(next);
    const current = scene.background;
    if (!isMediaKind(current)) return;
    onSceneChange({ ...scene, background: { ...current, flipH: next } });
    setSavedNote(null);
  };

  const commitFit = (next: "fit" | "fill") => {
    setFit(next);
    const current = scene.background;
    if (!isMediaKind(current)) return;
    onSceneChange({ ...scene, background: { ...current, fit: next } });
    setSavedNote(null);
  };

  const handleText = (raw: string) => {
    // Clamp at commit: maxLength blocks typing, but a paste path that slips
    // past the native cap must never land in scene state - all four gates
    // agree at SCENE_MAX_TEXT_CHARS.
    const text =
      raw.length > SCENE_MAX_TEXT_CHARS ? raw.slice(0, SCENE_MAX_TEXT_CHARS) : raw;
    const overlaysNext = overlays.map((overlay, i) =>
      i === safeIndex && overlay.kind === "text" ? { ...overlay, text } : overlay
    );
    commitOverlays(overlaysNext);
    setSavedNote(null);
  };

  const handleOverlayColor = (raw: string) => {
    if (!HEX_COLOR.test(raw)) return;
    const overlaysNext = overlays.map((overlay, i) =>
      i === safeIndex ? { ...overlay, color: raw } : overlay
    );
    commitOverlays(overlaysNext);
    setSavedNote(null);
  };

  const pickBackground = (kind: "none" | "color") => {
    onSceneChange({
      ...scene,
      background:
        kind === "color"
          ? { kind: "color", color: HEX_COLOR.test(backgroundColor) ? backgroundColor : COLOR_FALLBACK }
          : { kind: "none" },
    });
    setSavedNote(null);
    setImportError(null);
  };

  /**
   * Ask MAIN for a picked file (S2-T8b). The dialog, read, magic sniff and
   * caps all run in main; this only receives the embedded data: URL.
   * null = cancelled dialog = deliberate no-op. Failures map to copy that
   * states the next step and NEVER echo a path (main sends none).
   */
  const importBackground = async (kind: MediaBackgroundKind) => {
    const bridge = window.lyricvision;
    if (!bridge) {
      setImportError(
        "Renderer bridge missing (preload failed). Reopen the window to import media."
      );
      return;
    }
    setImportError(null);
    let source: string | null;
    try {
      source = await bridge.importMedia(kind);
    } catch (err) {
      setImportError(mapMediaImportError(err, kind));
      return;
    }
    if (source === null) return; // cancelled: no-op
    // Staged drafts are CARRIED into the first imported media background.
    const next: Background = {
      kind,
      source,
      rotation: stagedValue(transform.rotation, TRANSFORM_RANGES.rotation, 0),
      flipH,
      scale: stagedValue(transform.scale, TRANSFORM_RANGES.scale, 1),
      panX: stagedValue(transform.panX, TRANSFORM_RANGES.panX, 0),
      panY: stagedValue(transform.panY, TRANSFORM_RANGES.panY, 0),
      fit,
    };
    onSceneChange({ ...scene, background: next });
    setSavedNote(null);
  };

  const clearBackground = () => {
    // Dropping media returns to none; the staged drafts stay local so a
    // re-import carries them forward again.
    onSceneChange({ ...scene, background: { kind: "none" } });
    setSavedNote(null);
    setImportError(null);
  };

  const addOverlay = () => {
    if (atCap) return;
    const overlay = {
      kind: "text" as const,
      text: "New overlay",
      x: 0.5,
      y: 0.5,
      size: 0.1,
      rotation: 0,
      color: "#ffffff",
    };
    const next = [...overlays, overlay];
    commitOverlays(next);
    setSelected(next.length - 1); // a new overlay auto-selects
    setSavedNote(null);
  };

  const removeOverlay = () => {
    // safeIndex -1 = nothing selected (empty click deselected): filter(-1)
    // would remove nothing yet still commit a dirty scene, so no-op instead.
    if (safeIndex < 0 || !overlays.length) return;
    const next = overlays.filter((_, i) => i !== safeIndex);
    commitOverlays(next);
    setSelected(Math.max(0, Math.min(safeIndex, next.length - 1)));
    setSavedNote(null);
  };

  const handleSave = async () => {
    const bridge = window.lyricvision;
    if (!bridge) {
      setSaveError("Renderer bridge missing (preload failed). Reopen the window to save.");
      return;
    }
    setSaveError(null);
    setSavedNote(null);
    try {
      const { rejected } = await bridge.saveSettings({ scene });
      if (rejected && rejected.includes("scene")) {
        setSaveError(await sceneRejectionDetail(bridge, scene));
        return;
      }
      setSavedNote("Scene saved.");
      onSaved?.(scene);
    } catch (err) {
      setSaveError(`Could not save the scene: ${errMessage(err)}. Fix the value and try again.`);
    }
  };

  const handleReset = () => {
    onReset();
    setTransform(INITIAL_TRANSFORM);
    setFlipH(false);
    setFit("fit");
    setSaveError(null);
    setSavedNote(null);
    setImportError(null);
  };

  return (
    <div className="space-y-4">
      {/* Background: none/color + media import (S2-T8b). Video (S3) and
          gpu-temp (S4) stay out until their own tasks. */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Background</p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={backgroundKind === "none" ? "default" : "outline"}
            aria-pressed={backgroundKind === "none"}
            onClick={() => pickBackground("none")}
          >
            None
          </Button>
          <Button
            type="button"
            size="sm"
            variant={backgroundKind === "color" ? "default" : "outline"}
            aria-pressed={backgroundKind === "color"}
            onClick={() => pickBackground("color")}
          >
            Color
          </Button>
          <Button
            type="button"
            size="sm"
            variant={backgroundKind === "image" ? "default" : "outline"}
            aria-pressed={backgroundKind === "image"}
            onClick={() => void importBackground("image")}
          >
            Image
          </Button>
          <Button
            type="button"
            size="sm"
            variant={backgroundKind === "gif" ? "default" : "outline"}
            aria-pressed={backgroundKind === "gif"}
            onClick={() => void importBackground("gif")}
          >
            GIF
          </Button>
        </div>
        {scene.background.kind === "color" && (
          <div className="space-y-1">
            <Label htmlFor="scene-background-color">Background color</Label>
            <Input
              id="scene-background-color"
              type="color"
              value={HEX_COLOR.test(backgroundColor) ? backgroundColor : COLOR_FALLBACK}
              onChange={(e) => {
                const value = e.target.value;
                if (!HEX_COLOR.test(value)) return;
                onSceneChange({ ...scene, background: { kind: "color", color: value } });
                setSavedNote(null);
              }}
            />
          </div>
        )}
        {mediaBackground && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Derived from the data: URL only — a picked path never exists here. */}
            <p className="text-xs text-muted-foreground">{`In use: ${describeMediaSource(mediaBackground.source)}`}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void importBackground(mediaBackground.kind)}
            >
              Replace
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={clearBackground}>
              Clear
            </Button>
          </div>
        )}
        {importError && (
          <p role="alert" className="text-sm text-destructive">
            {importError}
          </p>
        )}
      </div>

      {/* Transform: commits into image/gif backgrounds; on none/color the
          values stay staged with an explicit hint (see file header). */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Transform</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="scene-rotation">Rotation (degrees)</Label>
            <Input
              id="scene-rotation"
              inputMode="decimal"
              value={transform.rotation}
              onChange={(e) => handleTransform("rotation", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="scene-scale">Scale</Label>
            <Input
              id="scene-scale"
              inputMode="decimal"
              value={transform.scale}
              onChange={(e) => handleTransform("scale", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="scene-pan-x">Pan X (-1 to 1)</Label>
            <Input
              id="scene-pan-x"
              inputMode="decimal"
              value={transform.panX}
              onChange={(e) => handleTransform("panX", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="scene-pan-y">Pan Y (-1 to 1)</Label>
            <Input
              id="scene-pan-y"
              inputMode="decimal"
              value={transform.panY}
              onChange={(e) => handleTransform("panY", e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="scene-flip-h" className="inline-flex items-center gap-2">
            <Checkbox
              id="scene-flip-h"
              checked={flipH}
              onCheckedChange={(v) => commitFlip(v === true)}
            />
            Flip horizontally
          </Label>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={fit === "fit" ? "default" : "outline"}
              aria-pressed={fit === "fit"}
              onClick={() => commitFit("fit")}
            >
              Fit
            </Button>
            <Button
              type="button"
              size="sm"
              variant={fit === "fill" ? "default" : "outline"}
              aria-pressed={fit === "fill"}
              onClick={() => commitFit("fill")}
            >
              Fill
            </Button>
          </div>
        </div>
        {!mediaBackground && (
          <p className="text-xs text-muted-foreground">
            Pick an image or GIF background to commit these values.
          </p>
        )}
      </div>

      {/* Text overlays: rows select, one inspector edits the selection. */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Text overlays</p>
        <div className="flex flex-wrap gap-2">
          {overlays.map((overlay, index) => (
            <Button
              key={`overlay-row-${index}`}
              type="button"
              size="sm"
              variant={safeIndex === index ? "default" : "outline"}
              aria-pressed={safeIndex === index}
              onClick={() => setSelected(index)}
            >
              {`Overlay ${index + 1}`}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={addOverlay} disabled={atCap}>
            Add text overlay
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={removeOverlay}
            disabled={overlays.length === 0}
          >
            Remove overlay
          </Button>
        </div>
        {atCap && (
          <p className="text-xs text-muted-foreground">
            Limit reached: remove an overlay before adding another.
          </p>
        )}

        {selectedOverlay && (
          <div className="grid grid-cols-2 gap-3 rounded-md border p-3">
            {selectedOverlay.kind === "text" && (
              <div className="col-span-2 space-y-1">
                <Label htmlFor="overlay-text">Overlay text</Label>
                <Input
                  id="overlay-text"
                  maxLength={SCENE_MAX_TEXT_CHARS}
                  value={selectedOverlay.text}
                  onChange={(e) => handleText(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="overlay-x">Overlay X (0-1)</Label>
              <Input
                id="overlay-x"
                inputMode="decimal"
                value={unitDrafts.x}
                onChange={(e) => handleUnit("x", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="overlay-y">Overlay Y (0-1)</Label>
              <Input
                id="overlay-y"
                inputMode="decimal"
                value={unitDrafts.y}
                onChange={(e) => handleUnit("y", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="overlay-size">Overlay size (0-1)</Label>
              <Input
                id="overlay-size"
                inputMode="decimal"
                value={unitDrafts.size}
                onChange={(e) => handleUnit("size", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="overlay-rotation">Overlay rotation (degrees)</Label>
              <Input
                id="overlay-rotation"
                inputMode="decimal"
                value={unitDrafts.rotation}
                onChange={(e) => handleUnit("rotation", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="overlay-color">Overlay color</Label>
              <Input
                id="overlay-color"
                type="color"
                value={
                  HEX_COLOR.test(selectedOverlay.color) ? selectedOverlay.color : "#ffffff"
                }
                onChange={(e) => handleOverlayColor(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Live preview: bytes rendered by the sidecar's engine on the panel.
          The overlay layer on top is GUIDANCE only — it composes no pixels;
          the PNG below it stays the single source of truth. The stage fixes
          the engine's 240x427 preview aspect; all gesture math converts px
          through the stage's measured rect, never through a hard constant. */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Preview</p>
        <div className="flex aspect-[3/2] w-full items-center justify-center overflow-hidden rounded-md border bg-black/40">
          {previewUrl ? (
            <div
              ref={stageRef}
              className="relative h-full aspect-[240/427] [container-type:size]"
            >
              <img
                src={previewUrl}
                alt="Scene preview"
                className="absolute inset-0 h-full w-full"
              />
              <div
                className="absolute inset-0 touch-none select-none"
                onPointerDown={(e) => {
                  // Empty space deselects; widget hits start their own gesture.
                  if (e.target === e.currentTarget) setSelected(null);
                }}
              >
                {overlays.map((overlay, index) => {
                  const gesturing =
                    gesture !== null && ghost !== null && gesture.index === index;
                  const placement = gesturing && ghost ? ghost : overlay;
                  const dxPx =
                    gesturing && gesture
                      ? (placement.x - overlay.x) * gesture.rect.width
                      : 0;
                  const dyPx =
                    gesturing && gesture
                      ? (placement.y - overlay.y) * gesture.rect.height
                      : 0;
                  const scale =
                    gesturing && overlay.size > 0 ? placement.size / overlay.size : 1;
                  const isSelected = safeIndex === index;
                  return (
                    <div
                      key={`preview-overlay-${index}`}
                      data-dragging={gesturing ? "true" : undefined}
                      className="absolute"
                      style={{
                        left: `${overlay.x * 100}%`,
                        top: `${overlay.y * 100}%`,
                        height: `${overlay.size * 100}%`,
                        transform: overlayBoxTransform(
                          dxPx,
                          dyPx,
                          placement.rotation,
                          scale
                        ),
                      }}
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`Select overlay ${index + 1}`}
                        aria-pressed={isSelected}
                        className={`h-full rounded-sm border border-dashed px-1 ${
                          isSelected ? "border-primary" : "border-white/50"
                        }`}
                        style={{
                          // size is a fraction of canvas HEIGHT (the engine's
                          // font_px = size * h); cqh expresses exactly that
                          // against the size-container stage.
                          fontSize: `${overlay.size * 100}cqh`,
                          color: overlay.color,
                        }}
                        onPointerDown={(e) => beginGesture(index, "move", e)}
                        onClick={() => setSelected(index)}
                      >
                        {/* gpu-temp has no renderer until S4-T15: an honest
                            empty box, never phantom data. */}
                        {overlay.kind === "text" ? overlay.text : ""}
                      </Button>
                      {isSelected && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            aria-label={`Resize overlay ${index + 1}`}
                            className="absolute -bottom-1.5 -right-1.5 h-3 w-3 rounded-full p-0"
                            onPointerDown={(e) => beginGesture(index, "resize", e)}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            aria-label={`Rotate overlay ${index + 1}`}
                            className="absolute left-1/2 -top-1.5 h-3 w-3 -translate-x-1/2 rounded-full p-0"
                            onPointerDown={(e) => beginGesture(index, "rotate", e)}
                          />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Waiting for the panel…</p>
          )}
        </div>
        {previewError && (
          <p role="alert" className="text-sm text-destructive">
            {previewError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          The preview renders on the connected panel, so it is live only while
          LyricVision holds the display.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void handleSave()}>
          Save scene
        </Button>
        <Button type="button" variant="outline" onClick={handleReset}>
          Reset
        </Button>
        {savedNote && (
          <span className="text-sm text-muted-foreground">{savedNote}</span>
        )}
      </div>
      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}
    </div>
  );
}
