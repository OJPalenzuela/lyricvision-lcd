/**
 * Scene store (S7-T20) — the single source of truth for the scene.
 *
 * WHY THIS EXISTS: the scene used to live in App component state; moving it
 * into a Zustand store makes it reachable from anywhere without prop
 * drilling, and the zundo `temporal` middleware buys bounded undo/redo over
 * exactly the data users think of as "the scene".
 *
 * HISTORY BOUNDARY (scene mutations only): `partialize` snapshots ONLY the
 * `scene` slice. The Reset baseline (`savedScene`) is excluded because
 * persistence is not an undoable edit. Transient editor UI — rail section,
 * overlay selection, drag-in-progress ghost, hover, numeric input drafts,
 * preview bytes, status copy — never enters this store at all: it stays
 * component-local in SceneEditor.tsx, so it cannot create history entries
 * by construction. What IS undoable: every scene mutation, including
 * background switches and media imports (they commit through `setScene`),
 * plus `resetToSaved` (a scene mutation like any other).
 *
 * PREVIEW RE-EMISSION (why history moves reach the panel): undo/redo restore
 * `scene` as a NEW reference through the store's normal `set` path. App's
 * `useSceneStore((s) => s.scene)` selector sees that change, re-renders, and
 * SceneEditor's `[scene]` effect re-arms its EXISTING debounce —
 * PREVIEW_DEBOUNCE_MS (250 ms) in SceneEditor.tsx, the one timing source —
 * which calls `bridge.previewScene`. The fan-out is keyed off the scene
 * VALUE, not off who changed it, so history navigation pushes the preview
 * exactly like a manual edit, with no second debounce constant to drift.
 *
 * SECURITY: this store is NOT a validation gate. hardening.validateScene
 * (main) and validate_scene (Python) remain the authorities; the store only
 * enforces structural sanity for its own helpers (index bounds, overlay cap).
 */
import { create, useStore, type StoreApi } from "zustand";
import { temporal, type TemporalState } from "zundo";

import {
  DEFAULT_SCENE,
  SCENE_OVERLAYS_CAP,
  type Background,
  type Overlay,
  type OverlayPlacement,
  type Scene,
} from "@/lib/scene";

/**
 * Bounded history: 50 committed scene mutations (enough for a long editing
 * session; small enough that snapshots — media data: URLs included — stay a
 * bounded memory cost). Oldest entries evict first (zundo `limit`).
 */
export const SCENE_HISTORY_LIMIT = 50;

interface SceneStoreState {
  /** The live scene — App wires it into SceneEditor's props contract. */
  scene: Scene;
  /** Last PERSISTED scene (boot load or successful save): the Reset baseline. */
  savedScene: Scene;
  /** Replace the scene wholesale — the props-facade commit path. */
  setScene(next: Scene): void;
  /** Patch one overlay's shared placement (x/y/size/rotation/color). */
  updateOverlay(index: number, patch: Partial<OverlayPlacement>): void;
  /** Append an overlay (defaults to the standard new text overlay). */
  addOverlay(overlay?: Overlay): void;
  /** Remove the overlay at `index` (out of range = no-op). */
  removeOverlay(index: number): void;
  /** Swap the background, keeping overlays. */
  setBackground(next: Background): void;
  /** Boot load: install scene + Reset baseline AND clear history (root). */
  hydrate(scene: Scene): void;
  /** Move the Reset baseline after a successful save (not undoable). */
  markSaved(scene: Scene): void;
  /** Reset reverts to the last persisted scene (itself undoable). */
  resetToSaved(): void;
  /** Step back one scene mutation (no-op at the history root). */
  undo(): void;
  /** Step forward one scene mutation (no-op with an empty redo stack). */
  redo(): void;
}

/** The slice zundo snapshots — see the history boundary above. */
export type SceneHistorySnapshot = Pick<SceneStoreState, "scene">;

/** The overlay `addOverlay` creates when called without an argument. */
const DEFAULT_NEW_OVERLAY: Overlay = {
  kind: "text",
  text: "New overlay",
  x: 0.5,
  y: 0.5,
  size: 0.1,
  rotation: 0,
  color: "#ffffff",
};

/**
 * Accessor for zundo's temporal store. WHY the explicit return type: the
 * store's own actions (undo/redo/hydrate) need it during initialization,
 * and annotating the return type breaks what would otherwise be a circular
 * type inference through `useSceneStore`'s initializer (TS7022).
 */
const temporalApi = (): StoreApi<TemporalState<SceneHistorySnapshot>> =>
  useSceneStore.temporal;

export const useSceneStore = create<SceneStoreState>()(
  temporal(
    (set, get) => ({
      scene: DEFAULT_SCENE,
      savedScene: DEFAULT_SCENE,

      setScene: (next) => set({ scene: next }),

      updateOverlay: (index, patch) =>
        set((state) => {
          const existing = state.scene.overlays[index];
          // Out-of-range index: typed no-op, never a hole or a crash.
          if (!existing) return {};
          return {
            scene: {
              ...state.scene,
              overlays: state.scene.overlays.map((overlay, i) =>
                i === index ? { ...overlay, ...patch } : overlay
              ),
            },
          };
        }),

      addOverlay: (overlay) =>
        set((state) => {
          // Mirror the schema cap: a helper must not be able to build a
          // scene the validator would reject.
          if (state.scene.overlays.length >= SCENE_OVERLAYS_CAP) return {};
          return {
            scene: {
              ...state.scene,
              overlays: [
                ...state.scene.overlays,
                overlay ?? { ...DEFAULT_NEW_OVERLAY },
              ],
            },
          };
        }),

      removeOverlay: (index) =>
        set((state) => {
          if (index < 0 || index >= state.scene.overlays.length) return {};
          return {
            scene: {
              ...state.scene,
              overlays: state.scene.overlays.filter((_, i) => i !== index),
            },
          };
        }),

      setBackground: (next) =>
        set((state) => ({ scene: { ...state.scene, background: next } })),

      // why: the boot/persisted scene is the NEW root of history — clearing
      // makes it impossible for the first Ctrl+Z after launch to "undo" back
      // to the mount-time default the user never edited.
      hydrate: (scene) => {
        set({ scene, savedScene: scene });
        temporalApi().getState().clear();
      },

      // why: saving moves the Reset baseline, not the scene — with the
      // scene-only partialize + reference equality below, no history entry
      // is recorded (persistence is not an undoable edit).
      markSaved: (scene) => set({ savedScene: scene }),

      resetToSaved: () => set({ scene: get().savedScene }),

      // why (preview re-emission): these route through zundo's temporal
      // store, which restores `scene` as a NEW reference via the normal
      // `set` path — that is what re-triggers App's selector re-render and
      // SceneEditor's existing 250 ms preview debounce (see the file
      // header). History navigation therefore pushes scene:preview exactly
      // like a manual edit, deliberately keyed off the scene value.
      undo: () => temporalApi().getState().undo(),
      redo: () => temporalApi().getState().redo(),
    }),
    {
      // why (history boundary): snapshot ONLY the scene slice; savedScene
      // is bookkeeping, transient UI never lives here (see file header).
      partialize: (state: SceneStoreState): SceneHistorySnapshot => ({
        scene: state.scene,
      }),
      // why: zundo v2 records on EVERY set by default — without this,
      // bookkeeping sets with an unchanged scene reference (e.g. markSaved)
      // would push no-op entries. Reference equality is the right semantic
      // because every mutation builds a NEW scene object; an unchanged
      // reference means nothing undoable happened.
      equality: (pastState: SceneHistorySnapshot, currentState: SceneHistorySnapshot) =>
        pastState.scene === currentState.scene,
      limit: SCENE_HISTORY_LIMIT,
    }
  )
);

/** Reactive "undo history exists" for button disabled states. */
export function useCanUndo(): boolean {
  return useStore(useSceneStore.temporal, (state) => state.pastStates.length > 0);
}

/** Reactive "redo history exists" for button disabled states. */
export function useCanRedo(): boolean {
  return useStore(
    useSceneStore.temporal,
    (state) => state.futureStates.length > 0
  );
}
