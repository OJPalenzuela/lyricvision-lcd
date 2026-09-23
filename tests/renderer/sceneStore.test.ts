/**
 * S7-T20 — the Zustand scene store: actions, bounded zundo history, and
 * the history boundary (scene mutations ONLY).
 *
 * Pure store tests: no DOM, no bridge. The preview fan-out that must ride
 * along with history moves (undo/redo → scene:preview) is pinned in
 * SceneEditorUndo.test.tsx, which drives the real App wiring.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { SCENE_HISTORY_LIMIT, useSceneStore } from "@/lib/sceneStore";
import {
  DEFAULT_SCENE,
  SCENE_OVERLAYS_CAP,
  isScene,
  type Background,
  type Scene,
} from "@/lib/scene";

const state = () => useSceneStore.getState();
const history = () => useSceneStore.temporal.getState();

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

function sceneWithOverlay(text: string): Scene {
  return { ...DEFAULT_SCENE, overlays: [textOverlay(text)] };
}

function colorScene(color: string): Scene {
  return { ...DEFAULT_SCENE, background: { kind: "color", color } };
}

function basePlacement(x: number, y: number, size: number) {
  return { x, y, size };
}

beforeEach(() => {
  // Boot-equivalent reset: every test starts from the default scene with
  // an empty history, no matter what the previous test left behind.
  state().hydrate(DEFAULT_SCENE);
});

describe("scene store actions (state shape pinned)", () => {
  it("exposes exactly the scene data and the action surface", () => {
    expect(Object.keys(state()).sort()).toEqual(["addOverlay", "hydrate", "markSaved", "redo", "removeOverlay", "reorderOverlays", "resetToSaved", "savedScene", "scene", "setBackground", "setBasePlacement", "setScene", "undo", "updateOverlay"]);
  });

  it("setScene replaces the whole scene and records one history entry", () => {
    const next = colorScene("#123456");
    state().setScene(next);
    expect(state().scene).toBe(next);
    expect(isScene(state().scene)).toBe(true);
    expect(history().pastStates).toHaveLength(1);
  });

  it("updateOverlay patches placement only, leaving sibling overlays untouched", () => {
    const before: Scene = {
      ...DEFAULT_SCENE,
      overlays: [textOverlay("A"), textOverlay("B")],
    };
    state().setScene(before);

    state().updateOverlay(0, { x: 0.25, color: "#ff0000" });

    expect(state().scene.overlays[0]).toEqual({
      ...textOverlay("A"),
      x: 0.25,
      color: "#ff0000",
    });
    expect(state().scene.overlays[0]).toMatchObject({
      y: 0.5,
      size: 0.1,
      rotation: 0,
      text: "A",
    });
    // Structural sharing: the untouched sibling and the background keep
    // their exact references — only the patched overlay was rebuilt.
    expect(state().scene.overlays[1]).toBe(before.overlays[1]);
    expect(state().scene.background).toBe(before.background);

    // Out-of-range index is a no-op: same reference, no crash, no hole.
    const snapshot = state().scene;
    state().updateOverlay(9, { x: 0.1 });
    expect(state().scene).toBe(snapshot);
  });

  it("[S1] setBasePlacement is identity-guarded, structurally shares siblings, and survives overlay reorder", () => {
    const cover = basePlacement(0.5, 0.2, 0.4);
    const title = basePlacement(0.5, 0.4, 0.05);
    const before: Scene = {
      ...DEFAULT_SCENE,
      overlays: [textOverlay("A"), textOverlay("B")],
      basePlacements: { cover, title },
    };
    state().hydrate(before);

    state().setBasePlacement("cover", { ...cover });
    expect(state().scene).toBe(before);
    expect(state().scene.basePlacements).toBe(before.basePlacements);
    expect(history().pastStates).toHaveLength(0);

    const lyrics = basePlacement(0.2, 0.8, 0.06);
    state().setBasePlacement("lyrics", lyrics);
    expect(state().scene.basePlacements).toEqual({ cover, title, lyrics });
    expect(state().scene.basePlacements?.cover).toBe(cover);
    expect(state().scene.basePlacements?.title).toBe(title);
    expect(state().scene.overlays).toBe(before.overlays);
    expect(isScene(state().scene)).toBe(true);
    expect(history().pastStates).toHaveLength(1);

    const placements = state().scene.basePlacements;
    state().reorderOverlays(1, 0);
    expect(state().scene.basePlacements).toBe(placements);
    expect(state().scene.basePlacements).toEqual({ cover, title, lyrics });
    expect(history().pastStates).toHaveLength(2);
  });

  it("[S1b] setBasePlacement rebuilds the scene and placement map but preserves background identity", () => {
    const background = { kind: "color", color: "#123456" } as const;
    const before: Scene = {
      ...DEFAULT_SCENE,
      background,
      basePlacements: { cover: basePlacement(0.5, 0.2, 0.4) },
    };
    state().hydrate(before);

    state().setBasePlacement("cover", basePlacement(0.6, 0.3, 0.5));

    expect(state().scene).not.toBe(before);
    expect(state().scene.background).toBe(background);
    expect(state().scene.basePlacements).not.toBe(before.basePlacements);
    expect(state().scene.basePlacements?.cover).toEqual(
      basePlacement(0.6, 0.3, 0.5)
    );
    expect(history().pastStates).toHaveLength(1);
  });

  it("addOverlay appends the default text overlay and enforces the cap", () => {
    const only = sceneWithOverlay("Only");
    state().setScene(only);
    state().addOverlay();

    expect(state().scene.overlays).toHaveLength(2);
    expect(state().scene.overlays[0]).toBe(only.overlays[0]);
    expect(state().scene.overlays[1]).toEqual({
      kind: "text",
      text: "New overlay",
      x: 0.5,
      y: 0.5,
      size: 0.1,
      rotation: 0,
      color: "#ffffff",
    });
    expect(isScene(state().scene)).toBe(true);

    // At the schema cap: no growth, no history entry, scene untouched.
    const full: Scene = {
      ...DEFAULT_SCENE,
      overlays: Array.from({ length: SCENE_OVERLAYS_CAP }, (_, i) =>
        textOverlay(`T${i}`)
      ),
    };
    state().hydrate(full);
    const atCap = state().scene;
    state().addOverlay();
    expect(state().scene).toBe(atCap);
    expect(state().scene.overlays).toHaveLength(SCENE_OVERLAYS_CAP);
    expect(history().pastStates).toHaveLength(0);
  });

  it("removeOverlay removes the indexed overlay and ignores out-of-range indexes", () => {
    const before: Scene = {
      ...DEFAULT_SCENE,
      overlays: [textOverlay("A"), textOverlay("B")],
    };
    state().setScene(before);

    state().removeOverlay(0);
    expect(state().scene.overlays).toHaveLength(1);
    expect(state().scene.overlays[0]).toBe(before.overlays[1]);

    const snapshot = state().scene;
    state().removeOverlay(5);
    expect(state().scene).toBe(snapshot);
    expect(isScene(state().scene)).toBe(true);
  });

  it("setBackground swaps the background and keeps the overlay list", () => {
    const withOverlay = sceneWithOverlay("Keep me");
    state().setScene(withOverlay);

    const bg: Background = { kind: "color", color: "#aabbcc" };
    state().setBackground(bg);

    expect(state().scene.background).toBe(bg);
    expect(state().scene.overlays).toBe(withOverlay.overlays);
    expect(isScene(state().scene)).toBe(true);
  });
});

describe("undo/redo round trip", () => {
  it("mutate → undo → prior snapshot → redo → mutation", () => {
    const a = sceneWithOverlay("A");
    const b = sceneWithOverlay("B");
    const c = sceneWithOverlay("C");
    state().hydrate(a);
    state().setScene(b);
    state().setScene(c);
    expect(history().pastStates).toHaveLength(2);
    expect(history().futureStates).toHaveLength(0);

    state().undo();
    expect(state().scene).toBe(b); // exact snapshot restored, not a rebuild
    expect(history().futureStates).toHaveLength(1);

    state().redo();
    expect(state().scene).toBe(c);
    expect(history().futureStates).toHaveLength(0);

    state().undo();
    state().undo();
    expect(state().scene).toBe(a); // back at the hydrated root
    expect(history().pastStates).toHaveLength(0);

    state().redo();
    state().redo();
    expect(state().scene).toBe(c);
  });

  it("undo/redo are no-ops at the ends of history", () => {
    const root = state().scene;
    state().undo();
    expect(state().scene).toBe(root);
    state().redo();
    expect(state().scene).toBe(root);
    expect(history().pastStates).toHaveLength(0);
    expect(history().futureStates).toHaveLength(0);
  });
});

describe("history boundary (scene mutations only)", () => {
  it("markSaved updates the Reset baseline without creating history", () => {
    const a = sceneWithOverlay("A");
    state().hydrate(a);

    const saved = colorScene("#ff0000");
    state().markSaved(saved);

    expect(state().savedScene).toBe(saved);
    expect(state().scene).toBe(a); // the live scene did not move
    expect(history().pastStates).toHaveLength(0); // persistence is not an undoable edit
  });

  it("resetToSaved is a scene mutation and is itself undoable", () => {
    const saved = colorScene("#00ff00");
    state().hydrate(saved);
    const draft = sceneWithOverlay("Draft");
    state().setScene(draft);

    state().resetToSaved();
    expect(state().scene).toBe(saved);
    expect(history().pastStates).toHaveLength(2);

    state().undo();
    expect(state().scene).toBe(draft); // the pre-reset draft comes back
  });

  it("hydrate installs the new baseline and clears history (boot is not undoable)", () => {
    state().setScene(colorScene("#111111"));
    expect(history().pastStates).toHaveLength(1);

    const boot = sceneWithOverlay("Boot");
    state().hydrate(boot);

    expect(state().scene).toBe(boot);
    expect(state().savedScene).toBe(boot);
    expect(history().pastStates).toHaveLength(0);
    expect(history().futureStates).toHaveLength(0);
  });
});

describe("bounded history", () => {
  it("evicts the oldest entries beyond SCENE_HISTORY_LIMIT", () => {
    state().hydrate(DEFAULT_SCENE);
    const tag = (i: number): Scene => sceneWithOverlay(`s${i}`);
    const total = SCENE_HISTORY_LIMIT + 10; // 60 committed edits
    for (let i = 0; i < total; i += 1) state().setScene(tag(i));

    expect(SCENE_HISTORY_LIMIT).toBe(50);
    expect(history().pastStates).toHaveLength(SCENE_HISTORY_LIMIT);

    for (let i = 0; i < SCENE_HISTORY_LIMIT; i += 1) state().undo();

    // Unbounded, past would hold [DEFAULT, s0..s58]; the limit keeps only
    // the newest 50 ([s9..s58]), so the deepest reachable state is s9 —
    // the mount default and s0..s8 were evicted for good.
    expect(state().scene).toEqual(
      tag(total - SCENE_HISTORY_LIMIT - 1) // s9
    );
    expect(history().pastStates).toHaveLength(0);

    const deepest = state().scene;
    state().undo(); // nothing left to apply: must NOT drift any further
    expect(state().scene).toBe(deepest);

    expect(history().futureStates).toHaveLength(SCENE_HISTORY_LIMIT);
  });
});
