import { useState } from "react";
import type { ReactNode } from "react";
import { createRequire } from "node:module";
import { describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "@/App";
import SceneEditor from "@/components/SceneEditor";
import type { LyricvisionBridge, StoredSettings } from "@/lib/bridge";
import {
  DEFAULT_SCENE,
  type MediaBackgroundKind,
  type Scene,
} from "@/lib/scene";

/**
 * S7-T19 — TRCC-style persistent side rail for the scene editor.
 *
 * What this suite pins down (written BEFORE the implementation, TDD):
 *  1. the rail renders in App on boot and the old "Scene editor" button
 *     gate is GONE — sections are reachable with zero toggling;
 *  2. rail clicks switch the visible panel, and ONLY the active panel's
 *     controls are mounted (a nav that never swaps content fails here);
 *  3. the relocated controls still drive the scene end to end —
 *     background kind + media import (Fondo), overlay add (Capas),
 *     inspector edits (Propiedades) — so moving the UI lost nothing;
 *  4. Save/Reset live in the always-visible main area from any section.
 *
 * MOTION IN JSDOM (honest mock): SceneEditor animates panel swaps with
 * motion/react (AnimatePresence + motion.div). jsdom implements no Web
 * Animations API, so this file replaces "motion/react" with a
 * passthrough: AnimatePresence renders its children directly and
 * motion.div renders a plain <div>, forwarding className/role/aria-label
 * and dropping only the motion-only props (initial/animate/exit/
 * transition). This is coverage, not a bypass: every assertion below
 * reads controls that must travel THROUGH that wrapper — if the motion
 * layer swallowed panel content, tests 1-4 could not find a single
 * control and would fail.
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
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    motion: {
      div: ({
        children,
        className,
        role,
        "aria-label": ariaLabel,
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
      }: PanelProps) => (
        <div className={className} role={role} aria-label={ariaLabel}>
          {children}
        </div>
      ),
    },
  };
});

const requireNative = createRequire(import.meta.url);
interface HardeningGate {
  validateScene(input: unknown): { ok: boolean; field?: string; error?: string };
}
const hardening = requireNative("../../src/hardening.js") as HardeningGate;

// Pillow-verified 1x1 PNG fixture (same bytes as SceneEditor.test.tsx):
// real data, so validateScene runs against an embeddable source.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgEpEDAABoAD1UCKP3AAAAAElFTkSuQmCC";

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
    importMedia: vi.fn(async () => PNG_DATA_URL),
  };
}

/** Mirrors the App wiring: the scene lives in parent state. */
function Harness({
  initial,
  onChange,
  onReset,
}: {
  initial: Scene;
  onChange: (scene: Scene) => void;
  onReset: () => void;
}) {
  const [scene, setScene] = useState(initial);
  return (
    <SceneEditor
      scene={scene}
      onSceneChange={(next) => {
        setScene(next);
        onChange(next);
      }}
      onReset={onReset}
    />
  );
}

function setup(initial: Scene = DEFAULT_SCENE) {
  const bridge = makeBridge();
  window.lyricvision = bridge;
  const onChange = vi.fn<(scene: Scene) => void>();
  const onReset = vi.fn<() => void>();
  const user = userEvent.setup();
  render(
    <Harness initial={initial} onChange={onChange} onReset={onReset} />
  );
  return { bridge, onChange, onReset, user };
}

function lastScene(onChange: Mock<(scene: Scene) => void>): Scene {
  return onChange.mock.calls[onChange.mock.calls.length - 1][0];
}

function sceneWithOverlay(): Scene {
  return {
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
}

describe("persistent side rail (no button gate)", () => {
  it("renders the rail on boot in App with no Scene editor button anywhere", async () => {
    const bridge = makeBridge();
    window.lyricvision = bridge;
    render(<App />);
    await waitFor(() => expect(bridge.getSettings).toHaveBeenCalled());

    // The old enter/exit edit mode is gone: no toggle exists to press.
    expect(
      screen.queryByRole("button", { name: "Scene editor" })
    ).not.toBeInTheDocument();

    const rail = screen.getByRole("navigation", { name: "Scene sections" });
    for (const label of ["Fondo", "Capas", "Propiedades"]) {
      expect(within(rail).getByRole("button", { name: label })).toBeInTheDocument();
    }

    // First section's controls are live without toggling anything, and
    // the live preview mounts with no gate click in between.
    expect(screen.getByRole("button", { name: "None" })).toBeInTheDocument();
    await screen.findByAltText("Scene preview", {}, { timeout: 3000 });
  });

  it("switches panels on rail clicks: only the active section's controls mount", async () => {
    const { user } = setup(sceneWithOverlay());

    // Boot = Fondo: background controls here, the other panels absent.
    expect(screen.getByRole("region", { name: "Fondo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "None" })).toBeInTheDocument();
    expect(screen.getByLabelText("Rotation (degrees)")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add text overlay" })
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Overlay X (0-1)")).not.toBeInTheDocument();

    // Capas mounts the overlay list and unmounts Fondo.
    await user.click(screen.getByRole("button", { name: "Capas" }));
    expect(screen.getByRole("region", { name: "Capas" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Fondo" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add text overlay" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overlay 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "None" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Overlay X (0-1)")).not.toBeInTheDocument();

    // Propiedades mounts the inspector for the selected overlay.
    await user.click(screen.getByRole("button", { name: "Propiedades" }));
    expect(
      screen.getByRole("region", { name: "Propiedades" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Capas" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Overlay text")).toBeInTheDocument();
    expect(screen.getByLabelText("Overlay X (0-1)")).toBeInTheDocument();
    expect(screen.getByLabelText("Overlay color")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add text overlay" })
    ).not.toBeInTheDocument();

    // And back: the rail is a switch, not a one-way trip.
    await user.click(screen.getByRole("button", { name: "Fondo" }));
    expect(screen.getByRole("region", { name: "Fondo" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Overlay X (0-1)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "None" })).toBeInTheDocument();
  });

  it("drives the scene from relocated controls in every section", async () => {
    const { bridge, onChange, user } = setup();

    // Fondo: background kind switch + media import still commit.
    await user.click(screen.getByRole("button", { name: "Image" }));
    await waitFor(() =>
      expect(bridge.importMedia).toHaveBeenCalledWith("image")
    );
    await waitFor(() =>
      expect(lastScene(onChange).background).toMatchObject({
        kind: "image",
        source: PNG_DATA_URL,
      })
    );
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);

    await user.click(screen.getByRole("button", { name: "Color" }));
    expect(lastScene(onChange).background).toEqual({
      kind: "color",
      color: "#000000",
    });

    // Capas: adding an overlay still commits through the scene setter.
    await user.click(screen.getByRole("button", { name: "Capas" }));
    await user.click(screen.getByRole("button", { name: "Add text overlay" }));
    expect(lastScene(onChange).overlays).toHaveLength(1);

    // Propiedades: inspector edits commit exactly as before the move.
    await user.click(screen.getByRole("button", { name: "Propiedades" }));
    await user.clear(screen.getByLabelText("Overlay text"));
    await user.type(screen.getByLabelText("Overlay text"), "Rail works");
    expect(lastScene(onChange).overlays[0]).toMatchObject({
      kind: "text",
      text: "Rail works",
    });

    const x = screen.getByLabelText("Overlay X (0-1)") as HTMLInputElement;
    fireEvent.change(x, { target: { value: "0.75" } });
    expect(lastScene(onChange).overlays[0]).toMatchObject({ x: 0.75 });
    expect(hardening.validateScene(lastScene(onChange)).ok).toBe(true);
  });

  it("keeps Save and Reset reachable in the main area from every section", async () => {
    const { bridge, onReset, user } = setup();

    // Boot (Fondo active): both actions are already reachable.
    expect(screen.getByRole("button", { name: "Save scene" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save scene" }));
    await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledTimes(1));
    expect(bridge.saveSettings.mock.calls[0][0].scene).toBeDefined();

    // Switching sections must not hide the persistence actions.
    await user.click(screen.getByRole("button", { name: "Capas" }));
    expect(screen.getByRole("button", { name: "Save scene" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Propiedades" }));
    expect(screen.getByRole("button", { name: "Save scene" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });
});
