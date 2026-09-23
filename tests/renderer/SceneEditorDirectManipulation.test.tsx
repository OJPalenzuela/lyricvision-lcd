import { useState } from "react";
import { act } from "react";
import { createRequire } from "node:module";
import { describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type Konva from "konva";
import type { ReactNode } from "react";

// jsdom canvas / Image seams MUST be installed before any Konva render.
// Scope is tests-only and documented in that module (see its header).
import "./konvaJsdomShims";
import { sceneStageRef } from "@/components/SceneStage";
import SceneEditor from "@/components/SceneEditor";
import {
  BASE_WIDGET_KEYS,
  type Scene,
  type TextOverlay,
} from "@/lib/scene";
import {
  PORTRAIT_HEIGHT,
  PORTRAIT_WIDTH,
} from "@/lib/basePlacements";
import type { LyricvisionBridge, StoredSettings } from "@/lib/bridge";
import {
  DEFAULT_SCENE,
  SCENE_OVERLAYS_CAP,
  type MediaBackgroundKind,
} from "@/lib/scene";

// motion/react (S7-T19 panel-swap animation) mocked to a passthrough so
// jsdom needs no Web Animations API: children render into a plain <div>.
// Honest coverage, not a bypass — every query below reads the REAL
// controls through this wrapper; if it swallowed content, they'd fail.
vi.mock("motion/react", () => {
  type PanelProps = {
    children?: ReactNode;
    className?: string;
    role?: string;
    "aria-label"?: string;
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
    transition?: unknown;
  };
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    motion: {
      div: ({
        children,
        className,
        role,
        "aria-label": ariaLabel,
      }: PanelProps) => (
        <div className={className} role={role} aria-label={ariaLabel}>
          {children}
        </div>
      ),
    },
  };
});

/** S7-T19 rail navigation: jump to a scene section by its rail label. */
const goSection = (name: "Fondo" | "Capas" | "Propiedades"): void => {
  fireEvent.click(screen.getByRole("button", { name }));
};

const requireNative = createRequire(import.meta.url);
interface HardeningGate {
  validateScene(input: unknown): { ok: boolean; field?: string; error?: string };
}
const hardening = requireNative("../../src/hardening.js") as HardeningGate;

const DEFAULT_SETTINGS: StoredSettings = {
  spotifyClientId: "",
  lcdFps: 10,
  syncOffsetMs: 0,
  layout: "lyrics",
  serial: "",
  runAtStartup: false,
  scene: DEFAULT_SCENE,
};

interface StubBridge extends LyricvisionBridge {
  previewScene: Mock<(scene: Scene) => Promise<string>>;
  importMedia: Mock<(kind: MediaBackgroundKind) => Promise<string | null>>;
}

function makeBridge(): StubBridge {
  return {
    getSettings: vi.fn(async () => ({
      settings: DEFAULT_SETTINGS,
      spotify: { connected: false },
      startupSupported: true,
    })),
    saveSettings: vi.fn(async () => ({ rejected: [] as string[] })),
    connectSpotify: vi.fn(async () => ({ started: true })),
    listDisplays: vi.fn(async () => []),
    minimize: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    refresh: vi.fn(async () => ({ ok: true })),
    setStartup: vi.fn(async () => ({ enabled: true })),
    exportDiagnostics: vi.fn(async () => ({ path: "diag.json" })),
    onPlayerState: vi.fn(() => vi.fn()),
    onSpotifyAuth: vi.fn(() => vi.fn()),
    previewScene: vi.fn(async () => "data:image/png;base64,aGVsbG8="),
    importMedia: vi.fn(async () => null),
  };
}

function Harness({ initial, onChange }: { initial: Scene; onChange: (scene: Scene) => void }) {
  const [scene, setScene] = useState(initial);
  return (
    <SceneEditor
      scene={scene}
      onSceneChange={(next) => {
        setScene(next);
        onChange(next);
      }}
      onReset={async () => {}}
    />
  );
}

function setup(initial: Scene) {
  const bridge = makeBridge();
  window.lyricvision = bridge;
  const onChange = vi.fn<(scene: Scene) => void>();
  const user = userEvent.setup();
  render(<Harness initial={initial} onChange={onChange} />);
  return { bridge, onChange, user };
}

function lastScene(onChange: Mock<(scene: Scene) => void>): Scene {
  return onChange.mock.calls[onChange.mock.calls.length - 1][0];
}

function textOverlay(text: string, overrides: Partial<TextOverlay> = {}): TextOverlay {
  return {
    kind: "text",
    text,
    x: 0.5,
    y: 0.5,
    size: 0.1,
    rotation: 0,
    color: "#ffffff",
    ...overrides,
  };
}

function sceneWithOverlays(overlays: TextOverlay[]): Scene {
  return { ...DEFAULT_SCENE, overlays };
}

/**
 * NON-DEGENERATE geometry stub: the stage (the Konva wrapper div) is mapped
 * to a 240x427 rect at (100, 50) — exactly the engine's preview size, so
 * 1 CSS px = 1/240 of the glass width. A zero-size rect would make every
 * pointer->unit conversion NaN or 0, which the exact-value assertions below
 * (x=0.7, size=0.2, rotation=90) would catch — the tests cannot pass vacuously.
 *
 * S7-T21: the stage re-measures its OWN rect at gesture start (jsdom reports
 * 0 at mount), so stubbing the wrapper after render is the honest seam.
 */
const STAGE_RECT = { left: 100, top: 50, width: 240, height: 427 } as const;
/** Center of the stubbed stage = normalized (0.5, 0.5) in glass space. */
const CENTER = { clientX: 220, clientY: 263.5 };

function stageEl(): HTMLElement {
  return screen.getByTestId("scene-stage");
}

function stubStageRect(): HTMLElement {
  const stage = stageEl();
  stage.getBoundingClientRect = () =>
    ({
      ...STAGE_RECT,
      right: STAGE_RECT.left + STAGE_RECT.width,
      bottom: STAGE_RECT.top + STAGE_RECT.height,
      x: STAGE_RECT.left,
      y: STAGE_RECT.top,
      toJSON: () => ({}),
    }) as DOMRect;
  return stage;
}

async function previewReady(): Promise<void> {
  await screen.findByRole("img", { name: "Scene preview" }, { timeout: 3000 });
}

/**
 * jsdom seam (documented in SceneStage.tsx): Konva's hit-graph needs a real
 * canvas backend, which jsdom does not have, so node gestures are driven
 * through Konva's OWN event API on the node the stage reports — never through
 * fabricated hit pixels. `sceneStageRef` is the module-level stage handle.
 */
function konvaNode(id: string): Konva.Node {
  const node = sceneStageRef.current?.findOne(`#${id}`);
  if (!node) throw new Error(`Konva node #${id} not found`);
  return node;
}

interface Point {
  clientX: number;
  clientY: number;
}

function fireDrag(
  kind: "dragstart" | "dragmove" | "dragend",
  id: string,
  coords: Point
): void {
  const node = konvaNode(id);
  act(() => {
    node.fire(kind, { evt: new MouseEvent(kind, coords) });
  });
}

/** Empty-space deselect: a REAL DOM event on the stage's content element. */
function clickEmptySpace(coords: Point): void {
  const content = stageEl().querySelector(".konvajs-content");
  if (!content) throw new Error("stage content element not found");
  fireEvent.mouseDown(content, coords);
  fireEvent.mouseUp(content, coords);
}

interface LogicalRect {
  label: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface LogicalPoint {
  x: number;
  y: number;
}

function logicalNodeRect(id: string, label: string): LogicalRect {
  const node = konvaNode(id);
  const centerX = Number(node.getAttr("x"));
  const centerY = Number(node.getAttr("y"));
  const width = Number(node.getAttr("width"));
  const height = Number(node.getAttr("height"));
  const rotation = Number(node.getAttr("rotation") ?? 0);
  if (![centerX, centerY, width, height, rotation].every(Number.isFinite)) {
    throw new Error(`${label} has non-finite geometry`);
  }
  const radians = (rotation * Math.PI) / 180;
  const extentX =
    (Math.abs(width * Math.cos(radians)) +
      Math.abs(height * Math.sin(radians))) /
    2;
  const extentY =
    (Math.abs(width * Math.sin(radians)) +
      Math.abs(height * Math.cos(radians))) /
    2;
  return {
    label,
    left: centerX - extentX,
    top: centerY - extentY,
    right: centerX + extentX,
    bottom: centerY + extentY,
  };
}

function contains(rect: LogicalRect, point: LogicalPoint): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function deriveEmptyPoint(scene: Scene): {
  logical: LogicalPoint;
  client: Point;
  blocked: LogicalRect[];
} {
  const blocked = [
    ...BASE_WIDGET_KEYS.map((widget) =>
      logicalNodeRect(`base-${widget}`, `base:${widget}`)
    ),
    ...scene.overlays.map((_, index) =>
      logicalNodeRect(`overlay-${index}`, `overlay:${index}`)
    ),
  ];
  const xEdges = new Set<number>([0, PORTRAIT_WIDTH]);
  const yEdges = new Set<number>([0, PORTRAIT_HEIGHT]);
  for (const rect of blocked) {
    if (rect.right > 0 && rect.left < PORTRAIT_WIDTH) {
      xEdges.add(Math.max(0, rect.left));
      xEdges.add(Math.min(PORTRAIT_WIDTH, rect.right));
    }
    if (rect.bottom > 0 && rect.top < PORTRAIT_HEIGHT) {
      yEdges.add(Math.max(0, rect.top));
      yEdges.add(Math.min(PORTRAIT_HEIGHT, rect.bottom));
    }
  }
  const xs = [...xEdges].sort((a, b) => a - b);
  const ys = [...yEdges].sort((a, b) => a - b);
  let best: { point: LogicalPoint; area: number } | undefined;
  for (let xi = 0; xi + 1 < xs.length; xi += 1) {
    for (let yi = 0; yi + 1 < ys.length; yi += 1) {
      const point = {
        x: (xs[xi] + xs[xi + 1]) / 2,
        y: (ys[yi] + ys[yi + 1]) / 2,
      };
      if (blocked.some((rect) => contains(rect, point))) continue;
      const area = (xs[xi + 1] - xs[xi]) * (ys[yi + 1] - ys[yi]);
      if (!best || area > best.area) best = { point, area };
    }
  }
  if (!best) {
    throw new Error("scene has no empty logical point inside the stage");
  }
  const scale = STAGE_RECT.width / PORTRAIT_WIDTH;
  return {
    logical: best.point,
    client: {
      clientX: STAGE_RECT.left + best.point.x * scale,
      clientY: STAGE_RECT.top + best.point.y * scale,
    },
    blocked,
  };
}

describe("S7-T21 Konva drag to move", () => {
  it("commits a 0-1 position that passes validateScene and keeps the inspector in sync", async () => {
    const { bridge, onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    stubStageRect();

    fireDrag("dragstart", "overlay-0", CENTER);
    // Gesture observability moved from a pointer-capture stub to the stage's
    // own dragging flag (the capture mechanism was deleted with the hand-
    // rolled pointer code — see the migration ledger).
    expect(stageEl().getAttribute("data-dragging")).toBe("true");
    // +48 px on a 240 px-wide stage = +0.2 in x; y untouched.
    fireDrag("dragmove", "overlay-0", { clientX: 268, clientY: 263.5 });
    expect(lastScene(onChange).overlays[0].x).toBeCloseTo(0.7, 6);
    fireDrag("dragend", "overlay-0", { clientX: 268, clientY: 263.5 });
    expect(stageEl().getAttribute("data-dragging")).toBeNull();

    const scene = lastScene(onChange);
    expect(scene.overlays[0].x).toBeCloseTo(0.7, 6);
    expect(scene.overlays[0].y).toBe(0.5);
    expect(hardening.validateScene(scene).ok).toBe(true);

    // Inspector lives in the Propiedades rail section (S7-T19): switch to
    // it before reading the drag back out.
    goSection("Propiedades");
    // Numeric inspector reads back exactly what the drag committed.
    const x = screen.getByLabelText("Overlay X (0-1)") as HTMLInputElement;
    const y = screen.getByLabelText("Overlay Y (0-1)") as HTMLInputElement;
    await waitFor(() => expect(Number(x.value)).toBeCloseTo(0.7, 6));
    expect(y.value).toBe("0.5");
  });

  it("clamps a drag past every boundary so release never produces a rejected scene", async () => {
    const { onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    stubStageRect();

    // Far beyond the top-left corner.
    fireDrag("dragstart", "overlay-0", CENTER);
    fireDrag("dragmove", "overlay-0", { clientX: -2000, clientY: -2000 });
    fireDrag("dragend", "overlay-0", { clientX: -2000, clientY: -2000 });
    const low = lastScene(onChange);
    expect(low.overlays[0].x).toBe(0);
    expect(low.overlays[0].y).toBe(0);
    expect(hardening.validateScene(low).ok).toBe(true);

    // Far beyond the bottom-right corner.
    fireDrag("dragstart", "overlay-0", CENTER);
    fireDrag("dragmove", "overlay-0", { clientX: 4000, clientY: 4000 });
    fireDrag("dragend", "overlay-0", { clientX: 4000, clientY: 4000 });
    const high = lastScene(onChange);
    expect(high.overlays[0].x).toBe(1);
    expect(high.overlays[0].y).toBe(1);
    expect(hardening.validateScene(high).ok).toBe(true);
  });
});

describe("S7-T21 resize handle", () => {
  it("commits size within [0,1], clamps both edges, and syncs the inspector", async () => {
    const { onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    stubStageRect();
    goSection("Propiedades"); // inspector lives behind the rail (S7-T19)

    // +24 px x and +42.7 px y on 240x427 = +0.1 and +0.1 -> size 0.1+0.1 = 0.2.
    fireDrag("dragstart", "resize-handle-0", CENTER);
    fireDrag("dragmove", "resize-handle-0", { clientX: 244, clientY: 306.2 });
    fireDrag("dragend", "resize-handle-0", { clientX: 244, clientY: 306.2 });
    const grown = lastScene(onChange);
    expect(grown.overlays[0].size).toBeCloseTo(0.2, 6);
    expect(grown.overlays[0].size).toBeGreaterThanOrEqual(0);
    expect(grown.overlays[0].size).toBeLessThanOrEqual(1);
    expect(hardening.validateScene(grown).ok).toBe(true);
    const size = screen.getByLabelText("Overlay size (0-1)") as HTMLInputElement;
    await waitFor(() => expect(Number(size.value)).toBeCloseTo(0.2, 6));

    // Collapsed hard inward: clamped at the gesture floor, never <= 0 or NaN.
    fireDrag("dragstart", "resize-handle-0", CENTER);
    fireDrag("dragmove", "resize-handle-0", { clientX: -3000, clientY: -3000 });
    fireDrag("dragend", "resize-handle-0", { clientX: -3000, clientY: -3000 });
    const shrunk = lastScene(onChange);
    expect(shrunk.overlays[0].size).toBeGreaterThanOrEqual(0.01);
    expect(shrunk.overlays[0].size).toBeLessThanOrEqual(1);
    expect(hardening.validateScene(shrunk).ok).toBe(true);

    // Blown hard outward: clamped at 1.
    fireDrag("dragstart", "resize-handle-0", CENTER);
    fireDrag("dragmove", "resize-handle-0", { clientX: 5000, clientY: 5000 });
    fireDrag("dragend", "resize-handle-0", { clientX: 5000, clientY: 5000 });
    expect(lastScene(onChange).overlays[0].size).toBe(1);
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
  });
});

describe("S7-T21 rotation handle", () => {
  it("commits rotation within the declared -360..360 range and clamps both edges", async () => {
    const { onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    stubStageRect();
    goSection("Propiedades"); // inspector lives behind the rail (S7-T19)
    const rotation = screen.getByLabelText(
      "Overlay rotation (degrees)"
    ) as HTMLInputElement;

    // Start straight above the anchor (angle 0), move to the right of the
    // anchor: delta = +90 degrees (clockwise-positive, like the engine).
    fireDrag("dragstart", "rotate-handle-0", { clientX: 220, clientY: 100 });
    fireDrag("dragmove", "rotate-handle-0", { clientX: 380, clientY: 263.5 });
    fireDrag("dragend", "rotate-handle-0", { clientX: 380, clientY: 263.5 });
    const turned = lastScene(onChange);
    expect(turned.overlays[0].rotation).toBeCloseTo(90, 9);
    expect(turned.overlays[0].rotation).toBeGreaterThanOrEqual(-360);
    expect(turned.overlays[0].rotation).toBeLessThanOrEqual(360);
    expect(hardening.validateScene(turned).ok).toBe(true);
    await waitFor(() => expect(Number(rotation.value)).toBeCloseTo(90, 9));

    // Origin 300 + delta 180 would be 480: must clamp to 360, not reject.
    fireEvent.change(rotation, { target: { value: "300" } });
    fireDrag("dragstart", "rotate-handle-0", { clientX: 220, clientY: 100 });
    fireDrag("dragmove", "rotate-handle-0", { clientX: 220, clientY: 490.5 }); // delta = +180
    fireDrag("dragend", "rotate-handle-0", { clientX: 220, clientY: 490.5 });
    expect(lastScene(onChange).overlays[0].rotation).toBe(360);
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);

    // Origin -300 + delta -80 would be -380: must clamp to -360.
    fireEvent.change(rotation, { target: { value: "-300" } });
    fireDrag("dragstart", "rotate-handle-0", { clientX: 220, clientY: 100 });
    fireDrag("dragmove", "rotate-handle-0", { clientX: 23, clientY: 228.8 }); // delta = -80
    fireDrag("dragend", "rotate-handle-0", { clientX: 23, clientY: 228.8 });
    expect(lastScene(onChange).overlays[0].rotation).toBe(-360);
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
  });

  it("keeps the scene rotation on the guide node of a NON-selected overlay", async () => {
    const { onChange } = setup(
      sceneWithOverlays([textOverlay("One"), textOverlay("Two", { x: 0.25 })])
    );
    await previewReady();
    stubStageRect();

    // +90 degrees through the REAL handle (overlay 1 is selected at boot),
    // so the scene — the guide's only input — carries a known rotation.
    fireDrag("dragstart", "rotate-handle-0", { clientX: 220, clientY: 100 });
    fireDrag("dragmove", "rotate-handle-0", { clientX: 380, clientY: 263.5 });
    fireDrag("dragend", "rotate-handle-0", { clientX: 380, clientY: 263.5 });
    const scene = lastScene(onChange);
    expect(scene.overlays[0].rotation).toBeCloseTo(90, 9);

    // Select overlay 2: overlay 1 becomes NON-selected and loses its
    // selection chrome — only the guide <Text> keeps id overlay-0.
    goSection("Capas");
    fireEvent.click(screen.getByRole("button", { name: "Overlay 2" }));

    // The guide Text still reports the scene rotation in degrees. HEAD's
    // CSS rotated EVERY overlay box (selected or not), so the Konva guide
    // must too — this fails if the Text's rotation prop is removed.
    expect(konvaNode("overlay-0").rotation()).toBe(scene.overlays[0].rotation);
    expect(konvaNode("overlay-0").rotation()).toBeCloseTo(90, 9);
    expect(sceneStageRef.current?.findOne("#resize-handle-0") ?? null).toBeNull();
  });
});

describe("S7-T21 gesture contract (live node values, single debounced preview)", () => {
  it("updates the node with zero preview calls during the gesture and exactly one on release", async () => {
    const { bridge, onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    stubStageRect();

    fireDrag("dragstart", "overlay-0", CENTER);
    expect(stageEl().getAttribute("data-dragging")).toBe("true");

    fireDrag("dragmove", "overlay-0", { clientX: 268, clientY: 263.5 });
    // The Konva node now shows the LIVE scene value (the old CSS ghost is
    // gone), while zero preview traffic leaves the panel untouched:
    expect(lastScene(onChange).overlays[0].x).toBeCloseTo(0.7, 6);
    expect(konvaNode("overlay-0").x()).toBeCloseTo(0.7 * 480, 6);
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);

    fireDrag("dragmove", "overlay-0", { clientX: 316, clientY: 263.5 });
    expect(lastScene(onChange).overlays[0].x).toBeCloseTo(0.9, 6);
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);

    // Hold the gesture open well past the 250 ms preview debounce. The stage
    // may only animate while a finger is down: a preview on the move path
    // would re-arm schedulePreview and fire mid-gesture, so this window is
    // what makes "0 calls during the gesture" an observed result rather than
    // a synchronous snapshot taken before any timer had a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);

    fireDrag("dragend", "overlay-0", { clientX: 316, clientY: 263.5 });
    const released = lastScene(onChange);
    expect(released.overlays[0].x).toBeCloseTo(0.9, 6);
    expect(hardening.validateScene(released).ok).toBe(true);

    // Release: exactly ONE engine preview request fires (250 ms debounce).
    await waitFor(() => expect(bridge.previewScene).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(bridge.previewScene).toHaveBeenCalledTimes(2);

    // Gesture flag is gone once the node is released.
    expect(stageEl().getAttribute("data-dragging")).toBeNull();
  });

  it("does not fire any preview for a plain selection tap", async () => {
    const { bridge, onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    stubStageRect();

    const node = konvaNode("overlay-0");
    act(() => {
      node.fire("mousedown", { evt: new MouseEvent("mousedown", CENTER) });
      node.fire("click", { evt: new MouseEvent("click", CENTER) });
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onChange).not.toHaveBeenCalled();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);

    // Selection is observable through the keyboard-accessible Capas list —
    // the canvas node itself has no DOM aria-pressed to read.
    goSection("Capas");
    expect(screen.getByRole("button", { name: "Overlay 1" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});

describe("S7-T21 selection", () => {
  it("keeps stage selection, list selection and the inspector in sync; empty click deselects; keyboard works without a pointer", async () => {
    const sceneUnderTest = sceneWithOverlays([
      textOverlay("One"),
      textOverlay("Two", { x: 0.25 }),
    ]);
    const { user } = setup(sceneUnderTest);
    await previewReady();
    stubStageRect();

    // List -> stage. The rail mounts one section at a time (TRCC-style), so
    // each assertion switches to the section that owns the control: rows live
    // in Capas, the inspector in Propiedades. The preview stage itself is
    // always mounted in the main column.
    goSection("Capas");
    await user.click(screen.getByRole("button", { name: "Overlay 2" }));
    expect(screen.getByRole("button", { name: "Overlay 2" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Overlay 1" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    goSection("Propiedades");
    expect(screen.getByLabelText("Overlay X (0-1)")).toHaveValue("0.25");

    // Stage -> list (pointer, through Konva's own event API).
    act(() => {
      konvaNode("overlay-0").fire("mousedown", {
        evt: new MouseEvent("mousedown", CENTER),
      });
    });
    goSection("Capas");
    expect(screen.getByRole("button", { name: "Overlay 1" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    goSection("Propiedades");
    expect(screen.getByLabelText("Overlay X (0-1)")).toHaveValue("0.5");

    // Keyboard-only selection: focus + Enter on the Capas row, no pointer
    // involved (the canvas exposes no focusable DOM node by design).
    // The rail shows ONE section at a time: switch back to Capas before
    // querying a row (querying it from Propiedades finds no rows at all).
    goSection("Capas");
    const row = screen.getByRole("button", { name: "Overlay 2" });
    row.focus();
    await user.keyboard("{Enter}");
    goSection("Capas");
    expect(screen.getByRole("button", { name: "Overlay 2" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    goSection("Propiedades");
    expect(screen.getByLabelText("Overlay X (0-1)")).toHaveValue("0.25");

    // Empty-space click deselects. Derive the point from the mounted scene
    // instead of guessing a client literal: base and overlay hit boxes can
    // change with the scene, and the point must still be inside the canvas.
    const derived = deriveEmptyPoint(sceneUnderTest);
    expect(derived.logical.x).toBeGreaterThan(0);
    expect(derived.logical.x).toBeLessThan(PORTRAIT_WIDTH);
    expect(derived.logical.y).toBeGreaterThan(0);
    expect(derived.logical.y).toBeLessThan(PORTRAIT_HEIGHT);
    expect(
      derived.blocked.filter((rect) => contains(rect, derived.logical))
    ).toEqual([]);
    expect(derived.client.clientX).toBeGreaterThan(STAGE_RECT.left);
    expect(derived.client.clientX).toBeLessThan(
      STAGE_RECT.left + STAGE_RECT.width
    );
    expect(derived.client.clientY).toBeGreaterThan(STAGE_RECT.top);
    expect(derived.client.clientY).toBeLessThan(
      STAGE_RECT.top + STAGE_RECT.height
    );
    clickEmptySpace(derived.client);
    expect(screen.queryByLabelText("Overlay text")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Overlay rotation (degrees)")
    ).not.toBeInTheDocument();
    goSection("Capas");
    expect(screen.getByRole("button", { name: "Overlay 1" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByRole("button", { name: "Overlay 2" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });
});

describe("S7-T21 overlay cap under drag", () => {
  it("keeps SCENE_OVERLAYS_CAP enforced: dragging at the cap never appends an overlay", async () => {
    const full = sceneWithOverlays(
      Array.from({ length: SCENE_OVERLAYS_CAP }, (_, i) => textOverlay(`T${i}`))
    );
    const { onChange } = setup(full);
    await previewReady();
    stubStageRect();
    goSection("Capas");
    expect(screen.getByRole("button", { name: "Add text overlay" })).toBeDisabled();

    fireDrag("dragstart", "overlay-0", CENTER);
    fireDrag("dragmove", "overlay-0", { clientX: 280, clientY: 263.5 });
    fireDrag("dragend", "overlay-0", { clientX: 280, clientY: 263.5 });

    const scene = lastScene(onChange);
    expect(scene.overlays).toHaveLength(SCENE_OVERLAYS_CAP);
    expect(scene.overlays[0].x).toBeCloseTo(0.75, 6);
    expect(hardening.validateScene(scene).ok).toBe(true);
  });
});

describe("S7-T21 inspector edit then drag", () => {
  it("takes the drag origin from the freshly committed inspector value, not a stale draft", async () => {
    const { onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    stubStageRect();

    // Commit a new x through the inspector first: the gesture must read its
    // origin from THIS scene, not from the mount-time value (0.5).
    goSection("Propiedades");
    const x = screen.getByLabelText("Overlay X (0-1)") as HTMLInputElement;
    fireEvent.change(x, { target: { value: "0.25" } });
    expect(lastScene(onChange).overlays[0].x).toBe(0.25);
    expect(x.value).toBe("0.25");

    // +60 px on the 240 px stage = +0.25, so 0.25 + 0.25 = 0.5. A stale
    // origin of 0.5 would commit 0.75 instead — both failure modes (stale
    // origin, gesture never running and leaving 0.25) miss this assertion.
    fireDrag("dragstart", "overlay-0", CENTER);
    fireDrag("dragmove", "overlay-0", { clientX: 280, clientY: 263.5 });
    fireDrag("dragend", "overlay-0", { clientX: 280, clientY: 263.5 });

    const scene = lastScene(onChange);
    expect(scene.overlays[0].x).toBeCloseTo(0.5, 6);
    expect(scene.overlays[0].y).toBe(0.5);
    expect(hardening.validateScene(scene).ok).toBe(true);
    // The inspector reads back the committed drag value.
    await waitFor(() => expect(Number(x.value)).toBeCloseTo(0.5, 6));
  });
});

describe("S7-T21 use-image engine preview layer", () => {
  it("mounts the preview PNG as the Konva base layer and reports the image status", async () => {
    const { bridge } = setup(sceneWithOverlays([textOverlay("Hi")]));
    const stage = await screen.findByTestId("scene-stage", {}, { timeout: 3000 });
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);

    // The src the sidecar returned is what the base layer loads.
    expect(stage.getAttribute("data-preview-src")).toBe(
      "data:image/png;base64,aGVsbG8="
    );

    // jsdom fires NO image `load` on its own — konvaJsdomShims.ts provides the
    // documented seam, so `use-image` really resolves to `loaded` here.
    await waitFor(
      () => expect(stage.getAttribute("data-image-status")).toBe("loaded"),
      { timeout: 3000 }
    );

    // ...and the base layer node exists underneath the overlay nodes.
    expect(konvaNode("engine-preview")).toBeTruthy();
    expect(konvaNode("overlay-0")).toBeTruthy();
  });
});
