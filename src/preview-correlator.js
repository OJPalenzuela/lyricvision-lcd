'use strict';

// S2-T8 — reqId correlation for scene previews riding the LIVE sidecar pipe.
//
// Why this exists: preview_response shares stdout with acks/status lines, so
// the main-process router needs a seam that claims a preview line FIRST and
// settles exactly the request awaiting it. Pure CommonJS (no electron, no
// child handles) so tests/unit/scene-preview.test.js drives it directly.

const { parsePreviewResponse } = require('./bridge-spawn');

const DEFAULT_PREVIEW_TIMEOUT_MS = 3000;

// Late replies after a timeout land in a capped graveyard so they are
// consumed without growing unbounded. WHY a late reply can never settle a
// LATER request: reqIds come from nextPreviewReqId() in bridge-spawn.js - a
// strictly monotonic counter that never resets - so a stale id can never
// equal a future request's id. Monotonicity is the actual guarantee; this
// graveyard Set is a cheap backstop that only starts to matter if ids ever
// become reusable (e.g. someone adds a reset on sidecar restart).
const DISCARDED_CAP = 64;

// Reason tokens forwarded to the renderer, which maps each to actionable UI
// copy. Stable surface: asserted by tests on both sides of the IPC channel.
const PREVIEW_REASON = Object.freeze({
  INVALID_SCENE: 'preview_invalid_scene',
  SIDECAR_ABSENT: 'preview_sidecar_absent',
  EXITED: 'preview_sidecar_exited',
  TIMEOUT: 'preview_timeout',
  WRITE_FAILED: 'preview_write_failed',
  MALFORMED: 'preview_malformed_response',
  ENGINE: 'preview_engine_error'
});

// "<reason>: <detail>" — the renderer finds the reason token anywhere in the
// message (Electron wraps invoke errors), the detail stays for logs.
function previewError(reason, detail) {
  const err = new Error(detail ? `${reason}: ${detail}` : String(reason));
  err.previewReason = reason;
  return err;
}

function createPreviewCorrelator({ timeoutMs = DEFAULT_PREVIEW_TIMEOUT_MS } = {}) {
  const pending = new Map(); // reqId -> {resolve, reject, timer}
  const discarded = new Set(); // timed-out reqIds awaiting (or past) their late reply

  function clearEntry(reqId) {
    const entry = pending.get(reqId);
    if (!entry) return null;
    pending.delete(reqId);
    clearTimeout(entry.timer);
    return entry;
  }

  /** Wait for one preview_response. Timeout moves the id to the graveyard. */
  function wait(reqId) {
    if (pending.has(reqId)) {
      return Promise.reject(new Error(`duplicate preview reqId: ${reqId}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(reqId)) return;
        pending.delete(reqId);
        if (discarded.size >= DISCARDED_CAP) discarded.clear(); // cap beats precision
        discarded.add(reqId);
        reject(previewError(PREVIEW_REASON.TIMEOUT, `no response within ${timeoutMs} ms`));
      }, timeoutMs);
      // Must never hold the main process open by itself.
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(reqId, { resolve, reject, timer });
    });
  }

  /** Settle one pending request locally (e.g. the stdin write failed). */
  function settleError(reqId, err) {
    const entry = clearEntry(reqId);
    if (entry) entry.reject(err);
  }

  /** Sidecar gone: fail every waiter; no pending entry may survive. */
  function rejectAll(err) {
    for (const reqId of Array.from(pending.keys())) settleError(reqId, err);
  }

  function pendingCount() {
    return pending.size;
  }

  /**
   * True while `reqId` still sits in the timeout graveyard. Test/inspection
   * hook: production routing relies on monotonic reqIds (see DISCARDED_CAP),
   * not on consulting this Set.
   */
  function isDiscarded(reqId) {
    return discarded.has(reqId);
  }

  /**
   * Claim one stdout line. Returns true when the line IS a preview_response
   * (settled, dropped-as-late, or unmatched-but-claimed) so the caller never
   * falls through to the ack/status path; false for acks, status and junk.
   */
  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(String(line).trim());
    } catch {
      return false;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    if (msg.cmd !== 'preview_response') return false; // ack/status/junk: not ours

    const reqId = msg.reqId;
    if (Number.isInteger(reqId)) {
      const entry = clearEntry(reqId);
      if (entry) {
        const parsed = parsePreviewResponse(line); // verdict for THIS line
        if (parsed.ok && parsed.error) {
          // Engine rejected the scene: keep its reason token in the message.
          const { reason, message, field } = parsed.error;
          entry.reject(
            previewError(PREVIEW_REASON.ENGINE, `${reason}: ${message}${field ? ` (${field})` : ''}`)
          );
        } else if (parsed.ok) {
          entry.resolve(`data:${parsed.mediaType};base64,${parsed.image}`);
        } else {
          // Correlated but malformed (bad base64, wrong dimensions, …).
          entry.reject(previewError(PREVIEW_REASON.MALFORMED, `${parsed.field}: ${parsed.error}`));
        }
        return true;
      }
      // No waiter: a late reply after timeout (spend the graveyard entry)
      // or a stray id — either way it is consumed and dropped.
      discarded.delete(reqId);
      return true;
    }
    return true; // preview_response without a usable reqId: claim + drop
  }

  return { wait, settleError, rejectAll, handleLine, pendingCount, isDiscarded };
}

module.exports = {
  createPreviewCorrelator,
  previewError,
  PREVIEW_REASON,
  DEFAULT_PREVIEW_TIMEOUT_MS
};
