/**
 * S2-T8d: background.source character ceiling. BOTH JS copies — the
 * authoritative hardening gate (settings:save) and the renderer's
 * instant-feedback guard (isScene) — are pinned to the sidecar's raw-byte
 * cap SCENE_MAX_GIF_BYTES by the stated arithmetic (base64 = 4 * ceil(raw/3)
 * chars + the longest accepted `data:` prefix), so neither JS copy can drift
 * alone and neither can fall below the encoded size of a legitimately-at-cap
 * import. The product parse matters: a naive int regex would read `16` off
 * `16 * 1024 * 1024` and make the pin vacuous.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { SCENE_MEDIA_SOURCE_MAX_CHARS, isScene, type Scene } from "@/lib/scene";

const requireNative = createRequire(import.meta.url);

interface HardeningGate {
  SCENE_MEDIA_SOURCE_MAX_CHARS: number;
}
const hardening = requireNative("../../src/hardening.js") as HardeningGate;

/** Read `NAME = <int * int * ...>` from Python as a PRODUCT, not an int. */
function readPythonProduct(file: string, name: string): number {
  // vitest runs from the repo root, so a repo-relative path is exact here.
  const source = readFileSync(file, "utf8");
  const match = source.match(new RegExp(`^${name} = ([\\d\\s*]+)$`, "m"));
  if (!match) throw new Error(`${name} not found in ${file}`);
  return match[1]
    .split("*")
    .map((part) => Number(part.trim()))
    .reduce((acc, n) => acc * n, 1);
}

function sceneWithSource(source: string): Scene {
  return {
    version: 1,
    background: {
      kind: "image",
      source,
      rotation: 0,
      flipH: false,
      scale: 1,
      panX: 0,
      panY: 0,
      fit: "fit",
    },
    overlays: [],
  };
}

describe("background.source ceiling: renderer guard pinned cross-language", () => {
  const pyBytes = readPythonProduct("bridge/lcd_bridge.py", "SCENE_MAX_GIF_BYTES");

  it("derives both JS ceilings from the Python cap by the stated arithmetic", () => {
    expect(pyBytes).toBe(16 * 1024 * 1024);
    const derived = 4 * Math.ceil(pyBytes / 3) + 23; // base64 + longest data: prefix
    expect(derived).toBe(22369647);
    expect(SCENE_MEDIA_SOURCE_MAX_CHARS).toBe(derived);
    expect(hardening.SCENE_MEDIA_SOURCE_MAX_CHARS).toBe(derived);
  });

  it("agrees with hardening on both sides of the boundary", () => {
    expect(isScene(sceneWithSource("A".repeat(SCENE_MEDIA_SOURCE_MAX_CHARS)))).toBe(true);
    expect(isScene(sceneWithSource("A".repeat(SCENE_MEDIA_SOURCE_MAX_CHARS + 1)))).toBe(false);
  });
});
