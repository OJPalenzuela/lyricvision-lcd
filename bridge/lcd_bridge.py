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
  {"type": "ack", "seq": N}  once per rendered frame that used a seq
Human logs go to stderr. Exit codes: 0 ok, 2 unknown panel, 3 busy/absent.
"""

from __future__ import annotations

import argparse
import base64
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
    PREVIEW_UNAVAILABLE_MESSAGE,
    PROTOCOL_VERSION,
    ProtocolError,
    build_frame_header,
    build_preview_error,
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
            validate_preview_request(payload)
        except ProtocolError as exc:
            return ("reply", build_preview_error(req_id, exc.reason, exc.message, exc.field))
        # No renderer until S1-T6: answer explicitly with a greppable typed
        # error instead of rendering anything or silently ignoring the line.
        return (
            "reply",
            build_preview_error(req_id, "preview_unavailable", PREVIEW_UNAVAILABLE_MESSAGE),
        )
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
            build_protocol_error("invalid_request", "state envelope must carry a state object"),
        )
    return ("reply", build_protocol_error("unknown_cmd", f"unknown message type: {discriminator!r}"))


def extract_display(state: Dict[str, Any], now_ms: Optional[float] = None) -> Dict[str, Any]:
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
    artwork = track.get("artworkUrl", track.get("artwork_url", state.get("artworkUrl", "")))
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
    for i, line in enumerate(wrap_text(draw, model["title"], title_font, max_w, limit=2)):
        draw.text((margin, 26 + i * 40), line, font=title_font, fill=(245, 247, 250))
    artist = model["artist"] or " "
    for i, line in enumerate(wrap_text(draw, artist, artist_font, max_w, limit=1)):
        draw.text((margin, 26 + 2 * 40 + i * 30), line, font=artist_font, fill=(150, 160, 175))
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
            (draw.textbbox((0, 0), ln, font=current_font)[2]
             - draw.textbbox((0, 0), ln, font=current_font)[0])
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
        draw.text(((w - tw) / 2, top + i * line_h), ln, font=current_font,
                  fill=(255, 255, 255))
    if model["next"]:
        nxt_lines = wrap_text(draw, model["next"], next_font, max_w, limit=2)[:2]
        ny = top + len(current_lines) * line_h + 24
        for i, ln in enumerate(nxt_lines):
            bbox = draw.textbbox((0, 0), ln, font=next_font)
            tw = bbox[2] - bbox[0]
            draw.text(((w - tw) / 2, ny + i * 36), ln, font=next_font,
                      fill=(130, 140, 155))

    # Progress bar (bottom) + LV-09 time text. Unknown duration -> empty track.
    bar_w, bar_h = w - 2 * margin, 8
    bar_y = h - 56
    draw.rounded_rectangle([margin, bar_y, margin + bar_w, bar_y + bar_h],
                           radius=4, fill=(35, 42, 55))
    if model["durationMs"] > 0:
        frac = min(1.0, max(0.0, model["progressMs"] / model["durationMs"]))
        if frac > 0:
            draw.rounded_rectangle([margin, bar_y, margin + int(bar_w * frac), bar_y + bar_h],
                                   radius=4, fill=(88, 166, 255))
    status = "▶" if model["isPlaying"] else "❚❚"
    small = load_font(18, bold=False)
    draw.text((margin, bar_y + 16), status, font=small, fill=(120, 130, 145))
    time_str = f'{format_time(model["progressMs"])} / {format_time(model["durationMs"])}'
    tb = draw.textbbox((0, 0), time_str, font=small)
    draw.text((w - margin - (tb[2] - tb[0]), bar_y + 16), time_str,
              font=small, fill=(120, 130, 145))

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

    art = fetch_artwork(model.get("artworkUrl", "")) if model.get("artworkUrl") else None
    if art is not None:
        try:
            square = _center_crop_square(art).resize((art_size, art_size), Image.LANCZOS)
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
        draw_note_icon(draw, art_x + art_size // 2, art_y + art_size // 2, art_size // 3)

    # Title / artist / album below the art.
    title_font = load_font(30, bold=True)
    artist_font = load_font(22, bold=False)
    album_font = load_font(20, bold=False)
    text_top = art_y + art_size + 22
    for i, line in enumerate(wrap_text(draw, model["title"], title_font, max_w, limit=2)):
        draw.text((margin, text_top + i * 38), line, font=title_font, fill=(245, 247, 250))
    artist = model["artist"] or " "
    for i, line in enumerate(wrap_text(draw, artist, artist_font, max_w, limit=1)):
        draw.text((margin, text_top + 2 * 38 + i * 30), line, font=artist_font,
                  fill=(150, 160, 175))
    if model.get("album"):
        for i, line in enumerate(wrap_text(draw, model["album"], album_font, max_w, limit=1)):
            draw.text((margin, text_top + 2 * 38 + 30 + i * 28), line, font=album_font,
                      fill=(120, 130, 145))

    # Progress bar + drawn icon + m:ss / m:ss time (bottom).
    bar_w, bar_h = w - 2 * margin, 8
    bar_y = h - 56
    draw.rounded_rectangle([margin, bar_y, margin + bar_w, bar_y + bar_h],
                           radius=4, fill=(35, 42, 55))
    if model["durationMs"] > 0:
        frac = min(1.0, max(0.0, model["progressMs"] / model["durationMs"]))
        if frac > 0:
            draw.rounded_rectangle([margin, bar_y, margin + int(bar_w * frac), bar_y + bar_h],
                                   radius=4, fill=(88, 166, 255))
    icon_size = 22
    icon_y = bar_y + 16
    if model["isPlaying"]:
        draw_play_icon(draw, margin, icon_y, icon_size)
    else:
        draw_pause_icon(draw, margin, icon_y, icon_size)
    small = load_font(20, bold=False)
    time_str = f'{format_time(model["progressMs"])} / {format_time(model["durationMs"])}'
    tb = draw.textbbox((0, 0), time_str, font=small)
    draw.text((w - margin - (tb[2] - tb[0]), icon_y - 2), time_str,
              font=small, fill=(150, 160, 175))

    return img


def render_unified(
    state: Dict[str, Any],
    glass: Tuple[int, int] = DEFAULT_GLASS,
    now_ms: Optional[float] = None,
):
    """Render the UNIFIED single view (LV-09 producto: el unico modo).

    Portrait 480x854: arte arriba (center-crop, fallback gradiente + nota),
    titulo/artista/album, linea actual (+ siguiente atenuada), icono
    play/pausa dibujado (nunca emoji), tiempo ``cur / total`` (m:ss) y barra
    proporcional. Sin arte nunca levanta. ``now_ms`` congela el reloj (tests).
    """
    if Image is None:
        raise RuntimeError("Pillow is required for rendering (pip install Pillow)")
    w, h = glass
    model = extract_display(state, now_ms)

    img = Image.new("RGB", (w, h), (10, 13, 20))
    draw = ImageDraw.Draw(img)
    margin = 28
    max_w = w - 2 * margin

    # Art on top: 320px centered (leaves room for lyrics below; full-bleed
    # 424px left no vertical space for current+next). Same LRU/fetch path
    # as the legacy cover layout.
    art_size = 320
    art_x = margin + (max_w - art_size) // 2
    art_y = 24
    art = fetch_artwork(model.get("artworkUrl", "")) if model.get("artworkUrl") else None
    if art is not None:
        try:
            square = _center_crop_square(art).resize((art_size, art_size), Image.LANCZOS)
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
        draw_note_icon(draw, art_x + art_size // 2, art_y + art_size // 2, art_size // 3)

    # Title / artist / album below the art.
    title_font = load_font(28, bold=True)
    artist_font = load_font(22, bold=False)
    album_font = load_font(20, bold=False)
    text_top = art_y + art_size + 16
    for i, line in enumerate(wrap_text(draw, model["title"], title_font, max_w, limit=2)):
        draw.text((margin, text_top + i * 36), line, font=title_font, fill=(245, 247, 250))
    artist = model["artist"] or " "
    for i, line in enumerate(wrap_text(draw, artist, artist_font, max_w, limit=1)):
        draw.text((margin, text_top + 2 * 36 + i * 28), line, font=artist_font,
                  fill=(150, 160, 175))
    if model.get("album"):
        for i, line in enumerate(wrap_text(draw, model["album"], album_font, max_w, limit=1)):
            draw.text((margin, text_top + 2 * 36 + 28 + i * 26), line, font=album_font,
                      fill=(120, 130, 145))

    # Current line (+ next attenuated), centered in the middle band.
    current_font = load_font(34, bold=True)
    next_font = load_font(24, bold=False)
    current_lines: list[str] = []
    size = 34
    for size in range(34, 21, -2):
        current_font = load_font(size, bold=True)
        current_lines = []
        for para in (model["current"] or "♪").split("\n"):
            current_lines.extend(wrap_text(draw, para, current_font, max_w, limit=3))
        current_lines = current_lines[:3]
        widest = max(
            (draw.textbbox((0, 0), ln, font=current_font)[2]
             - draw.textbbox((0, 0), ln, font=current_font)[0])
            for ln in current_lines
        )
        if widest <= max_w:
            break
    lyrics_top = text_top + 2 * 36 + 28 + 30
    line_h = size + 10
    for i, ln in enumerate(current_lines):
        bbox = draw.textbbox((0, 0), ln, font=current_font)
        tw = bbox[2] - bbox[0]
        draw.text(((w - tw) / 2, lyrics_top + i * line_h), ln, font=current_font,
                  fill=(255, 255, 255))
    if model["next"]:
        nxt_lines = wrap_text(draw, model["next"], next_font, max_w, limit=2)[:2]
        ny = lyrics_top + len(current_lines) * line_h + 14
        for i, ln in enumerate(nxt_lines):
            bbox = draw.textbbox((0, 0), ln, font=next_font)
            tw = bbox[2] - bbox[0]
            draw.text(((w - tw) / 2, ny + i * 32), ln, font=next_font,
                      fill=(130, 140, 155))

    # Progress bar + drawn icon + m:ss / m:ss time (bottom). Unknown
    # duration -> empty track (total 0:00), same rule as legacy layouts.
    bar_w, bar_h = w - 2 * margin, 8
    bar_y = h - 56
    draw.rounded_rectangle([margin, bar_y, margin + bar_w, bar_y + bar_h],
                           radius=4, fill=(35, 42, 55))
    if model["durationMs"] > 0:
        frac = min(1.0, max(0.0, model["progressMs"] / model["durationMs"]))
        if frac > 0:
            draw.rounded_rectangle([margin, bar_y, margin + int(bar_w * frac), bar_y + bar_h],
                                   radius=4, fill=(88, 166, 255))
    icon_size = 22
    icon_y = bar_y + 16
    if model["isPlaying"]:
        draw_play_icon(draw, margin, icon_y, icon_size)
    else:
        draw_pause_icon(draw, margin, icon_y, icon_size)
    small = load_font(20, bold=False)
    time_str = f'{format_time(model["progressMs"])} / {format_time(model["durationMs"])}'
    tb = draw.textbbox((0, 0), time_str, font=small)
    draw.text((w - margin - (tb[2] - tb[0]), icon_y - 2), time_str,
              font=small, fill=(150, 160, 175))

    return img


def render_portrait(
    state: Dict[str, Any],
    glass: Tuple[int, int] = DEFAULT_GLASS,
    now_ms: Optional[float] = None,
):
    """Render the portrait frame at glass resolution (default 480x854).

    LV-09 unified: SIEMPRE la vista unica (:func:`render_unified`); el
    ``layout`` guardado viejo se acepta (whitelist) pero se ignora.
    Mantiene la forma de llamada para no tocar el path USB/rotacion/encode.
    """
    _ = layout_from_state(state)  # compat: validate, ignore result
    return render_unified(state, glass, now_ms)


# ---------------------------------------------------------------------------
# Scene renderer (S1-T4): backgrounds + transforms + text overlays.
#
# ADDITIVE by contract: the live frame loop still runs render_unified();
# swapping it to render_scene is S1-T7 together with physical-hardware
# validation. Nothing below is reachable from the USB path yet.
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


class SceneRenderError(Exception):
    """Typed scene-rendering failure (S1-T4).

    Deliberately disjoint from ProtocolError (validation: "the scene is
    malformed") and from OSError (filesystem: never allowed to leak from
    this renderer). ``reason`` is the greppable discriminator:

      unsupported_background  valid kind, not implemented yet (gif/video)
      unsupported_overlay     valid kind, not implemented yet (gpu-temp)
      media_refused           source resolves outside the media root
      media_missing           contained key is not a regular file
      media_unreadable        bytes would not decode as an image
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


def _load_media_bytes(source: str, media_root: Any) -> bytes:
    """Inline data: URL bytes, or a contained read from the media root."""
    if source[:5].lower() == "data:":
        return _decode_data_url(source)
    path = _resolve_media_source(source, media_root)
    if not os.path.isfile(path):
        raise SceneRenderError(
            "media_missing",
            f"media key not found in the media root: {source!r}",
            field="background.source",
        )
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except OSError as exc:
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
    w, h = canvas.size
    payload = _load_media_bytes(bg["source"], media_root)
    image = _open_rgba(payload, bg["source"])
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


def render_scene(scene, *, media_root, size=(480, 854)):
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
      * Background gif/video and gpu-temp overlays validate but are not
        implemented until S1-T5/S3-T12: they raise
        SceneRenderError("unsupported_*") so the caller can tell
        "unsupported" from "invalid" (ProtocolError from validate_scene).
      * ADDITIVE: not wired into the live frame loop (S1-T7, hardware).
    """
    if Image is None:
        raise RuntimeError("Pillow is required for rendering (pip install Pillow)")
    if not (
        isinstance(size, tuple)
        and len(size) == 2
        and all(
            isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in size
        )
    ):
        raise ValueError("size must be a (width, height) tuple of positive ints")
    # Defense in depth: validation errors are ProtocolError, never
    # SceneRenderError -- the two families stay disjoint for callers.
    validated = validate_scene(scene)
    w, h = size
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    background = validated["background"]
    kind = background["kind"]
    if kind == "none":
        pass  # a transparent canvas IS the background
    elif kind == "color":
        canvas.paste(_hex_rgb(background["color"]) + (255,), (0, 0, w, h))
    elif kind == "image":
        _render_image_background(canvas, background, media_root)
    else:
        # gif/video (and any kind the validator might add later): valid but
        # not implemented here. Checked BEFORE the source is touched, so an
        # unsupported kind never leaks a media error.
        raise SceneRenderError(
            "unsupported_background",
            f"background kind {kind!r} is not supported by render_scene yet "
            "(gif/video: S1-T5 / S3-T12)",
            field="background.kind",
        )
    for index, overlay in enumerate(validated["overlays"]):
        overlay_kind = overlay["kind"]
        if overlay_kind == "text":
            _draw_text_overlay(canvas, overlay, index)
        else:
            # gpu-temp needs runtime temperature data this pure renderer is
            # not given; valid shape, unimplementable here.
            raise SceneRenderError(
                "unsupported_overlay",
                f"overlay kind {overlay_kind!r} is not supported by "
                "render_scene yet",
                field=f"overlays[{index}].kind",
            )
    return canvas


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


def send_frame(ep_out, profile: PanelProfile, jpeg: bytes, timeout_ms: int = 5000) -> None:
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


def _stdin_reader(stop: threading.Event, pending: "queue.Queue[Tuple[Optional[int], Dict[str, Any]]]"):
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
    pending: "queue.Queue[Tuple[Optional[int], Dict[str, Any]]]" = queue.Queue(maxsize=30)
    stop = threading.Event()
    reader = threading.Thread(target=_stdin_reader, args=(stop, pending), daemon=True)
    reader.start()

    # --- Open + handshake once (via protocol.py), then registry lookup. ---
    try:
        dev, ep_out, ep_in = open_device(args.serial)
    except DeviceUnavailableError as exc:
        emit({"type": "status", "status": exc.status,
              "message": str(exc), "queue": 0, "frames": 0})
        log(f"error: {exc}")
        stop.set()
        return 3

    try:
        pm, sub = do_handshake(ep_out, ep_in)
    except DeviceUnavailableError as exc:
        emit({"type": "status", "status": exc.status,
              "message": str(exc), "queue": 0, "frames": 0})
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
    log(f"panel: {profile.name} (PM={pm} SUB={sub}), "
        f"glass {glass[0]}x{glass[1]} -> buffer "
        f"{profile.buffer_size[0]}x{profile.buffer_size[1]}")

    state: Dict[str, Any] = {}
    seq: Optional[int] = None
    fps = DEFAULT_FPS
    frames = 0
    last_status = time.monotonic() - STATUS_INTERVAL_S  # emit immediately

    try:
        while True:
            # Drain to the latest state; remember the newest seq for ACKs.
            try:
                while True:
                    new_seq, new_state = pending.get_nowait()
                    state = new_state
                    if new_seq is not None:
                        seq = new_seq
                    fps = fps_from_state(state)
            except queue.Empty:
                pass

            portrait = render_portrait(state, glass)
            buffer_img = portrait_to_buffer(portrait, profile.rotation)
            jpeg = encode_jpeg(buffer_img)
            try:
                send_frame(ep_out, profile, jpeg)
            except Exception as exc:
                emit({"type": "status", "status": "blocked", "panel": profile.name,
                      "pm": pm, "sub": sub, "fps": fps, "queue": pending.qsize(),
                      "frames": frames, "message": f"bulk write failed: {exc}"})
                log(f"error: bulk write failed: {exc}")
                close_device(dev)
                return 3
            frames += 1

            if seq is not None:
                emit({"type": "ack", "seq": seq})

            now = time.monotonic()
            if now - last_status >= STATUS_INTERVAL_S:
                emit({"type": "status", "panel": profile.name, "pm": pm, "sub": sub,
                      "fps": fps, "queue": pending.qsize(), "frames": frames})
                last_status = now

            if args.once is not None and frames >= args.once:
                break
            time.sleep(1.0 / fps)
    except KeyboardInterrupt:
        log("interrupted")
    finally:
        stop.set()
        close_device(dev)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
