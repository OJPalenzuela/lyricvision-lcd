import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { Redo2, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import LayersList from "@/components/LayersList";
import SceneStage, { type OverlayPlacement } from "@/components/SceneStage";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorPicker } from "@/components/ui/color-picker";
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
import { useCanRedo, useCanUndo, useSceneStore } from "@/lib/sceneStore";

/**
 * Scene editor (S2-T8): WYSIWYG surface whose every committed value is
 * previewed live on the connected panel (scene:preview IPC over the live
 * sidecar pipe) and persisted through saveSettings({scene}).
 *
 * STATE SPLIT (why): the scene lives in the Zustand scene store
 * (S7-T20, src/renderer/lib/sceneStore.ts) — it must survive this
 * component unmounting and feeds Save/Reset plus undo/redo; App wires the
 * store into the props below, so this component stays props-driven. The
 * canvas itself moved to Konva in S7-T21 (src/renderer/components/
 * SceneStage.tsx). Everything else is ephemeral editor UI state kept local
 * on purpose: numeric drafts (typing must not be interrupted by
 * round-trips), overlay selection, the active rail section, preview bytes,
 * and status messages never leak into settings — and never into undo
 * history either, which records scene mutations only.
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
 * DIRECT MANIPULATION (S2-T9 -> S7-T21): the stage is a Konva/react-konva
 * Layer in SceneStage.tsx. The sidecar's engine PNG is its BASE <Image>
 * (loaded through use-image); the overlay nodes above it are GUIDANCE only —
 * this file still composes no pixels, and the PNG underneath stays the
 * single source of truth. Gestures commit their clamped values LIVE into
 * scene state (that is what makes history coalescing observable), while
 * schedulePreview is gated so the panel still sees exactly ONE debounced
 * scene:preview per gesture, from the same 250 ms source as every other edit.
 *
 * GESTURE COALESCING (S7-T21): exactly ONE undo entry per gesture — a
 * drag/resize/rotate, or one focused numeric edit session. beginCoalesce
 * snapshots the pre-gesture scene and pauses zundo's temporal store; the
 * live commits therefore record nothing; endCoalesce rewinds to that
 * snapshot WHILE STILL PAUSED (the rewind records nothing either), resumes,
 * and commits the final value, so zundo writes exactly one entry whose undo
 * target IS the snapshot. The `owner` tag keeps a field blur from closing a
 * drag (and vice versa).
 */

const PREVIEW_DEBOUNCE_MS = 250;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const COLOR_FALLBACK = "#000000";
const SHORT_HEX = /^#[0-9a-fA-F]{3}$/;

/**
 * Accept the canonical #rrggbb form plus react-colorful's possible #abc
 * shorthand, always committing the canonical 6-digit shape the validator
 * requires. Reject, never coerce: an unparseable value returns null and
 * commits NOTHING.
 */
function normalizeHexColor(raw: string): string | null {
  if (HEX_COLOR.test(raw)) return raw;
  if (SHORT_HEX.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return null;
}

/** Coalescing session owners: S7-T21 drag/field, S7-T22 color. */
type CoalesceOwner = "drag" | "field" | "color";

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

/**
 * Elements that own the browser's native text undo/redo (typing surfaces).
 * WHY: the editor-scoped Ctrl+Z must never steal history from a text
 * field — editing text and editing the scene are different histories, and
 * native undo is what users expect while a field has focus.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * Rail sections (S7-T19): TRCC-style persistent navigation — pick a
 * section and edit immediately, no enter/exit edit mode. The labels are
 * the owner-specified section names; every other copy in this file stays
 * English. `fondo` owns the background KIND together with its transform
 * because the validator binds transform keys to image/gif backgrounds
 * only: splitting them would split one editing concern across sections.
 */
const SCENE_SECTIONS = [
  { id: "fondo", label: "Fondo" },
  { id: "capas", label: "Capas" },
  { id: "propiedades", label: "Propiedades" },
] as const;

type SceneSectionId = (typeof SCENE_SECTIONS)[number]["id"];

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
  // Active rail section (S7-T19): persistent nav, no edit-mode toggle.
  const [section, setSection] = useState<SceneSectionId>("fondo");
  // S7-T21 gesture coalescing (see file header): history is paused for the
  // whole gesture and exactly one entry is written when it ends.
  const coalescing = useRef<{ owner: CoalesceOwner; snapshot: Scene } | null>(
    null
  );
  // Live gestures commit scene values (that is what makes coalescing
  // observable), so this gate keeps the 250 ms preview from re-arming until
  // the gesture lifts: a drag still costs exactly ONE preview request.
  const gestureActive = useRef(false);
  // Which editable field owns the current coalescing session (focus -> blur).
  const focusedField = useRef<string | null>(null);
  // S7-T22 color-gesture state (react-colorful): one pointer press opens an
  // owner-tagged "color" session; the snapshot tells release whether ANY
  // value actually changed (a tap that re-emits the current color must
  // record nothing — the snapshot === scene branch stays honored).
  const colorGestureActive = useRef(false);
  const colorGestureSnapshot = useRef<Scene | null>(null);
  // Window-level release listeners capture their closure at REGISTRATION
  // time, so they call through this ref — refreshed on every render — to
  // reach the latest endColorGesture (fresh scene/endCoalesce/schedulePreview).
  const colorReleaseRef = useRef<() => void>(() => {});

  const handleWindowRelease = useCallback(() => {
    colorReleaseRef.current();
  }, []);

  const endCoalesce = (owner: CoalesceOwner): void => {
    const active = coalescing.current;
    if (!active || active.owner !== owner) return;
    coalescing.current = null;
    if (active.snapshot === scene) {
      // Nothing actually moved (a plain tap, or focus without an edit):
      // record nothing — selecting must never dirty the scene OR history.
      useSceneStore.temporal.getState().resume();
      return;
    }
    onSceneChange(active.snapshot); // unrecorded rewind (still paused)
    useSceneStore.temporal.getState().resume();
    onSceneChange(scene); // final value -> exactly ONE history entry
  };

  const beginCoalesce = (owner: CoalesceOwner, snapshot: Scene): void => {
    if (coalescing.current?.owner === owner) return; // already coalescing
    // Defensive: another session is still open (its blur may not have
    // arrived). Close it first so its edits get their own single entry.
    if (coalescing.current) endCoalesce(coalescing.current.owner);
    coalescing.current = { owner, snapshot };
    useSceneStore.temporal.getState().pause();
  };

  /**
   * S7-T22 color gesture (react-colorful): pointer boundaries open/close the
   * "color" coalescing session, so ONE pointer press = ONE history entry no
   * matter how many onChange values stream mid-gesture. The release listener
   * also lives on `window` because a pointer can be released OUTSIDE the
   * wrapper; live commits stay gated (gestureActive) so the panel sees
   * exactly ONE debounced preview after the gesture, from the same 250 ms
   * source as every other edit.
   */
  const beginColorGesture = (): void => {
    if (colorGestureActive.current) return;
    colorGestureActive.current = true;
    colorGestureSnapshot.current = scene;
    gestureActive.current = true; // suppress previews until the release
    beginCoalesce("color", scene);
    window.addEventListener("pointerup", handleWindowRelease);
    window.addEventListener("pointercancel", handleWindowRelease);
  };

  const endColorGesture = (): void => {
    if (!colorGestureActive.current) return;
    colorGestureActive.current = false;
    window.removeEventListener("pointerup", handleWindowRelease);
    window.removeEventListener("pointercancel", handleWindowRelease);
    const startedAt = colorGestureSnapshot.current;
    colorGestureSnapshot.current = null;
    const changed = startedAt !== scene; // any live commit rebuilt the scene
    gestureActive.current = false; // unblock previews BEFORE the final commit
    endCoalesce("color");
    if (changed) schedulePreview(scene); // ONE debounced push, single source
  };

  // Refresh the window-release target every render (see colorReleaseRef).
  useEffect(() => {
    colorReleaseRef.current = endColorGesture;
  });

  // Unmount mid-gesture must never leave history frozen OR window listeners
  // attached to a dead component.
  useEffect(
    () => () => {
      if (colorGestureActive.current) {
        colorGestureActive.current = false;
        window.removeEventListener("pointerup", handleWindowRelease);
        window.removeEventListener("pointercancel", handleWindowRelease);
      }
      if (coalescing.current) {
        coalescing.current = null;
        useSceneStore.temporal.getState().resume();
      }
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

  // S7-T20 history controls: reactive against zundo's temporal store, so
  // the buttons disable live at both ends of history (empty at boot root).
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();

  // Refs, not state: debounce timers and stale-reply guards must not trigger
  // re-renders or capture stale closures.
  const seqRef = useRef(0);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const overlays = scene.overlays;
  const safeIndex =
    selected === null ? -1 : Math.min(selected, Math.max(0, overlays.length - 1));
  const selectedOverlay = safeIndex >= 0 ? (overlays[safeIndex] ?? null) : null;
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
    // S7-T21: a gesture commits live values on every move (that is what
    // makes coalescing observable), but the panel must not repaint until the
    // finger lifts — ONE debounced preview per gesture, still from the single
    // PREVIEW_DEBOUNCE_MS source (never a second timer constant).
    if (gestureActive.current) return;
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
   * S7-T21 gesture bridge to the Konva stage (SceneStage.tsx owns
   * hit-testing and the px->unit math). This component owns what a gesture
   * MEANS for history and preview: one coalesced undo entry and one
   * debounced engine preview per gesture. The `scene` closure is the value
   * from the render that saw dragstart — safe because a gesture is the only
   * thing committing while it holds the pointer, and endCoalesce re-reads
   * the LATEST closure (the render produced by the last live commit).
   */
  const handleGestureBegin = (index: number): void => {
    if (!scene.overlays[index]) return;
    setSelected(index);
    gestureActive.current = true; // suppress previews until the release
    beginCoalesce("drag", scene);
    setSavedNote(null);
  };

  const handleGestureMove = (
    index: number,
    placement: OverlayPlacement
  ): void => {
    if (!scene.overlays[index]) return;
    // Live commit: this is what makes coalescing observable, and it is safe
    // because beginCoalesce already paused zundo for this gesture.
    commitOverlays(
      scene.overlays.map((overlay, i) =>
        i === index ? { ...overlay, ...placement } : overlay
      )
    );
    setSavedNote(null);
  };

  const handleGestureEnd = (): void => {
    gestureActive.current = false; // unblock previews BEFORE the final commit
    endCoalesce("drag");
    // Release preview, GUARANTEED: endCoalesce rewinds and re-sets the scene,
    // which can net back to an identity React bails out on (Object.is), so the
    // [scene] effect may never re-run — schedule explicitly here. Still the
    // single PREVIEW_DEBOUNCE_MS timer; a mid-gesture schedule is impossible
    // because the gate above was open only after the last commit.
    schedulePreview(scene);
  };

  /**
   * S7-T22 dnd-kit commit (Capas): the DROP mutates the array through the
   * store — one `set` in sceneStore.reorderOverlays IS the single history
   * entry (no commits exist during the drag, so there is nothing to
   * coalesce), and the [scene] effect arms the usual ONE debounced preview.
   *
   * SELECTION STABILITY (index → identity, CRITICAL): selection is an
   * index, and a reorder SHIFTS indices. The selected overlay OBJECT is
   * captured before the move and re-found by reference (`indexOf`) after —
   * the selection follows the same overlay, and SceneStage's positional
   * `overlay-N` ids / handles (re-derived from the array on every render)
   * therefore land on the right objects.
   */
  const handleReorder = (from: number, to: number): void => {
    if (from === to) return;
    if (from < 0 || from >= overlays.length) return;
    if (to < 0 || to >= overlays.length) return;
    const anchor = safeIndex >= 0 ? overlays[safeIndex] ?? null : null;
    useSceneStore.getState().reorderOverlays(from, to);
    if (!anchor) return;
    const next = useSceneStore.getState().scene.overlays;
    const newIndex = next.indexOf(anchor);
    if (newIndex >= 0 && newIndex !== safeIndex) setSelected(newIndex);
  };

  /**
   * Field coalescing at the editor ROOT: focusin/focusout bubble, so one
   * pair of handlers covers every inspector input instead of wiring each
   * control. Editable targets only (same gate as the Ctrl+Z handler), keyed
   * by control id so blur always closes the session focus opened.
   */
  const handleRootFocus = (event: { target: EventTarget }): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !isEditableTarget(target)) return;
    const key = target.id || target.tagName;
    if (focusedField.current !== null && focusedField.current !== key) {
      endCoalesce("field"); // a previous field never blurred (defensive)
    }
    focusedField.current = key;
    beginCoalesce("field", scene);
  };

  const handleRootBlur = (event: { target: EventTarget }): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !isEditableTarget(target)) return;
    const key = target.id || target.tagName;
    if (focusedField.current !== key) return;
    focusedField.current = null;
    endCoalesce("field");
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
    // Reject, never coerce: only canonical #rrggbb (plus react-colorful's
    // possible #abc shorthand, expanded) ever reaches the scene.
    const hex = normalizeHexColor(raw);
    if (!hex) return;
    const overlay = safeIndex >= 0 ? overlays[safeIndex] : undefined;
    // Same-value guard (S7-T22): a tap that re-emits the current color must
    // not rebuild the scene — with no commit, snapshot === scene at release
    // and endCoalesce records ZERO entries for a gesture that changed nothing.
    if (!overlay || overlay.color === hex) return;
    const overlaysNext = overlays.map((item, i) =>
      i === safeIndex ? { ...item, color: hex } : item
    );
    commitOverlays(overlaysNext);
    setSavedNote(null);
  };

  const handleBackgroundColor = (raw: string) => {
    const hex = normalizeHexColor(raw);
    if (!hex) return;
    if (scene.background.kind === "color" && scene.background.color === hex) {
      return;
    }
    onSceneChange({ ...scene, background: { kind: "color", color: hex } });
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

  /**
   * Editor-scoped history shortcuts (S7-T20). WHY each check, in order:
   * - the handler sits on the editor ROOT, so it fires only for events
   *   originating inside the editor (scope: it cannot hijack the rest of
   *   the window);
   * - editable targets are skipped BEFORE anything else: native text undo
   *   wins in inputs, so Ctrl+Z mid-typing never moves the scene;
   * - preventDefault only when WE handle it, so the skipped native path is
   *   never suppressed. Ctrl+Shift+Z redos. Windows-only app → Ctrl key.
   */
  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!event.ctrlKey || (event.key !== "z" && event.key !== "Z")) return;
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    if (event.shiftKey) useSceneStore.getState().redo();
    else useSceneStore.getState().undo();
  };

  // Panels are hoisted into variables so the rail can swap them while
  // each block keeps its original shape (S7-T19 restructure).
  const fondoPanel = (
    <>
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
            {/* S7-T22: react-colorful swatch (pointer gesture, coalesced
                through the "color" owner) + the native field (typed hex /
                keyboard) — two doors into the SAME existing
                background.color field, gated by ONE handler. */}
            <div
              data-testid="background-color-gesture"
              onPointerDown={beginColorGesture}
              className="space-y-2"
            >
              <ColorPicker
                value={HEX_COLOR.test(backgroundColor) ? backgroundColor : COLOR_FALLBACK}
                onChange={handleBackgroundColor}
                aria-label="Background color picker"
              />
              <Input
                id="scene-background-color"
                type="color"
                value={HEX_COLOR.test(backgroundColor) ? backgroundColor : COLOR_FALLBACK}
                onChange={(e) => handleBackgroundColor(e.target.value)}
              />
            </div>
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
    </>
  );

  // Capas (S7-T22): the overlay list with dnd-kit sortable rows — select via
  // the row button, reorder via the drag handle (pointer or keyboard). The
  // row order IS scene.overlays order = the sidecar paint order (z-order).
  const capasPanel = (
    <>
      {/* Text overlays: rows select; the selected one is edited in the
          Propiedades section. */}
      <div className="space-y-2">
        <LayersList
          overlays={overlays}
          selected={safeIndex}
          onSelect={setSelected}
          onReorder={handleReorder}
        />
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
      </div>
    </>
  );

  // Propiedades: the selected overlay's inspector (position/size/rotation/
  // color). With no selection the panel shows guidance instead of dead
  // controls (the preview's empty-space click deselects).
  const inspectorPanel = (
    <>
      <div className="space-y-2">
        <p className="text-sm font-medium">Propiedades</p>
        {!selectedOverlay && (
          <p className="text-xs text-muted-foreground">
            Select an overlay on the preview or in Capas to edit its
            properties.
          </p>
        )}

        {selectedOverlay && (
          <motion.div
            key={`overlay-card-${safeIndex}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="grid grid-cols-2 gap-3 rounded-md border p-3"
          >
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
              {/* S7-T22: react-colorful swatch streams continuous onChange —
                  pointer boundaries open the "color" coalescing owner, so
                  ONE drag = ONE history entry + ONE debounced preview. The
                  native field stays as the keyboard/typed-hex path. */}
              <div
                data-testid="overlay-color-gesture"
                onPointerDown={beginColorGesture}
                className="space-y-2"
              >
                <ColorPicker
                  value={
                    HEX_COLOR.test(selectedOverlay.color) ? selectedOverlay.color : "#ffffff"
                  }
                  onChange={handleOverlayColor}
                  aria-label="Overlay color picker"
                />
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
          </motion.div>
        )}
      </div>
    </>
  );

  // Main area (S7-T19): the live engine preview plus the persistence
  // actions — both stay visible from EVERY rail section, so no control
  // ever hides behind a tab.
  const previewBlock = (
    <>
      {/* Live preview: bytes rendered by the sidecar's engine on the panel.
          The overlay layer on top is GUIDANCE only — it composes no pixels;
          the PNG below it stays the single source of truth. The stage fixes
          the engine's 240x427 preview aspect; all gesture math converts px
          through the stage's measured rect, never through a hard constant. */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Preview</p>
        <div className="flex aspect-[3/2] w-full items-center justify-center overflow-hidden rounded-md border bg-black/40">
          {previewUrl ? (
            <SceneStage
              previewUrl={previewUrl}
              overlays={overlays}
              selected={safeIndex >= 0 ? safeIndex : null}
              onSelect={setSelected}
              onGestureBegin={handleGestureBegin}
              onGestureMove={handleGestureMove}
              onGestureEnd={handleGestureEnd}
            />
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
    </>
  );

  const saveBlock = (
    <>
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
    </>
  );

  const activeLabel =
    SCENE_SECTIONS.find((item) => item.id === section)?.label ??
    SCENE_SECTIONS[0].label;

  return (
    <div
      className="flex items-start gap-4"
      onKeyDown={handleEditorKeyDown}
      onFocus={handleRootFocus}
      onBlur={handleRootBlur}
    >
      {/* S7-T19 persistent rail: pick a section and edit immediately —
          there is no enter/exit edit mode anymore. aria-pressed mirrors
          the switch, the same pattern the background kind pills use. The
          history row (S7-T20) shares this always-visible column: same
          width, no layout redesign — and it sits OUTSIDE <nav> because
          undo/redo are actions, not navigation landmarks. */}
      <div className="flex w-32 shrink-0 flex-col">
        <nav aria-label="Scene sections" className="flex flex-col gap-1">
          {SCENE_SECTIONS.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={section === item.id ? "default" : "ghost"}
              aria-pressed={section === item.id}
              onClick={() => setSection(item.id)}
              className="justify-start"
            >
              {item.label}
            </Button>
          ))}
        </nav>
        <div
          className="mt-2 flex gap-1"
          role="group"
          aria-label="Scene history"
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="flex-1"
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            disabled={!canUndo}
            onClick={() => useSceneStore.getState().undo()}
          >
            <Undo2 className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="flex-1"
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
            disabled={!canRedo}
            onClick={() => useSceneStore.getState().redo()}
          >
            <Redo2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Panel column: exactly ONE panel is mounted at a time; motion
          gives the swap a snappy 150 ms slide/fade (first user-visible
          win of the motion migration). The region label tracks state. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={section}
          role="region"
          aria-label={activeLabel}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.15 }}
          className="min-w-0 flex-1 space-y-4"
        >
          {section === "fondo" && fondoPanel}
          {section === "capas" && capasPanel}
          {section === "propiedades" && inspectorPanel}
        </motion.div>
      </AnimatePresence>

      {/* Main area: live preview + Save/Reset, always visible. */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {previewBlock}
        {saveBlock}
      </div>
    </div>
  );
}
