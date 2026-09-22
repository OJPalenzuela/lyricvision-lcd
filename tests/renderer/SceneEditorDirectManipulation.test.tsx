import { useState } from "react";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SceneEditor from "@/components/SceneEditor";
import type { LyricvisionBridge, StoredSettings } from "@/lib/bridge";
import {
  DEFAULT_SCENE,
  SCENE_OVERLAYS_CAP,
  type MediaBackgroundKind,
  type Scene,
  type TextOverlay,
} from "@/lib/scene";

const requireNative = createRequire(import.meta.url);
interface HardeningGate {
  validateScene(input: unknown): { ok: boolean; field?: string; error?: string };
}
const hardening = requireNative("../../src/hardening.js") as HardeningGate;

/**
 * jsdom ships no PointerEvent: give React and user-event a constructor so
 * pointerdown/pointermove/pointerup carry clientX/clientY/pointerId like a
 * real browser. Installed at module scope, before any render.
 */
if (typeof window.PointerEvent === "undefined") {
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEventStub as unknown as typeof PointerEvent;
}

/**
 * jsdom implements no pointer-capture API. The component guards both calls
 * with `?.`, but stubbing them lets the tests PROVE the capture path runs
 * (setPointerCapture on pointerdown, releasePointerCapture on release)
 * instead of silently skipping it.
 */
const setPointerCaptureMock = vi.fn((_pointerId: number) => {});
const releasePointerCaptureMock = vi.fn((_pointerId: number) => {});
beforeAll(() => {
  Element.prototype.setPointerCapture = setPointerCaptureMock;
  Element.prototype.releasePointerCapture = releasePointerCaptureMock;
  Element.prototype.hasPointerCapture = () => true;
});

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
 * NON-DEGENERATE geometry stub: the stage (preview <img> wrapper) is mapped
 * to a 240x427 rect at (100, 50) — exactly the engine's preview size, so
 * 1 CSS px = 1/240 of the glass width. A zero-size rect would make every
 * pointer->unit conversion NaN or 0, which the exact-value assertions below
 * (x=0.7, size=0.2, rotation=90) would catch — the tests cannot pass vacuously.
 */
const STAGE_RECT = { left: 100, top: 50, width: 240, height: 427 } as const;
/** Center of the stubbed stage = normalized (0.5, 0.5) in glass space. */
const CENTER = { clientX: 220, clientY: 263.5 };

function stubStageRect(): HTMLElement {
  const img = screen.getByAltText("Scene preview");
  const stage = img.parentElement;
  if (!stage) throw new Error("preview stage not found");
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
  await screen.findByAltText("Scene preview", {}, { timeout: 3000 });
}

function pdown(el: Element, coords = CENTER): void {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, ...coords });
}

function pmove(target: Window | Element, coords: { clientX: number; clientY: number }): void {
  fireEvent.pointerMove(target, { pointerId: 1, ...coords });
}

function pup(target: Window | Element, coords: { clientX: number; clientY: number }): void {
  fireEvent.pointerUp(target, { pointerId: 1, ...coords });
}

describe("S2-T9 drag to move", () => {
  it("commits a 0-1 position that passes validateScene and keeps the inspector in sync", async () => {
    const { bridge, onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    stubStageRect();

    const box = screen.getByRole("button", { name: "Select overlay 1" });
    pdown(box);
    // +48 px on a 240 px-wide stage = +0.2 in x; y untouched.
    pmove(window, { clientX: 268, clientY: 263.5 });
    pup(window, { clientX: 268, clientY: 263.5 });

    const scene = lastScene(onChange);
    expect(scene.overlays[0].x).toBeCloseTo(0.7, 6);
    expect(scene.overlays[0].y).toBe(0.5);
    expect(hardening.validateScene(scene).ok).toBe(true);

    // Numeric inspector reads back exactly what the drag committed.
    const x = screen.getByLabelText("Overlay X (0-1)") as HTMLInputElement;
    const y = screen.getByLabelText("Overlay Y (0-1)") as HTMLInputElement;
    await waitFor(() => expect(Number(x.value)).toBeCloseTo(0.7, 6));
    expect(y.value).toBe("0.5");

    // Capture strategy really ran (stubs installed in beforeAll).
    expect(setPointerCaptureMock).toHaveBeenCalledWith(1);
    expect(releasePointerCaptureMock).toHaveBeenCalledWith(1);
  });

  it("clamps a drag past every boundary so release never produces a rejected scene", async () => {
    const { onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    stubStageRect();
    const box = screen.getByRole("button", { name: "Select overlay 1" });

    // Far beyond the top-left corner.
    pdown(box);
    pmove(window, { clientX: -2000, clientY: -2000 });
    pup(window, { clientX: -2000, clientY: -2000 });
    const low = lastScene(onChange);
    expect(low.overlays[0].x).toBe(0);
    expect(low.overlays[0].y).toBe(0);
    expect(hardening.validateScene(low).ok).toBe(true);

    // Far beyond the bottom-right corner.
    pdown(box);
    pmove(window, { clientX: 4000, clientY: 4000 });
    pup(window, { clientX: 4000, clientY: 4000 });
    const high = lastScene(onChange);
    expect(high.overlays[0].x).toBe(1);
    expect(high.overlays[0].y).toBe(1);
    expect(hardening.validateScene(high).ok).toBe(true);
  });
});

describe("S2-T9 resize handle", () => {
  it("commits size within [0,1], clamps both edges, and syncs the inspector", async () => {
    const { onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    stubStageRect();
    const handle = screen.getByRole("button", { name: "Resize overlay 1" });

    // +24 px x and +42.7 px y on 240x427 = +0.1 and +0.1 -> size 0.1+0.1 = 0.2.
    pdown(handle);
    pmove(window, { clientX: 244, clientY: 306.2 });
    pup(window, { clientX: 244, clientY: 306.2 });
    const grown = lastScene(onChange);
    expect(grown.overlays[0].size).toBeCloseTo(0.2, 6);
    expect(grown.overlays[0].size).toBeGreaterThanOrEqual(0);
    expect(grown.overlays[0].size).toBeLessThanOrEqual(1);
    expect(hardening.validateScene(grown).ok).toBe(true);
    const size = screen.getByLabelText("Overlay size (0-1)") as HTMLInputElement;
    await waitFor(() => expect(Number(size.value)).toBeCloseTo(0.2, 6));

    // Collapsed hard inward: clamped at the gesture floor, never <= 0 or NaN.
    pdown(handle);
    pmove(window, { clientX: -3000, clientY: -3000 });
    pup(window, { clientX: -3000, clientY: -3000 });
    const shrunk = lastScene(onChange);
    expect(shrunk.overlays[0].size).toBeGreaterThanOrEqual(0.01);
    expect(shrunk.overlays[0].size).toBeLessThanOrEqual(1);
    expect(hardening.validateScene(shrunk).ok).toBe(true);

    // Blown hard outward: clamped at 1.
    pdown(handle);
    pmove(window, { clientX: 5000, clientY: 5000 });
    pup(window, { clientX: 5000, clientY: 5000 });
    expect(lastScene(onChange).overlays[0].size).toBe(1);
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
  });
});

describe("S2-T9 rotation handle", () => {
  it("commits rotation within the declared -360..360 range and clamps both edges", async () => {
    const { onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    stubStageRect();
    const handle = screen.getByRole("button", { name: "Rotate overlay 1" });
    const rotation = screen.getByLabelText(
      "Overlay rotation (degrees)"
    ) as HTMLInputElement;

    // Start straight above the anchor (angle 0), move to the right of the
    // anchor: delta = +90 degrees (clockwise-positive, like the engine).
    pdown(handle, { clientX: 220, clientY: 100 });
    pmove(window, { clientX: 380, clientY: 263.5 });
    pup(window, { clientX: 380, clientY: 263.5 });
    const turned = lastScene(onChange);
    expect(turned.overlays[0].rotation).toBeCloseTo(90, 9);
    expect(turned.overlays[0].rotation).toBeGreaterThanOrEqual(-360);
    expect(turned.overlays[0].rotation).toBeLessThanOrEqual(360);
    expect(hardening.validateScene(turned).ok).toBe(true);
    await waitFor(() => expect(Number(rotation.value)).toBeCloseTo(90, 9));

    // Origin 300 + delta 180 would be 480: must clamp to 360, not reject.
    fireEvent.change(rotation, { target: { value: "300" } });
    pdown(handle, { clientX: 220, clientY: 100 });
    pmove(window, { clientX: 220, clientY: 490.5 }); // delta = +180
    pup(window, { clientX: 220, clientY: 490.5 });
    expect(lastScene(onChange).overlays[0].rotation).toBe(360);
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);

    // Origin -300 + delta -80 would be -380: must clamp to -360.
    fireEvent.change(rotation, { target: { value: "-300" } });
    pdown(handle, { clientX: 220, clientY: 100 });
    pmove(window, { clientX: 23, clientY: 228.8 }); // delta = -80
    pup(window, { clientX: 23, clientY: 228.8 });
    expect(lastScene(onChange).overlays[0].rotation).toBe(-360);
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
  });
});

describe("S2-T9 ghost contract (0 ms CSS ghost, PNG on release)", () => {
  it("updates the ghost with zero preview calls during the gesture and exactly one on release", async () => {
    const { bridge, onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    stubStageRect();

    const box = screen.getByRole("button", { name: "Select overlay 1" });
    const wrapper = box.parentElement;
    expect(wrapper).not.toBeNull();
    if (!wrapper) throw new Error("wrapper missing");

    pdown(box, CENTER);
    expect(wrapper.getAttribute("data-dragging")).toBe("true");

    pmove(window, { clientX: 268, clientY: 263.5 });
    // Ghost moved (CSS transform), scene untouched, zero preview traffic:
    expect(onChange).not.toHaveBeenCalled();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    expect(wrapper.style.transform).toMatch(/translate\(4[5-9](\.\d+)?px, 0px\)/);

    pmove(window, { clientX: 316, clientY: 263.5 });
    expect(onChange).not.toHaveBeenCalled();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    expect(wrapper.style.transform).toMatch(/translate\(9[0-9](\.\d+)?px, 0px\)/);

    // Hold the gesture open well past the 250 ms preview debounce. The ghost
    // may only animate its CSS transform while a finger is down: a scene setter
    // on the move path would re-arm schedulePreview and a preview would fire
    // mid-gesture, so this window is what makes "0 calls during the gesture"
    // an observed result rather than a synchronous snapshot taken before any
    // timer had a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(onChange).not.toHaveBeenCalled();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);

    pup(window, { clientX: 316, clientY: 263.5 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);

    // Release: exactly ONE engine preview request fires (250 ms debounce).
    await waitFor(() => expect(bridge.previewScene).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(bridge.previewScene).toHaveBeenCalledTimes(2);

    // Ghost is gone; the wrapper is back to its static transform.
    expect(wrapper.getAttribute("data-dragging")).toBeNull();
    expect(wrapper.style.transform).toBe("translate(-50%, -50%)");
  });

  it("does not fire any preview for a plain selection tap", async () => {
    const { bridge, onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    stubStageRect();

    const box = screen.getByRole("button", { name: "Select overlay 1" });
    pdown(box);
    pup(box, CENTER);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onChange).not.toHaveBeenCalled();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Select overlay 1" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});

describe("S2-T9 selection", () => {
  it("keeps preview selection, list selection and the inspector in sync; empty click deselects; keyboard works without a pointer", async () => {
    const { user } = setup(
      sceneWithOverlays([textOverlay("One"), textOverlay("Two", { x: 0.25 })])
    );
    await previewReady();
    stubStageRect();

    // List -> preview.
    await user.click(screen.getByRole("button", { name: "Overlay 2" }));
    expect(screen.getByRole("button", { name: "Select overlay 2" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Select overlay 1" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByLabelText("Overlay X (0-1)")).toHaveValue("0.25");

    // Preview -> list (pointer).
    await user.click(screen.getByRole("button", { name: "Select overlay 1" }));
    expect(screen.getByRole("button", { name: "Overlay 1" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByLabelText("Overlay X (0-1)")).toHaveValue("0.5");

    // Keyboard-only selection: focus + Enter, no pointer involved.
    const box2 = screen.getByRole("button", { name: "Select overlay 2" });
    box2.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Overlay 2" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByLabelText("Overlay X (0-1)")).toHaveValue("0.25");

    // Empty-space click deselects: inspector goes away, no row stays pressed.
    const stage = stubStageRect();
    expect(stage.children.length).toBe(2); // [engine <img>, overlay layer]
    const layer = stage.children[1];
    fireEvent.pointerDown(layer);
    expect(screen.queryByLabelText("Overlay text")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Overlay rotation (degrees)")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overlay 1" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByRole("button", { name: "Overlay 2" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByRole("button", { name: "Select overlay 1" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });
});

describe("S2-T9 overlay cap under drag", () => {
  it("keeps SCENE_OVERLAYS_CAP enforced: dragging at the cap never appends an overlay", async () => {
    const full = sceneWithOverlays(
      Array.from({ length: SCENE_OVERLAYS_CAP }, (_, i) => textOverlay(`T${i}`))
    );
    const { onChange } = setup(full);
    await previewReady();
    stubStageRect();
    expect(screen.getByRole("button", { name: "Add text overlay" })).toBeDisabled();

    const box = screen.getByRole("button", { name: "Select overlay 1" });
    pdown(box);
    pmove(window, { clientX: 280, clientY: 263.5 });
    pup(window, { clientX: 280, clientY: 263.5 });

    const scene = lastScene(onChange);
    expect(scene.overlays).toHaveLength(SCENE_OVERLAYS_CAP);
    expect(scene.overlays[0].x).toBeCloseTo(0.75, 6);
    expect(hardening.validateScene(scene).ok).toBe(true);
  });
});

describe("S2-T9 inspector edit then drag", () => {
  it("takes the drag origin from the freshly committed inspector value, not a stale draft", async () => {
    const { onChange } = setup(sceneWithOverlays([textOverlay("Hi")]));
    await previewReady();
    stubStageRect();

    // Commit a new x through the inspector first: the gesture must read its
    // origin from THIS scene, not from the mount-time value (0.5).
    const x = screen.getByLabelText("Overlay X (0-1)") as HTMLInputElement;
    fireEvent.change(x, { target: { value: "0.25" } });
    expect(lastScene(onChange).overlays[0].x).toBe(0.25);
    expect(x.value).toBe("0.25");

    // +60 px on the 240 px stage = +0.25, so 0.25 + 0.25 = 0.5. A stale
    // origin of 0.5 would commit 0.75 instead — both failure modes (stale
    // origin, gesture never running and leaving 0.25) miss this assertion.
    const box = screen.getByRole("button", { name: "Select overlay 1" });
    pdown(box);
    pmove(window, { clientX: 280, clientY: 263.5 });
    pup(window, { clientX: 280, clientY: 263.5 });

    const scene = lastScene(onChange);
    expect(scene.overlays[0].x).toBeCloseTo(0.5, 6);
    expect(scene.overlays[0].y).toBe(0.5);
    expect(hardening.validateScene(scene).ok).toBe(true);
    // The inspector reads back the committed drag value.
    await waitFor(() => expect(Number(x.value)).toBeCloseTo(0.5, 6));
  });
});
