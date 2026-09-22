import { useEffect, useRef, useState, useCallback } from "react";

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
 */

const PREVIEW_DEBOUNCE_MS = 250;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const COLOR_FALLBACK = "#000000";

type UnitField = "x" | "y" | "size";
type TransformField = "rotation" | "scale" | "panX" | "panY";

const EMPTY_UNIT_DRAFTS: Record<UnitField, string> = {
  x: "0.5",
  y: "0.5",
  size: "0.1",
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
  const [selected, setSelected] = useState(0);
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
  const safeIndex = Math.min(selected, Math.max(0, overlays.length - 1));
  const selectedOverlay = overlays[safeIndex] ?? null;
  const backgroundKind = scene.background.kind;
  const backgroundColor =
    scene.background.kind === "color" ? scene.background.color : COLOR_FALLBACK;
  const mediaBackground = isMediaKind(scene.background) ? scene.background : null;
  const atCap = overlays.length >= SCENE_OVERLAYS_CAP;

  // Keep drafts aligned with the selected overlay whenever the scene or the
  // selection changes (add/remove/switch/Reset all flow through here).
  useEffect(() => {
    const overlay = scene.overlays[safeIndex] ?? null;
    setUnitDrafts(
      overlay
        ? { x: String(overlay.x), y: String(overlay.y), size: String(overlay.size) }
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
      const next: Record<UnitField, string> = { x: prev.x, y: prev.y, size: prev.size };
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

  const handleUnit = (field: UnitField, raw: string) => {
    const result = stagedNumber(raw, 0, 1);
    setUnitDraft(field, result ? result.draft : raw);
    if (!result || safeIndex >= overlays.length) return;
    const overlaysNext = overlays.map((overlay, i) => {
      if (i !== safeIndex) return overlay;
      return {
        ...overlay,
        x: field === "x" ? result.commit : overlay.x,
        y: field === "y" ? result.commit : overlay.y,
        size: field === "size" ? result.commit : overlay.size,
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
    if (!overlays.length) return;
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

      {/* Live preview: bytes rendered by the sidecar's engine on the panel. */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Preview</p>
        <div className="flex aspect-[3/2] w-full items-center justify-center overflow-hidden rounded-md border bg-black/40">
          {previewUrl ? (
            <img src={previewUrl} alt="Scene preview" className="max-h-full max-w-full" />
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
