import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { SCENE_MAX_TEXT_CHARS, isScene, type Scene } from "@/lib/scene";

const requireNative = createRequire(import.meta.url);

interface HardeningGate {
  SCENE_MAX_TEXT_CHARS: number;
  validateScene(input: unknown): { ok: boolean; field?: string; error?: string };
}
const hardening = requireNative("../../src/hardening.js") as HardeningGate;

/**
 * Read a `NAME = <int>` literal straight out of a Python source file. The
 * 4096 cap necessarily exists in one Python file and two JS files (the
 * CommonJS gate cannot import a TS module), so the ONLY thing keeping those
 * copies honest is this cross-language pin: if any copy drifts, this test
 * fails — duplication with a pinned equality, never duplication by trust.
 */
function readPythonInt(file: string, name: string): number {
  // vitest runs from the repo root, so a repo-relative path is exact here
  // (import.meta.url resolves to undefined under the jsdom environment).
  const source = readFileSync(file, "utf8");
  const match = source.match(new RegExp(`^${name} = (\\d+)`, "m"));
  if (!match) throw new Error(`${name} not found in ${file}`);
  return Number(match[1]);
}

function sceneWithText(text: string): Scene {
  return {
    version: 1,
    background: { kind: "none" },
    overlays: [
      { kind: "text", text, x: 0.5, y: 0.5, size: 0.1, rotation: 0, color: "#ffffff" },
    ],
  };
}

describe("overlay text-length cap: cross-language pin", () => {
  const renderCap = readPythonInt("bridge/lcd_bridge.py", "SCENE_MAX_TEXT_CHARS");
  const protocolCap = readPythonInt("bridge/protocol.py", "SCENE_MAX_TEXT_CHARS");

  it("pins the render cap, the protocol cap and both JS gates to one number", () => {
    expect(renderCap).toBe(4096);
    expect(protocolCap).toBe(renderCap);
    expect(hardening.SCENE_MAX_TEXT_CHARS).toBe(renderCap);
    expect(SCENE_MAX_TEXT_CHARS).toBe(renderCap);
  });

  it("accepts a cap-length overlay text at every JS gate", () => {
    const scene = sceneWithText("a".repeat(renderCap));
    expect(hardening.validateScene(scene).ok).toBe(true);
    expect(isScene(scene)).toBe(true);
  });

  it("rejects a cap+1 overlay text at every JS gate, on the field path", () => {
    const scene = sceneWithText("a".repeat(renderCap + 1));
    const verdict = hardening.validateScene(scene);
    expect(verdict.ok).toBe(false);
    expect(verdict.field).toBe("overlays[0].text");
    expect(isScene(scene)).toBe(false);
  });
});
