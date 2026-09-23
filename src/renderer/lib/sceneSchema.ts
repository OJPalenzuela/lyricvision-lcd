import { z } from "zod";

import {
  SCENE_MAX_TEXT_CHARS,
  SCENE_MEDIA_SOURCE_MAX_CHARS,
  SCENE_OVERLAYS_CAP,
  SCENE_VERSION,
} from "@/lib/scene";

/**
 * Editor-side Zod mirror of the frozen scene model.
 *
 * This schema is deliberately a feedback tool, not an IPC or USB trust
 * boundary. `sceneSchema` follows the predicates in `scene.ts` exactly. The
 * separate `editorSceneSchema` adds only the editor's already-declared
 * rotation control range, so a finite value accepted by the persisted model
 * can still receive immediate guidance when it is proposed as a new editor
 * value. Neither schema replaces hardening.validateScene or the Python gate.
 */

const finiteNumber = z.number().finite();
const unitFraction = finiteNumber
  .min(0, "Must be between 0 and 1.")
  .max(1, "Must be between 0 and 1.");
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use the #rrggbb format.");
const source = z
  .string()
  .min(1, "A media source is required.")
  .max(
    SCENE_MEDIA_SOURCE_MAX_CHARS,
    `A media source cannot exceed ${SCENE_MEDIA_SOURCE_MAX_CHARS} characters.`
  )
  .refine(
    (value) => !value.includes("\u0000") && !value.split(/[/\\]/).includes(".."),
    "A media source cannot contain NUL or a '..' path segment."
  );

const mediaFields = {
  source,
  rotation: finiteNumber,
  flipH: z.boolean(),
  scale: finiteNumber.positive(),
  panX: finiteNumber,
  panY: finiteNumber,
  fit: z.enum(["fit", "fill"]),
};

const placementFields = {
  x: unitFraction,
  y: unitFraction,
  size: unitFraction,
  rotation: finiteNumber,
  color: hexColor,
};

/**
 * Size is a fraction of portrait width for cover/progress and portrait height
 * for title/artist/lyrics. The artist control owns the artist + album block.
 */
const basePlacementSchema = z.strictObject({
  x: unitFraction,
  y: unitFraction,
  size: unitFraction,
});

const basePlacementsSchema = z.strictObject({
  /** Size uses portrait width. */
  cover: basePlacementSchema.optional(),
  /** Size uses portrait height. */
  title: basePlacementSchema.optional(),
  /** Owns the combined artist + album metadata block; size uses portrait height. */
  artist: basePlacementSchema.optional(),
  /** Size uses portrait width. */
  progress: basePlacementSchema.optional(),
  /** Size uses portrait height. */
  lyrics: basePlacementSchema.optional(),
});

const noneBackgroundSchema = z.strictObject({
  kind: z.literal("none"),
});

const colorBackgroundSchema = z.strictObject({
  kind: z.literal("color"),
  color: hexColor,
});

const imageBackgroundSchema = z.strictObject({
  kind: z.literal("image"),
  ...mediaFields,
});

const gifBackgroundSchema = z.strictObject({
  kind: z.literal("gif"),
  ...mediaFields,
});

const videoBackgroundSchema = z.strictObject({
  kind: z.literal("video"),
  ...mediaFields,
});

const backgroundSchema = z.discriminatedUnion("kind", [
  noneBackgroundSchema,
  colorBackgroundSchema,
  imageBackgroundSchema,
  gifBackgroundSchema,
  videoBackgroundSchema,
]);

const textOverlaySchema = z.strictObject({
  kind: z.literal("text"),
  text: z.string().max(
    SCENE_MAX_TEXT_CHARS,
    `Text cannot exceed ${SCENE_MAX_TEXT_CHARS} characters.`
  ),
  ...placementFields,
});

const gpuTempOverlaySchema = z.strictObject({
  kind: z.literal("gpu-temp"),
  ...placementFields,
});

const overlaySchema = z.discriminatedUnion("kind", [
  textOverlaySchema,
  gpuTempOverlaySchema,
]);

function firstNonIndexKey(value: readonly unknown[]): string | null {
  const length = value.length;
  for (const key of Object.keys(value)) {
    const index = Number(key);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= length ||
      String(index) !== key
    ) {
      return key;
    }
  }
  return null;
}

/** Observe array metadata before Zod clones it; the value is returned unchanged. */
export function observeOverlays(value: unknown, ctx: z.RefinementCtx): unknown {
  if (!Array.isArray(value)) return value;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      ctx.addIssue({
        code: "custom",
        path: [index],
        message: "Overlays must not contain holes.",
      });
    }
  }
  const extraKey = firstNonIndexKey(value);
  if (extraKey !== null) {
    ctx.addIssue({
      code: "custom",
      path: [extraKey],
      message: `Overlays must not define the non-index property '${extraKey}'.`,
    });
  }
  return value;
}

const overlaysSchema = z.preprocess(observeOverlays, z.array(overlaySchema).max(
  SCENE_OVERLAYS_CAP,
  `A scene cannot contain more than ${SCENE_OVERLAYS_CAP} overlays.`
));

/** Exact runtime mirror of the frozen `src/renderer/lib/scene.ts` guards. */
export const sceneSchema = z.strictObject({
  version: z.literal(SCENE_VERSION),
  background: backgroundSchema,
  overlays: overlaysSchema,
  basePlacements: basePlacementsSchema.optional(),
});

/**
 * Editor input policy layered on the model mirror. The inspector and stage
 * already clamp rotation to [-360, 360]; this makes a bypassed control value
 * visible as feedback without changing the persisted model contract.
 */
export const editorSceneSchema = sceneSchema.superRefine((scene, ctx) => {
  if (
    scene.background.kind !== "none" &&
    scene.background.kind !== "color" &&
    (scene.background.rotation < -360 || scene.background.rotation > 360)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["background", "rotation"],
      message: "Rotation must be between -360 and 360 degrees.",
    });
  }

  scene.overlays.forEach((overlay, index) => {
    if (overlay.rotation < -360 || overlay.rotation > 360) {
      ctx.addIssue({
        code: "custom",
        path: ["overlays", index, "rotation"],
        message: "Rotation must be between -360 and 360 degrees.",
      });
    }
  });
});

export interface SceneValidationIssue {
  path: string;
  message: string;
}

export type SceneValidationResult =
  | { success: true }
  | { success: false; issues: SceneValidationIssue[] };

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "scene";
  return path
    .map((part, index) => {
      if (typeof part === "number") return `[${part}]`;
      if (index === 0) return String(part);
      return `.${String(part)}`;
    })
    .join("");
}

function toValidationIssues(
  issues: readonly { path: PropertyKey[]; message: string }[]
): SceneValidationIssue[] {
  return issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

/**
 * Model-faithful validation for local acceptance gates. This deliberately
 * uses the frozen scene mirror, never the editor-only rotation policy: a
 * persisted model-valid value must not lock unrelated editor work.
 */
export function validateSceneForModel(input: unknown): SceneValidationResult {
  try {
    const result = sceneSchema.safeParse(input);
    if (result.success) return { success: true };
    return { success: false, issues: toValidationIssues(result.error.issues) };
  } catch {
    return {
      success: false,
      issues: [
        {
          path: "scene",
          message: "The scene could not be checked safely. Fix the value and try again.",
        },
      ],
    };
  }
}

/**
 * SafeParse wrapper for editor UX. A throwing host value becomes feedback,
 * never an exception that can interrupt the editor; the IPC authorities keep
 * their own total validation contracts.
 */
export function validateSceneForEditor(input: unknown): SceneValidationResult {
  try {
    const result = editorSceneSchema.safeParse(input);
    if (result.success) return { success: true };
    return { success: false, issues: toValidationIssues(result.error.issues) };
  } catch {
    return {
      success: false,
      issues: [
        {
          path: "scene",
          message: "The scene could not be checked safely. Fix the value and try again.",
        },
      ],
    };
  }
}
