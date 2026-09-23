import { useLayoutEffect, useRef, useState } from "react";
import {
  Circle,
  Group,
  Image as KonvaImage,
  Layer,
  Rect,
  Stage,
  Text,
} from "react-konva";
import useImage from "use-image";
import type Konva from "konva";

import {
  BASE_WIDGET_META,
  MIN_BASE_WIDGET_SIZE,
  PORTRAIT_HEIGHT,
  PORTRAIT_WIDTH,
  type ResolvedBasePlacements,
} from "@/lib/basePlacements";
import {
  BASE_WIDGET_KEYS,
  type BasePlacement,
  type BaseWidget,
  type Scene,
} from "@/lib/scene";

/**
 * S7-T21 — the editor canvas, rebuilt on Konva/react-konva. It replaces the
 * hand-rolled pointer listeners + CSS ghost that lived in SceneEditor.tsx.
 *
 * LAYER CONTRACT (why): the sidecar's engine PNG is the BASE <Image>, loaded
 * through `use-image`; the overlay nodes above it are GUIDANCE only — this
 * component composes no pixels, so the preview stays WYSIWYG (the PNG under
 * the guides is what the panel shows). Overlay nodes are DERIVED from the
 * committed 0–1 scene values on every render; selection stays component-local
 * in SceneEditor and is passed down here.
 *
 * SPACE: nodes are authored in logical GLASS/portrait space (480×854) and the
 * Stage is scaled to the measured container, so every node coordinate is a
 * pure function of the scene. Base-widget size uses the centralized
 * BASE_WIDGET_META unit: width widgets scale by PORTRAIT_WIDTH and height
 * widgets scale by PORTRAIT_HEIGHT.
 *
 * JSDOM SEAM (honest): jsdom ships no canvas backend, so there is no hit
 * graph to trust in tests. Tests reach the stage through the module-level
 * `sceneStageRef` and drive Konva's OWN event API (`node.fire("dragmove", …)`);
 * empty-space deselects are driven by a real DOM event on `.konvajs-content`.
 * The canvas/Image shims live in tests/renderer/konvaJsdomShims.ts — tests
 * only, never imported by this file.
 */

export type GestureMode = "move" | "resize" | "rotate";

/** A gesture's committed contribution: clamped 0–1 placement + degrees. */
export interface OverlayPlacement {
  x: number;
  y: number;
  size: number;
  rotation: number;
}

/** Logical portrait space — the glass the engine renders into (registry rotates later). */
const GLASS_WIDTH = PORTRAIT_WIDTH;
const GLASS_HEIGHT = PORTRAIT_HEIGHT;

/**
 * Gesture-time floor for resize. The validator accepts size in [0,1], but a
 * 0-size widget is invisible and ungrabbable, so the drag clamps at 0.01 —
 * still inside the validator's range.
 */
const MIN_OVERLAY_SIZE = MIN_BASE_WIDGET_SIZE;

/** Declared overlay rotation range — inspector and rotation handle share it. */
const OVERLAY_ROTATION_RANGE: readonly [number, number] = [-360, 360];

/**
 * Guide-box aspect. The old DOM box was sized by its button's intrinsic text
 * width; a Konva <Text> needs an explicit box to center in, so the guide box
 * is height × 6 (height == fontSize, exactly like the old `size * cqh`).
 * It is a hit/drag target only — the PNG underneath still shows the truth.
 */
const GUIDE_BOX_ASPECT = 6;

/** Handle radius in logical px (12 CSS px on the 240-wide preview = 24 logical). */
const HANDLE_RADIUS = 12;

/** jsdom / pre-layout fallback: the engine's own 240×427 preview size. */
const FALLBACK_SCALE = 240 / GLASS_WIDTH;

/**
 * jsdom test seam: the mounted Stage, reachable without DOM hit-testing.
 * Tests read it as `sceneStageRef.current?.findOne("#overlay-0")`.
 */
export const sceneStageRef: { current: Konva.Stage | null } = { current: null };

interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface GestureState {
  index: number;
  mode: GestureMode;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  /** Stage rect measured once at dragstart; deltas never re-measure. */
  rect: StageRect;
  originX: number;
  originY: number;
  originSize: number;
  originRotation: number;
}

export type BaseGestureMode = "move" | "resize";

interface BaseGestureState {
  widget: BaseWidget;
  mode: BaseGestureMode;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  rect: StageRect;
  origin: BasePlacement;
}

type StageOverlay = Scene["overlays"][number];

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Gesture math: current pointer -> placement, clamped DURING the gesture so
 * neither the live node nor the released scene can leave the ranges
 * hardening.validateScene enforces (x/y/size in [0,1], rotation finite and
 * inside the declared [-360,360]). Ported unchanged from S2-T9, so the same
 * expected values (0.7 / 0.2 / 90 / ±360) hold.
 */
function gesturePlacement(g: GestureState): OverlayPlacement {
  const { rect, originX, originY, originSize, originRotation } = g;
  const dx = g.clientX - g.startClientX;
  const dy = g.clientY - g.startClientY;
  if (g.mode === "move") {
    // Clamp the PIXEL delta against the origin first so the node stays
    // pixel-exact against the measured rect, then clamp the unit value
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
  // never snaps the node the long way around.
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

function baseGesturePlacement(gesture: BaseGestureState): BasePlacement {
  const dx = gesture.clientX - gesture.startClientX;
  const dy = gesture.clientY - gesture.startClientY;
  if (gesture.mode === "move") {
    const dxPx = clampNumber(
      dx,
      -gesture.origin.x * gesture.rect.width,
      (1 - gesture.origin.x) * gesture.rect.width
    );
    const dyPx = clampNumber(
      dy,
      -gesture.origin.y * gesture.rect.height,
      (1 - gesture.origin.y) * gesture.rect.height
    );
    return {
      ...gesture.origin,
      x: clampNumber(gesture.origin.x + dxPx / gesture.rect.width, 0, 1),
      y: clampNumber(gesture.origin.y + dyPx / gesture.rect.height, 0, 1),
    };
  }
  const delta =
    BASE_WIDGET_META[gesture.widget].sizeUnit === "width"
      ? dx / gesture.rect.width
      : dy / gesture.rect.height;
  return {
    ...gesture.origin,
    size: clampNumber(
      gesture.origin.size + delta,
      MIN_BASE_WIDGET_SIZE,
      1
    ),
  };
}

function baseGuideBox(
  widget: BaseWidget,
  placement: BasePlacement
): { width: number; height: number } {
  const sizeUnit = BASE_WIDGET_META[widget].sizeUnit;
  const size =
    placement.size * (sizeUnit === "width" ? GLASS_WIDTH : GLASS_HEIGHT);
  if (sizeUnit === "width") {
    return widget === "cover"
      ? { width: size, height: size }
      : { width: size, height: 8 };
  }
  const height =
    widget === "title"
      ? Math.max(40, size * 2)
      : widget === "artist"
        ? Math.max(48, size * 2.5)
        : Math.max(96, size * 3.5);
  return { width: GLASS_WIDTH - 56, height };
}

function baseResizeHandle(
  widget: BaseWidget,
  placement: BasePlacement,
  box: { width: number; height: number }
): { x: number; y: number } {
  const centerX = placement.x * GLASS_WIDTH;
  const centerY = placement.y * GLASS_HEIGHT;
  if (widget === "cover") {
    return { x: centerX + box.width / 2, y: centerY + box.height / 2 };
  }
  if (widget === "progress") {
    return { x: centerX + box.width / 2, y: centerY };
  }
  return { x: centerX, y: centerY + box.height / 2 };
}

/**
 * Handle anchors in STAGE space: the guide box rotates around its center, so
 * each handle is its unrotated offset rotated by the scene's degrees
 * (clockwise-positive in y-down space — same sign as the engine and as CSS).
 * Handles are siblings of the text, which is what keeps them out of the
 * text's own transform while still tracking it.
 */
function handlePositions(overlay: StageOverlay): {
  resize: { x: number; y: number };
  rotate: { x: number; y: number };
} {
  const centerX = overlay.x * GLASS_WIDTH;
  const centerY = overlay.y * GLASS_HEIGHT;
  const boxHeight = overlay.size * GLASS_HEIGHT;
  const boxWidth = boxHeight * GUIDE_BOX_ASPECT;
  const rad = (overlay.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    // bottom-right corner offset (+w/2, +h/2)
    resize: {
      x: centerX + (boxWidth / 2) * cos - (boxHeight / 2) * sin,
      y: centerY + (boxWidth / 2) * sin + (boxHeight / 2) * cos,
    },
    // top-center offset (0, -h/2)
    rotate: {
      x: centerX + (boxHeight / 2) * sin,
      y: centerY - (boxHeight / 2) * cos,
    },
  };
}

interface SceneStageProps {
  previewUrl: string;
  overlays: Scene["overlays"];
  basePlacements: ResolvedBasePlacements;
  /** Index of the selected overlay (already clamped by SceneEditor), or null. */
  selected: number | null;
  selectedBase: BaseWidget | null;
  onSelect: (index: number | null) => void;
  onSelectBase: (widget: BaseWidget | null) => void;
  onGestureBegin: (index: number, mode: GestureMode) => void;
  onGestureMove: (index: number, placement: OverlayPlacement) => void;
  onGestureEnd: () => void;
  onBaseGestureBegin: (widget: BaseWidget, mode: BaseGestureMode) => void;
  onBaseGestureMove: (widget: BaseWidget, placement: BasePlacement) => void;
  onBaseGestureEnd: () => void;
}

export default function SceneStage({
  previewUrl,
  overlays,
  basePlacements,
  selected,
  selectedBase,
  onSelect,
  onSelectBase,
  onGestureBegin,
  onGestureMove,
  onGestureEnd,
  onBaseGestureBegin,
  onBaseGestureMove,
  onBaseGestureEnd,
}: SceneStageProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  // Gesture bookkeeping: the ref is the source of truth for the drag
  // callbacks (no stale closures); state only flags the wrapper for tests.
  const gestureRef = useRef<GestureState | null>(null);
  const baseGestureRef = useRef<BaseGestureState | null>(null);
  const [scale, setScale] = useState(FALLBACK_SCALE);
  const [dragging, setDragging] = useState(false);
  const [image, status] = useImage(previewUrl);

  // Size the Stage from the CONTAINER, never from a hard constant: the same
  // +48 px drag must mean +0.2 at any preview size (S2-T9 rect-driven rule).
  // jsdom reports an empty rect at mount, so the fallback keeps a sane scale
  // and gesture math re-measures the real rect at dragstart.
  useLayoutEffect(() => {
    const measure = (): void => {
      const element = wrapperRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setScale(rect.width / GLASS_WIDTH);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const startGesture = (
    index: number,
    mode: GestureMode,
    event: { evt: Event }
  ): void => {
    const pointer = event.evt as MouseEvent;
    if (typeof pointer.button === "number" && pointer.button !== 0) return; // primary only
    if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return;
    const element = wrapperRef.current;
    const overlay = overlays[index];
    if (!element || !overlay) return;
    // No measurable stage (no layout yet): px->unit is undefined, so fall
    // back to selection-only instead of committing NaN.
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    // The rect is captured ONCE: deltas never re-measure mid-gesture.
    gestureRef.current = {
      index,
      mode,
      startClientX: pointer.clientX,
      startClientY: pointer.clientY,
      clientX: pointer.clientX,
      clientY: pointer.clientY,
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
    };
    setDragging(true);
    onGestureBegin(index, mode);
  };

  const moveGesture = (event: { evt: Event }): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const pointer = event.evt as MouseEvent;
    if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return;
    const next: GestureState = {
      ...gesture,
      clientX: pointer.clientX,
      clientY: pointer.clientY,
    };
    gestureRef.current = next;
    onGestureMove(next.index, gesturePlacement(next));
  };

  const endGesture = (): void => {
    if (!gestureRef.current) return; // a plain tap never began one
    gestureRef.current = null;
    setDragging(false);
    onGestureEnd();
  };

  const startBaseGesture = (
    widget: BaseWidget,
    mode: BaseGestureMode,
    event: { evt: Event }
  ): void => {
    const pointer = event.evt as MouseEvent;
    if (typeof pointer.button === "number" && pointer.button !== 0) return;
    if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return;
    const element = wrapperRef.current;
    const placement = basePlacements[widget];
    if (!element || !placement) return;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    baseGestureRef.current = {
      widget,
      mode,
      startClientX: pointer.clientX,
      startClientY: pointer.clientY,
      clientX: pointer.clientX,
      clientY: pointer.clientY,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      origin: placement,
    };
    setDragging(true);
    onBaseGestureBegin(widget, mode);
  };

  const moveBaseGesture = (event: { evt: Event }): void => {
    const gesture = baseGestureRef.current;
    if (!gesture) return;
    const pointer = event.evt as MouseEvent;
    if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return;
    const next = {
      ...gesture,
      clientX: pointer.clientX,
      clientY: pointer.clientY,
    };
    baseGestureRef.current = next;
    onBaseGestureMove(next.widget, baseGesturePlacement(next));
  };

  const endBaseGesture = (): void => {
    if (!baseGestureRef.current) return;
    baseGestureRef.current = null;
    setDragging(false);
    onBaseGestureEnd();
  };

  // Empty space deselects; a child hit sets cancelBubble and never lands here.
  const handleStageMouseDown = (event: { target: Konva.Node }): void => {
    if (event.target === event.target.getStage()) {
      onSelect(null);
      onSelectBase(null);
    }
  };

  const handleOverlayMouseDown =
    (index: number) =>
    (event: { target: Konva.Node; cancelBubble?: boolean }): void => {
      event.cancelBubble = true;
      onSelect(index);
    };

  const handleBaseMouseDown =
    (widget: BaseWidget) =>
    (event: { target: Konva.Node; cancelBubble?: boolean }): void => {
      event.cancelBubble = true;
      onSelectBase(widget);
    };

  return (
    <div
      ref={wrapperRef}
      className="relative h-full aspect-[240/427]"
      data-testid="scene-stage"
      role="img"
      aria-label="Scene preview"
      aria-describedby="scene-stage-guides-description"
      data-preview-src={previewUrl}
      data-image-status={status ?? "not-loaded"}
      data-dragging={dragging ? "true" : null}
    >
      <p id="scene-stage-guides-description" className="sr-only">
        Labeled dashed guides mark where the panel renders real Spotify content.
        The editor does not have live Spotify content, so the guides do not
        preview the current track.
      </p>
      <Stage
        ref={(node) => {
          stageRef.current = node;
          sceneStageRef.current = node;
        }}
        width={GLASS_WIDTH * scale}
        height={GLASS_HEIGHT * scale}
        scaleX={scale}
        scaleY={scale}
        onMouseDown={handleStageMouseDown}
      >
        {/* Base layer: the engine's own PNG (WYSIWYG truth), never hit-tested. */}
        <Layer listening={false}>
          {image ? (
            <KonvaImage
              id="engine-preview"
              image={image}
              width={GLASS_WIDTH}
              height={GLASS_HEIGHT}
            />
          ) : null}
        </Layer>
        {/* Base Spotify content guides: deliberately BELOW overlay guidance. */}
        <Layer id="base-placement-guides">
          {BASE_WIDGET_KEYS.map((widget) => {
            const placement = basePlacements[widget];
            const box = baseGuideBox(widget, placement);
            const centerX = placement.x * GLASS_WIDTH;
            const centerY = placement.y * GLASS_HEIGHT;
            const isSelected = selectedBase === widget;
            const resizeHandle = baseResizeHandle(widget, placement, box);
            const centeredLabel = widget === "cover" || widget === "progress";
            const labelWidth = centeredLabel ? 176 : box.width - 12;
            const labelX = centeredLabel ? centerX - labelWidth / 2 : centerX - box.width / 2 + 6;
            const labelY =
              box.height < 24 ? centerY - 24 : centerY - box.height / 2 + 4;
            return (
              <Group key={`base-${widget}`}>
                <Rect
                  id={`base-${widget}`}
                  x={centerX}
                  y={centerY}
                  offsetX={box.width / 2}
                  offsetY={box.height / 2}
                  width={box.width}
                  height={box.height}
                  cornerRadius={4}
                  stroke={isSelected ? "#38bdf8" : "#f8fafc"}
                  strokeWidth={isSelected ? 3 : 2}
                  dash={[8, 6]}
                  draggable
                  onDragStart={(event) => startBaseGesture(widget, "move", event)}
                  onDragMove={moveBaseGesture}
                  onDragEnd={endBaseGesture}
                  onMouseDown={handleBaseMouseDown(widget)}
                />
                <Text
                  id={`base-label-${widget}`}
                  x={labelX}
                  y={labelY}
                  width={labelWidth}
                  text={`${BASE_WIDGET_META[widget].label} · panel content`}
                  align={centeredLabel ? "center" : "left"}
                  fontSize={12}
                  fontStyle="bold"
                  fill="#f8fafc"
                  stroke="#020617"
                  strokeWidth={3}
                  listening={false}
                />
                {isSelected && (
                  <Circle
                    id={`base-resize-handle-${widget}`}
                    x={resizeHandle.x}
                    y={resizeHandle.y}
                    radius={HANDLE_RADIUS}
                    fill="#ffffff"
                    stroke="#2563eb"
                    strokeWidth={2}
                    draggable
                    onDragStart={(event) =>
                      startBaseGesture(widget, "resize", event)
                    }
                    onDragMove={moveBaseGesture}
                    onDragEnd={endBaseGesture}
                    onMouseDown={handleBaseMouseDown(widget)}
                  />
                )}
              </Group>
            );
          })}
        </Layer>
        {/* Overlay guidance layer: derived from committed 0-1 scene values only. */}
        <Layer id="overlay-placement-guides">
          {overlays.map((overlay, index) => {
            const centerX = overlay.x * GLASS_WIDTH;
            const centerY = overlay.y * GLASS_HEIGHT;
            const boxHeight = overlay.size * GLASS_HEIGHT;
            const boxWidth = boxHeight * GUIDE_BOX_ASPECT;
            const isSelected = selected === index;
            const handles = handlePositions(overlay);
            return (
              <Group key={`overlay-${index}`}>
                <Text
                  id={`overlay-${index}`}
                  x={centerX}
                  y={centerY}
                  offsetX={boxWidth / 2}
                  offsetY={boxHeight / 2}
                  // Center-rotation parity with HEAD's CSS rotate(Ndeg):
                  // offsetX/Y make the node's origin its CENTER, so the
                  // guide spins about the same point transform-origin:50%
                  // 50% did — selected OR not (same pattern as the Rect).
                  rotation={overlay.rotation}
                  width={boxWidth}
                  height={boxHeight}
                  align="center"
                  verticalAlign="middle"
                  wrap="none"
                  fontSize={boxHeight}
                  fill={overlay.color}
                  // gpu-temp has no renderer until S4-T15: an honest empty
                  // box, never phantom data.
                  text={overlay.kind === "text" ? overlay.text : ""}
                  draggable
                  onDragStart={(event) => startGesture(index, "move", event)}
                  onDragMove={moveGesture}
                  onDragEnd={endGesture}
                  onMouseDown={handleOverlayMouseDown(index)}
                />
                {isSelected && (
                  <Rect
                    x={centerX}
                    y={centerY}
                    offsetX={boxWidth / 2}
                    offsetY={boxHeight / 2}
                    width={boxWidth}
                    height={boxHeight}
                    rotation={overlay.rotation}
                    stroke="#ffffff"
                    strokeWidth={2}
                    dash={[8, 6]}
                    listening={false}
                  />
                )}
                {isSelected && (
                  <>
                    <Circle
                      id={`resize-handle-${index}`}
                      x={handles.resize.x}
                      y={handles.resize.y}
                      radius={HANDLE_RADIUS}
                      fill="#ffffff"
                      stroke="#2563eb"
                      strokeWidth={2}
                      draggable
                      onDragStart={(event) => startGesture(index, "resize", event)}
                      onDragMove={moveGesture}
                      onDragEnd={endGesture}
                      onMouseDown={handleOverlayMouseDown(index)}
                    />
                    <Circle
                      id={`rotate-handle-${index}`}
                      x={handles.rotate.x}
                      y={handles.rotate.y}
                      radius={HANDLE_RADIUS}
                      fill="#ffffff"
                      stroke="#7c3aed"
                      strokeWidth={2}
                      draggable
                      onDragStart={(event) => startGesture(index, "rotate", event)}
                      onDragMove={moveGesture}
                      onDragEnd={endGesture}
                      onMouseDown={handleOverlayMouseDown(index)}
                    />
                  </>
                )}
              </Group>
            );
          })}
        </Layer>
      </Stage>
    </div>
  );
}
