"""Version-0 wire constants for the Thermalright USB LCD bridge.

LV-03 scope: pure constants and pure helpers only. No USB I/O here;
the live bridge (claim, handshake exchange, streaming loop) lands in LV-04.

S0-T2 extends this file with the versioned stdin/stdout JSONL preview
envelope (preview_request / preview_response): still pure — validation and
message construction only; the sidecar's stdin dispatch lives in
bridge/lcd_bridge.py and answers from there.

Transport recap (locked, LV-01): USBDISPLAY 87AD:70DB, interface 0
class 0xFF, bulk OUT endpoint 0x01 / IN 0x81, wMaxPacketSize 512,
WinUSB driver, no Zadig needed.
"""

import json
import math
import re
import struct
from typing import Any, Dict, Iterator, NoReturn, Optional, Tuple

# --- Handshake (64 bytes, host -> device then device -> host) ---
HANDSHAKE_SIZE = 64
HANDSHAKE_MAGIC = bytes((0x12, 0x34, 0x56, 0x78))  # echoed back by device
HANDSHAKE_TAG = b"SSCRM-V1"
PM_OFFSET = 24  # panel model byte in the device response
SUB_OFFSET = 36  # panel sub-model byte in the device response

# --- Frame header (64 bytes, little-endian) ---
HEADER_SIZE = 64
MAGIC = 0x78563412  # u32 LE @0; on the wire: 12 34 56 78
OFF_MAGIC = 0
OFF_CMD = 4  # u32 LE: command id
OFF_W = 8  # u16 LE: buffer width
OFF_H = 12  # u16 LE: buffer height
OFF_MODE = 0x38  # u8: payload mode (2 = JPEG)
OFF_PAYLOAD_LEN = 0x3C  # u32 LE: payload byte length

CMD_FRAME = 2  # still-image frame command
MODE_JPEG = 2

# Panel model value that selects RGB565 big-endian raw encoding
# instead of JPEG (kept as a constant so LV-04 never hardcodes it).
PM_RGB565BE = 32

# --- Bulk streaming ---
CHUNK_SIZE = 16 * 1024  # payload split into 16 KiB bulk writes
BULK_PACKET = 512  # wMaxPacketSize; a transfer ending on this boundary needs a ZLP


def parse_handshake(resp: bytes) -> Tuple[int, int]:
    """Extract ``(pm, sub)`` from a raw handshake response.

    Raises ``ValueError`` on short/empty responses instead of returning
    a guessed default.
    """
    if len(resp) <= SUB_OFFSET:
        raise ValueError(
            f"handshake response too short: {len(resp)} bytes, "
            f"need more than {SUB_OFFSET}"
        )
    return resp[PM_OFFSET], resp[SUB_OFFSET]


def build_frame_header(w: int, h: int, cmd: int, payload_len: int) -> bytes:
    """Build the 64-byte little-endian frame header.

    Layout: magic u32 @0, cmd u32 @4, w u16 @8, h u16 @12,
    mode u8 @0x38, payload length u32 @0x3C; all other bytes zero.
    """
    header = bytearray(HEADER_SIZE)
    struct.pack_into("<I", header, OFF_MAGIC, MAGIC)
    struct.pack_into("<I", header, OFF_CMD, cmd)
    struct.pack_into("<H", header, OFF_W, w)
    struct.pack_into("<H", header, OFF_H, h)
    header[OFF_MODE] = MODE_JPEG
    struct.pack_into("<I", header, OFF_PAYLOAD_LEN, payload_len)
    return bytes(header)


def iter_chunks(payload: bytes) -> Iterator[Tuple[bytes, bool]]:
    """Yield ``(chunk, need_zlp)`` pairs for a frame payload.

    Payload goes out in 16 KiB bulk writes. ``need_zlp`` is True only on
    the last chunk when the total payload length is an exact multiple of
    the 512-byte bulk packet size (a transfer ending on a packet boundary
    must be terminated with a zero-length packet). Empty payloads yield
    nothing.
    """
    total = len(payload)
    zlp = total > 0 and total % BULK_PACKET == 0
    for offset in range(0, total, CHUNK_SIZE):
        chunk = payload[offset : offset + CHUNK_SIZE]
        last = offset + CHUNK_SIZE >= total
        yield chunk, (zlp and last)


# --- Versioned stdin/stdout JSONL preview pair (S0-T2) ---
#
# Envelope shape follows the pairing that already ships: src/main.js
# buildBridgeEnvelope writes {"v":1,"seq":N,"cmd":"state","state":{...}} and
# bridge/lcd_bridge.py parse_state_line accepts v == 1 (plus the legacy
# {"type":"state",...} form). There is NO version handshake anywhere — both
# sides hardcode 1 — so v stays 1 and preview traffic is added as NEW cmd
# values inside v:1. Bumping v would reject every state line an already
# shipped shell sends to an already shipped sidecar, with nothing to
# negotiate it back down.

PROTOCOL_VERSION = 1
CMD_PREVIEW_REQUEST = "preview_request"
CMD_PREVIEW_RESPONSE = "preview_response"
CMD_ERROR = "error"

# Reduced-resolution cap on purpose: the base64 image crosses the SAME JSONL
# pipe that carries playback state every 2s while playing (15s idle), and a
# full 480x854 image would push those state lines behind a multi-hundred-KB
# blob. Half-scale of the portrait glass => a quarter of the pixels. S1-T6
# renders through render_scene at exactly this cap (lcd_bridge.preview_size).
PREVIEW_MAX_WIDTH = 480 // 2  # 240
PREVIEW_MAX_HEIGHT = 854 // 2  # 427

# S1-T6 payload cap: one preview_response crosses the same JSONL pipe as
# playback state, so the ENCODED image is bounded BEFORE it is emitted --
# never an unbounded line, never a pipe flood, always a typed refusal.
# 512 KiB of base64 (~384 KiB PNG) sits an order of magnitude above every
# realistic 240x427 render (measured on the pinned Pillow 12.3.0: color +
# text 4.3 KB, structured image scene 44.7 KB) while still refusing a
# crafted incompressible payload (240x427 RGBA noise = 547,488 base64
# chars) with reason "payload_too_large" instead of writing it out.
PREVIEW_MAX_BASE64_CHARS = 512 * 1024  # 524,288

PREVIEW_MEDIA_TYPES = ("image/jpeg", "image/png")

# Closed vocabulary for typed errors: a preview_response carries either an
# image or an error.reason from this tuple -- never both, never neither.
# S1-T6 adds the renderer's typed SceneRenderError reasons (a preview
# failure keeps the SAME greppable discriminator the renderer uses) plus
# the payload cap; "preview_unavailable" leaves the happy path and remains
# only as the missing-Pillow fallback below. src/bridge-spawn.js mirrors
# this list exactly and both suites pin it, so drift fails a test.
PREVIEW_ERROR_REASONS = (
    "invalid_request",
    "preview_unavailable",
    "render_failed",
    "version_mismatch",
    "unknown_cmd",
    "payload_too_large",
    "unsupported_background",
    "unsupported_overlay",
    "media_refused",
    "media_missing",
    "media_unreadable",
    "media_too_large",
    "text_too_long",
)

# Fallback message for the ONE genuinely unrenderable condition left after
# S1-T6: the Pillow renderer binary is absent. A valid, renderable scene
# never produces this reason anymore -- it renders.
PREVIEW_UNAVAILABLE_MESSAGE = (
    "preview renderer unavailable: Pillow is not installed "
    "(pip install -r bridge/requirements.txt)"
)

# Scene model constants mirrored from src/hardening.js (SCENE_VERSION,
# SCENE_OVERLAYS_CAP). See validate_scene for the lockstep contract.
SCENE_VERSION = 1
SCENE_OVERLAYS_CAP = 32
SCENE_KEYS = ("version", "background", "overlays")
PREVIEW_REQUEST_KEYS = ("v", "cmd", "reqId", "maxWidth", "maxHeight", "scene")

_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_BASE64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


class ProtocolError(ValueError):
    """Typed envelope rejection.

    This module's existing mechanism for malformed input is ValueError (see
    parse_handshake); ProtocolError keeps that contract while carrying the
    wire-level ``reason`` and the offending ``field`` so callers can answer
    with a well-formed error envelope instead of crashing or guessing.
    """

    def __init__(self, reason: str, message: str, field: Optional[str] = None):
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.field = field


def parse_json_object(line: str) -> Optional[Dict[str, Any]]:
    """Decode one JSONL line as a JSON object.

    None for blank, non-JSON or non-object lines: transport noise is not a
    message, matching parse_state_line's historical tolerance.
    """
    stripped = line.strip()
    if not stripped:
        return None
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _reject(field: str, error: str) -> NoReturn:
    raise ProtocolError("invalid_request", f"{field}: {error}", field=field)


def _first_unknown_key(value: Dict[str, Any], allowed: Tuple[str, ...]) -> Optional[str]:
    for key in value:
        if key not in allowed:
            return key
    return None


def _is_finite_number(value: Any) -> bool:
    # bool is an int subclass in Python while `typeof true === 'number'` is
    # false in JS: a boolean must be rejected to keep verdicts identical.
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def _is_unit_fraction(value: Any) -> bool:
    return _is_finite_number(value) and 0 <= value <= 1


def _is_hex_color(value: Any) -> bool:
    return isinstance(value, str) and _HEX_COLOR_RE.match(value) is not None


def _is_source(value: Any) -> bool:
    """Non-empty, no NUL (C path APIs truncate there), no ".." SEGMENT across
    either separator — "smile..png" stays legal. Mirrors hardening.isSource."""
    if not isinstance(value, str) or not value:
        return False
    if "\x00" in value:
        return False
    return ".." not in re.split(r"[/\\]", value)


def _background_keys(kind: Any) -> Optional[Tuple[str, ...]]:
    if kind == "none":
        return ("kind",)
    if kind == "color":
        return ("kind", "color")
    if kind in ("image", "gif", "video"):
        return ("kind", "source", "rotation", "flipH", "scale", "panX", "panY", "fit")
    return None


def _overlay_keys(kind: Any) -> Optional[Tuple[str, ...]]:
    if kind == "text":
        return ("kind", "text", "x", "y", "size", "rotation", "color")
    if kind == "gpu-temp":
        return ("kind", "x", "y", "size", "rotation", "color")
    return None


def _validate_background(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        _reject("background", "background must be an object")
    allowed = _background_keys(value.get("kind"))
    if allowed is None:
        _reject("background.kind", f"unknown background kind: {value.get('kind')}")
    unknown = _first_unknown_key(value, allowed)
    if unknown is not None:
        _reject(f"background.{unknown}", f"unknown background key: {unknown}")
    kind = value.get("kind")
    if kind == "none":
        return {"kind": "none"}
    if kind == "color":
        if not _is_hex_color(value.get("color")):
            _reject("background.color", "color must match #rrggbb")
        return {"kind": "color", "color": value.get("color")}
    # image / gif / video. `source` reaches a filesystem read downstream, so
    # it is rejected here as untrusted input, before anything consumes it.
    if not _is_source(value.get("source")):
        _reject(
            "background.source",
            'source must be a non-empty string without NUL or ".." segments',
        )
    if not _is_finite_number(value.get("rotation")):
        _reject("background.rotation", "rotation must be a finite number")
    if not isinstance(value.get("flipH"), bool):
        _reject("background.flipH", "flipH must be a boolean")
    scale = value.get("scale")
    if not _is_finite_number(scale) or scale <= 0:
        _reject("background.scale", "scale must be a finite number greater than 0")
    if not _is_finite_number(value.get("panX")):
        _reject("background.panX", "panX must be a finite number")
    if not _is_finite_number(value.get("panY")):
        _reject("background.panY", "panY must be a finite number")
    if value.get("fit") not in ("fit", "fill"):
        _reject("background.fit", "fit must be 'fit' or 'fill'")
    return {
        "kind": kind,
        "source": value.get("source"),
        "rotation": value.get("rotation"),
        "flipH": value.get("flipH"),
        "scale": scale,
        "panX": value.get("panX"),
        "panY": value.get("panY"),
        "fit": value.get("fit"),
    }


def _first_non_index_key(value: list) -> Optional[str]:
    """Mirror of hardening.firstNonIndexKey.

    Canonical index keys live in the list storage itself, so ANY own property
    on the instance is non-index drift. JSON cannot produce one; the shared
    corpus materializes it with a list subclass (materialize.extraOverlayProps
    in tests/fixtures/scene-shapes.json) the way the JS suite does
    Object.assign on the array.
    """
    if hasattr(value, "__dict__"):
        for key in value.__dict__:
            return key
    return None


def _validate_overlay(value: Any, index: int) -> Dict[str, Any]:
    at = f"overlays[{index}]"
    if not isinstance(value, dict):
        _reject(at, "overlay must be an object")
    allowed = _overlay_keys(value.get("kind"))
    if allowed is None:
        _reject(f"{at}.kind", f"unknown overlay kind: {value.get('kind')}")
    unknown = _first_unknown_key(value, allowed)
    if unknown is not None:
        _reject(f"{at}.{unknown}", f"unknown overlay key: {unknown}")
    if value.get("kind") == "text" and not isinstance(value.get("text"), str):
        _reject(f"{at}.text", "text must be a string")
    for axis in ("x", "y", "size"):
        if not _is_unit_fraction(value.get(axis)):
            _reject(f"{at}.{axis}", f"{axis} must be a fraction in [0,1]")
    if not _is_finite_number(value.get("rotation")):
        _reject(f"{at}.rotation", "rotation must be a finite number")
    if not _is_hex_color(value.get("color")):
        _reject(f"{at}.color", "color must match #rrggbb")
    # Rebuilt from the allowlist, never spread from input: every key in
    # `allowed` was validated present by the checks above.
    return {key: value.get(key) for key in allowed}


def validate_scene(value: Any) -> Dict[str, Any]:
    """Validate untrusted scene JSON and return the sanitized copy.

    LOCKSTEP: src/hardening.js validateScene is the TypeScript-side authority
    for scene shape (S0-T1); this is its Python twin, needed because
    preview_request.scene crosses the process boundary and background.source
    later reaches a filesystem read — so it is re-checked here as untrusted
    input BEFORE anything downstream sees it. The two rule sets MUST stay in
    lockstep: both suites consume tests/fixtures/scene-shapes.json (42 shapes
    with explicit expect/field), so a rule change on one side fails the other
    side's suite instead of drifting silently.

    The rules mirror JS exactly; the RESULT shape differs by design: JS
    returns {ok,...} because a settings gate must never throw, while this
    module's rejection mechanism is ValueError (see parse_handshake), so a
    reject raises ProtocolError carrying the same field/error strings.
    """
    if not isinstance(value, dict):
        _reject("<root>", "scene must be an object")
    unknown = _first_unknown_key(value, SCENE_KEYS)
    if unknown is not None:
        _reject(unknown, f"unknown scene key: {unknown}")
    version = value.get("version")
    if isinstance(version, bool) or version != SCENE_VERSION:
        _reject("version", f"version must be {SCENE_VERSION}")
    background = _validate_background(value.get("background"))
    overlays = value.get("overlays")
    if not isinstance(overlays, list):
        _reject("overlays", "overlays must be an array")
    extra = _first_non_index_key(overlays)
    if extra is not None:
        _reject("overlays", f"overlays must not define own non-index property: {extra}")
    if len(overlays) > SCENE_OVERLAYS_CAP:
        _reject("overlays", f"overlays exceeds the cap of {SCENE_OVERLAYS_CAP}")
    validated = [_validate_overlay(item, i) for i, item in enumerate(overlays)]
    return {"version": version, "background": background, "overlays": validated}


def validate_preview_request(payload: Any) -> Dict[str, Any]:
    """Parse and validate an incoming preview_request envelope.

    Raises ProtocolError (a ValueError): reason "version_mismatch" when `v`
    is not the shipped PROTOCOL_VERSION, "invalid_request" for anything else
    — including a scene that fails validate_scene. Returns the correlated,
    range-checked request:
    ``{"reqId": int, "maxWidth": int, "maxHeight": int, "scene": dict}``.
    """
    if not isinstance(payload, dict):
        _reject("<root>", "preview_request must be an object")
    unknown = _first_unknown_key(payload, PREVIEW_REQUEST_KEYS)
    if unknown is not None:
        _reject(unknown, f"unknown preview_request key: {unknown}")
    version = payload.get("v")
    if isinstance(version, bool) or version != PROTOCOL_VERSION:
        raise ProtocolError(
            "version_mismatch",
            f"unsupported protocol version: {version!r} (expected {PROTOCOL_VERSION})",
        )
    if payload.get("cmd") != CMD_PREVIEW_REQUEST:
        _reject("cmd", f"cmd must be {CMD_PREVIEW_REQUEST}")
    req_id = payload.get("reqId")
    if isinstance(req_id, bool) or not isinstance(req_id, int) or req_id < 1:
        _reject("reqId", "reqId must be a positive integer")
    sizes: Dict[str, int] = {}
    for key, cap in (("maxWidth", PREVIEW_MAX_WIDTH), ("maxHeight", PREVIEW_MAX_HEIGHT)):
        size = payload.get(key)
        if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= cap:
            _reject(key, f"{key} must be an integer in [1,{cap}]")
        sizes[key] = size
    scene = validate_scene(payload.get("scene"))
    return {
        "reqId": req_id,
        "maxWidth": sizes["maxWidth"],
        "maxHeight": sizes["maxHeight"],
        "scene": scene,
    }


def build_preview_response(
    req_id: int,
    image: str,
    media_type: str,
    width: int,
    height: int,
) -> Dict[str, Any]:
    """Well-formed preview_response carrying a base64 image (S1-T6 renders).

    Validated here so the renderer cannot emit an off-contract line: base64
    payload, allowlisted media type, and the produced size inside the
    reduced-resolution cap that keeps the shared JSONL pipe responsive.
    """
    if not isinstance(req_id, int) or isinstance(req_id, bool):
        raise ValueError("preview response requires an integer reqId")
    if not isinstance(image, str) or not _BASE64_RE.match(image):
        raise ValueError("preview image must be a non-empty base64 string")
    if media_type not in PREVIEW_MEDIA_TYPES:
        raise ValueError(f"unsupported preview media type: {media_type!r}")
    if not isinstance(width, int) or isinstance(width, bool) or not 1 <= width <= PREVIEW_MAX_WIDTH:
        raise ValueError(f"preview width must be an integer in [1,{PREVIEW_MAX_WIDTH}]")
    if not isinstance(height, int) or isinstance(height, bool) or not 1 <= height <= PREVIEW_MAX_HEIGHT:
        raise ValueError(f"preview height must be an integer in [1,{PREVIEW_MAX_HEIGHT}]")
    return {
        "v": PROTOCOL_VERSION,
        "cmd": CMD_PREVIEW_RESPONSE,
        "reqId": req_id,
        "mediaType": media_type,
        "width": width,
        "height": height,
        "image": image,
    }


def build_preview_error(
    req_id: Optional[int],
    reason: str,
    message: str,
    field: Optional[str] = None,
) -> Dict[str, Any]:
    """preview_response that carries a typed error instead of an image.

    ``reason`` must come from PREVIEW_ERROR_REASONS: callers pass values
    ProtocolError already minted (or PREVIEW_UNAVAILABLE_MESSAGE), so the
    validation of untrusted input stays on the reading side, never on our
    own constructors. ``reqId`` is echoed even when the request was too
    malformed to carry a usable one (None -> null) so the shell can still
    see which line failed.
    """
    envelope: Dict[str, Any] = {
        "v": PROTOCOL_VERSION,
        "cmd": CMD_PREVIEW_RESPONSE,
        "reqId": req_id,
        "error": {"reason": reason, "message": message},
    }
    if field is not None:
        envelope["error"]["field"] = field
    return envelope


def build_protocol_error(reason: str, message: str) -> Dict[str, Any]:
    """Envelope-level rejection that is not attributable to a preview request:
    an unknown cmd, or a version mismatch on a foreign message.

    `cmd` is "error" — deliberately NOT preview_response — so the shell can
    tell "your preview failed" apart from "I could not parse your message".
    """
    return {
        "v": PROTOCOL_VERSION,
        "cmd": CMD_ERROR,
        "error": {"reason": reason, "message": message},
    }
