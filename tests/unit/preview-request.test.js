// @vitest-environment node
'use strict';

/**
 * Preview envelope (S0-T2): bridge-spawn builds a validated preview_request
 * BEFORE touching the child's stdin, correlates preview_response lines by
 * reqId, and rejects malformed responses with a typed reason.
 *
 * Hardware-free: a fake child captures writes. No network, no USB, no
 * shell.openExternal.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireNative = createRequire(import.meta.url);
const {
  PREVIEW_PROTOCOL_VERSION,
  PREVIEW_MAX_WIDTH,
  PREVIEW_MAX_HEIGHT,
  PREVIEW_ERROR_REASONS,
  buildPreviewRequest,
  writePreviewRequest,
  parsePreviewResponse,
} = requireNative('../../src/bridge-spawn.js');
const { validateScene } = requireNative('../../src/hardening.js');

const MEDIA = { rotation: 0, flipH: false, scale: 1, panX: 0, panY: 0, fit: 'fit' };
// NUL built via fromCharCode: no literal control characters in the file.
const NUL_SOURCE = 'a' + String.fromCharCode(0) + 'b';

function scene(overrides = {}) {
  return { version: 1, background: { kind: 'none' }, overlays: [], ...overrides };
}

function textOverlay(overrides = {}) {
  return {
    kind: 'text',
    text: 'hi',
    x: 0.5,
    y: 0.5,
    size: 0.1,
    rotation: 0,
    color: '#ffffff',
    ...overrides,
  };
}

function fakeChild({ throws = false } = {}) {
  const writes = [];
  return {
    writes,
    child: {
      stdin: {
        write: (line) => {
          if (throws) throw new Error('EPIPE');
          writes.push(line);
          return true;
        },
      },
    },
  };
}

describe('buildPreviewRequest (S0-T2 envelope)', () => {
  it('builds a versioned request with the reduced-resolution size hint', () => {
    const built = buildPreviewRequest(scene());
    expect(built.ok).toBe(true);
    expect(built.envelope.v).toBe(PREVIEW_PROTOCOL_VERSION);
    expect(built.envelope.cmd).toBe('preview_request');
    expect(Number.isInteger(built.envelope.reqId)).toBe(true);
    expect(built.envelope.reqId).toBeGreaterThan(0);
    expect(built.envelope.maxWidth).toBe(PREVIEW_MAX_WIDTH);
    expect(built.envelope.maxHeight).toBe(PREVIEW_MAX_HEIGHT);
    expect(built.envelope.scene).toEqual(scene());
    expect(built.line.endsWith('\n')).toBe(true);
    expect(JSON.parse(built.line)).toEqual(built.envelope);
  });

  it('caps stay pinned in lockstep with bridge/protocol.py', () => {
    // Half of the 480x854 portrait glass: quarter of the pixels, so a
    // preview line never stalls playback state on the shared JSONL pipe.
    expect(PREVIEW_MAX_WIDTH).toBe(480 / 2);
    expect(PREVIEW_MAX_HEIGHT).toBe(Math.floor(854 / 2));
    expect(PREVIEW_ERROR_REASONS).toContain('preview_unavailable');
    expect(PREVIEW_ERROR_REASONS).toContain('version_mismatch');
    expect(PREVIEW_ERROR_REASONS).toContain('invalid_request');
  });

  it('error vocabulary stays pinned in lockstep with bridge/protocol.py', () => {
    // S1-T6: the renderer can now answer, so the vocabulary gains the
    // payload cap plus every typed SceneRenderError reason. Exact list:
    // drift against protocol.py PREVIEW_ERROR_REASONS fails one suite.
    expect(PREVIEW_ERROR_REASONS).toEqual([
      'invalid_request',
      'preview_unavailable',
      'render_failed',
      'version_mismatch',
      'unknown_cmd',
      'payload_too_large',
      'unsupported_background',
      'unsupported_overlay',
      'media_refused',
      'media_missing',
      'media_unreadable',
      'media_too_large',
      'text_too_long',
    ]);
  });

  it('rejects a malformed scene with the exact field validateScene reports', () => {
    const bad = [
      [scene({ overlays: [textOverlay({ x: 1.5 })] }), 'overlays[0].x'],
      [scene({ evil: true }), 'evil'],
      [scene({ background: { kind: 'image', source: 'a/../b.png', ...MEDIA } }), 'background.source'],
      [scene({ background: { kind: 'gif', source: NUL_SOURCE, ...MEDIA } }), 'background.source'],
      [scene({ background: { kind: 'color', color: '#fff' } }), 'background.color'],
      [scene({ version: 2 }), 'version'],
      [null, '<root>'],
    ];
    for (const [input, field] of bad) {
      const built = buildPreviewRequest(input);
      expect(built.ok).toBe(false);
      expect(built.field).toBe(field);
      expect(built.envelope).toBeUndefined();
      // Same verdict as the hardened path it must delegate to.
      expect(built.field).toBe(validateScene(input).field);
    }
  });

  it('rejects a malformed reqId or size hint', () => {
    expect(buildPreviewRequest(scene(), { reqId: 0 })).toMatchObject({ ok: false, field: 'reqId' });
    expect(buildPreviewRequest(scene(), { reqId: 1.5 })).toMatchObject({ ok: false, field: 'reqId' });
    expect(buildPreviewRequest(scene(), { reqId: 'abc' })).toMatchObject({ ok: false, field: 'reqId' });
    expect(
      buildPreviewRequest(scene(), { maxWidth: PREVIEW_MAX_WIDTH + 1 })
    ).toMatchObject({ ok: false, field: 'maxWidth' });
    expect(buildPreviewRequest(scene(), { maxHeight: 0 })).toMatchObject({
      ok: false,
      field: 'maxHeight',
    });
  });
});

describe('writePreviewRequest validates BEFORE stdin write', () => {
  it('writes exactly one line for a valid scene', () => {
    const { child, writes } = fakeChild();
    const written = writePreviewRequest(child, scene({ overlays: [textOverlay()] }));
    expect(written.ok).toBe(true);
    expect(writes).toHaveLength(1);
    const envelope = JSON.parse(writes[0]);
    expect(envelope.cmd).toBe('preview_request');
    expect(envelope.reqId).toBe(written.reqId);
  });

  it('never touches stdin when the scene fails validation', () => {
    const { child, writes } = fakeChild();
    const written = writePreviewRequest(child, scene({ overlays: [textOverlay({ y: -0.1 })] }));
    expect(written.ok).toBe(false);
    expect(written.field).toBe('overlays[0].y');
    expect(writes).toHaveLength(0);
  });

  it('never touches stdin when the size hint is out of cap', () => {
    const { child, writes } = fakeChild();
    const written = writePreviewRequest(child, scene(), { maxHeight: PREVIEW_MAX_HEIGHT + 1 });
    expect(written).toMatchObject({ ok: false, field: 'maxHeight' });
    expect(writes).toHaveLength(0);
  });

  it('fails closed on a missing or broken child stdin', () => {
    expect(writePreviewRequest(null, scene())).toMatchObject({ ok: false, field: '<child>' });
    expect(writePreviewRequest({}, scene())).toMatchObject({ ok: false, field: '<child>' });
    const { child } = fakeChild({ throws: true });
    const written = writePreviewRequest(child, scene());
    expect(written.ok).toBe(false);
    expect(written.field).toBe('<child>');
    expect(written.error).toContain('EPIPE');
  });
});

describe('parsePreviewResponse correlation (S0-T2)', () => {
  const okResponse = {
    v: 1,
    cmd: 'preview_response',
    reqId: 3,
    mediaType: 'image/jpeg',
    width: 240,
    height: 427,
    image: 'aGVsbG8=',
  };
  const errorResponse = {
    v: 1,
    cmd: 'preview_response',
    reqId: 3,
    error: { reason: 'preview_unavailable', message: 'preview renderer not available yet (S1-T6)' },
  };

  it('parses a successful response and matches the correlation id', () => {
    const parsed = parsePreviewResponse(JSON.stringify(okResponse), 3);
    expect(parsed).toEqual({
      ok: true,
      reqId: 3,
      mediaType: 'image/jpeg',
      width: 240,
      height: 427,
      image: 'aGVsbG8=',
    });
  });

  it('parses a typed error response instead of an image', () => {
    const parsed = parsePreviewResponse(JSON.stringify(errorResponse), 3);
    expect(parsed.ok).toBe(true);
    expect(parsed.reqId).toBe(3);
    expect(parsed.error.reason).toBe('preview_unavailable');
    expect(parsed.image).toBeUndefined();
  });

  it('parses the S1-T6 renderer error reasons as typed errors', () => {
    // The sidecar can now emit renderer-side reasons (payload cap,
    // containment, unsupported kinds); the shell must accept them as
    // typed errors, not reject them as unknown vocabulary.
    for (const reason of [
      'payload_too_large',
      'media_refused',
      'unsupported_background',
      'media_missing',
    ]) {
      const line = JSON.stringify({
        v: 1,
        cmd: 'preview_response',
        reqId: 3,
        error: { reason, message: `typed: ${reason}` },
      });
      expect(parsePreviewResponse(line, 3)).toEqual({
        ok: true,
        reqId: 3,
        error: { reason, message: `typed: ${reason}` },
      });
    }
  });

  it('rejects a response correlated to a different request', () => {
    const parsed = parsePreviewResponse(JSON.stringify(okResponse), 4);
    expect(parsed).toMatchObject({ ok: false, field: 'reqId' });
  });

  it('gives each request its own correlation id', () => {
    const first = buildPreviewRequest(scene());
    const second = buildPreviewRequest(scene());
    expect(first.reqId).not.toBe(second.reqId);
    const explicit = buildPreviewRequest(scene(), { reqId: 42 });
    expect(explicit.reqId).toBe(42);
    expect(explicit.envelope.reqId).toBe(42);
  });

  it('rejects malformed responses with a typed reason', () => {
    expect(parsePreviewResponse('not json')).toMatchObject({ ok: false, field: '<line>' });
    expect(parsePreviewResponse('"just a string"')).toMatchObject({ ok: false, field: '<line>' });
    expect(parsePreviewResponse(JSON.stringify({ ...okResponse, v: 2 }))).toMatchObject({
      ok: false,
      field: 'v',
    });
    expect(parsePreviewResponse(JSON.stringify({ ...okResponse, cmd: 'status' }))).toMatchObject({
      ok: false,
      field: 'cmd',
    });
    expect(parsePreviewResponse(JSON.stringify({ ...okResponse, reqId: 'x' }))).toMatchObject({
      ok: false,
      field: 'reqId',
    });
    const { image, ...withoutImage } = okResponse;
    expect(parsePreviewResponse(JSON.stringify(withoutImage))).toMatchObject({
      ok: false,
      field: 'image',
    });
    expect(
      parsePreviewResponse(JSON.stringify({ ...okResponse, image: 'not base64!!' }))
    ).toMatchObject({ ok: false, field: 'image' });
    expect(
      parsePreviewResponse(JSON.stringify({ ...okResponse, width: PREVIEW_MAX_WIDTH + 1 }))
    ).toMatchObject({ ok: false, field: 'width' });
    expect(
      parsePreviewResponse(
        JSON.stringify({ v: 1, cmd: 'preview_response', reqId: 3, error: { reason: 'vibes' } })
      )
    ).toMatchObject({ ok: false, field: 'error.reason' });
  });
});
