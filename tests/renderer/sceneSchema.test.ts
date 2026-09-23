import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCENE,
  SCENE_MAX_TEXT_CHARS,
  SCENE_MEDIA_SOURCE_MAX_CHARS,
  SCENE_OVERLAYS_CAP,
  type Scene,
} from "@/lib/scene";
import {
  editorSceneSchema,
  observeOverlays,
  sceneSchema,
  validateSceneForEditor,
  validateSceneForModel,
} from "@/lib/sceneSchema";

const textOverlay = (text = "Hello"): Scene["overlays"][number] => ({
  kind: "text",
  text,
  x: 0.5,
  y: 0.5,
  size: 0.1,
  rotation: 0,
  color: "#ffffff",
});

const mediaBackground = (
  kind: "image" | "gif" | "video" = "image"
): Scene["background"] => ({
  kind,
  source: "media/sample.png",
  rotation: 0,
  flipH: false,
  scale: 1,
  panX: 0,
  panY: 0,
  fit: "fit",
});

const sceneWithOverlay = (
  patch: Partial<Scene["overlays"][number]> = {}
): Scene => ({
  version: 1,
  background: { kind: "none" },
  overlays: [{ ...textOverlay(), ...patch }],
});

describe("scene Zod schema", () => {
  it("accepts the default scene and keeps the text cap pinned at 4096", () => {
    expect(sceneSchema.safeParse(DEFAULT_SCENE).success).toBe(true);
    expect(SCENE_MAX_TEXT_CHARS).toBe(4096);
    expect(
      sceneSchema.safeParse(sceneWithOverlay({ text: "a".repeat(4096) })).success
    ).toBe(true);
  });

  it("accepts the optional keyed base-placement map", () => {
    const scene = {
      ...DEFAULT_SCENE,
      basePlacements: {
        cover: { x: 0.2, y: 0.8, size: 0.2 },
        title: { x: 0.8, y: 0.1, size: 0.05 },
        artist: { x: 0.2, y: 0.9, size: 0.04 },
        progress: { x: 0.2, y: 0.1, size: 0.3 },
        lyrics: { x: 0.2, y: 0.9, size: 0.08 },
      },
    };
    expect(sceneSchema.safeParse(scene).success).toBe(true);
    expect(validateSceneForModel(scene).success).toBe(true);
    expect(sceneSchema.safeParse({ ...DEFAULT_SCENE, basePlacements: {} }).success).toBe(
      true
    );
  });

  it.each([
    ["non-object map", null, "basePlacements"],
    ["array map", [], "basePlacements"],
    ["unknown widget", { unknown: { x: 0.5, y: 0.5, size: 0.1 } }, "basePlacements"],
    ["missing size", { cover: { x: 0.5, y: 0.5 } }, "basePlacements.cover.size"],
    ["x above one", { cover: { x: 1.1, y: 0.5, size: 0.1 } }, "basePlacements.cover.x"],
    ["y below zero", { cover: { x: 0.5, y: -0.1, size: 0.1 } }, "basePlacements.cover.y"],
    ["NaN size", { cover: { x: 0.5, y: 0.5, size: Number.NaN } }, "basePlacements.cover.size"],
    ["extra key", { cover: { x: 0.5, y: 0.5, size: 0.1, extra: true } }, "basePlacements.cover"],
    ["rotation", { cover: { x: 0.5, y: 0.5, size: 0.1, rotation: 90 } }, "basePlacements.cover"],
  ])("rejects malformed base placements: %s", (_name, basePlacements, path) => {
    const scene = { ...DEFAULT_SCENE, basePlacements };
    const result = sceneSchema.safeParse(scene);
    expect(result.success).toBe(false);
    expect(validateSceneForModel(scene).success).toBe(false);
    expect(validateSceneForModel(scene)).toEqual({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path }),
      ]),
    });
  });

  it.each([
    ["x", 1.5],
    ["y", -0.1],
    ["size", Number.NaN],
  ])("rejects an out-of-range overlay %s", (field, value) => {
    const scene = sceneWithOverlay({ [field]: value });
    const result = sceneSchema.safeParse(scene);
    expect(result.success).toBe(false);
    expect(validateSceneForEditor(scene).success).toBe(false);
  });

  it("rejects text over the cross-language cap", () => {
    const result = sceneSchema.safeParse(
      sceneWithOverlay({ text: "a".repeat(SCENE_MAX_TEXT_CHARS + 1) })
    );
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["overlays", 0, "text"] }),
      ])
    );
  });

  it("rejects unknown overlay and background discriminants", () => {
    expect(
      sceneSchema.safeParse({
        version: 1,
        background: { kind: "none" },
        overlays: [{ ...textOverlay(), kind: "unknown" }],
      }).success
    ).toBe(false);
    expect(
      sceneSchema.safeParse({
        version: 1,
        background: { kind: "unknown" },
        overlays: [],
      }).success
    ).toBe(false);
  });

  it("rejects extra keys, invalid enums, and non-finite numbers", () => {
    expect(
      sceneSchema.safeParse({
        ...DEFAULT_SCENE,
        extra: true,
      }).success
    ).toBe(false);
    expect(
      sceneSchema.safeParse({
        ...DEFAULT_SCENE,
        background: {
          ...mediaBackground(),
          fit: "stretch",
        },
      }).success
    ).toBe(false);
    expect(
      sceneSchema.safeParse(sceneWithOverlay({ rotation: Number.POSITIVE_INFINITY }))
        .success
    ).toBe(false);
  });

  it("keeps the model rotation rule finite while the editor clamp rejects out-of-range edits", () => {
    const scene = sceneWithOverlay({ rotation: 361 });
    // The frozen scene model and IPC gate require finite rotation, not a
    // narrower persisted-value range. The editor-specific schema owns the
    // existing [-360, 360] control clamp.
    expect(sceneSchema.safeParse(scene).success).toBe(true);
    expect(editorSceneSchema.safeParse(scene).success).toBe(false);
  });

  it("accepts every declared background kind and rejects media field violations", () => {
    for (const kind of ["image", "gif", "video"] as const) {
      expect(
        sceneSchema.safeParse({
          version: 1,
          background: mediaBackground(kind),
          overlays: [],
        }).success
      ).toBe(true);
    }
    expect(
      sceneSchema.safeParse({
        version: 1,
        background: { ...mediaBackground(), source: "" },
        overlays: [],
      }).success
    ).toBe(false);
    expect(
      sceneSchema.safeParse({
        version: 1,
        background: { ...mediaBackground(), scale: 0 },
        overlays: [],
      }).success
    ).toBe(false);
    expect(
      sceneSchema.safeParse({
        version: 1,
        background: { ...mediaBackground(), panX: Number.NaN },
        overlays: [],
      }).success
    ).toBe(false);
  });

  it("rejects media NUL, both slash traversal forms, and the source cap", () => {
    for (const source of ["media/\u0000.png", "media/../sample.png", "media\\..\\sample.png"]) {
      expect(
        sceneSchema.safeParse({
          version: 1,
          background: { ...mediaBackground(), source },
          overlays: [],
        }).success
      ).toBe(false);
    }
    expect(
      sceneSchema.safeParse({
        version: 1,
        background: {
          ...mediaBackground(),
          source: "x".repeat(SCENE_MEDIA_SOURCE_MAX_CHARS + 1),
        },
        overlays: [],
      }).success
    ).toBe(false);
  });

  it("rejects non-boolean flipH and non-finite rotation", () => {
    expect(
      sceneSchema.safeParse({
        version: 1,
        background: { ...mediaBackground(), flipH: "false" },
        overlays: [],
      }).success
    ).toBe(false);
    for (const rotation of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        sceneSchema.safeParse({
          version: 1,
          background: { ...mediaBackground(), rotation },
          overlays: [],
        }).success
      ).toBe(false);
    }
  });

  it("rejects negative and non-finite scale and non-finite panY", () => {
    for (const scale of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        sceneSchema.safeParse({
          version: 1,
          background: { ...mediaBackground(), scale },
          overlays: [],
        }).success
      ).toBe(false);
    }
    expect(
      sceneSchema.safeParse({
        version: 1,
        background: { ...mediaBackground(), panY: Number.NaN },
        overlays: [],
      }).success
    ).toBe(false);
  });

  it("does not mutate sparse or decorated arrays while preprocessing", () => {
    const issues: { path: PropertyKey[]; message: string }[] = [];
    const context: Parameters<typeof observeOverlays>[1] = {
      addIssue: (issue) => {
        issues.push({ path: issue.path, message: issue.message });
      },
    };

    const sparse: Scene["overlays"] = [];
    sparse[0] = textOverlay();
    sparse[2] = textOverlay();
    const sparseReference = sparse;
    const sparseReturned = observeOverlays(sparse, context);
    expect(sparseReturned).toBe(sparseReference);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: [1], message: "Overlays must not contain holes." }),
      ])
    );
    const sparseScene = { version: 1, background: { kind: "none" }, overlays: sparse };
    expect(sceneSchema.safeParse(sparseScene).success).toBe(false);
    expect(sparseScene.overlays).toBe(sparseReference);
    expect(sparse).toBe(sparseReference);
    expect(1 in sparse).toBe(false);

    issues.length = 0;
    const decorated: Scene["overlays"] = [textOverlay()];
    Object.assign(decorated, { unexpected: true });
    const decoratedReference = decorated;
    const decoratedReturned = observeOverlays(decorated, context);
    expect(decoratedReturned).toBe(decoratedReference);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["unexpected"],
          message: "Overlays must not define the non-index property 'unexpected'.",
        }),
      ])
    );
    const decoratedScene = {
      version: 1,
      background: { kind: "none" },
      overlays: decorated,
    };
    expect(sceneSchema.safeParse(decoratedScene).success).toBe(false);
    expect(decoratedScene.overlays).toBe(decoratedReference);
    expect(decorated).toBe(decoratedReference);
    expect(Object.prototype.hasOwnProperty.call(decorated, "unexpected")).toBe(true);
    expect(decorated.unexpected).toBe(true);
  });

  it("mirrors the overlay cap and rejects sparse or decorated arrays", () => {
    const atCap = Array.from({ length: SCENE_OVERLAYS_CAP }, () => textOverlay());
    expect(
      sceneSchema.safeParse({ version: 1, background: { kind: "none" }, overlays: atCap })
        .success
    ).toBe(true);
    expect(
      sceneSchema.safeParse({
        version: 1,
        background: { kind: "none" },
        overlays: [...atCap, textOverlay()],
      }).success
    ).toBe(false);

    const sparse: Scene["overlays"] = [];
    sparse[0] = textOverlay();
    sparse[2] = textOverlay();
    expect(
      sceneSchema.safeParse({ version: 1, background: { kind: "none" }, overlays: sparse })
        .success
    ).toBe(false);
    const decorated: Scene["overlays"] = [textOverlay()];
    Object.assign(decorated, { unexpected: true });
    expect(
      sceneSchema.safeParse({ version: 1, background: { kind: "none" }, overlays: decorated })
        .success
    ).toBe(false);
  });

  it("does not coerce strings or silently strip unknown fields", () => {
    const result = sceneSchema.safeParse({
      version: 1,
      background: { kind: "none", unexpected: true },
      overlays: [],
    });
    expect(result.success).toBe(false);
    expect(sceneSchema.safeParse({ ...DEFAULT_SCENE, version: "1" }).success).toBe(
      false
    );
  });
});
