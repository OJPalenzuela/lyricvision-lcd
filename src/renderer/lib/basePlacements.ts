import {
  BASE_WIDGET_KEYS,
  type BasePlacement,
  type BasePlacements,
  type BaseWidget,
} from "@/lib/scene";

/** Logical portrait dimensions used by the editor preview and panel contract. */
export const PORTRAIT_WIDTH = 480;
export const PORTRAIT_HEIGHT = 854;

/** Keeps a direct-manipulation resize target visible and grabbable. */
export const MIN_BASE_WIDGET_SIZE = 0.01;

type BaseSizeUnit = "width" | "height";

interface BaseWidgetMeta {
  label: string;
  description: string;
  sizeUnit: BaseSizeUnit;
  panelContent: string;
}

export const BASE_WIDGET_META = {
  cover: {
    label: "Cover",
    description: "This control owns the Spotify cover artwork.",
    sizeUnit: "width",
    panelContent: "cover artwork",
  },
  title: {
    label: "Title",
    description: "This control owns the Spotify track title.",
    sizeUnit: "height",
    panelContent: "track title",
  },
  artist: {
    label: "Artist + album",
    description: "This control owns the artist and album metadata block.",
    sizeUnit: "height",
    panelContent: "artist and album metadata",
  },
  progress: {
    label: "Progress",
    description: "This control owns the Spotify progress bar.",
    sizeUnit: "width",
    panelContent: "progress bar",
  },
  lyrics: {
    label: "Lyrics",
    description: "This control owns the current and next synced lyric lines.",
    sizeUnit: "height",
    panelContent: "synced lyrics",
  },
} as const satisfies Record<BaseWidget, BaseWidgetMeta>;

export type ResolvedBasePlacements = Record<BaseWidget, BasePlacement>;

/**
 * Nominal anchors for the legacy layout when a scene has no override for a
 * widget. They let the editor show all five controls without pretending it
 * has Spotify data. The first edit writes a complete explicit placement; the
 * engine remains authoritative for the actual live-content pixels.
 */
export const LEGACY_BASE_GUIDE_PLACEMENTS = {
  cover: { x: 0.5, y: 184 / PORTRAIT_HEIGHT, size: 320 / PORTRAIT_WIDTH },
  title: { x: 0.5, y: 374 / PORTRAIT_HEIGHT, size: 28 / PORTRAIT_HEIGHT },
  artist: { x: 0.5, y: 456 / PORTRAIT_HEIGHT, size: 22 / PORTRAIT_HEIGHT },
  progress: { x: 0.5, y: 802 / PORTRAIT_HEIGHT, size: 424 / PORTRAIT_WIDTH },
  lyrics: { x: 0.5, y: 526 / PORTRAIT_HEIGHT, size: 34 / PORTRAIT_HEIGHT },
} as const satisfies ResolvedBasePlacements;

/** Fill absent optional keys with nominal legacy anchors, preserving explicit objects. */
export function resolveBasePlacements(
  placements: BasePlacements | undefined
): ResolvedBasePlacements {
  const resolved = {} as ResolvedBasePlacements;
  for (const widget of BASE_WIDGET_KEYS) {
    resolved[widget] = placements?.[widget] ?? LEGACY_BASE_GUIDE_PLACEMENTS[widget];
  }
  return resolved;
}

export function sameBasePlacement(
  left: BasePlacement | undefined,
  right: BasePlacement
): boolean {
  return (
    left !== undefined &&
    left.x === right.x &&
    left.y === right.y &&
    left.size === right.size
  );
}
