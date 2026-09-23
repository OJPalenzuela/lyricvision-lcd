/**
 * S7-T22 — Layers panel (@dnd-kit sortable), react-colorful color pickers,
 * and their history/preview contracts, driven through the REAL App wiring
 * (store → props → SceneEditor), same harness as SceneEditorUndo.
 *
 * JSDOM HONESTY — read before trusting any green here:
 *  - Keyboard drag: REAL events. Real keydown/keyup are dispatched on the
 *    real drag-handle element and @dnd-kit's KeyboardSensor runs for real.
 *    The one fabrication is LAYOUT: jsdom reports zero-size rects, so
 *    `Element.prototype.getBoundingClientRect` is shimmed below to
 *    synthesize a vertical stack for `<li>` rows (dnd-kit measures
 *    droppables and its keyboard coordinate getter needs relative
 *    geometry). Only `<li>` inside a `<UL>` is affected; everything else
 *    keeps jsdom's default rect. Pointer-driven reordering is NOT claimed
 *    as covered — no real pointer capture / hit geometry exists in jsdom.
 *  - Color swatch gesture: gesture BOUNDARIES (pointerdown on the wrapper
 *    and pointerup reaching the window listener) are REAL DOM events
 *    through React's real handlers. react-colorful's internal geometry
 *    (getBoundingClientRect → HSV math) cannot run in jsdom, so continuous
 *    change values are injected through the `colorPickerChangeSeam` module
 *    seam — the same precedent as `sceneStageRef` (bypass geometry only;
 *    the real onChange prop chain, owner-tagged coalescing, store commits,
 *    history and the debounced preview are all exercised for real).
 *    NO end-to-end pointer coverage of react-colorful is claimed.
 *  - Konva: driven through `sceneStageRef` + the existing canvas shims,
 *    same as SceneEditorDirectManipulation.
 *
 * Neuter probes (see the S7-T22 report): "[P1]" = commit-once-at-dragEnd,
 * "[P2]" = beginCoalesce("color"), "[P3]" = the `snapshot === scene`
 * no-change branch, "[R1]/[R2]" = per-gesture single preview push.
 */
import { act } from "react";
import type { ReactNode } from "react";
import { afterAll, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// jsdom canvas / Image seams (S7-T21) must install before any Konva render.
import "./konvaJsdomShims";
import { colorPickerChangeSeam } from "@/components/ui/color-picker";
import { sceneStageRef } from "@/components/SceneStage";
import App from "@/App";
import type { LyricvisionBridge, StoredSettings } from "@/lib/bridge";
import { useSceneStore } from "@/lib/sceneStore";
import {
  DEFAULT_SCENE,
  SCENE_VERSION,
  type MediaBackgroundKind,
  type Scene,
  type TextOverlay,
} from "@/lib/scene";

// motion/react mocked to a passthrough (S7-T19 suites' honest mock): jsdom
// needs no Web Animations API; every query reads the REAL controls through it.
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

/* ------------------------------------------------------------------ *
 * LAYOUT FABRICATION (jsdom): synthesize a vertical stack for <li>    *
 * rows so dnd-kit's droppable measurement + keyboard coordinate       *
 * getter see relative geometry. Only <li> inside a <UL> is affected;  *
 * every other element keeps jsdom's default zero rect.                *
 * ------------------------------------------------------------------ */
const ROW_HEIGHT = 40;
const REAL_GETBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function fabricate(
  this: Element
): DOMRect {
  const parent = this.parentElement;
  if (this.tagName === "LI" && parent && parent.tagName === "UL") {
    const rows = Array.from(parent.children).filter(
      (el) => el.tagName === "LI"
    );
    const top = rows.indexOf(this) * ROW_HEIGHT;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 200,
      bottom: top + ROW_HEIGHT,
      width: 200,
      height: ROW_HEIGHT,
      toJSON: () => ({}),
    } as DOMRect;
  }
  return REAL_GETBoundingClientRect.call(this) as DOMRect;
};
afterAll(() => {
  Element.prototype.getBoundingClientRect = REAL_GETBoundingClientRect;
});

const text = (label: string): TextOverlay => ({
  kind: "text",
  text: label,
  x: 0.5,
  y: 0.5,
  size: 0.1,
  rotation: 0,
  color: "#ffffff",
});

const bootScene: Scene = {
  version: SCENE_VERSION,
  background: { kind: "none" },
  overlays: [text("A"), text("B"), text("C")],
};

const texts = (): string[] =>
  useSceneStore
    .getState()
    .scene.overlays.map((o) => (o.kind === "text" ? o.text : ""));

const DEFAULT_SETTINGS: StoredSettings = {
  spotifyClientId: "",
  lcdFps: 10,
  syncOffsetMs: 0,
  layout: "lyrics",
  serial: "",
  runAtStartup: false,
  scene: bootScene,
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

/** Boots the real App against a stub bridge and waits for the store. */
async function renderBootedApp(bridge?: StubBridge): Promise<StubBridge> {
  const b = bridge ?? makeBridge();
  window.lyricvision = b;
  render(<App />);
  await waitFor(() => expect(b.getSettings).toHaveBeenCalled());
  await waitFor(() => expect(useSceneStore.getState().scene).toEqual(bootScene));
  await waitFor(() => expect(b.previewScene).toHaveBeenCalledWith(bootScene));
  return b;
}

function lastPreview(b: StubBridge): Scene | undefined {
  const calls = b.previewScene.mock.calls;
  return calls[calls.length - 1]?.[0];
}

const history = () => useSceneStore.temporal.getState();

const goSection = (name: "Fondo" | "Capas" | "Propiedades"): void => {
  fireEvent.click(screen.getByRole("button", { name }));
};

/**
 * Real keyboard drag: Space to grab, arrows to move, Space to drop.
 *
 * jsdom note (S7-T22, honest): dnd-kit's KeyboardSensor keeps its native
 * move/end listeners outside the React tree, and diagnostics showed the
 * sensor goes silent after activation no matter which single element the
 * events are dispatched on. Each phase is therefore dispatched on the
 * handle, its row, AND the body — a real keystroke reaches every plausible
 * listener target through propagation, and direct dispatch additionally
 * satisfies any `event.target` identity check. Arrow presses SATURATE at
 * the list boundary (sortableKeyboardCoordinates never wraps), so these
 * all-move-to-the-edge pins cannot overshoot from multi-dispatch. The grab
 * is dispatched on the handle ONLY, because Space while a drag is active
 * can be read as a drop by some paths. The drop sends keydown AND keyup so
 * the pin holds whether the sensor ends on press or on release.
 */
async function keyboardDrag(handle: HTMLElement, moves: number, up: boolean): Promise<void> {
  const label = handle.getAttribute("aria-label") ?? "";
  const grab = { code: "Space", key: " ", keyCode: 32 };
  const node = (): HTMLElement => screen.getByRole("button", { name: label });
  const targets = (): Element[] => {
    const current = node();
    const row = current.closest("li");
    return row ? [current, row, document.body] : [current, document.body];
  };
  node().focus();
  fireEvent.keyDown(node(), grab);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const code = up ? "ArrowUp" : "ArrowDown";
  const key = up ? "ArrowUp" : "ArrowDown";
  for (let i = 0; i < moves; i += 1) {
    for (const target of targets()) {
      fireEvent.keyDown(target, { code, key, keyCode: up ? 38 : 40 });
    }
  }
  for (const target of targets()) fireEvent.keyDown(target, grab);
  for (const target of targets()) fireEvent.keyUp(target, grab);
}

const settle = (ms = 320): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("Layers panel (@dnd-kit sortable)", () => {
  it("[P1] keyboard drag reorders through the store in exactly ONE history entry", async () => {
    await renderBootedApp();
    expect(history().pastStates).toHaveLength(0);

    goSection("Capas");
    const handle = screen.getByRole("button", { name: "Reorder Overlay 1" });
    await keyboardDrag(handle, 2, false); // [A,B,C] -> drag row 1 down two slots

    expect(texts()).toEqual(["B", "C", "A"]);
    expect(history().pastStates).toHaveLength(1);

    // One undo reverses the WHOLE drag as a single step.
    act(() => useSceneStore.getState().undo());
    expect(texts()).toEqual(["A", "B", "C"]);
    expect(history().pastStates).toHaveLength(0);
    expect(history().futureStates).toHaveLength(1);
  });

  it("selection follows the overlay identity across a reorder (inspector + Konva handles)", async () => {
    await renderBootedApp();
    await waitFor(() => expect(sceneStageRef.current).not.toBeNull());

    goSection("Capas");
    // Select overlay C (row 3, index 2), then drag row 1 (A) down twice.
    fireEvent.click(screen.getByRole("button", { name: "Overlay 3" }));
    const handleRow1 = screen.getByRole("button", { name: "Reorder Overlay 1" });
    await keyboardDrag(handleRow1, 2, false); // [A,B,C] -> [B,C,A]

    // C moved from index 2 to index 1: selection must follow the OBJECT.
    goSection("Propiedades");
    expect(screen.getByLabelText("Overlay text")).toHaveValue("C");
    // Positional Konva ids stay coherent: handles ride the new index…
    expect(sceneStageRef.current?.findOne("#resize-handle-1")).toBeTruthy();
    // …and no stale handles remain on the old index.
    expect(sceneStageRef.current?.findOne("#resize-handle-2")).toBeUndefined();
    expect(sceneStageRef.current?.findOne("#overlay-1")).toBeTruthy();

    // Second direction: the SELECTED overlay is the one dragged — from the
    // current [B,C,A], A sits at row 3; drag it up twice back to the top.
    goSection("Capas");
    const handleRow3 = screen.getByRole("button", { name: "Reorder Overlay 3" });
    await keyboardDrag(handleRow3, 2, true); // [B,C,A] -> [A,B,C]

    goSection("Propiedades");
    expect(screen.getByLabelText("Overlay text")).toHaveValue("C");
    expect(sceneStageRef.current?.findOne("#resize-handle-2")).toBeTruthy();
    expect(sceneStageRef.current?.findOne("#resize-handle-0")).toBeUndefined();
    expect(texts()).toEqual(["A", "B", "C"]);
  });

  it("[R1] one debounced preview push per reorder gesture", async () => {
    const bridge = await renderBootedApp();
    await waitFor(() => expect(sceneStageRef.current).not.toBeNull());
    bridge.previewScene.mockClear();

    goSection("Capas");
    await keyboardDrag(
      screen.getByRole("button", { name: "Reorder Overlay 1" }),
      2,
      false
    );

    await waitFor(() => expect(bridge.previewScene).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    await settle();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    expect(lastPreview(bridge)?.overlays.map((o) => o.text)).toEqual([
      "B",
      "C",
      "A",
    ]);
  });

  // Cap enforcement at the schema boundary is pinned in sceneStore.test.ts
  // ("addOverlay appends the default text overlay and enforces the cap");
  // this test covers only the reorder -> add/remove interaction.
  it("add and remove overlays still work after a reorder", async () => {
    await renderBootedApp();
    goSection("Capas");
    await keyboardDrag(
      screen.getByRole("button", { name: "Reorder Overlay 1" }),
      2,
      false
    );
    expect(history().pastStates).toHaveLength(1);

    // A new overlay appends at the END of the array = top of the z-order.
    fireEvent.click(screen.getByRole("button", { name: "Add text overlay" }));
    expect(texts()).toEqual(["B", "C", "A", "New overlay"]);
    expect(history().pastStates).toHaveLength(2);

    // The auto-selected new overlay (index 3) is what Remove takes out.
    fireEvent.click(screen.getByRole("button", { name: "Remove overlay" }));
    expect(texts()).toEqual(["B", "C", "A"]);
    expect(history().pastStates).toHaveLength(3);
  });

  it("a11y: the drag handle exposes dnd-kit keyboard semantics + instructions", async () => {
    await renderBootedApp();
    goSection("Capas");

    const handle = screen.getByRole("button", { name: "Reorder Overlay 1" });
    expect(handle).toHaveAttribute("aria-roledescription", "sortable");
    expect(handle).toHaveAttribute("tabindex", "0");
    const describedBy = handle.getAttribute("aria-describedby");
    if (!describedBy) throw new Error("drag handle has no aria-describedby");
    expect(document.getElementById(describedBy)).toBeInTheDocument();
    // Row keeps real list semantics around the handle.
    expect(handle.closest("li")).toBeTruthy();
    // Selection stays a separate, preserved control.
    const select = screen.getByRole("button", { name: "Overlay 1" });
    fireEvent.click(select);
    expect(select).toHaveAttribute("aria-pressed", "true");
    expect(history().pastStates).toHaveLength(0); // selecting records nothing
  });
});

describe("react-colorful color pickers (existing scene color fields)", () => {
  it("[P2][R2] one pointer gesture with continuous changes -> ONE history entry, ONE preview push", async () => {
    const bridge = await renderBootedApp();
    goSection("Propiedades");
    bridge.previewScene.mockClear();
    expect(history().pastStates).toHaveLength(0);

    const wrapper = screen.getByTestId("overlay-color-gesture");
    fireEvent.pointerDown(wrapper); // REAL event -> real begin handler
    act(() => {
      // Continuous onChange stream through the REAL prop chain (seam).
      colorPickerChangeSeam.current?.("#111111");
      colorPickerChangeSeam.current?.("#222222");
      colorPickerChangeSeam.current?.("#333333");
    });
    fireEvent.pointerUp(wrapper); // REAL bubbling event -> window listener

    expect(
      useSceneStore.getState().scene.overlays[0]
    ).toMatchObject({ color: "#333333" });
    expect(history().pastStates).toHaveLength(1);

    await waitFor(() => expect(bridge.previewScene).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    await settle();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);
    expect(lastPreview(bridge)?.overlays[0]).toMatchObject({
      color: "#333333",
    });

    // The whole gesture rewinds in ONE undo step.
    act(() => useSceneStore.getState().undo());
    expect(useSceneStore.getState().scene.overlays[0]).toMatchObject({
      color: "#ffffff",
    });
    expect(history().pastStates).toHaveLength(0);
  });

  it("[P3] no-change gesture records ZERO commits, ZERO history entries, ZERO previews", async () => {
    // Spy BEFORE App renders so the props facade captures the spy.
    const commitSpy = vi.spyOn(useSceneStore.getState(), "setScene");
    const bridge = await renderBootedApp();
    goSection("Propiedades");
    bridge.previewScene.mockClear();
    const before = useSceneStore.getState().scene;

    const wrapper = screen.getByTestId("overlay-color-gesture");
    fireEvent.pointerDown(wrapper);
    act(() => {
      // A tap that re-emits the CURRENT value: the same-value guard must
      // swallow it, and endCoalesce must take the `snapshot === scene`
      // resume-only branch (no rewind, no rebuild).
      colorPickerChangeSeam.current?.("#ffffff");
    });
    fireEvent.pointerUp(wrapper);

    expect(commitSpy).not.toHaveBeenCalled();
    expect(useSceneStore.getState().scene).toBe(before);
    expect(history().pastStates).toHaveLength(0);
    await settle();
    expect(bridge.previewScene).toHaveBeenCalledTimes(0);

    commitSpy.mockRestore();
  });

  it("background picker binds to the existing background.color field", async () => {
    await renderBootedApp();
    goSection("Fondo");
    fireEvent.click(screen.getByRole("button", { name: "Color" }));
    expect(history().pastStates).toHaveLength(1); // the kind switch itself

    const wrapper = screen.getByTestId("background-color-gesture");
    fireEvent.pointerDown(wrapper);
    act(() => {
      colorPickerChangeSeam.current?.("#ff0000");
    });
    fireEvent.pointerUp(wrapper);

    expect(useSceneStore.getState().scene.background).toEqual({
      kind: "color",
      color: "#ff0000",
    });
    // Kind switch + one coalesced gesture = TWO entries total.
    expect(history().pastStates).toHaveLength(2);
  });

  it("DEFAULT_SCENE stays untouched (guard sanity for this file)", () => {
    expect(DEFAULT_SCENE.overlays).toHaveLength(0);
  });
});
