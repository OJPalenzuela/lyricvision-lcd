/**
 * S7-T20 — undo/redo wired through the store-driven App:
 *
 *  1. history moves (undo/redo) RE-EMIT the debounced scene:preview so the
 *     physical panel follows history exactly like a manual edit;
 *  2. transient editor UI (rail section, overlay selection) creates NO
 *     history entries — history is scene mutations only;
 *  3. Ctrl+Z is scoped to the editor surface and never hijacks native
 *     undo inside text inputs;
 *  4. the Undo/Redo buttons disable exactly at the ends of history;
 *  5. App-level UI OUTSIDE the editor (a settings text field and a
 *     non-editable settings surface) never moves scene history — pins
 *     the handler's "cannot hijack the rest of the window" contract.
 *
 * All of these drive the REAL App wiring (store → props → SceneEditor), not a
 * hand-rolled harness, so the props contract facade is exercised as shipped.
 */
import { act } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import App from "@/App";
import type { LyricvisionBridge, StoredSettings } from "@/lib/bridge";
import { useSceneStore } from "@/lib/sceneStore";
import { DEFAULT_SCENE, type MediaBackgroundKind, type Scene } from "@/lib/scene";

// motion/react (S7-T19 panel-swap animation) mocked to a passthrough so
// jsdom needs no Web Animations API — same honest mock as the sibling
// suites: every query below reads the REAL controls through it.
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

const bootScene: Scene = {
  ...DEFAULT_SCENE,
  overlays: [
    {
      kind: "text",
      text: "Boot line",
      x: 0.5,
      y: 0.5,
      size: 0.1,
      rotation: 0,
      color: "#ffffff",
    },
  ],
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

/** Boots the real App against a stub bridge and waits for the store. */
async function renderBootedApp(): Promise<StubBridge> {
  const bridge = makeBridge();
  window.lyricvision = bridge;
  render(<App />);
  await waitFor(() => expect(bridge.getSettings).toHaveBeenCalled());
  await waitFor(() => expect(useSceneStore.getState().scene).toEqual(bootScene));
  await waitFor(() =>
    expect(bridge.previewScene).toHaveBeenCalledWith(bootScene)
  );
  return bridge;
}

function lastPreview(bridge: StubBridge): Scene | undefined {
  const calls = bridge.previewScene.mock.calls;
  return calls[calls.length - 1]?.[0];
}

const history = () => useSceneStore.temporal.getState();

describe("preview re-emission on undo/redo", () => {
  it("pushes a debounced scene:preview for every history move", async () => {
    const bridge = await renderBootedApp();
    const colorEdit: Scene = {
      ...bootScene,
      background: { kind: "color", color: "#000000" },
    };

    // A manual edit commits through the props facade into the store and
    // reaches the panel through the existing 250 ms debounce.
    fireEvent.click(screen.getByRole("button", { name: "Color" }));
    expect(useSceneStore.getState().scene).toEqual(colorEdit);
    await waitFor(() => expect(lastPreview(bridge)).toEqual(colorEdit), {
      timeout: 3000,
    });

    // Undo must re-emit the PRE-EDIT scene through the SAME channel, so
    // the physical panel follows history exactly like a manual edit.
    act(() => useSceneStore.getState().undo());
    expect(useSceneStore.getState().scene).toEqual(bootScene);
    await waitFor(() => expect(lastPreview(bridge)).toEqual(bootScene), {
      timeout: 3000,
    });

    // Redo re-emits the edit.
    act(() => useSceneStore.getState().redo());
    expect(useSceneStore.getState().scene).toEqual(colorEdit);
    await waitFor(() => expect(lastPreview(bridge)).toEqual(colorEdit), {
      timeout: 3000,
    });
  });
});

describe("history boundary in the editor", () => {
  it("keeps transient UI state (rail section, selection) out of history", async () => {
    await renderBootedApp();
    expect(history().pastStates).toHaveLength(0);

    // Active rail section: local editor UI, not a scene mutation.
    fireEvent.click(screen.getByRole("button", { name: "Capas" }));
    expect(screen.getByRole("region", { name: "Capas" })).toBeInTheDocument();

    // Overlay selection: local editor UI, not a scene mutation.
    fireEvent.click(screen.getByRole("button", { name: "Overlay 1" }));
    expect(
      screen.getByRole("button", { name: "Overlay 1" })
    ).toHaveAttribute("aria-pressed", "true");

    expect(history().pastStates).toHaveLength(0);

    // ...while a real scene mutation records exactly one entry.
    fireEvent.click(screen.getByRole("button", { name: "Fondo" }));
    fireEvent.click(screen.getByRole("button", { name: "Color" }));
    expect(history().pastStates).toHaveLength(1);
  });
});

describe("Ctrl+Z scoping", () => {
  it("does not undo inside a text input; undoes and redoes on the editor surface", async () => {
    await renderBootedApp();
    fireEvent.click(screen.getByRole("button", { name: "Color" }));
    expect(history().pastStates).toHaveLength(1);

    // Reach a real text input (the overlay inspector).
    fireEvent.click(screen.getByRole("button", { name: "Propiedades" }));
    const input = screen.getByLabelText("Overlay text");

    // Inside an editable element the native editing undo wins: the
    // default is NOT prevented, no history moves, the scene stands.
    const inputNotPrevented = fireEvent.keyDown(input, {
      key: "z",
      ctrlKey: true,
    });
    expect(inputNotPrevented).toBe(true);
    expect(history().pastStates).toHaveLength(1);
    expect(useSceneStore.getState().scene.background).toEqual({
      kind: "color",
      color: "#000000",
    });

    // On the editor surface (non-editable target) Ctrl+Z undoes.
    const nav = screen.getByRole("navigation", { name: "Scene sections" });
    const surfacePrevented = fireEvent.keyDown(nav, {
      key: "z",
      ctrlKey: true,
    });
    expect(surfacePrevented).toBe(false); // handled → defaultPrevented
    expect(useSceneStore.getState().scene).toEqual(bootScene);

    // Ctrl+Shift+Z redoes.
    fireEvent.keyDown(nav, { key: "z", ctrlKey: true, shiftKey: true });
    expect(useSceneStore.getState().scene.background).toEqual({
      kind: "color",
      color: "#000000",
    });
  });

  it("never moves history from App-level UI outside the editor", async () => {
    await renderBootedApp();
    fireEvent.click(screen.getByRole("button", { name: "Color" }));
    expect(history().pastStates).toHaveLength(1);

    // The Client ID field belongs to App's settings form and lives OUTSIDE
    // SceneEditor's root, where the undo handler is attached: Ctrl+Z there
    // must leave history and the scene alone (native field undo wins).
    const clientId = screen.getByLabelText("Client ID");
    const inputNotPrevented = fireEvent.keyDown(clientId, {
      key: "z",
      ctrlKey: true,
    });
    expect(inputNotPrevented).toBe(true);
    expect(history().pastStates).toHaveLength(1);

    // Non-editable App surface outside the editor: ROOT SCOPING alone must
    // keep scene history untouched — this is the pin that fails if a future
    // refactor attaches undo to window/document (the handler docstring at
    // SceneEditor.tsx:925 promises it "cannot hijack the rest of the
    // window"; source alone does not survive refactors, a test does).
    const lcdSection = screen.getByRole("region", { name: "LCD settings" });
    const sectionNotPrevented = fireEvent.keyDown(lcdSection, {
      key: "z",
      ctrlKey: true,
    });
    expect(sectionNotPrevented).toBe(true);
    expect(history().pastStates).toHaveLength(1);
    expect(useSceneStore.getState().scene.background).toEqual({
      kind: "color",
      color: "#000000",
    });
  });
});

describe("undo/redo buttons", () => {
  it("disables undo at the root and redo with an empty redo stack", async () => {
    await renderBootedApp();
    const undoButton = screen.getByRole("button", { name: "Undo" });
    const redoButton = screen.getByRole("button", { name: "Redo" });

    // Root: boot cleared history, and nothing was ever undone.
    expect(undoButton).toBeDisabled();
    expect(redoButton).toBeDisabled();

    // One edit: undo becomes available, the redo stack is still empty.
    fireEvent.click(screen.getByRole("button", { name: "Color" }));
    expect(undoButton).not.toBeDisabled();
    expect(redoButton).toBeDisabled();

    // Undo back to the root: undo exhausts, redo gains the edit.
    fireEvent.click(undoButton);
    expect(undoButton).toBeDisabled();
    expect(redoButton).not.toBeDisabled();

    // Redo consumes the future stack again.
    fireEvent.click(redoButton);
    expect(undoButton).not.toBeDisabled();
    expect(redoButton).toBeDisabled();
  });
});
