"""LyricVision LCD bridge v0.1 (LV-04).

Reads Spotify playback state as JSONL on stdin, renders a portrait frame
at glass resolution, rotates it into the landscape USB buffer, encodes
JPEG q80 4:2:0 and streams it over bulk USB.

Glass truth (locked LV-01): Vision MAX PM=11/SUB=5, buffer 854x480,
glass 480x854 portrait, rotate 90 CW in software, continuous stream
(the firmware blanks without it). TRCC/SignalRGB hold the device
exclusively: this bridge only REPORTS that condition (exit 3, status
``blocked``); retry policy lives in LV-05 (Electron shell).

Stdout is machine-readable JSONL only:
  {"type": "status", ...}  ~1 Hz (panel, pm/sub, fps, queue)
  {"type": "ack", "seq": N}  once per painted frame that used a seq, plus
                             once for a drained seq whose frame was skipped
                             as unchanged (S1-T7b)
Human logs go to stderr. Exit codes: 0 ok, 2 unknown panel, 3 busy/absent.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import queue
import struct
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from typing import Any, Dict, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.protocol import (  # noqa: E402
    CMD_FRAME,
    CMD_PREVIEW_REQUEST,
    HEADER_SIZE,
    MAGIC,
    PREVIEW_MAX_BASE64_CHARS,
    PREVIEW_UNAVAILABLE_MESSAGE,
    PROTOCOL_VERSION,
    ProtocolError,
    build_frame_header,
    build_preview_error,
    build_preview_response,
    build_protocol_error,
    iter_chunks,
    parse_handshake,
    parse_json_object,
    validate_preview_request,
    validate_scene,
)
from panels.registry import PanelProfile, lookup  # noqa: E402

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - surfaced clearly at runtime
    Image = None  # type: ignore

VID = 0x87AD
PID = 0x70DB
EP_OUT = 0x01
EP_IN = 0x81

DEFAULT_FPS = 10
MIN_FPS = 5
MAX_FPS = 30

DEFAULT_GLASS = (480, 854)

STATUS_INTERVAL_S = 1.0


class UnknownPanelError(Exception):
    """Handshake returned a (pm, sub) pair with no registry row."""

    def __init__(self, pm: int, sub: int):
        super().__init__(
            f"unknown panel PM={pm} SUB={sub}: no registry row; "
            "refusing to push pixels rather than guessing"
        )
        self.pm = pm
        self.sub = sub


class DeviceUnavailableError(Exception):
    """Device absent or exclusively held (TRCC/SignalRGB)."""

    def __init__(self, message: str, status: str = "no-device"):
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------
# Pure helpers (unit-tested, no USB/PIL side effects except where noted)
# --------------------------------------------------------------------------


def clamp_fps(raw: Any, default: int = DEFAULT_FPS) -> int:
    """Clamp an lcdFps setting into [5, 30]; garbage -> default (10)."""
    try:
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            return default
        value = int(raw)
    except (TypeError, ValueError):
        return default
    if value < MIN_FPS:
        return MIN_FPS
    if value > MAX_FPS:
        return MAX_FPS
    return value


def fps_from_state(state: Dict[str, Any]) -> int:
    """Extract lcdFps from a state dict (settings.lcdFps), clamped."""
    settings = state.get("settings")
    if not isinstance(settings, dict):
        return DEFAULT_FPS
    return clamp_fps(settings.get("lcdFps"), DEFAULT_FPS)


def _finite_float(value: Any) -> Optional[float]:
    """Coerce to a finite float; None for garbage (including bools)."""
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def current_progress(state: Dict[str, Any], now_ms: Optional[float] = None) -> float:
    """Extrapolated playback position in ms (LV-08, pure).

    When playing: ``progressMs + (now - measuredAt) + offsetMs``, clamped
    to >= 0. When paused (``isPlaying`` false/missing): static
    ``progressMs + offsetMs``, clamped to >= 0 (no time extrapolation, so
    the bar and clock freeze on pause).
    ``measuredAt`` is the Spotify ``timestamp`` (or the local receipt time)
    captured by the shell; without it, falls back to legacy ``updatedAt``,
    and without either, to the static ``progressMs`` (+ offset).
    ``now_ms`` defaults to the live clock; tests freeze it.

    LV-09 unified fix (A): ``measuredAt <= 0`` is the shell's old "missing"
    sentinel, never a valid Spotify timestamp (~1.7e12). It is treated as
    missing (static fallback); otherwise extrapolation from epoch 0 explodes
    to ~29M minutes and pins the bar at 100% (root cause of the glass bug).
    """
    base_ms = 0.0
    offset_ms = 0.0
    measured_at: Optional[float] = None
    is_playing = False
    if isinstance(state, dict):
        track = state.get("track")
        track_scope = track if isinstance(track, dict) else {}
        is_playing = bool(state.get("isPlaying", track_scope.get("isPlaying", False)))
        for scope in (state, state.get("track")):
            if isinstance(scope, dict) and "progressMs" in scope:
                coerced = _finite_float(scope["progressMs"])
                if coerced is not None:
                    base_ms = coerced
                    break
        coerced_offset = _finite_float(state.get("offsetMs"))
        if coerced_offset is not None:
            offset_ms = coerced_offset
        for key in ("measuredAt", "updatedAt"):
            coerced = _finite_float(state.get(key))
            if coerced is not None:
                measured_at = coerced
                break
        if measured_at is not None and measured_at <= 0:
            measured_at = None
    if not is_playing:
        return max(0.0, base_ms + offset_ms)
    now = _finite_float(now_ms)
    if now is None:
        now = time.time() * 1000.0
    if measured_at is None:
        return max(0.0, base_ms + offset_ms)
    return max(0.0, base_ms + (now - measured_at) + offset_ms)


# --------------------------------------------------------------------------
# Unified layout LV-09: single portrait view (compat note).
# Decision de producto: UNA sola vista, no layouts separados. Los valores
# guardados viejos 'lyrics'|'cover' se SIGUEN aceptando en la whitelist
# (compat: no rompe settings.json existentes) pero se IGNORAN al renderizar.
# m:ss + artwork LRU viven aqui (puros salvo fetch).
# --------------------------------------------------------------------------

LAYOUTS = ("lyrics", "cover")
DEFAULT_LAYOUT = "lyrics"


def is_valid_layout(value: Any) -> bool:
    """Whitelist check: exact 'lyrics'|'cover' only (case-sensitive).

    LV-09 unified: kept for COMPAT (old settings.json files still validate)
    but IGNORED at render time (single view, nothing to choose).
    """
    return isinstance(value, str) and value in LAYOUTS


def normalize_layout(raw: Any) -> str:
    """Normalize a layout value; garbage -> 'lyrics' (the default).

    LV-09 unified: compat only, the result is accepted but ignored.
    """
    return raw if is_valid_layout(raw) else DEFAULT_LAYOUT


def layout_from_state(state: Dict[str, Any]) -> str:
    """Extract the render layout from a state dict (top-level wins, then
    settings.layout); unknown/missing -> 'lyrics'.

    LV-09 unified: compat only, render_portrait ignores the result.
    """
    if not isinstance(state, dict):
        return DEFAULT_LAYOUT
    top = state.get("layout")
    if is_valid_layout(top):
        return top  # type: ignore[return-value]
    settings = state.get("settings")
    if isinstance(settings, dict) and is_valid_layout(settings.get("layout")):
        return settings["layout"]  # type: ignore[return-value]
    return DEFAULT_LAYOUT


def format_time(ms: Any) -> str:
    """Format milliseconds as m:ss (LV-09, pure). Garbage/negative -> 0:00."""
    try:
        if isinstance(ms, bool):
            return "0:00"
        total_s = int(float(ms) // 1000)
    except (TypeError, ValueError, OverflowError):
        return "0:00"
    if total_s < 0:
        total_s = 0
    minutes = total_s // 60
    seconds = total_s % 60
    return f"{minutes}:{seconds:02d}"


ART_CACHE_MAX = 30
ART_FETCH_TIMEOUT_S = 5

# URL -> (PIL Image | None, timestamp). None marks a failed fetch so the
# same track never retries (a new URL still tries once). OrderedDict for LRU.
_art_cache: "OrderedDict[str, Tuple[Any, float]]" = OrderedDict()


def clear_art_cache() -> None:
    """Empty the artwork cache (tests + track-change hygiene)."""
    _art_cache.clear()


def _art_cache_put(url: str, value: Any) -> None:
    """Insert (image|None, now) with LRU eviction at ART_CACHE_MAX."""
    if url in _art_cache:
        del _art_cache[url]
    _art_cache[url] = (value, time.time())
    while len(_art_cache) > ART_CACHE_MAX:
        _art_cache.popitem(last=False)  # evict oldest


def fetch_artwork(url: Any, timeout_s: float = ART_FETCH_TIMEOUT_S):
    """Fetch + decode artwork to a PIL RGB image (LV-09).

    urllib with a 5s timeout; results cached per URL (tope 30, LRU with
    timestamp). Empty URLs return None without I/O. Errors/timeouts/bad
    bytes are cached as None so the same track falls back without
    retrying; a new URL (new track) tries once.
    """
    if not isinstance(url, str) or not url.strip():
        return None
    key = url.strip()
    hit = _art_cache.get(key)
    if hit is not None:
        # LRU touch on hits.
        value, _ts = hit
        del _art_cache[key]
        _art_cache[key] = (value, _ts)
        return value
    try:
        req = urllib.request.Request(key, headers={"User-Agent": "LyricVision-LCD/0.1"})
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = resp.read(8 * 1024 * 1024)  # 8 MiB cap: album art is ~100 KiB
        if Image is None:
            raise RuntimeError("Pillow is required for artwork decode")
        img = Image.open(io.BytesIO(data)).convert("RGB")
        img.load()
    except Exception:
        _art_cache_put(key, None)
        return None
    _art_cache_put(key, img)
    return img


def parse_state_line(line: str) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
    """Parse one stdin JSONL line.

    Accepts versioned ``{"v":1,"seq":N,"cmd":"state","state":{...}}`` and
    legacy ``{"type":"state","state":{...}}`` (optional ``"seq"`` field).
    Returns ``(seq, state)``; ``(None, None)`` for blank/invalid lines.
    """
    line = line.strip()
    if not line:
        return None, None
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return None, None
    if not isinstance(payload, dict):
        return None, None
    state = payload.get("state")
    if not isinstance(state, dict):
        return None, None
    seq: Optional[int] = None
    if isinstance(payload.get("seq"), int):
        seq = payload["seq"]
    elif isinstance(payload.get("seq"), float) and payload["seq"].is_integer():
        seq = int(payload["seq"])
    is_versioned = payload.get("cmd") == "state" and payload.get("v") == 1
    is_legacy = payload.get("type") == "state"
    if not (is_versioned or is_legacy):
        # Tolerate bare state envelopes with a dict state + explicit seq.
        if seq is None:
            return None, None
    return seq, state


# --------------------------------------------------------------------------
# Preview rendering (S1-T6): a valid preview_request is answered with a real
# base64 PNG rendered by the SAME render_scene() the panel will use (S1-T7).
#
# media_root provenance -- containment depends on it. The sidecar is spawned
# by src/bridge-spawn.js resolveBridgeCommand, which passes ONLY --serial /
# --once argv (src/bridge-spawn.js:49-78) and stdio (src/bridge-spawn.js:
# 85-90): no cwd, no env override; and NO media-root key exists on the wire
# (bridge/protocol.py PREVIEW_REQUEST_KEYS pins the envelope keys). This
# module reads no environment variable either. So the ONE trusted anchor for
# the containment root is this file's own location: bridge-spawn.js
# repoRoot()/bridgeScript() (src/bridge-spawn.js:18-24) anchor the bridge at
# <repo>/bridge/*.py exactly the way __file__ does here. The wire can
# therefore never move the root: background.source is only ever resolved
# INSIDE this fixed directory (or is a data: URL, no filesystem at all), so
# _resolve_media_source keeps its containment meaning on this new call path.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEDIA_ROOT = os.path.join(REPO_ROOT, "media")

PREVIEW_MEDIA_TYPE = "image/png"


def preview_size(max_width: int, max_height: int) -> Tuple[int, int]:
    """Aspect-preserving preview size inside the request's hint box.

    Scene coordinates are normalized 0-1 fractions of the canvas, which is
    EXACTLY why the same scene renders correctly at any size: 240x427 is
    the same code path as 480x854 with smaller pixel math -- never a second
    renderer, never a post-hoc downscale. This helper only has to keep the
    glass aspect (480:854) inside the caller's caps, so (240, 427) -- an
    exact half of the glass -- is WYSIWYG with what the panel shows
    (tests/test_preview_render.py proves it against the full-size render).
    """
    glass_w, glass_h = DEFAULT_GLASS
    scale = min(max_width / glass_w, max_height / glass_h)
    width = max(1, min(max_width, round(glass_w * scale)))
    height = max(1, min(max_height, round(glass_h * scale)))
    return width, height


def _render_preview_response(request: Dict[str, Any]) -> Dict[str, Any]:
    """Render a VALIDATED preview_request into its preview_response envelope.

    Total by contract (route_stdin_line must never raise): containment
    refusals, unsupported kinds, decode failures, the payload cap and even
    an unexpected exception become typed error envelopes with a greppable
    reason. A traceback over stdout would be parsed as JSONL noise and
    silently dropped, leaving the shell waiting on a reply never sent.
    """
    req_id = request["reqId"]
    if Image is None:
        # The one genuinely unrenderable condition left after S1-T6: the
        # Pillow renderer binary itself is absent. The happy path renders.
        return build_preview_error(
            req_id, "preview_unavailable", PREVIEW_UNAVAILABLE_MESSAGE
        )
    size = preview_size(request["maxWidth"], request["maxHeight"])
    try:
        # frame_index: the envelope carries NO frame selector
        # (bridge/protocol.py PREVIEW_REQUEST_KEYS pins the keys), so the
        # documented default is 0 -- render_scene's own default, i.e. the
        # first GIF frame: a deterministic still (same request -> identical
        # response), which is what a static preview must show.
        canvas = render_scene(
            request["scene"], media_root=MEDIA_ROOT, size=size, frame_index=0
        )
        buffer = io.BytesIO()
        canvas.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    except SceneRenderError as exc:
        # Typed renderer failure: reason/field pass through verbatim so the
        # shell sees the same discriminator the renderer itself uses.
        return build_preview_error(req_id, exc.reason, exc.message, exc.field)
    except ProtocolError as exc:
        # render_scene re-validates as defense in depth; unreachable via
        # route_stdin_line (validation already ran) but still typed.
        return build_preview_error(req_id, exc.reason, exc.message, exc.field)
    except Exception as exc:  # total contract: no traceback may escape
        return build_preview_error(
            req_id, "render_failed", f"preview render failed: {exc}"
        )
    if len(encoded) > PREVIEW_MAX_BASE64_CHARS:
        # Payload cap BEFORE emit: the preview shares the JSONL pipe with
        # playback state, so an over-cap line is refused as a typed error
        # instead of flooding the pipe (the cap is read from this module's
        # namespace at call time; tests pin both directions).
        return build_preview_error(
            req_id,
            "payload_too_large",
            f"encoded preview is {len(encoded)} base64 chars, over the "
            f"{PREVIEW_MAX_BASE64_CHARS} char cap",
        )
    return build_preview_response(req_id, encoded, PREVIEW_MEDIA_TYPE, size[0], size[1])


def route_stdin_line(line: str) -> Optional[Tuple[str, Any, Any]]:
    """Route one stdin JSONL line (S0-T2).

    Returns:
      ("state", seq, state) -- a state envelope (versioned, legacy or bare)
          destined for the render queue: unchanged shipped pairing;
      ("reply", envelope)   -- a message that must be ANSWERED: a
          preview_response for a valid, invalid or wrong-version
          preview_request, or a typed cmd:"error" envelope for an unknown
          message type or an unusable state envelope;
      None -- blank/non-JSON/non-object transport noise, tolerated exactly as
          before (parse_state_line keeps its historical contract).

    Total by contract: never raises. An exception here would kill the stdin
    reader thread and leave the shell waiting on a sidecar that stopped
    taking state — a rejected message must become a reply, never a crash.
    """
    seq, state = parse_state_line(line)
    if state is not None:
        return ("state", seq, state)
    payload = parse_json_object(line)
    if payload is None:
        return None
    cmd = payload.get("cmd")
    if cmd == CMD_PREVIEW_REQUEST:
        # Correlation id is read defensively so even a malformed request gets
        # an answer the shell can (or cannot) match back to its queue.
        raw_req_id = payload.get("reqId")
        req_id: Optional[int] = (
            raw_req_id
            if isinstance(raw_req_id, int) and not isinstance(raw_req_id, bool)
            else None
        )
        try:
            request = validate_preview_request(payload)
        except ProtocolError as exc:
            return (
                "reply",
                build_preview_error(req_id, exc.reason, exc.message, exc.field),
            )
        # S1-T6: a valid request renders to a real reduced-resolution PNG
        # through the SAME render_scene() the panel will use (S1-T7).
        return ("reply", _render_preview_response(request))
    version = payload.get("v")
    if "v" in payload and (isinstance(version, bool) or version != PROTOCOL_VERSION):
        return (
            "reply",
            build_protocol_error(
                "version_mismatch",
                f"unsupported protocol version: {version!r} (expected {PROTOCOL_VERSION})",
            ),
        )
    discriminator = cmd if isinstance(cmd, str) else payload.get("type")
    if discriminator == "state":
        # parse_state_line already declined it: known cmd, unusable payload.
        return (
            "reply",
            build_protocol_error(
                "invalid_request", "state envelope must carry a state object"
            ),
        )
    return (
        "reply",
        build_protocol_error("unknown_cmd", f"unknown message type: {discriminator!r}"),
    )


def extract_display(
    state: Dict[str, Any], now_ms: Optional[float] = None
) -> Dict[str, Any]:
    """Flatten a state dict into render fields (tolerates old shapes).

    ``progressMs`` is extrapolated via :func:`current_progress` so the bar
    keeps moving between polls while playing (frozen while paused);
    pass ``now_ms`` to freeze the clock (tests).
    """
    track = state.get("track") if isinstance(state.get("track"), dict) else {}
    lyric = state.get("lyric") if isinstance(state.get("lyric"), dict) else {}

    title = str(track.get("title") or state.get("title") or "Unknown Track")
    artist = str(track.get("artist") or state.get("artist") or "")

    current = lyric.get("current_line", lyric.get("current", ""))
    nxt = lyric.get("next_line", lyric.get("next", ""))

    # Fallback: legacy shape track.lyrics.syncedLyrics [{text,startMs}].
    if not current and isinstance(track.get("lyrics"), dict):
        lyrics = track["lyrics"]
        items = lyrics.get("syncedLyrics") or []
        if isinstance(items, list) and items:
            progress = state.get("progressMs", track.get("progressMs", 0)) or 0
            try:
                progress_f = float(progress)
            except (TypeError, ValueError):
                progress_f = 0.0
            active = 0
            for i, item in enumerate(items):
                if isinstance(item, dict):
                    try:
                        if progress_f >= float(item.get("startMs", 0)):
                            active = i
                    except (TypeError, ValueError):
                        pass

            def _text(i: int) -> str:
                if 0 <= i < len(items) and isinstance(items[i], dict):
                    return str(items[i].get("text") or "")
                return ""

            current = _text(active)
            if not nxt:
                nxt = _text(active + 1)

    def _num(*keys: str, default: float = 0.0) -> float:
        for key in keys:
            for scope in (state, track):
                if key in scope:
                    try:
                        return float(scope[key])
                    except (TypeError, ValueError):
                        pass
        return default

    progress_ms = current_progress(state, now_ms)
    duration_ms = _num("durationMs")
    is_playing = bool(state.get("isPlaying", track.get("isPlaying", False)))

    album = str(track.get("album") or state.get("album") or "")
    artwork = track.get(
        "artworkUrl", track.get("artwork_url", state.get("artworkUrl", ""))
    )
    artwork_url = artwork if isinstance(artwork, str) else ""

    return {
        "title": title,
        "artist": artist,
        "album": album,
        "artworkUrl": artwork_url,
        "layout": layout_from_state(state),
        "current": str(current or ""),
        "next": str(nxt or ""),
        "progressMs": progress_ms,
        "durationMs": duration_ms,
        "isPlaying": is_playing,
    }


# --- Fonts: DejaVuSans if present, then seguiemj / segoeui / arial. ---

_FONT_CANDIDATES = {
    False: [
        "DejaVuSans.ttf",
        r"C:\Windows\Fonts\DejaVuSans.ttf",
        r"C:\Windows\Fonts\seguiemj.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ],
    True: [
        "DejaVuSans-Bold.ttf",
        r"C:\Windows\Fonts\DejaVuSans-Bold.ttf",
        r"C:\Windows\Fonts\seguiemj.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
    ],
}


def load_font(size: int, bold: bool = False):
    """Load a truetype font following the v0.1 chain, else PIL default."""
    for path in _FONT_CANDIDATES[bold]:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def wrap_text(draw, text: str, font, max_width: int, limit: int = 4):
    """Greedy word-wrap for a single paragraph (CJK: char-split, no spaces)."""
    if not text:
        return [""]
    words = text.split() if " " in text else list(text)
    joiner = " " if " " in text else ""
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else current + joiner + word
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if bbox[2] - bbox[0] <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
        if len(lines) >= limit:
            break
    if current and len(lines) < limit:
        lines.append(current)
    return lines[:limit] or [""]


def _center_crop_square(img):
    """Center-crop a PIL image to a square (largest centered square)."""
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def draw_play_icon(draw, x: int, y: int, size: int, fill=(245, 247, 250)) -> None:
    """Draw a play triangle (PIL polygon, no emoji fonts) in a size box."""
    draw.polygon(
        [(x, y), (x, y + size), (x + int(size * 0.9), y + size // 2)],
        fill=fill,
    )


def draw_pause_icon(draw, x: int, y: int, size: int, fill=(245, 247, 250)) -> None:
    """Draw a pause icon (two PIL bars, no emoji fonts) in a size box."""
    bar_w = max(2, size // 4)
    gap = max(2, size // 4)
    draw.rectangle([x, y, x + bar_w, y + size], fill=fill)
    draw.rectangle([x + bar_w + gap, y, x + 2 * bar_w + gap, y + size], fill=fill)


def draw_note_icon(draw, cx: int, cy: int, size: int, fill=(150, 160, 175)) -> None:
    """Draw a simple music-note glyph (PIL shapes only) centered at cx,cy."""
    head_rx, head_ry = int(size * 0.22), int(size * 0.16)
    head_cx, head_cy = cx - int(size * 0.12), cy + int(size * 0.22)
    draw.ellipse(
        [head_cx - head_rx, head_cy - head_ry, head_cx + head_rx, head_cy + head_ry],
        fill=fill,
    )
    stem_w = max(3, size // 14)
    stem_x = head_cx + head_rx - stem_w // 2
    stem_top = cy - int(size * 0.35)
    stem_bot = head_cy
    draw.rectangle([stem_x, stem_top, stem_x + stem_w, stem_bot], fill=fill)
    draw.polygon(
        [
            (stem_x, stem_top),
            (stem_x + int(size * 0.30), stem_top + int(size * 0.08)),
            (stem_x + int(size * 0.30), stem_top + int(size * 0.20)),
            (stem_x, stem_top + int(size * 0.14)),
        ],
        fill=fill,
    )


def render_lyrics(
    state: Dict[str, Any],
    glass: Tuple[int, int] = DEFAULT_GLASS,
    now_ms: Optional[float] = None,
):
    """Legacy lyrics frame (LV-09 unified: kept, dispatcher no longer uses it).

    ``now_ms`` freezes the clock for tests (None = live clock).
    """
    if Image is None:
        raise RuntimeError("Pillow is required for rendering (pip install Pillow)")
    w, h = glass
    model = extract_display(state, now_ms)

    img = Image.new("RGB", (w, h), (10, 13, 20))
    draw = ImageDraw.Draw(img)

    # Header: title / artist.
    title_font = load_font(32, bold=True)
    artist_font = load_font(22, bold=False)
    margin = 28
    max_w = w - 2 * margin
    for i, line in enumerate(
        wrap_text(draw, model["title"], title_font, max_w, limit=2)
    ):
        draw.text((margin, 26 + i * 40), line, font=title_font, fill=(245, 247, 250))
    artist = model["artist"] or " "
    for i, line in enumerate(wrap_text(draw, artist, artist_font, max_w, limit=1)):
        draw.text(
            (margin, 26 + 2 * 40 + i * 30), line, font=artist_font, fill=(150, 160, 175)
        )
    draw.line([(margin, 150), (w - margin, 150)], fill=(40, 48, 62), width=2)

    # Lyrics: current big centered, next attenuated.
    current_font = load_font(44, bold=True)
    next_font = load_font(28, bold=False)
    current_lines: list[str] = []
    size = 44
    for size in range(44, 23, -4):
        current_font = load_font(size, bold=True)
        current_lines = []
        for para in (model["current"] or "♪").split("\n"):
            current_lines.extend(wrap_text(draw, para, current_font, max_w, limit=4))
        current_lines = current_lines[:4]
        widest = max(
            (
                draw.textbbox((0, 0), ln, font=current_font)[2]
                - draw.textbbox((0, 0), ln, font=current_font)[0]
            )
            for ln in current_lines
        )
        if widest <= max_w:
            break
    cy = int(h * 0.46)
    line_h = size + 12
    top = cy - (len(current_lines) * line_h) // 2
    for i, ln in enumerate(current_lines):
        bbox = draw.textbbox((0, 0), ln, font=current_font)
        tw = bbox[2] - bbox[0]
        draw.text(
            ((w - tw) / 2, top + i * line_h),
            ln,
            font=current_font,
            fill=(255, 255, 255),
        )
    if model["next"]:
        nxt_lines = wrap_text(draw, model["next"], next_font, max_w, limit=2)[:2]
        ny = top + len(current_lines) * line_h + 24
        for i, ln in enumerate(nxt_lines):
            bbox = draw.textbbox((0, 0), ln, font=next_font)
            tw = bbox[2] - bbox[0]
            draw.text(
                ((w - tw) / 2, ny + i * 36), ln, font=next_font, fill=(130, 140, 155)
            )

    # Progress bar (bottom) + LV-09 time text. Unknown duration -> empty track.
    bar_w, bar_h = w - 2 * margin, 8
    bar_y = h - 56
    draw.rounded_rectangle(
        [margin, bar_y, margin + bar_w, bar_y + bar_h], radius=4, fill=(35, 42, 55)
    )
    if model["durationMs"] > 0:
        frac = min(1.0, max(0.0, model["progressMs"] / model["durationMs"]))
        if frac > 0:
            draw.rounded_rectangle(
                [margin, bar_y, margin + int(bar_w * frac), bar_y + bar_h],
                radius=4,
                fill=(88, 166, 255),
            )
    status = "▶" if model["isPlaying"] else "❚❚"
    small = load_font(18, bold=False)
    draw.text((margin, bar_y + 16), status, font=small, fill=(120, 130, 145))
    time_str = (
        f"{format_time(model['progressMs'])} / {format_time(model['durationMs'])}"
    )
    tb = draw.textbbox((0, 0), time_str, font=small)
    draw.text(
        (w - margin - (tb[2] - tb[0]), bar_y + 16),
        time_str,
        font=small,
        fill=(120, 130, 145),
    )

    return img


def render_cover(
    state: Dict[str, Any],
    glass: Tuple[int, int] = DEFAULT_GLASS,
    now_ms: Optional[float] = None,
):
    """Legacy cover frame (LV-09 unified: kept, dispatcher no longer uses it).

    Square artwork on top (center-crop), title/artist/album below, a PIL-drawn
    play/pause icon (triangle/bars, never emoji fonts) plus m:ss / m:ss time
    from the same ``current_progress`` base as the lyrics layout. Without
    artwork: gradient placeholder + drawn note icon (never raises).
    ``now_ms`` freezes the clock for tests (None = live clock).
    """
    if Image is None:
        raise RuntimeError("Pillow is required for rendering (pip install Pillow)")
    w, h = glass
    model = extract_display(state, now_ms)

    img = Image.new("RGB", (w, h), (10, 13, 20))
    draw = ImageDraw.Draw(img)
    margin = 28
    max_w = w - 2 * margin
    art_size = max_w
    art_x, art_y = margin, 28

    art = (
        fetch_artwork(model.get("artworkUrl", "")) if model.get("artworkUrl") else None
    )
    if art is not None:
        try:
            square = _center_crop_square(art).resize(
                (art_size, art_size), Image.LANCZOS
            )
            img.paste(square, (art_x, art_y))
        except Exception:
            art = None
    if art is None:
        # Fallback: vertical gradient placeholder + drawn note icon.
        top_c = (32, 42, 62)
        bot_c = (16, 20, 30)
        for yy in range(art_size):
            t = yy / max(1, art_size - 1)
            col = tuple(int(top_c[i] + (bot_c[i] - top_c[i]) * t) for i in range(3))
            draw.line([(art_x, art_y + yy), (art_x + art_size, art_y + yy)], fill=col)
        draw.rectangle(
            [art_x, art_y, art_x + art_size, art_y + art_size],
            outline=(40, 48, 62),
            width=2,
        )
        draw_note_icon(
            draw, art_x + art_size // 2, art_y + art_size // 2, art_size // 3
        )

    # Title / artist / album below the art.
    title_font = load_font(30, bold=True)
    artist_font = load_font(22, bold=False)
    album_font = load_font(20, bold=False)
    text_top = art_y + art_size + 22
    for i, line in enumerate(
        wrap_text(draw, model["title"], title_font, max_w, limit=2)
    ):
        draw.text(
            (margin, text_top + i * 38), line, font=title_font, fill=(245, 247, 250)
        )
    artist = model["artist"] or " "
    for i, line in enumerate(wrap_text(draw, artist, artist_font, max_w, limit=1)):
        draw.text(
            (margin, text_top + 2 * 38 + i * 30),
            line,
            font=artist_font,
            fill=(150, 160, 175),
        )
    if model.get("album"):
        for i, line in enumerate(
            wrap_text(draw, model["album"], album_font, max_w, limit=1)
        ):
            draw.text(
                (margin, text_top + 2 * 38 + 30 + i * 28),
                line,
                font=album_font,
                fill=(120, 130, 145),
            )

    # Progress bar + drawn icon + m:ss / m:ss time (bottom).
    bar_w, bar_h = w - 2 * margin, 8
    bar_y = h - 56
    draw.rounded_rectangle(
        [margin, bar_y, margin + bar_w, bar_y + bar_h], radius=4, fill=(35, 42, 55)
    )
    if model["durationMs"] > 0:
        frac = min(1.0, max(0.0, model["progressMs"] / model["durationMs"]))
        if frac > 0:
            draw.rounded_rectangle(
                [margin, bar_y, margin + int(bar_w * frac), bar_y + bar_h],
                radius=4,
                fill=(88, 166, 255),
            )
    icon_size = 22
    icon_y = bar_y + 16
    if model["isPlaying"]:
        draw_play_icon(draw, margin, icon_y, icon_size)
    else:
        draw_pause_icon(draw, margin, icon_y, icon_size)
    small = load_font(20, bold=False)
    time_str = (
        f"{format_time(model['progressMs'])} / {format_time(model['durationMs'])}"
    )
    tb = draw.textbbox((0, 0), time_str, font=small)
    draw.text(
        (w - margin - (tb[2] - tb[0]), icon_y - 2),
        time_str,
        font=small,
        fill=(150, 160, 175),
    )

    return img


def _draw_centered_text_lines(
    draw, lines, font, center_x, top, line_step, fill
) -> None:
    """Draw already-wrapped lines around one normalized center anchor."""
    for index, line in enumerate(lines):
        bbox = draw.textbbox((0, 0), line, font=font)
        width = bbox[2] - bbox[0]
        draw.text(
            (round(center_x - width / 2), top + index * line_step),
            line,
            font=font,
            fill=fill,
        )


def _base_font_size(placement: Dict[str, Any], canvas_height: int) -> int:
    return max(1, round(placement["size"] * canvas_height))


def render_unified(
    state: Dict[str, Any],
    glass: Tuple[int, int] = DEFAULT_GLASS,
    now_ms: Optional[float] = None,
    base=None,
    base_placements: Optional[Dict[str, Dict[str, Any]]] = None,
):
    """Render the UNIFIED single view (LV-09 producto: el unico modo).

    Portrait 480x854: arte arriba (center-crop, fallback gradiente + nota),
    titulo/artista/album, linea actual (+ siguiente atenuada), icono
    play/pausa dibujado (nunca emoji), tiempo ``cur / total`` (m:ss) y barra
    proporcional. Sin arte nunca levanta. ``now_ms`` congela el reloj (tests).

    ``base`` (S1-T7a): an OPTIONAL RGB canvas of exactly ``glass`` size to
    draw onto instead of a fresh one -- this is how a scene background sits
    UNDER this view (render_frame passes the flattened background). With
    ``base=None`` (every existing caller) the output is byte-identical to
    the pre-S1-T7a renderer: only the canvas acquisition differs. A base of
    the wrong mode or size is IGNORED and a fresh canvas is built instead
    -- fail-safe on the production path: the view the panel shows must
    never depend on a compatibility check passing.

    ``base_placements`` is the already-validated optional S7-T24a map. Each
    x/y is a center anchor in portrait glass space. Cover/progress size is a
    fraction of portrait width; text size is a fraction of portrait height.
    An absent key (or an absent map) runs the exact legacy geometry branch.
    """
    if Image is None:
        raise RuntimeError("Pillow is required for rendering (pip install Pillow)")
    w, h = glass
    model = extract_display(state, now_ms)
    placements = base_placements or {}
    cover_placement = placements.get("cover")
    title_placement = placements.get("title")
    artist_placement = placements.get("artist")
    lyrics_placement = placements.get("lyrics")
    progress_placement = placements.get("progress")

    if (
        base is not None
        and getattr(base, "mode", None) == "RGB"
        and getattr(base, "size", None) == (w, h)
    ):
        img = base
    else:
        img = Image.new("RGB", (w, h), (10, 13, 20))
    draw = ImageDraw.Draw(img)
    margin = 28
    max_w = w - 2 * margin

    # Art on top: 320px centered (leaves room for lyrics below; full-bleed
    # 424px left no vertical space for current+next). Same LRU/fetch path
    # as the legacy cover layout.
    legacy_art_size = 320
    legacy_art_x = margin + (max_w - legacy_art_size) // 2
    legacy_art_y = 24
    if cover_placement is not None:
        art_size = max(1, round(cover_placement["size"] * w))
        art_x = round(cover_placement["x"] * w - art_size / 2)
        art_y = round(cover_placement["y"] * h - art_size / 2)
    else:
        art_size = legacy_art_size
        art_x = legacy_art_x
        art_y = legacy_art_y
    art = (
        fetch_artwork(model.get("artworkUrl", "")) if model.get("artworkUrl") else None
    )
    if art is not None:
        try:
            square = _center_crop_square(art).resize(
                (art_size, art_size), Image.LANCZOS
            )
            img.paste(square, (art_x, art_y))
        except Exception:
            art = None
    if art is None:
        top_c = (32, 42, 62)
        bot_c = (16, 20, 30)
        for yy in range(art_size):
            t = yy / max(1, art_size - 1)
            col = tuple(int(top_c[i] + (bot_c[i] - top_c[i]) * t) for i in range(3))
            draw.line([(art_x, art_y + yy), (art_x + art_size, art_y + yy)], fill=col)
        draw.rectangle(
            [art_x, art_y, art_x + art_size, art_y + art_size],
            outline=(40, 48, 62),
            width=2,
        )
        draw_note_icon(
            draw, art_x + art_size // 2, art_y + art_size // 2, art_size // 3
        )

    # Title / artist / album below the art. Legacy branches are intentionally
    # untouched so a missing override keeps the pre-S7-T24a pixels byte-exact.
    text_top = legacy_art_y + legacy_art_size + 16
    if title_placement is None:
        title_font = load_font(28, bold=True)
        for i, line in enumerate(
            wrap_text(draw, model["title"], title_font, max_w, limit=2)
        ):
            draw.text(
                (margin, text_top + i * 36),
                line,
                font=title_font,
                fill=(245, 247, 250),
            )
    else:
        title_size = _base_font_size(title_placement, h)
        title_font = load_font(title_size, bold=True)
        title_lines = wrap_text(draw, model["title"], title_font, max_w, limit=2)
        title_step = title_size + 8
        title_top = round(
            title_placement["y"] * h
            - (title_size + (len(title_lines) - 1) * title_step) / 2
        )
        _draw_centered_text_lines(
            draw,
            title_lines,
            title_font,
            title_placement["x"] * w,
            title_top,
            title_step,
            (245, 247, 250),
        )

    artist = model["artist"] or " "
    if artist_placement is None:
        artist_font = load_font(22, bold=False)
        album_font = load_font(20, bold=False)
        for i, line in enumerate(wrap_text(draw, artist, artist_font, max_w, limit=1)):
            draw.text(
                (margin, text_top + 2 * 36 + i * 28),
                line,
                font=artist_font,
                fill=(150, 160, 175),
            )
        if model.get("album"):
            for i, line in enumerate(
                wrap_text(draw, model["album"], album_font, max_w, limit=1)
            ):
                draw.text(
                    (margin, text_top + 2 * 36 + 28 + i * 26),
                    line,
                    font=album_font,
                    fill=(120, 130, 145),
                )
    else:
        artist_size = _base_font_size(artist_placement, h)
        artist_font = load_font(artist_size, bold=False)
        artist_lines = wrap_text(draw, artist, artist_font, max_w, limit=1)
        artist_step = artist_size + 8
        album_lines = (
            wrap_text(
                draw,
                model["album"],
                load_font(max(1, round(artist_size * 20 / 22)), bold=False),
                max_w,
                limit=1,
            )
            if model.get("album")
            else []
        )
        album_step = max(1, round(artist_size * 20 / 22)) + 6
        block_height = artist_size + (album_step if album_lines else 0)
        artist_top = round(artist_placement["y"] * h - block_height / 2)
        _draw_centered_text_lines(
            draw,
            artist_lines,
            artist_font,
            artist_placement["x"] * w,
            artist_top,
            artist_step,
            (150, 160, 175),
        )
        if album_lines:
            _draw_centered_text_lines(
                draw,
                album_lines,
                load_font(max(1, round(artist_size * 20 / 22)), bold=False),
                artist_placement["x"] * w,
                artist_top + artist_step,
                album_step,
                (120, 130, 145),
            )

    # Current line (+ next attenuated), centered in the middle band.
    if lyrics_placement is None:
        current_font = load_font(34, bold=True)
        next_font = load_font(24, bold=False)
        current_lines: list[str] = []
        size = 34
        for size in range(34, 21, -2):
            current_font = load_font(size, bold=True)
            current_lines = []
            for para in (model["current"] or "♪").split("\n"):
                current_lines.extend(
                    wrap_text(draw, para, current_font, max_w, limit=3)
                )
            current_lines = current_lines[:3]
            widest = max(
                (
                    draw.textbbox((0, 0), ln, font=current_font)[2]
                    - draw.textbbox((0, 0), ln, font=current_font)[0]
                )
                for ln in current_lines
            )
            if widest <= max_w:
                break
        lyrics_top = text_top + 2 * 36 + 28 + 30
        line_h = size + 10
        for i, ln in enumerate(current_lines):
            bbox = draw.textbbox((0, 0), ln, font=current_font)
            tw = bbox[2] - bbox[0]
            draw.text(
                ((w - tw) / 2, lyrics_top + i * line_h),
                ln,
                font=current_font,
                fill=(255, 255, 255),
            )
        if model["next"]:
            nxt_lines = wrap_text(draw, model["next"], next_font, max_w, limit=2)[:2]
            ny = lyrics_top + len(current_lines) * line_h + 14
            for i, ln in enumerate(nxt_lines):
                bbox = draw.textbbox((0, 0), ln, font=next_font)
                tw = bbox[2] - bbox[0]
                draw.text(
                    ((w - tw) / 2, ny + i * 32),
                    ln,
                    font=next_font,
                    fill=(130, 140, 155),
                )
    else:
        max_font_size = _base_font_size(lyrics_placement, h)
        min_font_size = max(1, round(max_font_size * 22 / 34))
        current_lines = []
        for size in range(max_font_size, min_font_size - 1, -2):
            current_font = load_font(size, bold=True)
            current_lines = []
            for para in (model["current"] or "♪").split("\n"):
                current_lines.extend(
                    wrap_text(draw, para, current_font, max_w, limit=3)
                )
            current_lines = current_lines[:3]
            widest = max(
                draw.textbbox((0, 0), line, font=current_font)[2]
                - draw.textbbox((0, 0), line, font=current_font)[0]
                for line in current_lines
            )
            if widest <= max_w:
                break
        next_size = max(1, round(size * 24 / 34))
        next_font = load_font(next_size, bold=False)
        next_lines = (
            wrap_text(draw, model["next"], next_font, max_w, limit=2)[:2]
            if model["next"]
            else []
        )
        line_h = size + 10
        next_step = next_size + 8
        next_gap = 14 if next_lines else 0
        block_height = (
            size
            + (len(current_lines) - 1) * line_h
            + next_gap
            + (next_size + (len(next_lines) - 1) * next_step if next_lines else 0)
        )
        lyrics_top = round(lyrics_placement["y"] * h - block_height / 2)
        _draw_centered_text_lines(
            draw,
            current_lines,
            current_font,
            lyrics_placement["x"] * w,
            lyrics_top,
            line_h,
            (255, 255, 255),
        )
        if next_lines:
            _draw_centered_text_lines(
                draw,
                next_lines,
                next_font,
                lyrics_placement["x"] * w,
                lyrics_top + len(current_lines) * line_h + next_gap,
                next_step,
                (130, 140, 155),
            )

    # Progress bar + drawn icon + m:ss / m:ss time (bottom). Unknown
    # duration -> empty track (total 0:00), same rule as legacy layouts.
    bar_h = 8
    if progress_placement is None:
        bar_x = margin
        bar_w = w - 2 * margin
        bar_y = h - 56
    else:
        bar_w = max(1, round(progress_placement["size"] * w))
        bar_x = round(progress_placement["x"] * w - bar_w / 2)
        bar_y = round(progress_placement["y"] * h - bar_h / 2)
    draw.rounded_rectangle(
        [bar_x, bar_y, bar_x + bar_w, bar_y + bar_h],
        radius=4,
        fill=(35, 42, 55),
    )
    if model["durationMs"] > 0:
        frac = min(1.0, max(0.0, model["progressMs"] / model["durationMs"]))
        if frac > 0:
            draw.rounded_rectangle(
                [bar_x, bar_y, bar_x + int(bar_w * frac), bar_y + bar_h],
                radius=4,
                fill=(88, 166, 255),
            )
    icon_size = 22
    icon_y = bar_y + 16
    if model["isPlaying"]:
        draw_play_icon(draw, bar_x, icon_y, icon_size)
    else:
        draw_pause_icon(draw, bar_x, icon_y, icon_size)
    small = load_font(20, bold=False)
    time_str = (
        f"{format_time(model['progressMs'])} / {format_time(model['durationMs'])}"
    )
    tb = draw.textbbox((0, 0), time_str, font=small)
    draw.text(
        (bar_x + bar_w - (tb[2] - tb[0]), icon_y - 2),
        time_str,
        font=small,
        fill=(150, 160, 175),
    )

    return img


def _warn_scene_fallback(exc: BaseException) -> None:
    """Surface a scene fallback on stderr, deduped (S1-T7a).

    ``log`` writes to STDERR -- stdout is the JSONL protocol channel, and a
    stray line there would be parsed as noise (or worse, as an envelope).
    Deduped so a persistently broken scene logs once, not at lcdFps.
    """
    global _SCENE_FALLBACK_LAST
    text = f"{type(exc).__name__}: {exc}"
    if text != _SCENE_FALLBACK_LAST:
        _SCENE_FALLBACK_LAST = text
        log(f"scene disabled, showing lyrics view: {text}")


_SCENE_FALLBACK_LAST: Optional[str] = None


def apply_scene_retention(
    state: Dict[str, Any], last: Optional[Dict[str, Any]]
) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    """Resolve the RETAINED `settings.scene` field of one drained envelope.

    WHY ABSENT MEANS RETAIN HERE -- and nowhere else: the envelope stays a
    full replacement for EVERY other field (lcdFps, lyric, track,
    isPlaying, ...), but `settings.scene` is the one exception. The shell's
    scene fan-out (createSceneFanout in src/main.js) deliberately omits the
    key while its content digest is unchanged: an embedded scene is
    multi-megabyte and would otherwise cross the stdin pipe on every ~2 s
    state push. Treating that omission as "no scene" made every scene edit
    vanish from the panel one push (~2 s) after it landed -- the S2-T8a
    regression. Omission therefore means "keep rendering the last scene
    that validated here"; only an explicit null clears it.

    The four rules (scoped to `settings.scene` alone):
      1. key absent    -> retain `last`, injected back into settings; with
                          no scene ever received, leave the state alone and
                          the render path keeps today's lyrics view.
      2. explicit null -> clear: nothing is retained any more.
      3. invalid (validate_scene raises ProtocolError) -> CLEAR and warn
                          (deduped via _warn_scene_fallback). Fail-safe
                          direction: a scene we cannot validate is a scene
                          we must not draw -- never keep rendering stale
                          content, never latch on the failure.
      4. valid         -> use it and remember it as the new `last`.

    Pure by design: no module-global mutable state is read, and neither
    argument is mutated (a new state dict is built when injecting or
    clearing). main() keeps `last_scene` as a LOCAL beside `state` and calls
    this where the queue is drained; drain and render share the loop thread,
    so there is nothing to lock, and the step runs once per drained
    envelope -- never on the per-frame path.
    """
    if not isinstance(state, dict):
        return state, last
    settings = state.get("settings")
    # A non-dict `settings` has no scene key to interpret AND must not be
    # rewritten: rebuilding it as {"scene": last} would silently REPLACE the
    # malformed value (only when a scene was retained -- asymmetric with
    # `last is None`, which left it alone), changing the input shape the
    # downstream malformed-settings handling receives. Retention applies to
    # dict settings only; malformed input stays exactly as received.
    if not isinstance(settings, dict):
        return state, last
    scope = settings
    if "scene" not in scope:
        if last is None:
            return state, last  # Rule 1, no scene ever received
        return {**state, "settings": {**scope, "scene": last}}, last  # Rule 1
    if scope["scene"] is None:
        return state, None  # Rule 2: explicit null clears
    try:
        validated = validate_scene(scope["scene"])
    except ProtocolError as exc:
        _warn_scene_fallback(exc)
        return {**state, "settings": {**scope, "scene": None}}, None  # Rule 3
    # Rule 4: remember the VALIDATED copy, never the raw input.
    return {**state, "settings": {**scope, "scene": validated}}, validated


def _scene_from_state(state: Dict[str, Any]):
    """Validated scene from state.settings.scene, or None for "no scene".

    RETENTION LIVES UPSTREAM: main() resolves the shell's omitted-key case
    in apply_scene_retention BEFORE the loop renders, so by the time this
    runs an absent key means "nothing retained" (never configured, cleared
    by an explicit null, or refused as invalid) -- not "the fan-out stripped
    it this tick". Feeding a raw envelope here instead would re-open the
    S2-T8a absent-equals-none bug; do not "simplify" retention away.

    None means "render the legacy view": no retained scene OR a value that
    fails validate_scene -- a bad value in settings.json must never crash
    the loop or blank the panel (fail back, then surface via
    _warn_scene_fallback). Validation here is validate_scene itself: the
    sidecar never trusts the shell's gate (defense in depth, same rule the
    preview path applies to wire input).
    """
    settings = state.get("settings") if isinstance(state, dict) else None
    if not isinstance(settings, dict) or "scene" not in settings:
        return None
    scene = settings["scene"]
    if scene is None:
        return None
    try:
        return validate_scene(scene)
    except ProtocolError as exc:
        _warn_scene_fallback(exc)
        return None


def render_portrait(
    state: Dict[str, Any],
    glass: Tuple[int, int] = DEFAULT_GLASS,
    now_ms: Optional[float] = None,
    frame_index: Optional[int] = None,
):
    """Render the portrait frame at glass resolution (default 480x854).

    LV-09 unified: SIEMPRE la vista unica (:func:`render_unified`); el
    ``layout`` guardado viejo se acepta (whitelist) pero se ignora.
    S1-T7a: when ``state["settings"]["scene"]`` holds a USABLE scene the
    frame is composed through :func:`render_frame` (background -> lyrics
    view -> overlays). Absent, invalid or unusable scenes -- bad shape,
    refused/missing/unreadable media, kinds not implemented yet (video,
    gpu-temp) -- fall back to today's canvas, so a broken stored scene can
    never blank the panel, hang, or push a traceback onto stdout.
    S1-T7a-1: ``frame_index=None`` (the default, and everything the live
    loop passes) derives the GIF frame from ``now_ms`` through
    gif_frame_index_at; an explicit int still pins the selector.
    Mantiene la forma de llamada para no tocar el path USB/rotacion/encode.
    """
    _ = layout_from_state(state)  # compat: validate, ignore result
    scene = _scene_from_state(state)
    if scene is None:
        return render_unified(state, glass, now_ms)
    try:
        # S1-T7a-1 (verified defect): relying on render_scene's default
        # would pin every GIF to frame 0 forever on the panel while the
        # preview animated. Since S1-T7b the loop passes now_ms AND the
        # frame_index its dirty key was computed with (same instant, same
        # selector -- key and pixels must describe ONE frame), and it
        # wakes on frame_refresh_ms (a GIF frame's own delay, floored at
        # 1/lcdFps), so animation advances at the policy cadence: never
        # pinned, never faster than lcdFps allows.
        resolved_frame = (
            frame_index
            if frame_index is not None
            else gif_frame_index_at(scene, MEDIA_ROOT, now_ms)
        )
        return render_frame(
            state,
            scene,
            media_root=MEDIA_ROOT,
            glass=glass,
            now_ms=now_ms,
            frame_index=resolved_frame,
        )
    except Exception as exc:
        # Fail-safe (total contract): the composed path is the only NEW
        # thing on the production frame path, so every failure it can raise
        # -- typed media/validation errors, an unimplemented kind, even an
        # unexpected one -- degrades to today's lyrics frame. Letting one
        # escape would kill the sidecar and freeze the panel on the very
        # user input (a stored scene) this wrapper exists to distrust.
        _warn_scene_fallback(exc)
        return render_unified(state, glass, now_ms)


# ---------------------------------------------------------------------------
# Scene renderer (S1-T4): backgrounds + transforms + text overlays.
#
# S1-T7a: the live loop reaches these layers through render_frame()
# (background -> lyrics view -> overlays); render_scene() remains the
# preview's single-call path and paints exactly the same layers.
# ---------------------------------------------------------------------------

# Bounds for untrusted scene input: `size` can ask for a full-canvas font
# and `text` is any string, so without caps a single overlay could ask PIL
# to allocate gigabytes. Checked BEFORE any layer is allocated.
SCENE_MAX_TEXT_CHARS = 4096
SCENE_MAX_LAYER_DIM = 4096
# Scaled/rotated background cap: beyond a few canvas widths the 480x854
# glass cannot show more detail, but an unbounded `scale` would still make
# PIL build the full intermediate image.
SCENE_MAX_IMAGE_DIM = 4096
_TEXT_LAYER_PAD = 4

# GIF pacing (S1-T5): Pillow stores per-frame delay in milliseconds. A
# missing or zero delay must NEVER become a 0 ms interval -- that would
# busy-loop the caller -- and 100 ms is the de-facto Pillow/browser floor
# for "no delay given".
GIF_DEFAULT_DELAY_MS = 100

# GIF resource bounds (S1-T5), checked in this order BEFORE any pixel is
# decoded: source bytes (stat before the read, in _load_media_bytes) ->
# format -> per-side dimensions (header only) -> frame count (header scan;
# every GIF frame costs >= ~25 bytes on disk, so the byte cap bounds that
# scan too). 4096 per side also implies at most 4096*4096 = 16.7M decoded
# pixels, below Pillow's MAX_IMAGE_PIXELS (89,478,485 on the pinned
# 12.3.0), so an accepted file cannot reach the decompression-bomb limit;
# DecompressionBombError is still mapped to media_too_large as defense in
# depth.
SCENE_MAX_GIF_BYTES = 16 * 1024 * 1024
SCENE_MAX_GIF_FRAMES = 512
SCENE_MAX_GIF_DIM = 4096

# Refresh-policy sentinels (S1-T5, scene_refresh_ms below). FAIL-SAFE
# INVARIANT: every value here is a finite positive integer -- never 0,
# never negative, never infinity/NaN. 0 or negative would make a wired-in
# loop busy-spin; infinity or NaN would corrupt the now+wait deadline
# arithmetic into an overflow or a non-deadline. The static case genuinely
# needs no SCENE refresh, so its sentinel is LARGE (1 hour): if the
# "static" verdict were ever wrong, the worst case is a FROZEN panel --
# the last rendered frame stays visible until the next real event. A
# frozen panel is visible and reportable; a spin or an overflow is not.
# COMPOSITE BEHAVIOR (S1-T7a): this sentinel is only the SCENE component.
# frame_refresh_ms composes it with REFRESH_PLAYING_MS by MINIMUM, and
# composite_frame_key composes scene_digest with the display-state digest,
# frame_index and a time bucket whose width IS REFRESH_PLAYING_MS -- so
# live lyrics and the extrapolated progress clock can never be frozen by
# a static scene (proven in tests/test_compose_frame.py, the S1-T5
# verifier's binding acceptance criterion).
REFRESH_STATIC_MS = 60 * 60 * 1000
# gpu-temp overlay: sensor values move about once a second.
REFRESH_SENSOR_MS = 1000
# video: TODO(S3-T12) placeholder -- a ~30fps tick until real decode
# exposes the container's per-frame timing. Finite and small on purpose:
# a wired-in loop would degrade to frequent cheap checks, never to freeze.
REFRESH_VIDEO_MS = 33
# While PLAYING, the extrapolated m:ss clock changes every second and the
# progress bar keeps moving with NO state change, so the scene's own
# verdict (possibly the 1-hour sentinel) must be bounded: 250 ms = 4 checks
# per displayed second, so the composite key's time bucket -- derived from
# THIS constant, so key granularity and refresh policy cannot drift --
# changes within 250 ms of occurring. The bar advances one pixel per
# (duration/424) ms, so every single bar-pixel transition is observed for
# tracks >= 106 s; shorter tracks may merge a couple of pixels into one
# 250 ms step -- a visible jump, never a freeze. A second-wide bucket
# (1000 ms) matched only the m:ss text and under-repainted the sub-second
# bar; while PAUSED current_progress freezes, so this cadence and the
# bucket both go quiet and static scenes still never repaint.
REFRESH_PLAYING_MS = 250


class SceneRenderError(Exception):
    """Typed scene-rendering failure (S1-T4).

    Deliberately disjoint from ProtocolError (validation: "the scene is
    malformed") and from OSError (filesystem: never allowed to leak from
    this renderer). ``reason`` is the greppable discriminator:

      unsupported_background  valid kind, not implemented yet (video; gif: S1-T5)
      unsupported_overlay     valid kind, not implemented yet (gpu-temp)
      media_refused           source resolves outside the media root
      media_missing           contained key is not a regular file
      media_unreadable        bytes would not decode as an image
      media_too_large         source exceeds the GIF resource caps above
      text_too_long           text exceeds the caps above
    """

    def __init__(self, reason: str, message: str, field: Optional[str] = None):
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.field = field


def _hex_rgb(color: str) -> Tuple[int, int, int]:
    # validate_scene already pinned the #rrggbb shape; this only expands it.
    return (int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16))


def _decode_data_url(source: str) -> bytes:
    """Decode a data: URL inline. No filesystem access, by definition."""
    header, separator, payload = source.partition(",")
    if not separator:
        raise SceneRenderError(
            "media_unreadable",
            "data: URL is missing its ',' separator",
            field="background.source",
        )
    try:
        if ";base64" in header.lower():
            # validate=True: strict base64 keeps decode deterministic instead
            # of silently ignoring stray characters.
            return base64.b64decode(payload, validate=True)
        return urllib.parse.unquote_to_bytes(payload)
    except ValueError as exc:
        # binascii.Error is a ValueError: a non-decodable payload is a data
        # problem, never an internal fault.
        raise SceneRenderError(
            "media_unreadable",
            f"data: URL payload does not decode: {exc}",
            field="background.source",
        ) from exc


def _resolve_media_source(source: str, media_root: Any) -> str:
    """Resolve `source` as a key inside `media_root`, or refuse it.

    Security contract: validation (validate_scene) only rejects NUL and
    ".." segments -- it deliberately accepts every string this function
    must refuse. Containment is enforced HERE, at read time, on the
    RESOLVED path: absolute/UNC/drive-relative forms and "file://"-style
    schemes are refused before join(), and realpath() resolves
    symlink/junction escapes so the final prefix check runs on canonical
    paths. Never trust the validated string as a path by itself.
    """
    if "\x00" in source or source.startswith(("\\", "/")) or ":" in source:
        # Covers UNC (\\server\share), POSIX/drive-rooted (/etc/passwd),
        # "C:..." drive forms and "file://"/"http://" schemes in one rule.
        # ':' is illegal in Windows file names anyway, so no legal media
        # key is lost here. NUL is checked HERE too, not only upstream in
        # validate_scene: this resolver is a standalone gate, and a NUL
        # that survives it reaches open() as ValueError, which is not an
        # OSError and would escape the containment handlers below.
        raise SceneRenderError(
            "media_refused",
            f"source is not a media-root key: {source!r}",
            field="background.source",
        )
    try:
        root = os.path.realpath(os.path.abspath(os.fspath(media_root)))
        candidate = os.path.realpath(os.path.join(root, source))
    except (OSError, ValueError) as exc:
        # Fail CLOSED: an unresolvable path is refused, never guessed.
        raise SceneRenderError(
            "media_refused",
            f"source cannot be resolved inside the media root: {source!r}",
            field="background.source",
        ) from exc
    # normcase: Windows paths are case-insensitive, a prefix check is not.
    root_case = os.path.normcase(root)
    candidate_case = os.path.normcase(candidate)
    prefix = root_case if root_case.endswith(os.sep) else root_case + os.sep
    if candidate_case != root_case and not candidate_case.startswith(prefix):
        raise SceneRenderError(
            "media_refused",
            f"source resolves outside the media root: {source!r}",
            field="background.source",
        )
    return candidate


def _load_media_bytes(
    source: str, media_root: Any, *, max_bytes: Optional[int] = None
) -> bytes:
    """Inline data: URL bytes, or a contained read from the media root.

    ``max_bytes`` (GIF payloads, S1-T5): for filesystem keys the cap is
    enforced via stat() BEFORE the read, so a multi-gigabyte file is
    refused without ever being pulled into memory; a data: URL is checked
    on the decoded bytes (its size is already bounded by the scene JSON
    that carries it).
    """
    if source[:5].lower() == "data:":
        data = _decode_data_url(source)
        if max_bytes is not None and len(data) > max_bytes:
            raise SceneRenderError(
                "media_too_large",
                f"media payload is {len(data)} bytes, over the {max_bytes} "
                f"byte cap: {source[:64]!r}",
                field="background.source",
            )
        return data
    path = _resolve_media_source(source, media_root)
    if not os.path.isfile(path):
        raise SceneRenderError(
            "media_missing",
            f"media key not found in the media root: {source!r}",
            field="background.source",
        )
    try:
        if max_bytes is not None and os.path.getsize(path) > max_bytes:
            raise SceneRenderError(
                "media_too_large",
                f"media file exceeds the {max_bytes} byte cap: {source!r}",
                field="background.source",
            )
        with open(path, "rb") as handle:
            return handle.read()
    except OSError as exc:
        # SceneRenderError is not an OSError, so the size refusal above
        # passes through untouched; this arm is real I/O failure only.
        raise SceneRenderError(
            "media_unreadable",
            f"media key could not be read: {source!r}",
            field="background.source",
        ) from exc


def _open_rgba(payload: bytes, source: str):
    """Decode bytes to RGBA, wrapping every decode failure as typed."""
    try:
        with Image.open(io.BytesIO(payload)) as handle:
            handle.load()  # force the decode while the buffer is alive
            return handle.convert("RGBA")
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        # UnidentifiedImageError is an OSError; DecompressionBombError is
        # not -- both are media problems, so neither may leak raw.
        raise SceneRenderError(
            "media_unreadable",
            f"media bytes are not a decodable image: {source!r} ({exc})",
            field="background.source",
        ) from exc


def _render_image_background(canvas, bg: Dict[str, Any], media_root: Any) -> None:
    payload = _load_media_bytes(bg["source"], media_root)
    image = _open_rgba(payload, bg["source"])
    _compose_image_background(canvas, image, bg)


def _compose_image_background(canvas, image, bg: Dict[str, Any]) -> None:
    """Shared transform pipeline for image-like backgrounds (image, GIF).

    Split out at S1-T5 so a GIF frame and an image background are
    GUARANTEED the identical transform set: the code below is verbatim
    from the S1-T4 image path, and GIF frames enter at `image`.
    """
    w, h = canvas.size
    iw, ih = image.size
    # fit/fill is the viewport mode (letterbox vs cover-crop), then the
    # user's scale multiplies that base factor.
    if bg["fit"] == "fit":
        factor = min(w / iw, h / ih)
    else:
        factor = max(w / iw, h / ih)
    factor *= bg["scale"]
    tw = max(1, round(iw * factor))
    th = max(1, round(ih * factor))
    longest = max(tw, th)
    if longest > SCENE_MAX_IMAGE_DIM:
        shrink = SCENE_MAX_IMAGE_DIM / longest
        tw = max(1, round(tw * shrink))
        th = max(1, round(th * shrink))
    if bg["flipH"]:
        image = image.transpose(Image.FLIP_LEFT_RIGHT)
    if (tw, th) != (iw, ih):
        image = image.resize((tw, th), Image.LANCZOS)
    # TRANSFORM ORDER (rendering contract, not trivia): point-space
    # M = T . R . S with flip innermost -- expressed in PIL operations as
    # flip -> scale -> rotate -> translate(paste). Translation is OUTERMOST,
    # so panX/panY land in the un-rotated CANVAS frame: panning
    # horizontally always moves pixels horizontally on screen no matter the
    # rotation angle, and rotation happens about the image's own center.
    # (Panning before rotation would rotate the pan vector with the image.)
    rotation = float(bg["rotation"]) % 360.0
    if rotation:
        # Scene rotation is clockwise-positive (CSS convention); PIL's
        # rotate() is counter-clockwise-positive, hence the negation. The
        # % 360 normalization makes rotation=360 skip resampling entirely,
        # so 360 degrees returns the byte-identical original.
        image = image.rotate(
            -rotation, resample=Image.BICUBIC, expand=True, fillcolor=(0, 0, 0, 0)
        )
    bw, bh = image.size
    dx = (w - bw) / 2 + bg["panX"] * w
    dy = (h - bh) / 2 + bg["panY"] * h
    if not (math.isfinite(dx) and math.isfinite(dy)):
        return  # an infinite pan is beyond any viewport by definition
    pos = (round(dx), round(dy))
    if pos[0] + bw <= 0 or pos[0] >= w or pos[1] + bh <= 0 or pos[1] >= h:
        return  # fully off-canvas: nothing to draw (also bounds the ints)
    # Paste (verbatim RGBA copy, no blend): the canvas is empty where the
    # background lands, and source alpha is preserved so letterbox bars
    # from fit=fit stay untouched -> transparent.
    canvas.paste(image, pos)


def _draw_text_overlay(canvas, overlay: Dict[str, Any], index: int) -> None:
    w, h = canvas.size
    text = overlay["text"]
    if not text:
        return
    if len(text) > SCENE_MAX_TEXT_CHARS:
        raise SceneRenderError(
            "text_too_long",
            f"overlays[{index}].text exceeds {SCENE_MAX_TEXT_CHARS} characters",
            field=f"overlays[{index}].text",
        )
    # `size` is a fraction of canvas HEIGHT used as the font height.
    # Pillow's bundled default font scales to that pixel size with no file
    # on disk -- this renderer never reaches outside the repo for a font
    # (the legacy load_font() chain probes C:\Windows\Fonts and is
    # deliberately NOT used here).
    font_px = max(1, round(overlay["size"] * h))
    font = ImageFont.load_default(size=font_px)
    x0, y0, x1, y1 = font.getbbox(text)
    tw, th = x1 - x0, y1 - y0
    if tw > SCENE_MAX_LAYER_DIM or th > SCENE_MAX_LAYER_DIM:
        raise SceneRenderError(
            "text_too_long",
            f"overlays[{index}].text bounds exceed {SCENE_MAX_LAYER_DIM}px",
            field=f"overlays[{index}].text",
        )
    pad = _TEXT_LAYER_PAD
    layer = Image.new("RGBA", (tw + 2 * pad, th + 2 * pad), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    # Center anchor: shift by the bbox origin so the ink box (not the pen
    # origin) centers on the layer, which is then centered on (x, y).
    draw.text(
        (pad - x0, pad - y0),
        text,
        font=font,
        fill=_hex_rgb(overlay["color"]) + (255,),
    )
    rotation = float(overlay["rotation"]) % 360.0
    if rotation:
        # Same clockwise-positive convention as the background transform.
        layer = layer.rotate(
            -rotation, resample=Image.BICUBIC, expand=True, fillcolor=(0, 0, 0, 0)
        )
    lw, lh = layer.size
    pos = (round(overlay["x"] * w - lw / 2), round(overlay["y"] * h - lh / 2))
    plate = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    plate.paste(layer, pos)  # clipped silently if it hangs off the canvas
    # Alpha-composite, not paste: antialiased glyph edges carry partial
    # alpha that must BLEND with whatever is beneath the overlay.
    canvas.paste(Image.alpha_composite(canvas, plate))


def render_scene(scene, *, media_root, size=(480, 854), frame_index: int = 0):
    """Render a scene to an RGBA image -- pure, side-effect free.

    Contract (S1-T4):
      * Everything is computed in GLASS / PORTRAIT space (480x854 by
        default). The 90-degree-CW buffer rotation stays in
        portrait_to_buffer, untouched: this function never sees USB.
      * Deterministic: same scene in -> byte-identical image out (no
        clock, no randomness, no dict-order dependence).
      * `media_root` is the ONLY filesystem door: background.source is
        either a data: URL (decoded inline) or a key resolved and
        containment-checked inside media_root (_resolve_media_source).
      * `frame_index` selects a GIF frame DETERMINISTICALLY (default 0):
        no clock, no counter -- same scene + same selector -> byte-identical
        image. Past the last frame the selector WRAPS (GIFs loop by
        nature; clamping would freeze the animation) and the modulo runs
        before the frame walk, so a huge index costs one division, never
        a billion seeks. Negative/non-int (including bool) -> ValueError.
        The selected frame's DELAY is not returned here: callers read it
        from scene_refresh_ms, which shares this selector.
      * Background gif renders since S1-T5; video and gpu-temp overlays
        still validate but are not implemented (S3-T12): they raise
        SceneRenderError("unsupported_*") so the caller can tell
        "unsupported" from "invalid" (ProtocolError from validate_scene).
      * S1-T7a: the live loop composes the LAYERS below
        (render_scene_background + draw_scene_overlays) through
        render_frame; this single-call path stays the preview's engine
        and paints byte-identical pixels to the recomposed layers.
    """
    if Image is None:
        raise RuntimeError("Pillow is required for rendering (pip install Pillow)")
    _require_canvas_size(size)
    _validate_frame_index(frame_index)
    # Defense in depth: validation errors are ProtocolError, never
    # SceneRenderError -- the two families stay disjoint for callers.
    validated = validate_scene(scene)
    w, h = size
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    _paint_scene_background(canvas, validated, media_root, frame_index)
    _paint_scene_overlays(canvas, validated)
    return canvas


def _require_canvas_size(size) -> None:
    if not (
        isinstance(size, tuple)
        and len(size) == 2
        and all(isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in size)
    ):
        raise ValueError("size must be a (width, height) tuple of positive ints")


def _paint_scene_background(canvas, validated, media_root, frame_index) -> None:
    """Background dispatch on an ALREADY validated scene (S1-T7a split)."""
    background = validated["background"]
    kind = background["kind"]
    if kind == "none":
        pass  # a transparent canvas IS the background
    elif kind == "color":
        canvas.paste(
            _hex_rgb(background["color"]) + (255,),
            (0, 0, canvas.size[0], canvas.size[1]),
        )
    elif kind == "image":
        _render_image_background(canvas, background, media_root)
    elif kind == "gif":
        _render_gif_background(canvas, background, media_root, frame_index)
    else:
        # video (and any kind the validator might add later): valid but
        # not implemented here. Checked BEFORE the source is touched, so an
        # unsupported kind never leaks a media error.
        raise SceneRenderError(
            "unsupported_background",
            f"background kind {kind!r} is not supported by render_scene yet "
            "(video: S3-T12)",
            field="background.kind",
        )


def _paint_scene_overlays(canvas, validated) -> None:
    """Overlay dispatch on an ALREADY validated scene (S1-T7a split)."""
    for index, overlay in enumerate(validated["overlays"]):
        overlay_kind = overlay["kind"]
        if overlay_kind == "text":
            _draw_text_overlay(canvas, overlay, index)
        else:
            # gpu-temp needs runtime temperature data this pure renderer is
            # not given; valid shape, unimplementable here.
            raise SceneRenderError(
                "unsupported_overlay",
                f"overlay kind {overlay_kind!r} is not supported by render_scene yet",
                field=f"overlays[{index}].kind",
            )


def render_scene_background(
    scene, *, media_root, size=(480, 854), frame_index: int = 0
):
    """Background-only RGBA layer -- render_scene minus its overlay pass (S1-T7a).

    Same validation, same frame selector, same paint code as render_scene,
    so ``draw_scene_overlays(render_scene_background(s), s)`` is
    byte-identical to ``render_scene(s)`` (pinned in
    tests/test_compose_frame.py). This is the layer that sits UNDER the
    lyrics view in render_frame; the preview keeps using render_scene.
    """
    if Image is None:
        raise RuntimeError("Pillow is required for rendering (pip install Pillow)")
    _require_canvas_size(size)
    _validate_frame_index(frame_index)
    validated = validate_scene(scene)
    w, h = size
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    _paint_scene_background(canvas, validated, media_root, frame_index)
    return canvas


def draw_scene_overlays(canvas, scene) -> None:
    """Paint a scene's overlays onto an EXISTING image (top layer, S1-T7a).

    `canvas` must be RGBA: overlay ink alpha-blends with whatever is
    beneath it (Image.alpha_composite requirement), and its SIZE defines
    the 0-1 fraction space the overlay coordinates resolve against.
    Validation runs here too -- this is a public door, and an untrusted
    scene must never reach the painter. Mutates `canvas`, returns None.
    """
    validated = validate_scene(scene)
    _paint_scene_overlays(canvas, validated)


def _validate_frame_index(frame_index: Any) -> int:
    """Reject non-selector values before any GIF work starts.

    bool is an int subclass (True == 1), but a flag is never a selector:
    accepting it would silently render frame 1 for what reads as a toggle.
    """
    if isinstance(frame_index, bool) or not isinstance(frame_index, int):
        raise ValueError("frame_index must be an integer >= 0")
    if frame_index < 0:
        raise ValueError("frame_index must be an integer >= 0")
    return frame_index


def _open_gif(payload: bytes, source: str):
    """Open GIF bytes and enforce header-level bounds BEFORE any decode.

    Order matters (each check costs less than the work it prevents):
    format -> per-side dimensions (header only) -> frame count (header
    scan; the source byte cap was already enforced in _load_media_bytes,
    before this function was reached). Every failure closes the handle and
    raises a typed SceneRenderError -- OSError must never leak.
    """
    try:
        handle = Image.open(io.BytesIO(payload))
    except Image.DecompressionBombError as exc:
        # Crafted header whose pixel count exceeds Pillow's limit (the
        # exception text carries the actual limit, 178956970 on the pinned
        # 12.3.0): a SIZE problem by definition, so media_too_large.
        raise SceneRenderError(
            "media_too_large",
            f"GIF exceeds Pillow's decompression-bomb limit: {exc}",
            field="background.source",
        ) from exc
    except (OSError, ValueError, SyntaxError) as exc:
        # UnidentifiedImageError is an OSError: not-a-GIF bytes are a data
        # problem, never an internal fault.
        raise SceneRenderError(
            "media_unreadable",
            f"media bytes are not a decodable GIF: {source!r} ({exc})",
            field="background.source",
        ) from exc
    if handle.format != "GIF":
        # e.g. PNG bytes stored under a .gif key: decodable as an image,
        # but not a GIF -- and this path is GIF-specific (n_frames/seek/
        # duration), so accepting it would silently misrender.
        handle.close()
        raise SceneRenderError(
            "media_unreadable",
            f"media bytes are not GIF data: {source!r}",
            field="background.source",
        )
    width, height = handle.size
    if max(width, height) > SCENE_MAX_GIF_DIM:
        # Header-only check: fires before a single frame is decoded. It
        # also keeps accepted files at <= 4096*4096 = 16.7M pixels, below
        # Pillow's MAX_IMAGE_PIXELS (89,478,485), so an accepted GIF
        # cannot reach the decompression-bomb limit during load.
        handle.close()
        raise SceneRenderError(
            "media_too_large",
            f"GIF dimensions {width}x{height} exceed the "
            f"{SCENE_MAX_GIF_DIM}px per-side cap: {source!r}",
            field="background.source",
        )
    try:
        count = handle.n_frames  # header scan; bounded by the byte cap
    except (OSError, ValueError) as exc:
        handle.close()
        raise SceneRenderError(
            "media_unreadable",
            f"GIF frame table could not be read: {source!r} ({exc})",
            field="background.source",
        ) from exc
    if count > SCENE_MAX_GIF_FRAMES:
        handle.close()
        raise SceneRenderError(
            "media_too_large",
            f"GIF has {count} frames, over the {SCENE_MAX_GIF_FRAMES} cap: {source!r}",
            field="background.source",
        )
    return handle, count


def _gif_select(handle, count: int, frame_index: int, source: str) -> int:
    """Seek to the WRAPPED selector and return the frame it lands on.

    WRAP, not clamp: GIFs loop by nature -- clamping past the last frame
    would freeze the animation. The modulo runs BEFORE the walk, so a huge
    index costs one division instead of a billion seeks.
    """
    try:
        index = frame_index % count
        if index:
            # Pillow composes frames 0..index during a forward seek (GIF
            # disposal is applied inside the decoder), so the handle then
            # exposes the FULL canvas at `index`, not the stored partial
            # tile -- verified against the pinned 12.3.0 with
            # delta-encoded fixtures in tests/test_scene_gif.py.
            handle.seek(index)
    except Image.DecompressionBombError as exc:
        # Defense in depth: the dim cap above already implies a pixel count
        # under the limit; if the caps ever drift, this stays typed.
        raise SceneRenderError(
            "media_too_large",
            f"GIF frame decode exceeds Pillow's pixel limit: {exc}",
            field="background.source",
        ) from exc
    except (OSError, ValueError) as exc:
        raise SceneRenderError(
            "media_unreadable",
            f"GIF frame {frame_index} could not be decoded: {source!r} ({exc})",
            field="background.source",
        ) from exc
    return index


def _gif_delay(handle) -> int:
    """The selected frame's delay in ms, floored to GIF_DEFAULT_DELAY_MS.

    A missing or 0 delay must never become a 0 ms interval: that would
    busy-loop the future S1-T7 caller. Pillow and browsers treat "no delay
    given" as ~100 ms, so that is the documented floor.
    """
    delay = handle.info.get("duration")
    if isinstance(delay, int) and delay > 0:
        return delay
    return GIF_DEFAULT_DELAY_MS


def _gif_delays(handle, count: int, source: str) -> list[int]:
    """Every frame's delay in ms for one full loop -- the selector's clock.

    Built by walking the frames through the SAME _gif_select seek and the
    SAME _gif_delay floor that render_scene and scene_refresh_ms already
    use, so the time->index selector can never disagree with the renderer
    or the refresh policy about how long a frame lasts: no duplicated
    constant, no second derivation of the delay rule. Ascending indexes on
    a fresh handle are forward seeks only.

    COST (measured, not assumed -- an earlier comment here wrongly called
    this header-only): the delay READ is header-only (handle.info), but
    _gif_select decodes and composites each frame it lands on, so the
    walk's time tracks DECODED PIXELS, not file bytes -- 16x the frame
    pixels measured 9.4x the walk time while an 18x byte difference at
    constant pixels changed nothing. A panel-resolution, many-frame GIF
    can therefore push one walk past the 100 ms lcdFps budget near
    SCENE_MAX_GIF_FRAMES. This is bounded and degrades smoothly (the
    sleep follows the render, so over-budget ticks simply lower the
    effective fps with no backlog), and it runs ONCE per tick, not once
    per boundary. Memoizing this table per file is a known, still-open
    optimization -- not yet done, because nothing has measured it as a
    real user-visible problem on hardware.
    """
    delays = []
    for index in range(count):
        _gif_select(handle, count, index, source)
        delays.append(_gif_delay(handle))
    return delays


def _gif_open_frame(source: str, media_root: Any, frame_index: int, *, rgba: bool):
    """Select ONE frame of one GIF: shared by render and refresh policy.

    A single selector implementation serves both callers so
    `render_scene(frame_index=i)` and `scene_refresh_ms(frame_index=i)` can
    never disagree about which frame -- or which delay -- a selector value
    denotes. With rgba=False the frame's pixels are skipped (policy path
    needs only the delay; the seek cost is shared and unavoidable).
    """
    payload = _load_media_bytes(source, media_root, max_bytes=SCENE_MAX_GIF_BYTES)
    handle, count = _open_gif(payload, source)
    try:
        _gif_select(handle, count, frame_index, source)
        delay = _gif_delay(handle)
        image = None
        if rgba:
            try:
                image = handle.convert("RGBA")
            except Image.DecompressionBombError as exc:
                raise SceneRenderError(
                    "media_too_large",
                    f"GIF frame exceeds Pillow's pixel limit: {exc}",
                    field="background.source",
                ) from exc
            except (OSError, ValueError, SyntaxError) as exc:
                raise SceneRenderError(
                    "media_unreadable",
                    f"GIF frame could not be decoded: {source!r} ({exc})",
                    field="background.source",
                ) from exc
    finally:
        handle.close()
    return image, delay


def _render_gif_background(
    canvas, bg: Dict[str, Any], media_root: Any, frame_index: int
) -> None:
    """Draw frame `frame_index` of the GIF at bg["source"] (S1-T5).

    Containment is unchanged (the same _load_media_bytes ->
    _resolve_media_source door image backgrounds use), and the frame flows
    through the SHARED _compose_image_background pipeline, so
    flip/scale/rotate/pan behave identically for image and GIF.
    """
    image, _delay = _gif_open_frame(bg["source"], media_root, frame_index, rgba=True)
    _compose_image_background(canvas, image, bg)


# ---------------------------------------------------------------------------
# scene_digest / scene_refresh_ms (S1-T5): SCENE-ONLY dirty-flag COMPONENTS.
# Pure. INDEPENDENT-VERIFICATION FINDING (S1-T5, RESOLVED by S1-T7a): on
# their own both functions are a correct component of a dirty key, never
# the whole key -- render_unified draws the lyric line, a progress clock
# that ticks every second, title/artist/artwork and the play icon from
# state, and an animating GIF's scene digest is constant across frames.
# Wiring either ALONE freezes live lyrics behind a static background.
# composite_frame_key / frame_refresh_ms below compose these with the
# display-state digest, frame_index and the displayed-second time bucket;
# the binding test (static scene while lyric.current_line and progressMs
# change, frame still dirties) lives in tests/test_compose_frame.py.
# ---------------------------------------------------------------------------


def scene_digest(scene) -> str:
    """Stable content hash of a VALIDATED scene -- the dirty-flag key.

    * validate FIRST: hashing untrusted garbage would let an invalid scene
      compare "unchanged" against another invalid scene; validation errors
      stay ProtocolError (invalid input) while the return value stays a
      digest string (valid input) -- two disjoint families, never a hash
      of lies.
    * sort_keys: JSON key insertion order must never dirty the panel.
      validate_scene already rebuilds allowlisted keys in a fixed order;
      sort_keys makes that guarantee explicit instead of incidental.
    * List order (overlay sequence) is SIGNIFICANT: swapping two overlays
      changes what must be drawn, so it must change the digest.
    """
    validated = validate_scene(scene)
    canonical = json.dumps(validated, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def scene_refresh_ms(scene, *, media_root, frame_index: int = 0) -> int:
    """Milliseconds until this scene must be re-rendered -- refresh policy.

    Most urgent driver wins (the MINIMUM):
      * gif background: the SELECTED frame's own delay, wrapped and floored
        exactly like render_scene's selector (shared implementation).
      * video background: REFRESH_VIDEO_MS -- a documented TODO placeholder
        until S3-T12 exposes real per-frame timing.
      * gpu-temp overlay: REFRESH_SENSOR_MS (sensor values move ~1 Hz).
      * anything else (none/color/image + text overlays): REFRESH_STATIC_MS,
        and the static verdict deliberately touches NO filesystem: an image
        source need not exist to know it will not change on its own.
    Invalid scene -> ProtocolError, same family as render_scene.
    """
    _validate_frame_index(frame_index)
    validated = validate_scene(scene)
    background = validated["background"]
    kind = background["kind"]
    if kind == "gif":
        _image, wait = _gif_open_frame(
            background["source"], media_root, frame_index, rgba=False
        )
    elif kind == "video":
        wait = REFRESH_VIDEO_MS
    else:  # none/color/image: no autonomous change source
        wait = REFRESH_STATIC_MS
    if any(overlay["kind"] == "gpu-temp" for overlay in validated["overlays"]):
        wait = min(wait, REFRESH_SENSOR_MS)
    return wait


def _live_clock_ms() -> float:
    """The live wall clock in epoch ms -- what now_ms=None means.

    Same convention current_progress documents ("now_ms defaults to the
    live clock; tests freeze it"). Factored into a named helper so tests
    can freeze it through monkeypatch instead of patching the time module.
    """
    return time.time() * 1000.0


def gif_frame_index_at(scene, media_root, now_ms=None) -> int:
    """Which GIF frame should be showing at ``now_ms`` -- pure time->index.

    The GIF loop is PERIODIC: the per-frame delays sum to ``loop_ms``, so
    the frame on screen depends only on ``phase = now_ms % loop_ms``.
    That is the whole design -- no "scene started at" bookkeeping, no
    module-global mutable start time (a render path must not hold clock
    state that races with preview requests), no accumulated drift:
    identical ``now_ms`` always yields the identical index, which is what
    render_scene's determinism contract demands of a selector.

    Contract:
      * non-GIF scene (none/color/image/video): 0, WITHOUT opening any
        file -- the common path pays a dict check and nothing else.
      * delays come from _gif_delays (_gif_select + _gif_delay): the SAME
        seek and the SAME floor render_scene and scene_refresh_ms use, so
        all three can never disagree about a frame's length.
        Missing/zero durations floor to GIF_DEFAULT_DELAY_MS, so a real
        loop_ms is always > 0; an empty or non-positive list (defensive
        only) returns 0 -- never a ZeroDivisionError.
      * BOUNDARY RULE: half-open intervals [start, end) -- a phase landing
        EXACTLY on a boundary selects the NEW frame, because at that
        instant the previous frame's delay has fully elapsed. Every
        instant then maps to exactly one frame (no double ownership), and
        the walk is "advance when the delay expires".
      * ``now_ms=None`` -> the live clock (_live_clock_ms). Float, huge
        and NEGATIVE stamps are accepted: Python's % wraps the phase into
        [0, loop_ms) -- the same periodic rule, no special-cased branch --
        and the modulo is O(1) whatever the magnitude. Garbage that cannot
        name a phase (bool/str/inf/NaN) -> frame 0: fail-safe, never an
        exception on the render path.
      * Invalid scene -> ProtocolError, same family as scene_refresh_ms.
    """
    validated = validate_scene(scene)
    if validated["background"]["kind"] != "gif":
        return 0
    if now_ms is None:
        now = _live_clock_ms()
    else:
        coerced = _finite_float(now_ms)
        now = 0.0 if coerced is None else coerced
    source = validated["background"]["source"]
    payload = _load_media_bytes(source, media_root, max_bytes=SCENE_MAX_GIF_BYTES)
    handle, count = _open_gif(payload, source)
    try:
        delays = _gif_delays(handle, count, source)
    finally:
        handle.close()
    loop_ms = sum(delays)
    if loop_ms <= 0:
        return 0
    phase = now % loop_ms
    elapsed = 0
    for index, delay in enumerate(delays):
        elapsed += delay
        if phase < elapsed:
            return index
    # Unreachable for a positive loop (phase < loop_ms always holds):
    # defensive, and frame 0 is the same fail-safe a garbage stamp gets.
    return 0


# ---------------------------------------------------------------------------
# Composition (S1-T7a): background -> lyrics view -> overlays, plus the
# composite dirty key and refresh policy that keep the live loop honest.
# ---------------------------------------------------------------------------


def render_frame(
    state,
    scene,
    *,
    media_root,
    glass=DEFAULT_GLASS,
    now_ms=None,
    frame_index=0,
):
    """Compose ONE production frame: background -> lyrics view -> overlays.

    LAYER ORDER CONTRACT (why, not what): the scene background is the
    BOTTOM canvas -- it is what the user picked to sit behind everything;
    the lyrics view (render_unified) draws OVER it because it owns the
    glass layout (art, metadata, lyric lines, progress bar) and a scene
    must never hide live lyrics; scene text overlays draw LAST because the
    user placed them on top of the view -- matching the preview, where
    render_scene paints background then overlays over the same two layers.
    The lyrics view paints an OPAQUE canvas of its own when given no base,
    which is exactly why it must RECEIVE the flattened background as
    `base` instead of being drawn before it.

    scene=None is the "no scene" path and yields render_unified's exact
    bytes. Typed failures (invalid scene -> ProtocolError, refused or
    unreadable media -> SceneRenderError, unimplemented kinds) propagate
    by design: render_portrait is the fail-safe wrapper that degrades them
    to the legacy frame; direct callers handle them. `media_root` is the
    ONLY filesystem door -- identical containment to the preview path.
    """
    if scene is None:
        return render_unified(state, glass, now_ms)
    background = render_scene_background(
        scene, media_root=media_root, size=glass, frame_index=frame_index
    )
    # Flatten the RGBA background over today's canvas color (10, 13, 20).
    # alpha_composite at alpha 0 is identity, so a `none` background lands
    # on EXACTLY the legacy canvas -- the blank-scene frame is therefore
    # byte-identical to the pre-scene renderer, pixel for pixel.
    w, h = glass
    base = Image.alpha_composite(
        Image.new("RGBA", (w, h), (10, 13, 20) + (255,)), background
    ).convert("RGB")
    view = render_unified(
        state,
        glass,
        now_ms,
        base=base,
        base_placements=scene.get("basePlacements"),
    )
    # Presence probe only (cheap short-circuit for the common empty case);
    # draw_scene_overlays re-validates authoritatively below. By here the
    # scene is known-dict-valid (render_scene_background validated it).
    if not scene.get("overlays"):
        return view
    # RGB -> RGBA -> RGB: overlay ink must alpha-blend with BOTH layers
    # beneath it, and the JPEG path wants RGB back. With no overlays this
    # round-trip is skipped entirely, preserving the exact legacy bytes.
    layered = view.convert("RGBA")
    draw_scene_overlays(layered, scene)
    return layered.convert("RGB")


# Token for "no scene configured" in the composite key: one stable value,
# so the absent-scene case still composes a full key (never a short-circuit
# that would skip the state/bucket components).
NO_SCENE_DIGEST = "no-scene"


def display_state_digest(state, *, now_ms=None) -> str:
    """Stable hash of the DISPLAY-RELEVANT state subset (S1-T7a).

    * extract FIRST through extract_display -- the one function whose
      output render_unified paints from -- so everything the lyrics view
      reads is in the key BY CONSTRUCTION: title/artist/album/artworkUrl,
      the current/next pair INCLUDING the track.lyrics.syncedLyrics
      fallback derived from raw progressMs, durationMs, isPlaying.
      `layout` is deliberately absent: it is accepted and ignored at
      render time, so it must not dirty the panel.
    * The raw clock inputs are added on top (progressMs at state and track
      scope, offsetMs, measuredAt/updatedAt): the digest must be sensitive
      to every state change that CAN move pixels, even when the rendered
      value is momentarily unchanged.
    * settings.lcdFps is included: it changes the stream cadence.
    * NOT the wall clock: the extrapolated m:ss is intentionally excluded
      (the time bucket in composite_frame_key owns time). `now_ms` is
      forwarded to extract_display so extraction matches the render call;
      none of the hashed fields depends on it.
    * sort_keys: JSON key insertion order must never dirty the panel.
      `default=str` normalizes any out-of-band value instead of raising --
      over-sensitivity (a spurious refresh) is safe, a crash is not.
    """
    model = extract_display(state, now_ms)
    track = state.get("track") if isinstance(state.get("track"), dict) else {}
    settings = state.get("settings") if isinstance(state.get("settings"), dict) else {}
    subset = {
        # What the lyrics view paints (extract_display's output):
        "title": model["title"],
        "artist": model["artist"],
        "album": model["album"],
        "artworkUrl": model["artworkUrl"],
        "current": model["current"],
        "next": model["next"],
        "isPlaying": model["isPlaying"],
        "durationMs": model["durationMs"],
        # Raw inputs behind the extrapolated clock and the derived pair:
        "progressMs": state.get("progressMs"),
        "trackProgressMs": track.get("progressMs"),
        "offsetMs": state.get("offsetMs"),
        "measuredAt": state.get("measuredAt"),
        "updatedAt": state.get("updatedAt"),
        # Stream cadence:
        "lcdFps": settings.get("lcdFps"),
    }
    canonical = json.dumps(subset, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def composite_frame_key(state, scene, *, now_ms=None, frame_index=0) -> str:
    """scene digest || state digest || frame_index || time bucket (S1-T7a).

    The BINDING composition (S1-T5 verifier MAJOR): scene_digest alone is
    SCENE-ONLY -- live lyrics, artwork, the play icon and the extrapolated
    m:ss clock all keep moving with a static scene, and a GIF's scene
    digest is constant across frames. Components:
      * scene: scene_digest(scene); scene=None (none configured) uses
        NO_SCENE_DIGEST so the "no scene" case still composes fully.
      * state: display_state_digest -- every display-relevant value.
      * frame_index: separates GIF frames the scene digest cannot see.
      * TIME BUCKET = floor(extrapolated_progress_ms / REFRESH_PLAYING_MS)
        -- the bucket exists so the extrapolated clock and bar can dirty
        the key with NO state change, so its width IS the paint cadence
        while playing: it must equal the playing refresh verdict that
        frame_refresh_ms already prescribes, or the dirty flag repaints
        lazier than the policy says (a hard-coded 1000 ms collapsed
        paint-while-playing to ~1 Hz and turned the bar's sub-second pixel
        steps into visible jumps). Deriving it from REFRESH_PLAYING_MS
        single-sources both so the key and the refresh policy can never
        drift apart. 1000 ms matched only the m:ss text (second
        resolution); the bar moves faster than a second, so second
        granularity under-repainted. At 250 ms every bar-pixel change is
        caught within one bucket while playing -- and a paused/static
        scene still never repaints, because current_progress FROZES when
        paused, the bucket stops ticking and the key stays clean (the
        bucket rides the RENDERED value, not wall time: an epoch-aligned
        bucket would misalign with a clock whose extrapolation starts at
        measuredAt (+ offsetMs)).
    The scene is validated first (ProtocolError), same family as
    scene_digest: an invalid scene never compares "unchanged" against
    another invalid scene.
    """
    scene_part = NO_SCENE_DIGEST if scene is None else scene_digest(scene)
    state_part = display_state_digest(state, now_ms=now_ms)
    bucket = int(current_progress(state, now_ms) // REFRESH_PLAYING_MS)
    return f"{scene_part}|{state_part}|{frame_index}|{bucket}"


def frame_refresh_ms(state, scene, *, media_root, now_ms=None, frame_index=0) -> int:
    """Milliseconds until the COMPOSED frame must be re-rendered (S1-T7a).

    The scene verdict and the playback verdict combine by MINIMUM -- the
    most urgent driver wins, and the policy never UNDER-refreshes:
      * scene component: scene_refresh_ms (gif -> that frame's own delay,
        video -> REFRESH_VIDEO_MS, gpu-temp -> REFRESH_SENSOR_MS, static
        -> REFRESH_STATIC_MS); scene=None counts as static.
      * playback component: while playing the extrapolated m:ss clock and
        the bar keep moving with NO state change, so the scene's possibly
        1-hour verdict is bounded to REFRESH_PLAYING_MS (see why on that
        constant). Paused playback adds no pressure -- the extrapolation
        is frozen -- and the static sentinel stands.
    RETURN CONTRACT (FAIL-SAFE): always a finite positive int -- never 0,
    negative, float, inf or NaN (see the REFRESH_* invariant comment).
    Invalid scene -> ProtocolError, same family as scene_refresh_ms; a
    gif's delay is read through the same containment door the renderer
    uses, so media errors surface as SceneRenderError, never as a silent
    guess.
    """
    wait = (
        REFRESH_STATIC_MS
        if scene is None
        else scene_refresh_ms(scene, media_root=media_root, frame_index=frame_index)
    )
    track = state.get("track") if isinstance(state.get("track"), dict) else {}
    is_playing = bool(state.get("isPlaying", track.get("isPlaying", False)))
    if is_playing:
        wait = min(wait, REFRESH_PLAYING_MS)
    return int(wait)


# ---------------------------------------------------------------------------
# Loop pacing (S1-T7b): bounded wait + wake-on-state + dirty flag + ack
# routing. main() needs a USB device, so every per-iteration DECISION lives
# here as a pure unit; tests/test_render_pacer.py pins all of it
# hardware-free. The loop itself only wires the results to render/emit.
# ---------------------------------------------------------------------------


def bounded_wait_seconds(fps, refresh_ms=None) -> float:
    """Seconds the render loop may block before its next wake (S1-T7b).

    Replaces the old fixed-rate 1/fps sleep. Two binding bounds, in both
    directions:

    * FLOOR ``1/fps`` -- lcdFps/DEFAULT_FPS stays the render-rate CEILING:
      the refresh policy may make the cadence LAZIER than today, never
      faster (video's 33 ms verdict at the default 10 fps still waits
      100 ms). lcdFps must never be raised through the back door.
    * CEILING ``STATUS_INTERVAL_S`` -- frame_refresh_ms reports up to the
      1-hour static sentinel; blocking that long would cross the shell's
      bridge watchdog (src/main.js + src/hardening.js: >5 s with NO status
      AND NO ack restarts the sidecar -> frozen panel + restart storm).
      Capping the wait keeps the ~1 Hz status heartbeat alive, so the
      dirty flag may stop RENDERS but never HEARTBEATS.

    ``refresh_ms=None`` (policy raised, or returned non-positive/NaN) falls
    back to exactly today's blind cadence ``1/fps``: bounded, unsurprising,
    alive. +inf is harmless: the ceiling wins through min().
    """
    try:
        rate = 1.0 / int(fps)
    except (TypeError, ValueError, ZeroDivisionError):
        rate = 1.0 / DEFAULT_FPS
    if not rate > 0:  # also rejects NaN defensively
        rate = 1.0 / DEFAULT_FPS
    if refresh_ms is None:
        return rate
    try:
        refresh = float(refresh_ms)
    except (TypeError, ValueError):
        return rate
    if math.isnan(refresh) or refresh <= 0:
        return rate
    return max(rate, min(refresh / 1000.0, STATUS_INTERVAL_S))


def wait_for_state(pending, timeout_s):
    """The loop's wake-up wait (S1-T7b): block at most ``timeout_s``, return
    the envelope that ended the wait, or None on timeout.

    This is the wake-on-state half: a FRESH ENVELOPE ends the wait
    immediately instead of the old fixed-rate sleep running its full course
    past a state push. The consumed envelope goes back to the CALLER, who
    feeds it to :func:`drain_envelopes` as ``carried`` -- re-queueing it
    with ``put()`` would order an OLDER seq BEHIND a newer one and break
    drain-to-latest (scene retention's newest-wins rule depends on it).
    """
    try:
        return pending.get(timeout=timeout_s)
    except queue.Empty:
        return None


def drain_envelopes(pending, carried=None):
    """Every envelope owed to this iteration, oldest first / newest last.

    ``carried`` (the envelope :func:`wait_for_state` consumed) goes FIRST
    and is never re-queued -- see wait_for_state for why. Ordering is
    load-bearing: main() runs apply_scene_retention once per envelope in
    this order and keeps the last state + seq (drain-to-latest, newest
    wins).
    """
    items = []
    if carried is not None:
        items.append(carried)
    while True:
        try:
            items.append(pending.get_nowait())
        except queue.Empty:
            return items


class FramePlan:
    """One render loop iteration's decisions (S1-T7b).

    * ``wait_s`` -- how long the loop may block next (bounded both ways).
    * ``render`` -- the DIRTY FLAG: False skips render/encode/send entirely
      because the composed pixels would be byte-identical (that is where
      the CPU/USB win lives).
    * ``ack_seq`` -- seq to ack this iteration (None = emit no ack).
    * ``frame_index`` -- the GIF selector value the key was computed with;
      the loop passes it to render_portrait so key and pixels describe the
      SAME frame at the SAME instant.
    * ``key`` -- the composite frame key just computed (None on fail-safe).
    """

    __slots__ = ("wait_s", "render", "ack_seq", "frame_index", "key")

    def __init__(self, wait_s, render, ack_seq, frame_index, key):
        self.wait_s = wait_s
        self.render = render
        self.ack_seq = ack_seq
        self.frame_index = frame_index
        self.key = key


class FramePacer:
    """Pure decision core of the S1-T7b render loop: no I/O, no USB, no
    clock reads of its own (now_ms is always passed in), so pytest covers
    everything main() would otherwise decide behind a device.

    Owns the cross-iteration state: the last painted key (dirty flag) and
    the drained seq that still owes an ack. Single-threaded by
    construction -- only main()'s loop thread touches it; the stdin reader
    thread only enqueues.
    """

    def __init__(self, *, force=False):
        # force = paint every iteration regardless of the dirty key.
        # TEST-ONLY: `--once` is documented "tests only" in
        # src/bridge-spawn.js:46 and tests/test_shell_spawn.js drives it
        # with a demo state that is isPlaying:true but has NO measuredAt,
        # so extrapolation is static and the composite key never changes --
        # without force, frames would stall at 1 and `--once 3` would hang
        # forever. Production (no --once) always gets the dirty flag.
        self.force = force
        self.last_key: Optional[str] = None
        self._seq: Optional[int] = None
        self._ack_owed = False

    def note_drain(self, seq) -> None:
        """Loop calls this once per DRAINED envelope: a drained seq must be
        acked EVEN IF its frame is skipped as unchanged -- src/main.js's
        pendingAcks entry never clears without its ack, so an unacked seq
        would leak in the shell's map forever.
        """
        if seq is not None:
            self._seq = seq
            self._ack_owed = True

    def plan(self, state, scene, *, now_ms, fps, media_root=MEDIA_ROOT) -> FramePlan:
        """Decide one iteration: wait, dirty flag, ack routing.

        ACK CONTRACT (keeps tests/test_shell_spawn.js's exact-3-acks
        baseline green): EVERY painted frame re-acks the current seq -- the
        legacy behavior, one drained seq and three frames -> 6,6,6 -- PLUS
        exactly one ack for a drained seq whose frame was skipped as
        unchanged. plan() COMMITS the decision (clears the owed flag); the
        loop always emits ``ack_seq`` immediately after plan() returns, so
        clearing here is safe.
        """
        frame_index = 0
        key = None
        refresh_ms = None
        try:
            # frame_index must be the SAME selector render_portrait will use
            # at the SAME now_ms: key and pixels must describe one frame.
            frame_index = (
                0 if scene is None else gif_frame_index_at(scene, media_root, now_ms)
            )
            key = composite_frame_key(
                state, scene, now_ms=now_ms, frame_index=frame_index
            )
            refresh_ms = frame_refresh_ms(
                state,
                scene,
                media_root=media_root,
                now_ms=now_ms,
                frame_index=frame_index,
            )
        except Exception as exc:
            # Fail-safe DIRECTION (documented decision): an invalid or
            # unreadable scene must NEVER kill the loop. Paint
            # unconditionally (render_portrait has its own try/except
            # fallback to the legacy view), wait at today's 1/fps cadence,
            # and INVALIDATE the cached key so the next healthy iteration
            # repaints instead of leaving the fallback stuck on the panel.
            # Never latches: the failure is re-evaluated from scratch on
            # every iteration.
            _warn_scene_fallback(exc)
            self.last_key = None
            return FramePlan(
                bounded_wait_seconds(fps, None),
                True,
                self._commit_ack(render=True),
                frame_index,
                None,
            )
        render = self.force or key != self.last_key  # first plan: paint
        if render:
            self.last_key = key
        return FramePlan(
            bounded_wait_seconds(fps, refresh_ms),
            render,
            self._commit_ack(render=render),
            frame_index,
            key,
        )

    def _commit_ack(self, *, render):
        ack = self._ack_owed or (render and self._seq is not None)
        if not ack:
            return None
        self._ack_owed = False
        return self._seq


def portrait_to_buffer(portrait, rotation: str):
    """Map the portrait render into the landscape USB buffer.

    ``rot90cw`` (Vision MAX) is a 90-degree clockwise turn: portrait
    top-blue/bottom-red lands as buffer left-red/right-blue (glass-verified).
    ``none`` (Vision 360 square) is identity. Implemented with PIL
    transposes (lossless, no resampling).
    """
    if rotation == "none":
        return portrait
    if rotation == "rot90cw":
        return portrait.transpose(Image.ROTATE_270)
    raise ValueError(f"unsupported rotation: {rotation!r}")


def encode_jpeg(buffer_img) -> bytes:
    """Encode the landscape buffer as JPEG q80 4:2:0 (v0.1 locked)."""
    buf = io.BytesIO()
    buffer_img.convert("RGB").save(buf, format="JPEG", quality=80, subsampling=2)
    return buf.getvalue()


def build_handshake_packet() -> bytes:
    """Build the 64-byte host->device handshake (magic + mode 1 @0x38)."""
    packet = bytearray(HEADER_SIZE)
    struct.pack_into("<I", packet, 0, MAGIC)
    struct.pack_into("<I", packet, 0x38, 1)
    return bytes(packet)


def resolve_panel(pm: int, sub: int) -> PanelProfile:
    """Look up (pm, sub); raise UnknownPanelError instead of guessing."""
    profile = lookup(pm, sub)
    if not profile.known:
        raise UnknownPanelError(pm, sub)
    return profile


def unknown_status(pm: int, sub: int) -> Dict[str, Any]:
    """Stdout JSON for the unknown-panel refusal (exit 2)."""
    return {
        "type": "status",
        "status": "panel-unknown",
        "pm": pm,
        "sub": sub,
        "message": (
            f"unknown panel PM={pm} SUB={sub}: no registry row; "
            "refusing to push pixels rather than guessing"
        ),
    }


# --------------------------------------------------------------------------
# USB I/O (thin wrappers so unit tests can mock at the endpoint level)
# --------------------------------------------------------------------------


def _usb_backend():
    try:
        import libusb_package  # optional, not a hard dep (see bridge/README.md)

        return libusb_package.get_libusb1_backend()
    except ImportError:
        return None


def open_device(serial: Optional[str]):
    """Find, configure and claim 87AD:70DB; returns (dev, ep_out, ep_in)."""
    try:
        import usb.core
        import usb.util
    except ImportError as exc:
        raise DeviceUnavailableError(
            "pyusb is not installed; bridge cannot claim USB "
            f"(pip install -r bridge/requirements.txt): {exc}",
            status="no-device",
        )

    backend = _usb_backend()
    if backend is None:
        raise DeviceUnavailableError(
            "libusb runtime backend not found (libusb-package missing); "
            "reinstall with 'pip install -r bridge/requirements.txt' (dev) "
            "or rebuild the exe via 'pyinstaller bridge/lcd_bridge.spec'",
            status="no-backend",
        )
    try:
        candidates = list(
            usb.core.find(find_all=True, idVendor=VID, idProduct=PID, backend=backend)
        )
    except Exception as exc:
        raise DeviceUnavailableError(
            f"device {VID:04x}:{PID:04x} not accessible ({exc}); "
            "if TRCC/SignalRGB is open, quit it first (exclusive hold)",
            status="blocked",
        )
    if not candidates:
        raise DeviceUnavailableError(
            f"device {VID:04x}:{PID:04x} not found; check the cable "
            "and that TRCC/SignalRGB is closed",
            status="no-device",
        )

    dev = candidates[0]
    if serial:
        matched = None
        for cand in candidates:
            try:
                import usb.util as _util

                got = _util.get_string(cand, cand.iSerialNumber)
            except Exception:
                continue
            if got and got.lower() == serial.lower():
                matched = cand
                break
        if matched is None:
            raise DeviceUnavailableError(
                f"device {VID:04x}:{PID:04x} serial '{serial}' not found; "
                "check the cable and that TRCC/SignalRGB is closed",
                status="no-device",
            )
        dev = matched

    import usb.util

    try:
        try:
            dev.set_configuration()
        except Exception:
            pass  # already configured
        cfg = dev.get_active_configuration()
        ep_out = ep_in = None
        ifnum = None
        for intf in cfg:
            for ep in intf:
                addr = ep.bEndpointAddress
                if addr == EP_OUT:
                    ep_out = ep
                    ifnum = intf.bInterfaceNumber
                elif addr == EP_IN:
                    ep_in = ep
            if ep_out is not None and ep_in is not None:
                break
        if ep_out is None or ep_in is None:
            raise DeviceUnavailableError(
                f"device {VID:04x}:{PID:04x} has no bulk endpoints "
                f"0x{EP_OUT:02x}/0x{EP_IN:02x}; cannot stream",
                status="no-device",
            )
        try:
            usb.util.claim_interface(dev, ifnum)
        except Exception as exc:
            raise DeviceUnavailableError(
                f"device {VID:04x}:{PID:04x} is busy ({exc}); "
                "quit TRCC/SignalRGB first (they hold it exclusively)",
                status="blocked",
            )
    except DeviceUnavailableError:
        raise
    except Exception as exc:
        raise DeviceUnavailableError(
            f"device {VID:04x}:{PID:04x} is busy ({exc}); "
            "quit TRCC/SignalRGB first (they hold it exclusively)",
            status="blocked",
        )
    return dev, ep_out, ep_in


def close_device(dev) -> None:
    """Release + dispose a claimed device (best effort)."""
    try:
        import usb.util

        try:
            cfg = dev.get_active_configuration()
            for intf in cfg:
                try:
                    usb.util.release_interface(dev, intf.bInterfaceNumber)
                except Exception:
                    pass
        except Exception:
            pass
        usb.util.dispose_resources(dev)
    except Exception:
        pass


def do_handshake(ep_out, ep_in, timeout_ms: int = 2000) -> Tuple[int, int]:
    """Write the 64B handshake once, read the response, parse (pm, sub)."""
    import usb.core

    packet = build_handshake_packet()
    try:
        ep_out.write(packet, timeout_ms)
        resp = bytes(ep_in.read(1024, timeout_ms))
    except usb.core.USBError as exc:
        raise DeviceUnavailableError(
            f"device {VID:04x}:{PID:04x} handshake failed ({exc}); "
            "quit TRCC/SignalRGB first if it holds the device",
            status="blocked",
        )
    try:
        return parse_handshake(resp)
    except ValueError as exc:
        raise DeviceUnavailableError(
            f"device {VID:04x}:{PID:04x} handshake response invalid ({exc})",
            status="blocked",
        )


def send_frame(
    ep_out, profile: PanelProfile, jpeg: bytes, timeout_ms: int = 5000
) -> None:
    """Send one frame: 64B header (via protocol builder) + JPEG chunks."""
    w, h = profile.buffer_size
    header = build_frame_header(w, h, CMD_FRAME, len(jpeg))
    ep_out.write(header, timeout_ms)
    for chunk, need_zlp in iter_chunks(jpeg):
        ep_out.write(chunk, timeout_ms)
        if need_zlp:
            ep_out.write(b"", timeout_ms)


# --------------------------------------------------------------------------
# Output helpers (stdout = JSONL for the shell; stderr = human logs)
# --------------------------------------------------------------------------


def emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(f"[bridge] {message}\n")
    sys.stderr.flush()


def demo_state(layout: str = "lyrics") -> Dict[str, Any]:
    """Demo state used by --preview (no USB, no stdin needed).

    LV-09 unified: SIEMPRE la vista unica (arte + metadata + linea actual +
    siguiente + tiempo + barra). ``layout`` se acepta pero se ignora
    (alias compat: 'lyrics'|'cover' -> mismo unificado). Sin artworkUrl para
    ejercitar el fallback de gradiente sin red (2:31 / 3:20 del mockup).
    """
    _ = normalize_layout(layout)  # compat: validate, ignore result
    return {
        "track": {
            "title": "Unified Preview",
            "artist": "LyricVision",
            "album": "Mockup",
            "artworkUrl": "",
        },
        "lyric": {
            "current_line": "This is the current synced line",
            "next_line": "and the next one attenuated",
        },
        "progressMs": 151000,
        "durationMs": 200000,
        "isPlaying": True,
        "layout": "unified",
        "settings": {"lcdFps": 10},
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="LyricVision LCD bridge v0.1: stdin JSONL -> USB LCD (87AD:70DB)."
    )
    parser.add_argument(
        "--serial",
        default=None,
        help="USB serial to claim (default: first 87AD:70DB device found)",
    )
    parser.add_argument(
        "--once",
        type=int,
        default=None,
        metavar="N",
        help="send N frames then exit (for tests)",
    )
    parser.add_argument(
        "--preview",
        default=None,
        metavar="PATH",
        help="render one portrait frame to PATH as PNG and exit (no USB)",
    )
    parser.add_argument(
        "--preview-layout",
        default="lyrics",
        choices=["lyrics", "cover"],
        help="compat alias (LV-09 unified: ignored, --preview always renders the single view)",
    )
    return parser.parse_args(argv)


def run_preview(path: str, layout: str = "lyrics") -> int:
    """Render the unified preview (``layout`` is an ignored compat alias)."""
    if Image is None:
        log("error: Pillow is not installed (pip install -r bridge/requirements.txt)")
        return 1
    try:
        img = render_portrait(demo_state(normalize_layout(layout)), DEFAULT_GLASS)
        parent = os.path.dirname(os.path.abspath(path))
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        img.save(path, format="PNG")
    except Exception as exc:
        log(f"error: preview render failed: {exc}")
        return 1
    log(f"preview written to {path} ({img.size[0]}x{img.size[1]} portrait)")
    return 0


def _stdin_reader(
    stop: threading.Event, pending: "queue.Queue[Tuple[Optional[int], Dict[str, Any]]]"
):
    # Read bytes on purpose: the OS locale encoding on Windows (cp1252)
    # would mangle UTF-8 lyrics, so decode explicitly as UTF-8 here.
    #
    # Read from a DUP of fd 0, never sys.stdin: a daemon parked in a blocking
    # read holds its BufferedReader lock, and interpreter shutdown must finalize
    # sys.stdin — contending there is the fatal `_enter_buffered_busy` abort
    # (exit 0xC0000005). A separate buffer is finalized uncontended, so a reader
    # left alive by an early return before the render loop is safe to abandon.
    try:
        stream = os.fdopen(os.dup(0), "rb")
    except OSError:
        # fd 0 unusable means it is already closed, so stdin is at EOF here.
        stream = sys.stdin.buffer if hasattr(sys.stdin, "buffer") else sys.stdin
    for raw_bytes in stream:
        if stop.is_set():
            break
        if isinstance(raw_bytes, bytes):
            try:
                raw = raw_bytes.decode("utf-8")
            except UnicodeDecodeError:
                continue
        else:
            raw = raw_bytes
        routed = route_stdin_line(raw)
        if routed is None:
            continue
        if routed[0] == "reply":
            # Answered from the reader thread on purpose: emit() performs
            # exactly one TextIOWrapper.write() plus flush(), and a single
            # write() call is serialized by the wrapper's internal lock, so a
            # preview/error line cannot interleave with a state or ack line the
            # render loop emits concurrently. There is NO explicit Lock in this
            # module -- line integrity depends on emit() staying single-write,
            # so it must never be split into multiple write() calls.
            emit(routed[1])
            continue
        seq, state = routed[1], routed[2]
        try:
            pending.put_nowait((seq, state))
        except queue.Full:
            try:
                pending.get_nowait()  # drop oldest (backpressure visible via qsize)
            except queue.Empty:
                pass
            try:
                pending.put_nowait((seq, state))
            except queue.Full:
                pass


def main(argv=None) -> int:
    args = parse_args(argv)

    if args.preview:
        return run_preview(args.preview, getattr(args, "preview_layout", "lyrics"))

    if args.once is not None and args.once <= 0:
        log("error: --once N requires N >= 1")
        return 1

    # Start draining stdin BEFORE the USB bring-up. The shell writes state the
    # moment it spawns us (setImmediate after spawn in src/main.js), and those
    # envelopes must be queued before frame 1 — otherwise frame 1 renders the
    # default layout and acks nothing, which is what left
    # tests/test_shell_spawn.js with 2 acks for 3 frames.
    pending: "queue.Queue[Tuple[Optional[int], Dict[str, Any]]]" = queue.Queue(
        maxsize=30
    )
    stop = threading.Event()
    reader = threading.Thread(target=_stdin_reader, args=(stop, pending), daemon=True)
    reader.start()

    # --- Open + handshake once (via protocol.py), then registry lookup. ---
    try:
        dev, ep_out, ep_in = open_device(args.serial)
    except DeviceUnavailableError as exc:
        emit(
            {
                "type": "status",
                "status": exc.status,
                "message": str(exc),
                "queue": 0,
                "frames": 0,
            }
        )
        log(f"error: {exc}")
        stop.set()
        return 3

    try:
        pm, sub = do_handshake(ep_out, ep_in)
    except DeviceUnavailableError as exc:
        emit(
            {
                "type": "status",
                "status": exc.status,
                "message": str(exc),
                "queue": 0,
                "frames": 0,
            }
        )
        log(f"error: {exc}")
        close_device(dev)
        stop.set()
        return 3

    try:
        profile = resolve_panel(pm, sub)
    except UnknownPanelError as exc:
        emit(unknown_status(exc.pm, exc.sub))
        log(f"error: {exc}")
        close_device(dev)
        stop.set()
        return 2

    glass = profile.glass_size if profile.glass_size != (0, 0) else DEFAULT_GLASS
    log(
        f"panel: {profile.name} (PM={pm} SUB={sub}), "
        f"glass {glass[0]}x{glass[1]} -> buffer "
        f"{profile.buffer_size[0]}x{profile.buffer_size[1]}"
    )

    state: Dict[str, Any] = {}
    # Last VALIDATED scene received. Local to this loop thread (the reader
    # thread only enqueues envelopes), so retention needs no lock.
    last_scene: Optional[Dict[str, Any]] = None
    seq: Optional[int] = None
    fps = DEFAULT_FPS
    frames = 0
    last_status = time.monotonic() - STATUS_INTERVAL_S  # emit immediately
    # S1-T7b: wait / dirty-flag / ack decisions live in FramePacer (pure;
    # pytest covers them without USB). force pins the `--once` smoke
    # contract -- see FramePacer.__init__ for why tests-only mode paints
    # every iteration even when the key says nothing changed.
    pacer = FramePacer(force=args.once is not None)
    # The envelope the wake-up wait consumed; carried into the next drain.
    carried: Optional[Tuple[Optional[int], Dict[str, Any]]] = None

    try:
        while True:
            # Drain to the latest state; remember the newest seq for ACKs.
            # `carried` (the envelope the wake-up wait consumed below) goes
            # FIRST and is never re-queued: put() would order an older seq
            # BEHIND a newer one and break drain-to-latest -- scene
            # retention's newest-wins rule depends on that order.
            envelopes = drain_envelopes(pending, carried)
            carried = None
            for new_seq, new_state in envelopes:
                # `settings.scene` is the ONE retained field (see
                # apply_scene_retention): the shell omits the key while
                # its digest is unchanged, so replacing the state
                # wholesale here dropped the scene one push after every
                # edit. Every other field still comes from new_state.
                state, last_scene = apply_scene_retention(new_state, last_scene)
                if new_seq is not None:
                    seq = new_seq
                pacer.note_drain(new_seq)
                fps = fps_from_state(state)

            # S1-T7b: ONE decision per iteration -- dirty key (skip
            # render/encode/USB when the composed pixels would be
            # byte-identical), refresh-bounded wait (always <=
            # STATUS_INTERVAL_S, so the ~1 Hz heartbeat outlives a static
            # scene), and ack routing (painted frame OR drained-but-
            # unpainted seq).
            scene = _scene_from_state(state)
            now_ms = time.time() * 1000.0
            plan = pacer.plan(state, scene, now_ms=now_ms, fps=fps)

            # Heartbeat BEFORE the USB write, not only after it: the wait
            # can now be a full STATUS_INTERVAL_S, so a slow-but-successful
            # bulk write right after a full wait could otherwise push the
            # next status/ack past the 5 s watchdog (the old 1/fps sleep
            # was ~0.1 s and never stacked like that). Same guard as the
            # post-render check below => still ~1 Hz cadence, no spam.
            now = time.monotonic()
            if now - last_status >= STATUS_INTERVAL_S:
                emit(
                    {
                        "type": "status",
                        "panel": profile.name,
                        "pm": pm,
                        "sub": sub,
                        "fps": fps,
                        "queue": pending.qsize(),
                        "frames": frames,
                    }
                )
                last_status = now

            if plan.render:
                portrait = render_portrait(
                    state, glass, now_ms=now_ms, frame_index=plan.frame_index
                )
                buffer_img = portrait_to_buffer(portrait, profile.rotation)
                jpeg = encode_jpeg(buffer_img)
                try:
                    send_frame(ep_out, profile, jpeg)
                except Exception as exc:
                    emit(
                        {
                            "type": "status",
                            "status": "blocked",
                            "panel": profile.name,
                            "pm": pm,
                            "sub": sub,
                            "fps": fps,
                            "queue": pending.qsize(),
                            "frames": frames,
                            "message": f"bulk write failed: {exc}",
                        }
                    )
                    log(f"error: bulk write failed: {exc}")
                    close_device(dev)
                    return 3
                frames += 1

            # ACK contract (tests/test_shell_spawn.js asserts exactly 3 for
            # --once 3, seqs 6,6,6): every painted frame re-acks the
            # current seq, AND a drained seq whose frame was skipped as
            # unchanged still gets its one ack -- src/main.js's pendingAcks
            # never clears without it (an unacked seq is a leak).
            if plan.ack_seq is not None:
                emit({"type": "ack", "seq": plan.ack_seq})

            now = time.monotonic()
            if now - last_status >= STATUS_INTERVAL_S:
                emit(
                    {
                        "type": "status",
                        "panel": profile.name,
                        "pm": pm,
                        "sub": sub,
                        "fps": fps,
                        "queue": pending.qsize(),
                        "frames": frames,
                    }
                )
                last_status = now

            if args.once is not None and frames >= args.once:
                break

            # Wake-up (S1-T7b): block at most plan.wait_s (heartbeat bound --
            # the watchdog kills >5 s without status AND ack) and end EARLY
            # on a fresh envelope (wake-on-state), never the old blind
            # fixed-rate sleep. A consumed envelope is carried into the next
            # drain above, never re-queued.
            carried = wait_for_state(pending, plan.wait_s)
    except KeyboardInterrupt:
        log("interrupted")
    finally:
        stop.set()
        close_device(dev)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
