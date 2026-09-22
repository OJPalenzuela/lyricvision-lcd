// @vitest-environment node
'use strict';

/**
 * S2-T8b media import pipeline (src/main.js): the ONLY path by which a
 * user-picked file becomes scene state. Contract under test:
 *  - main opens the dialog and sniffs MAGIC BYTES (never the extension),
 *  - byte cap is checked via stat BEFORE the read, then re-checked on the
 *    decoded bytes (TOCTOU belt), GIF dim/frame caps before any decode,
 *  - check order mirrors the sidecar: bytes -> format -> dim -> frames,
 *  - every rejection is `token: detail` and NEVER carries a file path,
 *  - a cancelled dialog resolves null (no-op), never rejects,
 *  - the JS cap copies are pinned to the Python sidecar source
 *    (cross-language pin: drift in either copy fails this suite).
 * The sidecar re-enforces the same caps at render time (defence in depth).
 *
 * `electron` is stubbed via Module._load before the REAL src/main.js is
 * required (same mechanism as tests/unit/main-process.test.js); the stub's
 * ipcMain RECORDS handlers so the media:import channel is exercised through
 * its real registration, and app.getPath points at a fresh temp dir so the
 * settings:save -> disk -> settings:get round-trip is real.
 */

import Module from 'node:module';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireNative = createRequire(import.meta.url);
const hardening = requireNative('../../src/hardening.js');

// ---------------------------------------------------------------------------
// Fixtures: Pillow-generated, verified before embedding (format/size/frames).
// ---------------------------------------------------------------------------

// 1x1 PNG, 69 bytes (Pillow: PNG (1, 1))
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgEpEDAABoAD1UCKP3AAAAAElFTkSuQmCC';
// 4x4 JPEG, 633 bytes (Pillow: JPEG (4, 4))
const JPG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCpRRRX4ef0gf/Z';
// 8x8 GIF, 177 bytes, n_frames=3 (Pillow: GIF (8, 8) n_frames= 3)
const GIF3_B64 =
  'R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBCgABACwAAAAACAAIAIEA/wAAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBCgABACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7';
// 1x1 GIF, 43 bytes (Pillow: GIF (1, 1) n_frames= 1)
const GIF1_B64 =
  'R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==';

const PNG_BYTES = Buffer.from(PNG_B64, 'base64');
const JPG_BYTES = Buffer.from(JPG_B64, 'base64');
const GIF3_BYTES = Buffer.from(GIF3_B64, 'base64');
const GIF1_BYTES = Buffer.from(GIF1_B64, 'base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Synthetic GIF builder: header + logical screen descriptor + optional
 * graphic control extension + N image descriptors + trailer. Frame data is
 * a trivial LZW sub-block — the main-process walker never decodes pixels
 * (the sidecar does, at render time), so structure is what matters here.
 */
function buildGif({
  width,
  height,
  frames = 1,
  version = 'GIF89a',
  trailer = true,
} = {}) {
  const parts = [Buffer.from(version, 'ascii')];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  parts.push(lsd);
  parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]));
  for (let i = 0; i < frames; i += 1) {
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(0, 1);
    desc.writeUInt16LE(0, 3);
    desc.writeUInt16LE(Math.max(1, Math.min(width, 1)), 5);
    desc.writeUInt16LE(Math.max(1, Math.min(height, 1)), 7);
    parts.push(desc);
    parts.push(Buffer.from([0x02, 0x01, 0x00, 0x00])); // LZW min code + sub-block + terminator
  }
  if (trailer) parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/** GIF whose last sub-block claims 200 bytes but hits EOF: truncated data. */
function buildTruncatedGif() {
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    (() => {
      const lsd = Buffer.alloc(7);
      lsd.writeUInt16LE(8, 0);
      lsd.writeUInt16LE(8, 2);
      return lsd;
    })(),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), // image descriptor
    Buffer.from([0x02]), // LZW min code size
    Buffer.from([0xc8, 0x01, 0x02, 0x03]), // sub-block claims 200, has 3, then EOF
  ]);
}

// ---------------------------------------------------------------------------
// electron stub (records ipcMain channels; userData is a fresh temp dir)
// ---------------------------------------------------------------------------

let userDataDir = os.tmpdir();
const handlers = new Map();

const electronStub = {
  app: {
    requestSingleInstanceLock: () => true,
    on: () => {},
    whenReady: () => ({ then: () => {} }),
    getPath: () => userDataDir,
    getVersion: () => '0.1.0-test',
    quit: () => {},
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  BrowserWindow: Object.assign(function BrowserWindow() {}, {
    getFocusedWindow: () => null,
  }),
  ipcMain: {
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error(`duplicate ipcMain.handle: ${channel}`);
      handlers.set(channel, fn);
    },
  },
  Tray: function Tray() {},
  Menu: { buildFromTemplate: () => ({}) },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => Buffer.alloc(0),
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};

const main = requireNative('../../src/main.js');
main.registerIpc(); // records every channel, including media:import

function mediaImportChannel() {
  const handler = handlers.get('media:import');
  if (!handler) throw new Error('media:import channel is not registered');
  return handler;
}

function pickDialog(filePath, { canceled = false } = {}) {
  electronStub.dialog.showOpenDialog = vi.fn(async () => ({ canceled, filePaths: canceled ? [] : [filePath] }));
}

let workDir;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-media-import-'));
  userDataDir = workDir;
  electronStub.dialog.showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeMedia(name, bytes) {
  const filePath = path.join(workDir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

/** Rejects with `token: detail`; asserts token and no path/name leakage. */
async function expectRejection(promise, token, { detail, forbidden }) {
  let error = null;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error, `expected rejection with ${token}`).not.toBeNull();
  const message = String(error.message);
  expect(message).toContain(`${token}:`);
  if (detail) expect(message).toContain(detail);
  for (const needle of forbidden ?? []) {
    expect(message.includes(needle)).toBe(false);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Cross-language pin: JS cap copies vs the Python sidecar source
// ---------------------------------------------------------------------------

/** Read `NAME = <int or int*int*...>` (e.g. `16 * 1024 * 1024`) from Python. */
function readPythonExpr(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(new RegExp(`^${name} = ([\\d\\s*]+)$`, 'm'));
  if (!match) throw new Error(`${name} not found in ${file}`);
  return match[1]
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((acc, n) => acc * n, 1);
}

describe('media caps: cross-language pin to the sidecar', () => {
  it('pins the JS byte/dim/frame caps to the Python constants', () => {
    expect(readPythonExpr('bridge/lcd_bridge.py', 'SCENE_MAX_GIF_BYTES')).toBe(
      main.SCENE_MEDIA_MAX_BYTES
    );
    expect(readPythonExpr('bridge/lcd_bridge.py', 'SCENE_MAX_GIF_DIM')).toBe(
      main.SCENE_MEDIA_MAX_GIF_DIM
    );
    expect(readPythonExpr('bridge/lcd_bridge.py', 'SCENE_MAX_GIF_FRAMES')).toBe(
      main.SCENE_MEDIA_MAX_GIF_FRAMES
    );
    expect(main.SCENE_MEDIA_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(main.SCENE_MEDIA_MAX_GIF_DIM).toBe(4096);
    expect(main.SCENE_MEDIA_MAX_GIF_FRAMES).toBe(512);
    expect(main.MEDIA_CAPS).toEqual({
      maxBytes: 16 * 1024 * 1024,
      maxGifDim: 4096,
      maxGifFrames: 512,
    });
  });
});

// ---------------------------------------------------------------------------
// Acceptance: magic bytes -> embedded data: URL
// ---------------------------------------------------------------------------

describe('importMediaFromPath: acceptance', () => {
  it('embeds a PNG as a data: URL with a byte-exact round-trip', async () => {
    expect(PNG_BYTES.subarray(0, 8)).toEqual(PNG_MAGIC); // fixture self-check
    const filePath = writeMedia('picture.png', PNG_BYTES);
    const url = await main.importMediaFromPath(filePath, 'image');
    expect(url).toBe(PNG_DATA_URL);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')).toEqual(PNG_BYTES);
  });

  it('embeds a JPEG for kind image', async () => {
    const filePath = writeMedia('photo.jpg', JPG_BYTES);
    const url = await main.importMediaFromPath(filePath, 'image');
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(Buffer.from(url.split(',')[1], 'base64')).toEqual(JPG_BYTES);
  });

  it('accepts GIF bytes under kind image (Pillow decodes GIF too)', async () => {
    const filePath = writeMedia('anim.gif', GIF3_BYTES);
    const url = await main.importMediaFromPath(filePath, 'image');
    expect(url).toBe(`data:image/gif;base64,${GIF3_B64}`);
  });

  it('embeds a real 3-frame GIF for kind gif', async () => {
    const filePath = writeMedia('anim.gif', GIF3_BYTES);
    const url = await main.importMediaFromPath(filePath, 'gif');
    expect(url).toBe(`data:image/gif;base64,${GIF3_B64}`);
    expect(hardening.validateScene({
      version: 1,
      background: {
        kind: 'gif', source: url, rotation: 0, flipH: false,
        scale: 1, panX: 0, panY: 0, fit: 'fit',
      },
      overlays: [],
    }).ok).toBe(true);
  });

  it('accepts a synthetic GIF87a for kind gif', async () => {
    const filePath = writeMedia('old.gif', buildGif({ width: 8, height: 8, version: 'GIF87a' }));
    const url = await main.importMediaFromPath(filePath, 'gif');
    expect(url.startsWith('data:image/gif;base64,')).toBe(true);
  });

  it('embeds a real single-frame GIF (global color table walk)', async () => {
    // Pillow's output carries a global color table the block walk must skip.
    const filePath = writeMedia('single.gif', GIF1_BYTES);
    const url = await main.importMediaFromPath(filePath, 'gif');
    expect(url).toBe(`data:image/gif;base64,${GIF1_B64}`);
  });
});

// ---------------------------------------------------------------------------
// Dialog flow: cancel, kind gate, filters
// ---------------------------------------------------------------------------

describe('media:import channel', () => {
  it('is registered by registerIpc and returns the data: URL', async () => {
    const filePath = writeMedia('picture.png', PNG_BYTES);
    pickDialog(filePath);
    const url = await mediaImportChannel()({}, 'image');
    expect(url).toBe(PNG_DATA_URL);
  });

  it('resolves null when the dialog is cancelled', async () => {
    const filePath = writeMedia('picture.png', PNG_BYTES);
    pickDialog(filePath, { canceled: true });
    await expect(mediaImportChannel()({}, 'image')).resolves.toBeNull();
  });

  it('resolves null when the dialog reports no file', async () => {
    electronStub.dialog.showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: [] }));
    await expect(mediaImportChannel()({}, 'image')).resolves.toBeNull();
  });

  it('rejects an unsupported kind BEFORE the dialog opens', async () => {
    const spy = vi.fn(async () => ({ canceled: false, filePaths: ['/tmp/x'] }));
    electronStub.dialog.showOpenDialog = spy;
    await expectRejection(mediaImportChannel()({}, 'video'), 'media_kind_unsupported', {});
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes openFile filters scoped to the requested kind', async () => {
    electronStub.dialog.showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
    await mediaImportChannel()({}, 'image');
    const imageOptions = electronStub.dialog.showOpenDialog.mock.calls[0][0];
    expect(imageOptions.properties).toContain('openFile');
    expect(imageOptions.filters[0].extensions).toEqual(['png', 'jpg', 'jpeg', 'gif']);

    await mediaImportChannel()({}, 'gif');
    const gifOptions = electronStub.dialog.showOpenDialog.mock.calls[1][0];
    expect(gifOptions.filters).toEqual([{ name: 'GIF images', extensions: ['gif'] }]);
  });
});

// ---------------------------------------------------------------------------
// Bytes gate: stat-first, then the TOCTOU belt on the decoded bytes
// ---------------------------------------------------------------------------

describe('byte cap', () => {
  it('rejects an oversize file from stat WITHOUT reading it', async () => {
    const filePath = writeMedia(
      'oversize.png',
      Buffer.concat([
        PNG_MAGIC,
        Buffer.alloc(main.SCENE_MEDIA_MAX_BYTES + 1 - PNG_MAGIC.length, 0x61),
      ])
    );
    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const message = await expectRejection(
      main.importMediaFromPath(filePath, 'image'),
      'media_file_too_large',
      { detail: 'the limit is 16 MB', forbidden: [filePath, 'oversize'] }
    );
    expect(message).toContain(`${main.SCENE_MEDIA_MAX_BYTES + 1} bytes`);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('accepts a file that is exactly at the cap', async () => {
    const filePath = writeMedia(
      'boundary.png',
      Buffer.concat([PNG_MAGIC, Buffer.alloc(main.SCENE_MEDIA_MAX_BYTES - PNG_MAGIC.length, 0x61)])
    );
    const url = await main.importMediaFromPath(filePath, 'image');
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('re-checks the decoded bytes when stat under-reports (TOCTOU belt)', async () => {
    const filePath = writeMedia(
      'liar.png',
      Buffer.concat([PNG_MAGIC, Buffer.alloc(main.SCENE_MEDIA_MAX_BYTES, 0x61)])
    );
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 64 });
    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    await expectRejection(
      main.importMediaFromPath(filePath, 'image'),
      'media_file_too_large',
      { forbidden: [filePath, 'liar'] }
    );
    expect(readFileSpy).toHaveBeenCalledTimes(1); // belt only fires after the read
  });
});

// ---------------------------------------------------------------------------
// Format gate: magic sniff, kind-aware, extension-independent
// ---------------------------------------------------------------------------

describe('format sniff', () => {
  it('rejects a non-media file that claims a .png extension', async () => {
    const filePath = writeMedia('fake.png', Buffer.from('this is definitely not a png'));
    await expectRejection(main.importMediaFromPath(filePath, 'image'), 'media_type_unsupported', {
      forbidden: [filePath, 'fake'],
    });
  });

  it('rejects an empty file', async () => {
    const filePath = writeMedia('empty.png', Buffer.alloc(0));
    await expectRejection(main.importMediaFromPath(filePath, 'image'), 'media_type_unsupported', {});
  });

  it('rejects PNG and JPEG bytes under kind gif (GIF-only path)', async () => {
    const pngPath = writeMedia('picture.png', PNG_BYTES);
    await expectRejection(main.importMediaFromPath(pngPath, 'gif'), 'media_type_unsupported', {
      forbidden: [pngPath],
    });
    const jpgPath = writeMedia('photo.jpg', JPG_BYTES);
    await expectRejection(main.importMediaFromPath(jpgPath, 'gif'), 'media_type_unsupported', {
      forbidden: [jpgPath],
    });
  });

  it('rejects an unsupported kind on the direct seam too', async () => {
    const filePath = writeMedia('picture.png', PNG_BYTES);
    await expectRejection(main.importMediaFromPath(filePath, 'video'), 'media_kind_unsupported', {});
  });
});

// ---------------------------------------------------------------------------
// GIF structural gate: order bytes -> format -> dim -> frames (sidecar mirror)
// ---------------------------------------------------------------------------

describe('GIF structural checks (kind gif only)', () => {
  it('rejects dimensions over the per-side cap from the header', async () => {
    const filePath = writeMedia('huge.gif', buildGif({ width: 5000, height: 10 }));
    const message = await expectRejection(
      main.importMediaFromPath(filePath, 'gif'),
      'media_gif_dimensions_exceeded',
      { detail: '4096', forbidden: [filePath, 'huge'] }
    );
    expect(message).toContain('5000x10');
  });

  it('accepts dimensions exactly at the per-side cap', async () => {
    const filePath = writeMedia('maxdim.gif', buildGif({ width: 4096, height: 4096 }));
    const url = await main.importMediaFromPath(filePath, 'gif');
    expect(url.startsWith('data:image/gif;base64,')).toBe(true);
  });

  it('rejects a GIF over the frame cap', async () => {
    const filePath = writeMedia(
      'long.gif',
      buildGif({ width: 8, height: 8, frames: main.SCENE_MEDIA_MAX_GIF_FRAMES + 1 })
    );
    const message = await expectRejection(
      main.importMediaFromPath(filePath, 'gif'),
      'media_gif_frames_exceeded',
      { detail: '512', forbidden: [filePath, 'long'] }
    );
    expect(message).toContain('513 frames');
  });

  it('accepts a GIF at exactly the frame cap', async () => {
    const filePath = writeMedia(
      'maxframes.gif',
      buildGif({ width: 8, height: 8, frames: main.SCENE_MEDIA_MAX_GIF_FRAMES })
    );
    const url = await main.importMediaFromPath(filePath, 'gif');
    expect(url.startsWith('data:image/gif;base64,')).toBe(true);
  });

  it('checks dimensions BEFORE frames (sidecar order)', async () => {
    const filePath = writeMedia(
      'both.gif',
      buildGif({ width: 5000, height: 10, frames: main.SCENE_MEDIA_MAX_GIF_FRAMES + 1 })
    );
    await expectRejection(
      main.importMediaFromPath(filePath, 'gif'),
      'media_gif_dimensions_exceeded',
      {}
    );
  });

  it('reports truncated GIF data as media_unreadable', async () => {
    const filePath = writeMedia('cut.gif', buildTruncatedGif());
    await expectRejection(main.importMediaFromPath(filePath, 'gif'), 'media_unreadable', {
      forbidden: [filePath, 'cut'],
    });
  });

  it('reports a header shorter than the logical screen descriptor as media_unreadable', async () => {
    const filePath = writeMedia('stub.gif', Buffer.from('GIF89a', 'ascii'));
    await expectRejection(main.importMediaFromPath(filePath, 'gif'), 'media_unreadable', {});
  });

  it('leaves kind image free of the GIF structural gate (sidecar shrinks stills)', async () => {
    // An oversized-dimension GIF decodes fine on the image path; main must
    // not invent a refusal the sidecar does not have (it SHRINKS, not rejects).
    const filePath = writeMedia('wide.gif', buildGif({ width: 5000, height: 10 }));
    const url = await main.importMediaFromPath(filePath, 'image');
    expect(url.startsWith('data:image/gif;base64,')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Persistence: settings:save -> disk -> settings:get with an embedded scene
// ---------------------------------------------------------------------------

describe('settings round-trip with an embedded media scene', () => {
  it('persists the data: URL on disk and never the picked file path', async () => {
    const filePath = writeMedia('picture.png', PNG_BYTES);
    const scene = {
      version: 1,
      background: {
        kind: 'image',
        source: PNG_DATA_URL,
        rotation: 15,
        flipH: true,
        scale: 1.5,
        panX: 0.1,
        panY: -0.1,
        fit: 'fill',
      },
      overlays: [],
    };

    const saved = handlers.get('settings:save')({}, { scene });
    expect(saved.rejected).toEqual([]);
    expect(saved.settings.scene.background.source).toBe(PNG_DATA_URL);

    const raw = fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8');
    expect(raw).toContain(PNG_DATA_URL);
    expect(raw.includes(filePath)).toBe(false); // absolute path never persisted
    expect(raw.includes(workDir)).toBe(false);

    const reloaded = handlers.get('settings:get')({});
    expect(reloaded.settings.scene).toEqual(scene);
    expect(hardening.validateScene(JSON.parse(raw).scene).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S2-T8d: the 16 MB media budget must hold on the settings:save write path
// too — validateScene is the ONLY way a scene reaches disk, so the raw-byte
// cap reappears there as a character ceiling on background.source.
// ---------------------------------------------------------------------------

/**
 * The ceiling, DERIVED (never hand-copied) from the sidecar's raw-byte cap:
 * base64 is 4 * ceil(raw / 3) chars, plus the longest accepted data: prefix
 * "data:image/jpeg;base64," (23 chars):
 *   4 * ceil(16777216 / 3) + 23 = 22369624 + 23 = 22369647.
 */
const SOURCE_CEILING =
  4 * Math.ceil(readPythonExpr('bridge/lcd_bridge.py', 'SCENE_MAX_GIF_BYTES') / 3) + 23;

function sceneWithSource(source) {
  return {
    version: 1,
    background: {
      kind: 'image', source, rotation: 0, flipH: false,
      scale: 1, panX: 0, panY: 0, fit: 'fit',
    },
    overlays: [],
  };
}

describe('background.source ceiling: settings:save gate (S2-T8d)', () => {
  it('pins the JS ceiling to the Python byte cap by the stated base64 arithmetic', () => {
    const pyBytes = readPythonExpr('bridge/lcd_bridge.py', 'SCENE_MAX_GIF_BYTES');
    expect(pyBytes).toBe(16 * 1024 * 1024);
    expect(4 * Math.ceil(pyBytes / 3)).toBe(22369624); // base64 chars at the raw cap
    expect(SOURCE_CEILING).toBe(22369647); // + longest data: prefix (image/jpeg)
    expect(hardening.SCENE_MEDIA_SOURCE_MAX_CHARS).toBe(SOURCE_CEILING);
  });

  it('negative probe: the pin fails when either side drifts (not vacuous)', () => {
    const pyBytes = readPythonExpr('bridge/lcd_bridge.py', 'SCENE_MAX_GIF_BYTES');
    const pin = (jsCeiling, pythonBytes) =>
      expect(jsCeiling).toBe(4 * Math.ceil(pythonBytes / 3) + 23);
    // JS-side drift: an off-by-one ceiling must fail the pin.
    expect(() => pin(hardening.SCENE_MEDIA_SOURCE_MAX_CHARS + 1, pyBytes)).toThrow();
    // The naive raw-bytes number (forgetting the 4/3 expansion) must fail.
    expect(() => pin(16 * 1024 * 1024, pyBytes)).toThrow();
    // Python-side drift: a changed cap derives a different ceiling, so the
    // shipped JS value no longer satisfies the pin.
    expect(() => pin(hardening.SCENE_MEDIA_SOURCE_MAX_CHARS, pyBytes + 4096)).toThrow();
    // The real pair passes.
    pin(hardening.SCENE_MEDIA_SOURCE_MAX_CHARS, pyBytes);
  });

  it('rejects a source one character over the ceiling, naming the field and the limit', () => {
    const verdict = hardening.validateScene(sceneWithSource('A'.repeat(SOURCE_CEILING + 1)));
    expect(verdict.ok).toBe(false);
    expect(verdict.field).toBe('background.source');
    expect(verdict.error).toContain(String(SOURCE_CEILING));
  });

  it('accepts a source exactly at the ceiling (a JPEG import at the byte cap)', () => {
    const jpegAtCap =
      `data:image/jpeg;base64,${'A'.repeat(4 * Math.ceil((16 * 1024 * 1024) / 3))}`;
    expect(jpegAtCap.length).toBe(SOURCE_CEILING);
    expect(hardening.validateScene(sceneWithSource(jpegAtCap)).ok).toBe(true);
  });

  it('refuses a settings:save patch carrying an over-ceiling data: URL', () => {
    // The verifier's bypass shape: an over-budget media payload sent straight
    // to settings:save. Before the ceiling this returned rejected=[] and
    // wrote the payload to settings.json.
    const oversize =
      `data:image/png;base64,${'A'.repeat(4 * Math.ceil((17 * 1024 * 1024) / 3))}`;
    expect(oversize.length).toBeGreaterThan(SOURCE_CEILING);
    const saved = handlers.get('settings:save')({}, { scene: sceneWithSource(oversize) });
    expect(saved.rejected).toEqual(['scene']);
    const settingsFile = path.join(userDataDir, 'settings.json');
    const raw = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
    expect(raw).not.toContain(oversize.slice(0, 64));
  });

  it('round-trips an import AT the byte cap: import -> settings:save -> read-back', async () => {
    const filePath = writeMedia(
      'atcap.png',
      Buffer.concat([PNG_MAGIC, Buffer.alloc(main.SCENE_MEDIA_MAX_BYTES - PNG_MAGIC.length, 0x61)])
    );
    const url = await main.importMediaFromPath(filePath, 'image');
    expect(url.length).toBeLessThanOrEqual(SOURCE_CEILING);
    const saved = handlers.get('settings:save')({}, { scene: sceneWithSource(url) });
    expect(saved.rejected).toEqual([]);
    expect(saved.settings.scene.background.source.length).toBe(url.length);
    const reloaded = handlers.get('settings:get')({});
    expect(reloaded.settings.scene.background.source.length).toBe(url.length);
    expect(hardening.validateScene(reloaded.settings.scene).ok).toBe(true);
  }, 30000);
});

// ---------------------------------------------------------------------------
// S2-T8d: truncated-vs-unknown magic. A file that ENDS INSIDE a known
// signature is damaged/incomplete (media_unreadable); bytes that decisively
// match no known magic are an unsupported type (media_type_unsupported).
// ---------------------------------------------------------------------------

describe('truncated vs unknown magic (S2-T8d)', () => {
  it('reports a partial PNG signature as media_unreadable, not media_type_unsupported', async () => {
    const filePath = writeMedia('cut.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const message = await expectRejection(
      main.importMediaFromPath(filePath, 'image'),
      'media_unreadable',
      { detail: 'truncated', forbidden: ['media_type_unsupported'] }
    );
    expect(message).toContain('truncated');
  });

  it('reports a partial JPEG signature as media_unreadable', async () => {
    const filePath = writeMedia('cut.jpg', Buffer.from([0xff, 0xd8]));
    await expectRejection(main.importMediaFromPath(filePath, 'image'), 'media_unreadable', {});
  });

  it('reports a partial GIF signature as media_unreadable', async () => {
    const filePath = writeMedia('cut.gif', Buffer.from('GIF8', 'ascii'));
    await expectRejection(main.importMediaFromPath(filePath, 'gif'), 'media_unreadable', {});
  });

  it('keeps decisive-but-unknown bytes as media_type_unsupported', async () => {
    const filePath = writeMedia('notes.png', Buffer.from('just notes, no image signature here'));
    await expectRejection(main.importMediaFromPath(filePath, 'image'), 'media_type_unsupported', {});
  });
});
