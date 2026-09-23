// jsdom seams for Konva / use-image — S7-T21.
//
// Why this file exists: jsdom has no canvas backend (`HTMLCanvasElement.getContext`
// returns null without the optional `canvas` package). Konva calls `getContext('2d')`
// to measure text (`measureText`) and to build hit-graphs (`getImageData`); use-image
// calls `Image.prototype.src` and waits for a `load` event jsdom never fires.
//
// Honest scope — what this fabricates:
//   * `measureText` returns `length * fontPx * 0.6` — an APPROXIMATION, not a real
//     text run. Line breaking in tests therefore exercises the layout code path but
//     is not metrically faithful to a browser.
//   * `getImageData` returns fully transparent zeros — Konva's hit-graph sees "no
//     pixel here", so tests NEVER rely on canvas hit detection. Node gestures are
//     driven by explicit Konva events and stage-empty clicks by real DOM events on
//     the stage content div (see SceneEditorDirectManipulation.test.tsx).
//   * Gradients are inert stubs (only need `addColorStop`).
//   * The load seam fires `load` on a microtask after `src` is assigned (by
//     patching the NATIVE `src` accessor — subclassing jsdom's Image was probed
//     and does NOT work: the instance keeps the native prototype) and provides a
//     resolved `decode()` (use-image calls it in onload; jsdom lacks it). It
//     fabricates an AVAILABLE IMAGE of unknown intrinsic size (no width/height,
//     `complete` untouched), which is exactly what a jsdom runtime can honestly
//     provide. Pixel truth / WYSIWYG parity between preview and glass is owned
//     by the Python MAE suites.
//
// Scope: tests only. `vite.config.ts` / vitest config are untouched — the shims are
// imported per test file that renders Konva.
//
// No new dependencies (repo forbids adding `canvas`).

/** Zero-filled RGBA buffer, transparent. */
function transparentImageData(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(Math.max(0, width * height * 4));
}

function create2dContextShim(): CanvasRenderingContext2D {
  const shim: Record<string, unknown> = {
    // --- state / transform (Konva init + node drawing) ---
    canvas: null as HTMLCanvasElement | null,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: 'rgba(0,0,0,0)',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,

    // --- measurement (approximation; see header) ---
    measureText(text: string): TextMetrics {
      const fontPx = Number.parseFloat(String(shim.font ?? '10')) || 10;
      const width = text.length * fontPx * 0.6;
      return {
        width,
        actualBoundingBoxAscent: fontPx * 0.8,
        actualBoundingBoxDescent: fontPx * 0.2,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        fontBoundingBoxAscent: fontPx,
        fontBoundingBoxDescent: fontPx * 0.25,
        emHeightAscent: fontPx,
        emHeightDescent: fontPx * 0.25,
        hangingBaseline: fontPx * 0.8,
        alphabeticBaseline: 0,
        ideographicBaseline: -fontPx * 0.2,
      } as TextMetrics;
    },

    // --- hit-graph read (transparent; see header) ---
    getImageData(sx: number, sy: number, sw: number, sh: number): ImageData {
      return {
        data: transparentImageData(sw, sh),
        width: sw,
        height: sh,
        colorSpace: 'srgb',
        get(x: number, y: number): Uint8ClampedArray {
          const i = (y * sw + x) * 4;
          return this.data.slice(i, i + 4);
        },
        putImageData: undefined,
      } as unknown as ImageData;
    },
    createImageData(sw: number, sh?: number): ImageData {
      const width = typeof sw === 'object' ? sw.width : sw;
      const height = typeof sw === 'object' ? sw.height : sh ?? 1;
      return {
        data: transparentImageData(width, height),
        width,
        height,
        colorSpace: 'srgb',
        get: () => new Uint8ClampedArray(4),
        putImageData: undefined,
      } as unknown as ImageData;
    },

    // --- inert gradient stubs (only addColorStop is called) ---
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    createConicGradient: () => ({ addColorStop: () => undefined }),
    createPattern: () => null,
  };

  // Every other 2D method Konva may call becomes a no-op (save/restore/translate/
  // beginPath/fill/drawImage/...). No canvas pixel output is trusted in jsdom anyway.
  return new Proxy(shim as unknown as CanvasRenderingContext2D, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === 'string' && prop.startsWith('is')) {
        return () => false;
      }
      return () => undefined;
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
  });
}

/**
 * Idempotently install the jsdom canvas + Image seams on the current `window`.
 * Safe to import from many test files (module-level guard).
 */
export function installKonvaJsdomShims(win: Window & typeof globalThis = window): void {
  const w = win as unknown as {
    __konvaShimsInstalled?: boolean;
    HTMLCanvasElement: typeof HTMLCanvasElement;
    Image: typeof Image;
  };
  if (w.__konvaShimsInstalled) return;
  w.__konvaShimsInstalled = true;

  // 1) canvas 2d context (Konva text measurement + hit-graph reads)
  const proto = w.HTMLCanvasElement.prototype as HTMLCanvasElement & {
    getContext: (type: string, ...rest: unknown[]) => unknown;
  };
  proto.getContext = function getContext(type: string): unknown {
    if (type === '2d') return create2dContextShim();
    return null; // webgl / bitmap / etc. stay unsupported, as in plain jsdom
  };

  // 2) async image loads (use-image listens for `load`; jsdom never fires it).
  //    EMPIRICAL finding (probed in-session): subclassing jsdom's Image does NOT
  //    work — `new ShimImage()` returns an instance whose prototype is the NATIVE
  //    HTMLImageElement.prototype, so subclass accessors are shadowed (async
  //    onload stayed 0 while a manual dispatchEvent delivered fine). Patching the
  //    native `src` accessor (and setAttribute) instead guarantees every Image in
  //    this jsdom window fires `load` on a microtask after a src is assigned.
  //    Fabricates AVAILABILITY only: no decode, no intrinsic size, `complete`
  //    untouched — exactly what use-image needs to resolve, nothing more.
  const imgProto = w.HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const originalGet = srcDesc?.get;
  const originalSet = srcDesc?.set;
  const fireLoad = (target: HTMLImageElement): void => {
    queueMicrotask(() => {
      try {
        target.dispatchEvent(new Event("load"));
      } catch {
        /* realm quirk — the load seam is best-effort by design */
      }
    });
  };
  if (srcDesc && originalGet && originalSet) {
    Object.defineProperty(imgProto, "src", {
      configurable: true,
      enumerable: srcDesc.enumerable,
      get(this: HTMLImageElement): string {
        return originalGet.call(this) as string;
      },
      set(this: HTMLImageElement, value: string): void {
        originalSet.call(this, value);
        fireLoad(this);
      },
    });
  }
  const originalSetAttribute = imgProto.setAttribute;
  imgProto.setAttribute = function patchedSetAttribute(
    this: HTMLImageElement,
    name: string,
    value: string
  ): void {
    originalSetAttribute.call(this, name, value);
    if (String(name).toLowerCase() === "src") fireLoad(this);
  };
  // 3) `decode()` — use-image@1.1.4 calls `img.decode()` INSIDE its onload
  //    handler (index.js:42); jsdom's HTMLImageElement has no such method, so
  //    without this the handler throws ("img.decode is not a function") and the
  //    status never leaves `loading`. This fabricates a RESOLVED decode — i.e.
  //    "the bytes are considered present" — with no decoding and no pixel
  //    access, which is the whole honest extent of the seam in jsdom.
  if (typeof imgProto.decode !== "function") {
    imgProto.decode = function decode(): Promise<void> {
      return Promise.resolve();
    };
  }
}

installKonvaJsdomShims();
