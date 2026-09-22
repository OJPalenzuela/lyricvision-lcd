import { useEffect, useRef, useState, useCallback } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errMessage, type LyricvisionBridge } from "@/lib/bridge";
import { SCENE_MAX_TEXT_CHARS, SCENE_OVERLAYS_CAP, type Scene } from "@/lib/scene";

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
 * TRANSFORM IS STAGED: the schema only accepts rotation/scale/pan/flip/fit
 * on image/gif/video backgrounds, and media import is not implemented yet —
 * committing them now would fail hardening.validateScene, so they stay
 * local until S2-T8b wires media backgrounds.
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
    // Staged only: deliberately never committed (see file header).
    setTransformDraft(field, result ? result.draft : raw);
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
  };

  return (
    <div className="space-y-4">
      {/* Background: NONE and COLOR only — media kinds arrive with import (S2-T8b). */}
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
      </div>

      {/* Transform: staged locally, never committed (see file header). */}
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
              onCheckedChange={(v) => setFlipH(v === true)}
            />
            Flip horizontally
          </Label>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={fit === "fit" ? "default" : "outline"}
              aria-pressed={fit === "fit"}
              onClick={() => setFit("fit")}
            >
              Fit
            </Button>
            <Button
              type="button"
              size="sm"
              variant={fit === "fill" ? "default" : "outline"}
              aria-pressed={fit === "fill"}
              onClick={() => setFit("fill")}
            >
              Fill
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Used by image backgrounds. Media import is not available yet, so these
          values stay staged until an image background exists.
        </p>
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
