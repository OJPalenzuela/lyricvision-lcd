import { act } from "react";
import type { ReactNode } from "react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type Konva from "konva";

import "./konvaJsdomShims";
import App from "@/App";
import { sceneStageRef } from "@/components/SceneStage";
import type { LyricvisionBridge, StoredSettings } from "@/lib/bridge";
import { DEFAULT_SCENE, type Scene } from "@/lib/scene";
import { useSceneStore } from "@/lib/sceneStore";

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

const overlay = (patch: Partial<Scene["overlays"][number]> = {}): Scene["overlays"][number] => ({
  kind: "text",
  text: "Original",
  x: 0.5,
  y: 0.5,
  size: 0.1,
  rotation: 0,
  color: "#ffffff",
  ...patch,
});

const settingsFor = (scene: Scene): StoredSettings => ({
  spotifyClientId: "",
  lcdFps: 10,
  syncOffsetMs: 0,
  layout: "lyrics",
  serial: "",
  runAtStartup: false,
  scene,
});

interface StubBridge extends LyricvisionBridge {
  saveSettings: ReturnType<typeof vi.fn>;
  previewScene: ReturnType<typeof vi.fn>;
  importMedia: ReturnType<typeof vi.fn>;
  getSettings: ReturnType<typeof vi.fn>;
}

function makeBridge(scene: Scene): StubBridge {
  return {
    getSettings: vi.fn(async () => ({
      settings: settingsFor(scene),
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

async function boot(scene: Scene): Promise<StubBridge> {
  const bridge = makeBridge(scene);
  window.lyricvision = bridge;
  render(<App />);
  await waitFor(() => expect(bridge.getSettings).toHaveBeenCalled());
  await waitFor(() => expect(useSceneStore.getState().scene).toEqual(scene));
  return bridge;
}

const history = () => useSceneStore.temporal.getState();

// jsdom reports zero-size sortable rows. Synthesize only the <li> geometry that
// dnd-kit's real KeyboardSensor measures; all other layout stays untouched.
const ROW_HEIGHT = 40;
const REAL_GET_BOUNDING_CLIENT_RECT = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function fabricateRowRect(
  this: Element
): DOMRect {
  const parent = this.parentElement;
  if (this.tagName === "LI" && parent?.tagName === "UL") {
    const rows = Array.from(parent.children).filter(
      (element) => element.tagName === "LI"
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
  return REAL_GET_BOUNDING_CLIENT_RECT.call(this) as DOMRect;
};
afterAll(() => {
  Element.prototype.getBoundingClientRect = REAL_GET_BOUNDING_CLIENT_RECT;
});

function fireDrag(
  node: Konva.Node,
  kind: "dragstart" | "dragmove" | "dragend",
  coords: { clientX: number; clientY: number }
): void {
  act(() => {
    node.fire(kind, { evt: new MouseEvent(kind, coords) });
  });
}

async function keyboardDrag(
  handle: HTMLElement,
  moves: number,
  up: boolean
): Promise<void> {
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
  const key = up ? "ArrowUp" : "ArrowDown";
  const keyCode = up ? 38 : 40;
  for (let index = 0; index < moves; index += 1) {
    for (const target of targets()) {
      fireEvent.keyDown(target, { code: key, key, keyCode });
    }
  }
  for (const target of targets()) fireEvent.keyDown(target, grab);
  for (const target of targets()) fireEvent.keyUp(target, grab);
}

const invalidPlacementScene: Scene = {
  ...DEFAULT_SCENE,
  overlays: [overlay({ x: 1.5 })],
};

const editorInvalidRotationScene: Scene = {
  ...DEFAULT_SCENE,
  overlays: [overlay({ rotation: 1000 })],
};

const twoOverlayRotationScene: Scene = {
  ...DEFAULT_SCENE,
  overlays: [overlay({ text: "A", rotation: 1000 }), overlay({ text: "B" })],
};

describe("editor scene validation feedback", () => {
  it("associates feedback with the field and rejects an invalid edit without history", async () => {
    await boot(invalidPlacementScene);
    fireEvent.click(screen.getByRole("button", { name: "Propiedades" }));

    const x = screen.getByLabelText("Overlay X (0-1)");
    expect(x).toHaveAttribute("aria-invalid", "true");
    expect(x).toHaveAttribute("aria-describedby", "overlay-x-error");
    expect(screen.getAllByText(/Must be between 0 and 1\./)).toHaveLength(2);
    expect(history().pastStates).toHaveLength(0);

    const before = useSceneStore.getState().scene;
    const text = screen.getByLabelText("Overlay text");
    fireEvent.focusIn(text);
    fireEvent.change(text, {
      target: { value: "A rejected edit" },
    });
    fireEvent.focusOut(text);

    expect(useSceneStore.getState().scene).toBe(before);
    expect(history().pastStates).toHaveLength(0);
    expect(text).toHaveValue("Original");

    const y = screen.getByLabelText("Overlay Y (0-1)") as HTMLInputElement;
    fireEvent.change(y, { target: { value: "0.6" } });
    expect(y).toHaveValue("0.5");
    expect(useSceneStore.getState().scene).toBe(before);
    expect(history().pastStates).toHaveLength(0);
  });

  it("records exactly one entry after a valid correction through real focus/blur", async () => {
    await boot(editorInvalidRotationScene);
    fireEvent.click(screen.getByRole("button", { name: "Propiedades" }));
    const text = screen.getByLabelText("Overlay text") as HTMLInputElement;

    fireEvent.focusIn(text);
    fireEvent.change(text, { target: { value: "Corrected" } });
    fireEvent.focusOut(text);

    expect(useSceneStore.getState().scene.overlays[0].text).toBe("Corrected");
    expect(text).toHaveValue("Corrected");
    expect(history().pastStates).toHaveLength(1);
    expect(screen.getByLabelText("Overlay rotation (degrees)")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
  });

  it("accepts an unrelated edit when only the editor rotation policy is violated", async () => {
    await boot(editorInvalidRotationScene);
    fireEvent.click(screen.getByRole("button", { name: "Propiedades" }));
    await waitFor(() => expect(sceneStageRef.current).not.toBeNull());

    const beforeNode = sceneStageRef.current?.findOne("#overlay-0");
    if (!beforeNode) throw new Error("overlay node missing");
    const beforeX = beforeNode.x();
    const x = screen.getByLabelText("Overlay X (0-1)") as HTMLInputElement;

    fireEvent.focusIn(x);
    fireEvent.change(x, { target: { value: "0.4" } });
    fireEvent.focusOut(x);

    expect(useSceneStore.getState().scene.overlays[0].x).toBe(0.4);
    expect(x).toHaveValue("0.4");
    expect(history().pastStates).toHaveLength(1);
    const afterNode = sceneStageRef.current?.findOne("#overlay-0");
    if (!afterNode) throw new Error("overlay node missing after edit");
    expect(afterNode.x()).toBeCloseTo(192, 5);
    expect(afterNode.x()).not.toBe(beforeX);
    expect(screen.getByLabelText("Overlay rotation (degrees)")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(
      screen.getAllByText(/Rotation must be between -360 and 360 degrees\./)
    ).toHaveLength(2);
  });

  it("records one entry for a focused correction from an editor-invalid snapshot and undo restores it", async () => {
    await boot(editorInvalidRotationScene);
    fireEvent.click(screen.getByRole("button", { name: "Propiedades" }));
    const rotation = screen.getByLabelText(
      "Overlay rotation (degrees)"
    ) as HTMLInputElement;

    fireEvent.focusIn(rotation);
    fireEvent.change(rotation, { target: { value: "360" } });
    fireEvent.focusOut(rotation);

    expect(useSceneStore.getState().scene.overlays[0].rotation).toBe(360);
    expect(rotation).toHaveValue("360");
    expect(history().pastStates).toHaveLength(1);

    act(() => useSceneStore.getState().undo());
    expect(useSceneStore.getState().scene.overlays[0].rotation).toBe(1000);
    expect(rotation).toHaveValue("1000");
  });

  it("accepts a stage gesture candidate when only the editor rotation policy is violated", async () => {
    await boot(editorInvalidRotationScene);
    const stageElement = await screen.findByTestId("scene-stage", {}, { timeout: 3000 });
    stageElement.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 240,
        height: 427,
        right: 340,
        bottom: 477,
        x: 100,
        y: 50,
        toJSON: () => ({}),
      }) as DOMRect;
    const node = sceneStageRef.current?.findOne("#overlay-0");
    if (!node) throw new Error("overlay node missing");

    fireDrag(node, "dragstart", { clientX: 220, clientY: 263.5 });
    fireDrag(node, "dragmove", { clientX: 268, clientY: 263.5 });
    fireDrag(node, "dragend", { clientX: 268, clientY: 263.5 });

    expect(useSceneStore.getState().scene.overlays[0].x).toBeCloseTo(0.7, 6);
    expect(history().pastStates).toHaveLength(1);
  });

  it("accepts a reorder candidate when only the editor rotation policy is violated", async () => {
    await boot(twoOverlayRotationScene);
    fireEvent.click(screen.getByRole("button", { name: "Capas" }));
    const handle = screen.getByRole("button", { name: "Reorder Overlay 1" });

    await keyboardDrag(handle, 1, false);

    expect(
      useSceneStore.getState().scene.overlays.map((item) =>
        item.kind === "text" ? item.text : ""
      )
    ).toEqual(["B", "A"]);
    expect(history().pastStates).toHaveLength(1);
  });

  it("does not turn local feedback into a save or IPC gate", async () => {
    const bridge = await boot(invalidPlacementScene);

    fireEvent.click(screen.getByRole("button", { name: "Save scene" }));

    await waitFor(() =>
      expect(bridge.saveSettings).toHaveBeenCalledWith({ scene: invalidPlacementScene })
    );
    expect(screen.getByText(/Scene needs attention\./)).toBeInTheDocument();
  });

  it("keeps the editor's explicit numeric clamps explicit and bounded", async () => {
    await boot({ ...DEFAULT_SCENE, overlays: [overlay()] });
    fireEvent.click(screen.getByRole("button", { name: "Propiedades" }));

    fireEvent.change(screen.getByLabelText("Overlay X (0-1)"), {
      target: { value: "2" },
    });
    expect(useSceneStore.getState().scene.overlays[0].x).toBe(1);

    fireEvent.change(screen.getByLabelText("Overlay rotation (degrees)"), {
      target: { value: "999" },
    });
    expect(useSceneStore.getState().scene.overlays[0].rotation).toBe(360);
  });

  it("links a background field error to its native control", async () => {
    await boot({ ...DEFAULT_SCENE, background: { kind: "color", color: "red" } });

    const color = screen.getByLabelText("Background color");
    expect(color).toHaveAttribute("aria-invalid", "true");
    expect(color).toHaveAttribute("aria-describedby", "scene-background-color-error");
    expect(screen.getAllByText(/Use the #rrggbb format\./)).toHaveLength(2);
  });
});
