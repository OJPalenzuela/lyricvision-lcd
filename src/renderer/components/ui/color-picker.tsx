import { useEffect } from "react";
import { HexColorPicker } from "react-colorful";

/**
 * Color picker atom (S7-T22) — the shadcn/ui set gains a react-colorful
 * swatch instead of forking one. Controlled: `value` is an EXISTING scene
 * color field (#rrggbb) and `onChange` streams CONTINUOUS values during a
 * pointer gesture, so callers own the coalescing (SceneEditor opens the
 * owner-tagged "color" session on pointerdown and closes it on release —
 * one pointer press = one history entry, one debounced preview push).
 *
 * JSDOM SEAM (honest): react-colorful's pointer handlers derive colors from
 * `getBoundingClientRect` geometry, which jsdom cannot provide (zero-size
 * rects, no pointer capture). `colorPickerChangeSeam` exposes this
 * component's REAL onChange prop so tests can inject continuous values
 * while still exercising the real prop chain downstream — the same
 * precedent as `sceneStageRef` in SceneStage.tsx: bypass the geometry,
 * keep everything else real. Written by this module, read only by tests;
 * nothing in src/ depends on it.
 */
export const colorPickerChangeSeam: {
  current: ((value: string) => void) | null;
} = { current: null };

interface ColorPickerProps {
  /** Current #rrggbb value of the bound scene field. */
  value: string;
  /** Continuous stream — route through the caller's coalescing. */
  onChange: (value: string) => void;
  "aria-label": string;
}

export function ColorPicker({
  value,
  onChange,
  "aria-label": ariaLabel,
}: ColorPickerProps) {
  useEffect(() => {
    colorPickerChangeSeam.current = onChange;
    return () => {
      if (colorPickerChangeSeam.current === onChange) {
        colorPickerChangeSeam.current = null;
      }
    };
  }, [onChange]);

  return (
    <HexColorPicker
      color={value}
      onChange={onChange}
      aria-label={ariaLabel}
      className="h-32 w-full"
    />
  );
}
