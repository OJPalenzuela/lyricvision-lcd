/**
 * S7-T22 — `reorderOverlays` store action (TDD: written BEFORE the action
 * existed; the pre-implementation run fails with the action missing).
 *
 * Pins:
 *  1. a reorder moves ONE overlay from `from` to `to` while PRESERVING the
 *     object identity of every overlay (the selection remap and the React/
 *     Konva positional keys both rely on reference stability);
 *  2. one reorder call records exactly ONE history entry, and a single undo
 *     restores the prior order (zundo snapshots the scene slice);
 *  3. same-index / out-of-range calls are typed no-ops: no new scene
 *     reference, no history entry (reference equality stays the gate);
 *  4. a reorder never changes the overlay count — cap logic is unaffected.
 */
import { describe, expect, it } from "vitest";

import {
  SCENE_VERSION,
  type Scene,
  type TextOverlay,
} from "@/lib/scene";
import { useSceneStore } from "@/lib/sceneStore";

const text = (label: string): TextOverlay => ({
  kind: "text",
  text: label,
  x: 0.5,
  y: 0.5,
  size: 0.1,
  rotation: 0,
  color: "#ffffff",
});

const makeScene = (): Scene => ({
  version: SCENE_VERSION,
  background: { kind: "none" },
  overlays: [text("A"), text("B"), text("C")],
});

const history = () => useSceneStore.temporal.getState();

describe("sceneStore.reorderOverlays", () => {
  it("moves one overlay to the target index, preserving object identity", () => {
    const scene = makeScene();
    useSceneStore.getState().hydrate(scene);
    const [a, b, c] = scene.overlays;

    useSceneStore.getState().reorderOverlays(0, 2);

    const after = useSceneStore.getState().scene.overlays;
    expect(after.map((o) => (o.kind === "text" ? o.text : ""))).toEqual([
      "B",
      "C",
      "A",
    ]);
    expect(after[0]).toBe(b);
    expect(after[1]).toBe(c);
    expect(after[2]).toBe(a);
  });

  it("records exactly ONE history entry per reorder; one undo restores", () => {
    useSceneStore.getState().hydrate(makeScene());

    useSceneStore.getState().reorderOverlays(2, 0);

    expect(history().pastStates).toHaveLength(1);

    useSceneStore.getState().undo();
    expect(
      useSceneStore.getState().scene.overlays.map((o) =>
        o.kind === "text" ? o.text : ""
      )
    ).toEqual(["A", "B", "C"]);
    expect(history().pastStates).toHaveLength(0);
    expect(history().futureStates).toHaveLength(1);
  });

  it("same-index and out-of-range calls are no-ops (no entry)", () => {
    useSceneStore.getState().hydrate(makeScene());
    const before = useSceneStore.getState().scene;

    useSceneStore.getState().reorderOverlays(0, 0);
    useSceneStore.getState().reorderOverlays(-1, 1);
    useSceneStore.getState().reorderOverlays(0, 99);
    useSceneStore.getState().reorderOverlays(99, 0);

    expect(useSceneStore.getState().scene).toBe(before);
    expect(history().pastStates).toHaveLength(0);
  });

  // Cap enforcement at the schema boundary is pinned in sceneStore.test.ts
  // ("addOverlay appends the default text overlay and enforces the cap").
  it("never changes the overlay count across moves", () => {
    useSceneStore.getState().hydrate(makeScene());

    useSceneStore.getState().reorderOverlays(1, 0);
    useSceneStore.getState().reorderOverlays(0, 2);

    expect(useSceneStore.getState().scene.overlays).toHaveLength(3);
    expect(history().pastStates).toHaveLength(2);
  });
});
