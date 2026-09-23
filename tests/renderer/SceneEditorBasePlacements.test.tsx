import { act } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom canvas / Image seams must be installed before any Konva render.
import "./konvaJsdomShims";
import App from "@/App";
import { sceneStageRef } from "@/components/SceneStage";
import {
  BASE_WIDGET_META,
  PORTRAIT_HEIGHT,
  PORTRAIT_WIDTH,
  resolveBasePlacements,
} from "@/lib/basePlacements";
import type { LyricvisionBridge, StoredSettings } from "@/lib/bridge";
import {
  BASE_WIDGET_KEYS,
  SCENE_VERSION,
  type BasePlacement,
  type BaseWidget,
  type MediaBackgroundKind,
  type Scene,
  type TextOverlay,
} from "@/lib/scene";
import { useSceneStore } from "@/lib/sceneStore";

/**
 * S7-T24b — editor controls for the base Spotify widget placement contract.
 *
 * JSDOM HONESTY: list, inspector, history, persistence, and preview timing are
 * real React/store behavior. Konva gestures are driven with node.fire through
 * the documented sceneStageRef seam because jsdom has no canvas hit graph.
 */
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
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
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

const placement = (
  x: number,
  y: number,
  size: number
): BasePlacement => ({ x, y, size });

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
  overlays: [text("Overlay")],
  basePlacements: {
    cover: placement(0.5, 0.25, 0.2),
    artist: placement(0.5, 0.5, 0.03),
  },
};

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

async function renderBootedApp(): Promise<StubBridge> {
  const bridge = makeBridge();
  window.lyricvision = bridge;
  render(<App />);
  await waitFor(() => expect(bridge.getSettings).toHaveBeenCalled());
  await waitFor(() => expect(useSceneStore.getState().scene).toEqual(bootScene));
  await waitFor(() => expect(bridge.previewScene).toHaveBeenCalledWith(bootScene));
  await screen.findByTestId("scene-stage", {}, { timeout: 3000 });
  bridge.previewScene.mockClear();
  return bridge;
}

const history = () => useSceneStore.temporal.getState();
const scene = () => useSceneStore.getState().scene;
const settle = (ms = 350): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function goSection(name: "Fondo" | "Capas" | "Propiedades"): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

const STAGE_RECT = { left: 100, top: 50, width: 240, height: 427 } as const;
const CENTER = { clientX: 220, clientY: 263.5 };

function stubStageRect(): void {
  screen.getByTestId("scene-stage").getBoundingClientRect = () =>
    ({
      ...STAGE_RECT,
      right: STAGE_RECT.left + STAGE_RECT.width,
      bottom: STAGE_RECT.top + STAGE_RECT.height,
      x: STAGE_RECT.left,
      y: STAGE_RECT.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function konvaNode(id: string) {
  const node = sceneStageRef.current?.findOne(`#${id}`);
  if (!node) throw new Error(`Konva node #${id} not found`);
  return node;
}

function fireDrag(
  kind: "dragstart" | "dragmove" | "dragend",
  id: string,
  clientX: number,
  clientY: number
): void {
  act(() => {
    konvaNode(id).fire(kind, {
      evt: new MouseEvent(kind, { clientX, clientY }),
    });
  });
}

function baseRailButton(widget: BaseWidget): HTMLElement {
  const escaped = BASE_WIDGET_META[widget].label.replace("+", "\\+");
  return screen.getByRole("button", {
    name: new RegExp(`^Select ${escaped} placement guide\\.`),
  });
}

function selectBase(widget: BaseWidget): void {
  fireEvent.click(baseRailButton(widget));
}

describe("S7-T24b base Spotify placement guides", () => {
  it("[G1] renders five labeled panel-content guides and a keyboard list outside overlay sorting", async () => {
    await renderBootedApp();

    const stage = screen.getByTestId("scene-stage");
    const descriptionId = stage.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")).toHaveTextContent(
      /real Spotify content.*does not have live Spotify content/i
    );

    const expected = [
      ["cover", "Cover"],
      ["title", "Title"],
      ["artist", "Artist + album"],
      ["progress", "Progress"],
      ["lyrics", "Lyrics"],
    ] as const;
    for (const [widget, label] of expected) {
      const guide = konvaNode(`base-${widget}`);
      expect(guide.getAttr("draggable")).toBe(true);
      const guideLabel = konvaNode(`base-label-${widget}`);
      expect(guideLabel.getAttr("text")).toBe(`${label} · panel content`);
    }

    goSection("Capas");
    const list = screen.getByRole("list", {
      name: "Spotify content placement guides",
    });
    for (const [, label] of expected) {
      const select = within(list).getByRole("button", {
        name: new RegExp(`^Select ${label.replace("+", "\\+")} placement guide\\.`),
      });
      expect(select).toHaveAttribute("aria-pressed", "false");
    }
    expect(
      within(list).queryByRole("button", { name: /^Reorder / })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/painted below your scene overlays/i)
    ).toBeInTheDocument();

    act(() => {
      konvaNode("base-title").fire("mousedown", {
        evt: new MouseEvent("mousedown", CENTER),
      });
    });
    expect(
      within(list).getByRole("button", {
        name: /^Select Title placement guide\./,
      })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("[K1] activates a base guide rail button with Space", async () => {
    await renderBootedApp();
    goSection("Capas");
    const user = userEvent.setup();
    const cover = baseRailButton("cover");
    cover.focus();
    await user.keyboard(" ");
    expect(cover).toHaveAttribute("aria-pressed", "true");
  });

  it("[G2] keeps each guide geometry on its centralized size unit", async () => {
    await renderBootedApp();
    const resolved = resolveBasePlacements(scene().basePlacements);
    const geometry = Object.fromEntries(
      BASE_WIDGET_KEYS.map((widget) => {
        const node = konvaNode(`base-${widget}`);
        return [widget, { width: Number(node.getAttr("width")), height: Number(node.getAttr("height")) }];
      })
    ) as Record<BaseWidget, { width: number; height: number }>;
    for (const widget of BASE_WIDGET_KEYS) {
      const sizePx =
        resolved[widget].size *
        (BASE_WIDGET_META[widget].sizeUnit === "width"
          ? PORTRAIT_WIDTH
          : PORTRAIT_HEIGHT);
      const expectedHeight =
        widget === "cover"
          ? sizePx
          : widget === "progress"
            ? 8
            : widget === "title"
              ? Math.max(40, sizePx * 2)
              : widget === "artist"
                ? Math.max(48, sizePx * 2.5)
                : Math.max(96, sizePx * 3.5);
      expect(geometry[widget].width).toBeCloseTo(
        widget === "cover" || widget === "progress"
          ? sizePx
          : PORTRAIT_WIDTH - 56,
        6
      );
      expect(geometry[widget].height).toBeCloseTo(expectedHeight, 6);
    }
  });

  it("[H1] keeps the base guide layer below a listening overlay layer", async () => {
    await renderBootedApp();
    const layers = sceneStageRef.current?.getLayers() ?? [];
    const baseLayer = layers.find((layer) => layer.id() === "base-placement-guides");
    const overlayLayer = layers.find((layer) => layer.id() === "overlay-placement-guides");
    if (!baseLayer || !overlayLayer) throw new Error("placement guide layers not found");
    expect(layers.indexOf(baseLayer)).toBeLessThan(layers.indexOf(overlayLayer));
    expect(overlayLayer.listening()).toBe(true);
    goSection("Capas");
    selectBase("cover");
    expect(overlayLayer.listening()).toBe(true);
  });

  it("[P2] resizes all five guides on their declared width or height axis", async () => {
    await renderBootedApp();
    stubStageRect();
    goSection("Capas");
    const axes = [
      ["cover", "width"],
      ["progress", "width"],
      ["title", "height"],
      ["artist", "height"],
      ["lyrics", "height"],
    ] as const;
    for (const [widget, axis] of axes) {
      const before = resolveBasePlacements(scene().basePlacements)[widget];
      selectBase(widget);
      const deltaX = axis === "width" ? STAGE_RECT.width * 0.1 : 0;
      const deltaY = axis === "height" ? STAGE_RECT.height * 0.1 : 0;
      const handle = `base-resize-handle-${widget}`;
      fireDrag("dragstart", handle, CENTER.clientX, CENTER.clientY);
      fireDrag("dragmove", handle, CENTER.clientX + deltaX, CENTER.clientY + deltaY);
      fireDrag("dragend", handle, CENTER.clientX + deltaX, CENTER.clientY + deltaY);
      const after = scene().basePlacements?.[widget];
      expect(after?.size).toBeCloseTo(before.size + 0.1, 6);
      expect(after?.x).toBeCloseTo(before.x, 6);
      expect(after?.y).toBeCloseTo(before.y, 6);
    }
  });

  it("[P3] selecting a base guide creates no history entry or preview", async () => {
    const bridge = await renderBootedApp();
    const before = scene();
    goSection("Capas");
    selectBase("title");
    expect(scene()).toBe(before);
    expect(history().pastStates).toHaveLength(0);
    await settle();
    expect(bridge.previewScene).not.toHaveBeenCalled();
  });

  it("[P1] base move/resize clamp with one history entry and one preview per changed gesture", async () => {
    const bridge = await renderBootedApp();
    stubStageRect();
    goSection("Capas");
    fireEvent.click(
      screen.getByRole("button", { name: /^Select Cover placement guide\./ })
    );
    expect(history().pastStates).toHaveLength(0);

    fireDrag("dragstart", "base-cover", CENTER.clientX, CENTER.clientY);
    fireDrag("dragmove", "base-cover", 244, CENTER.clientY);
    expect(scene().basePlacements?.cover).toEqual(placement(0.6, 0.25, 0.2));
    expect(history().pastStates).toHaveLength(0);
    expect(bridge.previewScene).not.toHaveBeenCalled();
    fireDrag("dragend", "base-cover", 244, CENTER.clientY);
    expect(history().pastStates).toHaveLength(1);
    await waitFor(() => expect(bridge.previewScene).toHaveBeenCalledTimes(1));
    await settle();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);

    bridge.previewScene.mockClear();
    fireDrag("dragstart", "base-cover", CENTER.clientX, CENTER.clientY);
    fireDrag("dragmove", "base-cover", CENTER.clientX, CENTER.clientY);
    fireDrag("dragend", "base-cover", CENTER.clientX, CENTER.clientY);
    expect(history().pastStates).toHaveLength(1);
    await settle();
    expect(bridge.previewScene).not.toHaveBeenCalled();

    bridge.previewScene.mockClear();
    fireDrag("dragstart", "base-resize-handle-cover", CENTER.clientX, CENTER.clientY);
    fireDrag("dragmove", "base-resize-handle-cover", -2000, -2000);
    fireDrag("dragend", "base-resize-handle-cover", -2000, -2000);
    expect(scene().basePlacements?.cover?.size).toBe(0.01);
    expect(history().pastStates).toHaveLength(2);
    await waitFor(() => expect(bridge.previewScene).toHaveBeenCalledTimes(1));
    await settle();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);

    bridge.previewScene.mockClear();
    fireDrag("dragstart", "base-resize-handle-cover", CENTER.clientX, CENTER.clientY);
    fireDrag("dragmove", "base-resize-handle-cover", 2000, 2000);
    fireDrag("dragend", "base-resize-handle-cover", 2000, 2000);
    expect(scene().basePlacements?.cover?.size).toBe(1);
    expect(history().pastStates).toHaveLength(3);
    await waitFor(() => expect(bridge.previewScene).toHaveBeenCalledTimes(1));
    await settle();
    expect(bridge.previewScene).toHaveBeenCalledTimes(1);

    act(() => useSceneStore.getState().undo());
    expect(scene().basePlacements?.cover?.size).toBe(0.01);
  });

  it("[I1] keyboard selection exposes unit-correct inspector fields and saves through the existing path", async () => {
    const bridge = await renderBootedApp();
    const user = userEvent.setup();

    goSection("Capas");
    const artist = screen.getByRole("button", {
      name: /^Select Artist \+ album placement guide\./,
    });
    artist.focus();
    await user.keyboard("{Enter}");
    expect(artist).toHaveAttribute("aria-pressed", "true");

    goSection("Propiedades");
    const x = screen.getByLabelText("Artist + album X (0-1 width)");
    const y = screen.getByLabelText("Artist + album Y (0-1 height)");
    const size = screen.getByLabelText("Artist + album size (0-1 height)");
    expect(
      screen.queryByLabelText("Cover size (0-1 width)")
    ).not.toBeInTheDocument();
    expect(screen.getByText(/owns the artist and album metadata block/i)).toBeInTheDocument();

    await user.clear(x);
    await user.type(x, "0.2");
    await user.clear(y);
    await user.type(y, "0.3");
    await user.clear(size);
    await user.type(size, "0.4");

    await waitFor(() =>
      expect(scene().basePlacements?.artist).toEqual(
        placement(0.2, 0.3, 0.4)
      )
    );
    await user.click(screen.getByRole("button", { name: "Save scene" }));
    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledTimes(1));
    expect(bridge.saveSettings.mock.calls[0][0].scene.basePlacements?.artist).toEqual(
      placement(0.2, 0.3, 0.4)
    );
  });
});
