import { useState } from "react";
import { createRequire } from "node:module";
import { describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "@/App";
import SceneEditor from "@/components/SceneEditor";
import type { LyricvisionBridge, StoredSettings } from "@/lib/bridge";
import { DEFAULT_SCENE, SCENE_OVERLAYS_CAP, type MediaBackgroundKind, type Scene } from "@/lib/scene";

const requireNative = createRequire(import.meta.url);
interface HardeningGate {
  validateScene(input: unknown): { ok: boolean; field?: string; error?: string };
}
const hardening = requireNative("../../src/hardening.js") as HardeningGate;

// Pillow-verified fixtures (1x1 PNG / 8x8 3-frame GIF), same as
// tests/unit/media-import.test.js: real bytes, not placeholder strings.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgEpEDAABoAD1UCKP3AAAAAElFTkSuQmCC";
const GIF_DATA_URL =
  "data:image/gif;base64,R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBCgABACwAAAAACAAIAIEA/wAAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBCgABACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7";

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
    // Default: dialog cancelled (null = no-op). Tests override per scenario.
    importMedia: vi.fn(async () => null),
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

function sceneWithMedia(
  kind: "image" | "gif",
  overrides: Partial<{
    rotation: number;
    flipH: boolean;
    scale: number;
    panX: number;
    panY: number;
    fit: "fit" | "fill";
    source: string;
  }> = {}
): Scene {
  return {
    ...DEFAULT_SCENE,
    background: {
      kind,
      source: kind === "gif" ? GIF_DATA_URL : PNG_DATA_URL,
      rotation: 0,
      flipH: false,
      scale: 1,
      panX: 0,
      panY: 0,
      fit: "fit",
      ...overrides,
    },
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

  it('surfaces an engine-side media rejection (sidecar defence in depth)', async () => {
    setup(DEFAULT_SCENE, (bridge) => {
      bridge.previewScene.mockRejectedValue(
        new Error(
          "preview_engine_error: media_too_large: media payload is 16777217 bytes, over the 16777216 byte cap"
        )
      );
    });
    const text = await screen.findByText(
      /Engine rejected the scene \(media_too_large/,
      {},
      { timeout: 3000 }
    );
    expect(text.textContent).toContain("Fix the value and try again.");
  });
});

describe("background: media import (S2-T8b)", () => {
  it("offers Image and GIF, never Video or gpu-temp, and keeps Color working", async () => {
    const { onChange, user } = setup();
    expect(screen.getByRole("button", { name: "Image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GIF" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Video" })).not.toBeInTheDocument();
    expect(screen.queryByText(/gpu-temp/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Color" }));
    expect(screen.getByLabelText("Background color")).toBeInTheDocument();
    expect(lastScene(onChange).background).toEqual({
      kind: "color",
      color: expect.any(String),
    });
  });

  it("imports a PNG into an image background and shows the in-use summary", async () => {
    const { bridge, onChange, user } = setup(undefined, (stub) => {
      stub.importMedia.mockResolvedValue(PNG_DATA_URL);
    });
    await user.click(screen.getByRole("button", { name: "Image" }));
    await waitFor(() => expect(bridge.importMedia).toHaveBeenCalledWith("image"));

    const background = lastScene(onChange).background;
    expect(background).toMatchObject({
      kind: "image",
      source: PNG_DATA_URL,
      rotation: 0,
      flipH: false,
      scale: 1,
      panX: 0,
      panY: 0,
      fit: "fit",
    });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
    expect(await screen.findByText(/In use: PNG, about 1 KB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("imports a GIF into a gif background", async () => {
    const { bridge, onChange, user } = setup(undefined, (stub) => {
      stub.importMedia.mockResolvedValue(GIF_DATA_URL);
    });
    await user.click(screen.getByRole("button", { name: "GIF" }));
    await waitFor(() => expect(bridge.importMedia).toHaveBeenCalledWith("gif"));

    expect(lastScene(onChange).background).toMatchObject({
      kind: "gif",
      source: GIF_DATA_URL,
    });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
    expect(await screen.findByText(/In use: GIF, about 1 KB/)).toBeInTheDocument();
  });

  it("treats a cancelled dialog as a no-op", async () => {
    const { bridge, onChange, user } = setup(); // stub default resolves null
    await user.click(screen.getByRole("button", { name: "Image" }));
    await waitFor(() => expect(bridge.importMedia).toHaveBeenCalledTimes(1));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/In use:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows actionable copy when main rejects the file", async () => {
    const { onChange, user } = setup(undefined, (stub) => {
      stub.importMedia.mockRejectedValue(
        new Error(
          "Error invoking remote method 'media:import': Error: media_file_too_large: 17825807 bytes, the limit is 16 MB"
        )
      );
    });
    await user.click(screen.getByRole("button", { name: "GIF" }));
    const alert = await screen.findByText(/This file is too large to embed/);
    expect(alert.textContent).toContain("17825807 bytes, the limit is 16 MB");
    expect(alert.textContent).toContain("Pick a smaller file.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("falls back to actionable copy when the import fails without a reason", async () => {
    const { user } = setup(undefined, (stub) => {
      stub.importMedia.mockRejectedValue(new Error("boom"));
    });
    await user.click(screen.getByRole("button", { name: "Image" }));
    const alert = await screen.findByText(/The import could not finish\./);
    expect(alert.textContent).toContain("try again");
  });

  // S2-T8d: truncation and unknown-type are DIFFERENT statements — the UI
  // must map both tokens to their own actionable copy.
  it("maps media_unreadable to copy that names truncation and the next step", async () => {
    const { onChange, user } = setup(undefined, (stub) => {
      stub.importMedia.mockRejectedValue(
        new Error(
          "Error invoking remote method 'media:import': Error: media_unreadable: the file ends inside its type signature — it looks truncated or incomplete"
        )
      );
    });
    await user.click(screen.getByRole("button", { name: "Image" }));
    const alert = await screen.findByText(/truncated or incomplete/);
    expect(alert.textContent).toContain("This file could not be imported");
    expect(alert.textContent).toContain("Pick another file and try again.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("maps media_type_unsupported to copy that names the supported types and the next step", async () => {
    const { onChange, user } = setup(undefined, (stub) => {
      stub.importMedia.mockRejectedValue(
        new Error(
          "Error invoking remote method 'media:import': Error: media_type_unsupported: expected PNG, JPEG, or GIF data"
        )
      );
    });
    await user.click(screen.getByRole("button", { name: "Image" }));
    const alert = await screen.findByText(/not a PNG, JPEG, or GIF/);
    expect(alert.textContent).toContain("Pick a supported file and try again.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("replaces the media in place and clears back to none", async () => {
    const { bridge, onChange, user } = setup(undefined, (stub) => {
      stub.importMedia.mockResolvedValue(PNG_DATA_URL);
    });
    await user.click(screen.getByRole("button", { name: "Image" }));
    await screen.findByText(/In use: PNG/);

    await user.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(bridge.importMedia).toHaveBeenCalledTimes(2));
    expect(bridge.importMedia).toHaveBeenLastCalledWith("image"); // kind is kept

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(lastScene(onChange).background).toEqual({ kind: "none" });
    expect(screen.queryByText(/In use:/)).not.toBeInTheDocument();
  });

  it("carries staged transform drafts into the first imported media background", async () => {
    const { onChange, user } = setup(undefined, (stub) => {
      stub.importMedia.mockResolvedValue(PNG_DATA_URL);
    });
    const rotation = screen.getByLabelText(
      "Rotation (degrees)"
    ) as HTMLInputElement;
    fireEvent.change(rotation, { target: { value: "45" } });
    expect(onChange).not.toHaveBeenCalled(); // staged while the background is none

    await user.click(screen.getByRole("button", { name: "Image" }));
    expect(lastScene(onChange).background).toMatchObject({
      kind: "image",
      rotation: 45,
    });

    // Drafts survive a Clear and are carried into the next import too.
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(lastScene(onChange).background).toEqual({ kind: "none" });
    await user.click(screen.getByRole("button", { name: "Image" }));
    expect(lastScene(onChange).background).toMatchObject({
      kind: "image",
      rotation: 45,
    });
  });

  it("syncs the drafts from a scene that already carries media", () => {
    setup(
      sceneWithMedia("image", {
        rotation: 30,
        scale: 2,
        panX: 0.25,
        panY: -0.5,
        flipH: true,
        fit: "fill",
      })
    );
    expect(screen.getByLabelText("Rotation (degrees)")).toHaveValue("30");
    expect(screen.getByLabelText("Scale")).toHaveValue("2");
    expect(screen.getByLabelText("Pan X (-1 to 1)")).toHaveValue("0.25");
    expect(screen.getByLabelText("Flip horizontally")).toBeChecked();
    expect(screen.getByRole("button", { name: "Fill" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      screen.queryByText(/Pick an image or GIF background to commit these values\./)
    ).not.toBeInTheDocument();
  });

  it("commits rotation, scale, pan, flip and fit into an image background", async () => {
    const { onChange, user } = setup(sceneWithMedia("image"));

    const rotation = screen.getByLabelText(
      "Rotation (degrees)"
    ) as HTMLInputElement;
    fireEvent.change(rotation, { target: { value: "90" } });
    expect(lastScene(onChange).background).toMatchObject({ rotation: 90 });

    const scale = screen.getByLabelText("Scale") as HTMLInputElement;
    fireEvent.change(scale, { target: { value: "2" } });
    expect(lastScene(onChange).background).toMatchObject({ scale: 2 });

    const panX = screen.getByLabelText("Pan X (-1 to 1)") as HTMLInputElement;
    fireEvent.change(panX, { target: { value: "0.5" } });
    expect(lastScene(onChange).background).toMatchObject({ panX: 0.5 });

    const panY = screen.getByLabelText("Pan Y (-1 to 1)") as HTMLInputElement;
    fireEvent.change(panY, { target: { value: "-0.25" } });
    expect(lastScene(onChange).background).toMatchObject({ panY: -0.25 });

    await user.click(screen.getByLabelText("Flip horizontally"));
    expect(lastScene(onChange).background).toMatchObject({ flipH: true });

    await user.click(screen.getByRole("button", { name: "Fill" }));
    expect(lastScene(onChange).background).toMatchObject({ kind: "image", fit: "fill" });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
  });

  it("commits transform values into a gif background too", () => {
    const { onChange } = setup(sceneWithMedia("gif"));
    const rotation = screen.getByLabelText(
      "Rotation (degrees)"
    ) as HTMLInputElement;
    fireEvent.change(rotation, { target: { value: "-45" } });
    expect(lastScene(onChange).background).toMatchObject({
      kind: "gif",
      rotation: -45,
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

  it("keeps transform fields staged on non-media backgrounds", async () => {
    const { onChange } = setup();
    const rotation = screen.getByLabelText(
      "Rotation (degrees)"
    ) as HTMLInputElement;
    fireEvent.change(rotation, { target: { value: "9999" } });
    expect(rotation.value).toBe("360"); // clamped to the declared UI range
    // None/color backgrounds carry NO transform keys — committing them would
    // fail validateScene, so the values stay staged with an explicit hint.
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Pick an image or GIF background to commit these values\./)
    ).toBeInTheDocument();
  });

  it("keeps transform fields staged on a color background", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Color" }));
    onChange.mockClear();
    const scale = screen.getByLabelText("Scale") as HTMLInputElement;
    fireEvent.change(scale, { target: { value: "3" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Pick an image or GIF background to commit these values\./)
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

  it("saves a media scene with the embedded source intact", async () => {
    const { bridge, user } = setup(sceneWithMedia("gif", { rotation: 20 }));
    await user.click(screen.getByRole("button", { name: "Save scene" }));
    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledTimes(1));
    const patch = bridge.saveSettings.mock.calls[0][0];
    expect(patch.scene).toBeDefined();
    expect(hardening.validateScene(patch.scene).ok).toBe(true);
    if (!patch.scene) throw new Error("scene missing");
    expect(patch.scene.background).toMatchObject({
      kind: "gif",
      source: GIF_DATA_URL,
      rotation: 20,
    });
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

  // The lower edge of the same gate: both validators require only a string
  // under the cap, so clearing the field is a legal commit — not a no-op
  // that would snap the controlled input back to the previous text.
  it("commits an empty overlay text that still passes both gates", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("button", { name: "Add text overlay" }));
    await user.clear(screen.getByLabelText("Overlay text"));
    expect(lastScene(onChange).overlays[0]).toMatchObject({ text: "" });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
  });
});

describe("background kind switching (S2-T10)", () => {
  // The switch handlers REBUILD the background per kind, so switching away
  // from media must drop source/transform keys entirely (the gate rejects
  // unknown keys per kind) and a cancelled re-import must not resurrect
  // them. Staged transform drafts live in editor state and are carried
  // across every switch into the next imported media background.
  it("walks none/color/image/gif without leaking media keys or losing staged drafts", async () => {
    const { bridge, onChange, user } = setup(
      sceneWithMedia("image", { rotation: 45 }),
      (stub) => {
        // One file per pick: GIF first, then PNG; a third pick falls back to
        // the base stub (null = cancelled dialog).
        stub.importMedia
          .mockResolvedValueOnce(GIF_DATA_URL)
          .mockResolvedValueOnce(PNG_DATA_URL);
      }
    );
    const pressed = (name: "None" | "Color" | "Image" | "GIF"): string | null =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");

    expect(pressed("Image")).toBe("true");
    expect(screen.getByLabelText("Rotation (degrees)")).toHaveValue("45");
    expect(
      screen.queryByText(/Pick an image or GIF background/)
    ).not.toBeInTheDocument();

    // image -> color: exact shape — no source, no transform keys ride along.
    await user.click(screen.getByRole("button", { name: "Color" }));
    expect(lastScene(onChange).background).toEqual({
      kind: "color",
      color: "#000000",
    });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
    expect(pressed("Color")).toBe("true");
    expect(pressed("Image")).toBe("false");
    // The transform draft stays staged and visible instead of vanishing
    // with the media background it came from.
    expect(screen.getByLabelText("Rotation (degrees)")).toHaveValue("45");
    expect(
      screen.getByText(/Pick an image or GIF background to commit these values\./)
    ).toBeInTheDocument();

    // color -> none.
    await user.click(screen.getByRole("button", { name: "None" }));
    expect(lastScene(onChange).background).toEqual({ kind: "none" });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
    expect(pressed("None")).toBe("true");

    // none -> gif: a fresh import; the staged rotation is carried in.
    await user.click(screen.getByRole("button", { name: "GIF" }));
    await waitFor(() => expect(bridge.importMedia).toHaveBeenCalledWith("gif"));
    expect(lastScene(onChange).background).toMatchObject({
      kind: "gif",
      source: GIF_DATA_URL,
      rotation: 45,
    });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
    expect(pressed("GIF")).toBe("true");

    // gif -> image: the source is REPLACED by the new pick, never merged.
    await user.click(screen.getByRole("button", { name: "Image" }));
    await waitFor(() => expect(bridge.importMedia).toHaveBeenCalledWith("image"));
    expect(lastScene(onChange).background).toMatchObject({
      kind: "image",
      source: PNG_DATA_URL,
      rotation: 45,
    });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
    expect(pressed("Image")).toBe("true");

    // image -> color drops the embedded source once more.
    await user.click(screen.getByRole("button", { name: "Color" }));
    expect(lastScene(onChange).background).toEqual({
      kind: "color",
      color: "#000000",
    });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);

    // The Once-chain is exhausted, so this pick resolves null = cancelled:
    // switching back to a media kind must NOT resurrect the dropped source.
    onChange.mockClear();
    await user.click(screen.getByRole("button", { name: "Image" }));
    await waitFor(() => expect(bridge.importMedia).toHaveBeenCalledTimes(3));
    expect(onChange).not.toHaveBeenCalled();
    expect(pressed("Color")).toBe("true");
    expect(screen.queryByText(/In use:/)).not.toBeInTheDocument();
  });
});

describe("scene round trip through App (S2-T10)", () => {
  // App owns the scene (getSettings boot load -> setScene, onSceneChange,
  // onSaved refreshing the Reset baseline). The existing App test only
  // proves the surface renders; this walks the full persisted -> edited ->
  // saved -> reset cycle through the real wiring in App.tsx.
  it("boots from the persisted scene, saves an edit, and makes that save the Reset baseline", async () => {
    const bridge = makeBridge();
    const bootScene: Scene = {
      ...DEFAULT_SCENE,
      overlays: [textOverlay("Boot line")],
    };
    bridge.getSettings = vi.fn(async () => ({
      settings: { ...DEFAULT_SETTINGS, scene: bootScene },
      spotify: { connected: false },
      startupSupported: true,
    }));
    window.lyricvision = bridge;
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(bridge.getSettings).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Scene editor" }));
    const sceneSection = screen.getByRole("region", { name: "Scene" });
    const input = within(sceneSection).getByLabelText(
      "Overlay text"
    ) as HTMLInputElement;
    // The PERSISTED scene reached the editor, not the mount-time default.
    expect(input).toHaveValue("Boot line");

    await user.clear(input);
    await user.type(input, "Saved line");
    await user.click(
      within(sceneSection).getByRole("button", { name: "Save scene" })
    );
    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledTimes(1));
    const patch = bridge.saveSettings.mock.calls[0][0];
    if (!patch.scene) throw new Error("scene missing from the save patch");
    expect(patch.scene.overlays[0]).toMatchObject({ text: "Saved line" });
    expect(hardening.validateScene(patch.scene).ok).toBe(true);

    // An unsaved edit after the save: Reset must revert to the SAVED scene,
    // which only happens if onSaved refreshed App's reset baseline.
    await user.clear(screen.getByLabelText("Overlay text"));
    await user.type(screen.getByLabelText("Overlay text"), "Draft line");
    await user.click(
      within(sceneSection).getByRole("button", { name: "Reset" })
    );
    expect(within(sceneSection).getByLabelText("Overlay text")).toHaveValue(
      "Saved line"
    );
  });
});
