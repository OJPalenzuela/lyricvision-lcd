import { useState } from "react";
import { createRequire } from "node:module";
import { describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "@/App";
import SceneEditor from "@/components/SceneEditor";
import type { LyricvisionBridge, StoredSettings } from "@/lib/bridge";
import { DEFAULT_SCENE, SCENE_OVERLAYS_CAP, type Scene } from "@/lib/scene";

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
  };
}

/** Mirrors the App wiring: the scene lives in parent state. */
function Harness({
  initial,
  onChange,
}: {
  initial: Scene;
  onChange: (scene: Scene) => void;
}) {
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

function setup(
  initial: Scene = DEFAULT_SCENE,
  configure?: (bridge: StubBridge) => void
) {
  const bridge = makeBridge();
  configure?.(bridge);
  window.lyricvision = bridge;
  const onChange = vi.fn<(scene: Scene) => void>();
  const user = userEvent.setup();
  render(<Harness initial={initial} onChange={onChange} />);
  return { bridge, onChange, user };
}

function lastScene(onChange: Mock<(scene: Scene) => void>): Scene {
  return onChange.mock.calls[onChange.mock.calls.length - 1][0];
}

function textOverlay(text: string) {
  return {
    kind: "text" as const,
    text,
    x: 0.5,
    y: 0.5,
    size: 0.1,
    rotation: 0,
    color: "#ffffff",
  };
}

describe('live preview states', () => {
  it('renders the preview <img> fed by the engine data URL', async () => {
    const { bridge } = setup();
    const img = await screen.findByAltText("Scene preview", {}, { timeout: 3000 });
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(bridge.previewScene).toHaveBeenCalledWith(DEFAULT_SCENE);
  });

  it('shows the no-sidecar message with the next step', async () => {
    setup(DEFAULT_SCENE, (bridge) => {
      bridge.previewScene.mockRejectedValue(
        new Error(
          "Error invoking remote method 'scene:preview': Error: preview_sidecar_absent: no live sidecar"
        )
      );
    });
    await screen.findByText(
      /No live panel connection\. Connect the LCD/,
      {},
      { timeout: 3000 }
    );
  });

  it('shows the timeout message with the next step', async () => {
    setup(DEFAULT_SCENE, (bridge) => {
      bridge.previewScene.mockRejectedValue(
        new Error("preview_timeout: no preview_response within 3000 ms")
      );
    });
    await screen.findByText(/Preview timed out\./, {}, { timeout: 3000 });
  });

  it('shows the engine-rejected message with the typed reason', async () => {
    setup(DEFAULT_SCENE, (bridge) => {
      bridge.previewScene.mockRejectedValue(
        new Error("preview_engine_error: text_too_long: text exceeds the cap")
      );
    });
    const text = await screen.findByText(
      /Engine rejected the scene \(text_too_long/,
      {},
      { timeout: 3000 }
    );
    expect(text.textContent).toContain("Fix the value and try again.");
  });
});

describe("background: none and color only in this task", () => {
  it("never offers image, gif or video", async () => {
    const { onChange, user } = setup();
    expect(screen.queryByRole("button", { name: "Image" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "GIF" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Video" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Color" }));
    expect(screen.getByLabelText("Background color")).toBeInTheDocument();
    expect(lastScene(onChange).background).toEqual({
      kind: "color",
      color: expect.any(String),
    });
  });
});

describe("text overlays", () => {
  it("adds, selects, edits and removes text overlays", async () => {
    const { onChange, user } = setup();

    await user.click(screen.getByRole("button", { name: "Add text overlay" }));
    const row = screen.getByRole("button", { name: "Overlay 1" });
    expect(row).toHaveAttribute("aria-pressed", "true"); // new overlay auto-selects

    await user.clear(screen.getByLabelText("Overlay text"));
    await user.type(screen.getByLabelText("Overlay text"), "Hello");
    const first = lastScene(onChange);
    expect(first.overlays).toHaveLength(1);
    expect(first.overlays[0]).toMatchObject({ kind: "text", text: "Hello" });
    expect(hardening.validateScene(first).ok).toBe(true);

    await user.click(screen.getByRole("button", { name: "Add text overlay" }));
    await user.clear(screen.getByLabelText("Overlay text"));
    await user.type(screen.getByLabelText("Overlay text"), "Second");
    expect(screen.getByLabelText("Overlay text")).toHaveValue("Second");

    // Select the first row again: the inspector must show ITS values.
    await user.click(screen.getByRole("button", { name: "Overlay 1" }));
    expect(screen.getByLabelText("Overlay text")).toHaveValue("Hello");

    await user.click(screen.getByRole("button", { name: "Remove overlay" }));
    const after = lastScene(onChange);
    expect(after.overlays).toHaveLength(1);
    expect(after.overlays[0]).toMatchObject({ text: "Second" });
    expect(hardening.validateScene(after).ok).toBe(true);
  });

  it("respects SCENE_OVERLAYS_CAP with actionable copy", () => {
    const full: Scene = {
      ...DEFAULT_SCENE,
      overlays: Array.from({ length: SCENE_OVERLAYS_CAP }, (_, i) =>
        textOverlay(`T${i}`)
      ),
    };
    setup(full);
    expect(screen.getByRole("button", { name: "Add text overlay" })).toBeDisabled();
    expect(
      screen.getByText(/Limit reached: remove an overlay before adding another\./)
    ).toBeInTheDocument();
  });
});

describe("numeric inspector clamping", () => {
  it("clamps an overlay unit field into [0,1] before it reaches scene state", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Add text overlay" }));
    const x = screen.getByLabelText("Overlay X (0-1)") as HTMLInputElement;

    fireEvent.change(x, { target: { value: "5" } });
    expect(x.value).toBe("1");
    expect(lastScene(onChange).overlays[0]).toMatchObject({ x: 1 });

    fireEvent.change(x, { target: { value: "-3" } });
    expect(x.value).toBe("0");
    expect(lastScene(onChange).overlays[0]).toMatchObject({ x: 0 });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
  });

  it("keeps transform fields staged locally (the schema binds them to media kinds)", async () => {
    const { onChange } = setup();
    const rotation = screen.getByLabelText(
      "Rotation (degrees)"
    ) as HTMLInputElement;
    fireEvent.change(rotation, { target: { value: "9999" } });
    expect(rotation.value).toBe("360"); // clamped to the declared UI range
    // None/color backgrounds carry NO transform keys — wiring them in would
    // fail validateScene, so staging stays local until media import (S2-T8b).
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Used by image backgrounds\./)
    ).toBeInTheDocument();
  });
});

describe("persisting the scene", () => {
  it("saves through saveSettings with a scene that passes validateScene", async () => {
    const { bridge, user } = setup();
    await user.click(screen.getByRole("button", { name: "Save scene" }));
    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledTimes(1));
    const patch = bridge.saveSettings.mock.calls[0][0];
    expect(patch.scene).toBeDefined();
    expect(hardening.validateScene(patch.scene).ok).toBe(true);
  });

  it("is reachable from the app surface", async () => {
    const bridge = makeBridge();
    window.lyricvision = bridge;
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(bridge.getSettings).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Scene editor" }));
    const img = await screen.findByAltText("Scene preview", {}, { timeout: 3000 });
    expect(img).toBeInTheDocument();
  });

  it("shows the rejected field path when the settings gate refuses the scene", async () => {
    const { bridge, user } = setup(DEFAULT_SCENE, (stub) => {
      stub.saveSettings = vi.fn(async () => ({ rejected: ["scene"] }));
      // settings:save returns only the KEY; the field path comes from the
      // same validateScene verdict the preview gate reports.
      stub.previewScene.mockRejectedValue(
        new Error(
          "preview_invalid_scene: overlays[0].x: x must be a fraction in [0,1]"
        )
      );
    });
    await user.click(screen.getByRole("button", { name: "Save scene" }));
    const message = await screen.findByText(
      /Could not save the scene: overlays\[0\]\.x/
    );
    expect(message.textContent).toContain("Fix the value and try again.");
  });
});

describe("overlay text length gate", () => {
  it("caps the input at 4096 and clamps an over-long paste out of scene state", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Add text overlay" }));
    const input = screen.getByLabelText("Overlay text") as HTMLInputElement;
    expect(input).toHaveAttribute("maxLength", "4096");

    // fireEvent bypasses the native maxLength the way an exotic paste can:
    // the commit path must clamp so scene state never leaves the gates.
    fireEvent.change(input, { target: { value: "a".repeat(4097) } });
    const scene = lastScene(onChange);
    expect(scene.overlays[0]).toMatchObject({ text: "a".repeat(4096) });
    expect(hardening.validateScene(scene).ok).toBe(true);
    expect(screen.getByLabelText("Overlay text")).toHaveValue("a".repeat(4096));
  });
});
