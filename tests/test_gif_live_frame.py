"""Time -> GIF frame selector and live composed-frame wiring (S1-T7a-1).

Run from the repo root:
    .venv/Scripts/python.exe -m pytest tests/test_gif_live_frame.py -v

The defect pinned here (independent verification, 1 MAJOR): the live loop
calls render_portrait(state, glass) with NO frame_index, so render_scene's
default 0 selected GIF frame 0 on every tick -- the preview animated while
the physical panel froze. The headline test therefore renders the
COMPOSED frame through render_portrait at two timestamps and demands
different bytes; a selector-only test could not catch the call-site bug.

Hardware-free: no USB, no network (artworkUrl is always empty, so
render_unified never fetches). Every GIF fixture is generated with Pillow
inside the test (tmp_path = system temp, never the repo) -- no binary GIF
is ever committed.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from PIL import Image  # noqa: E402

from bridge import lcd_bridge  # noqa: E402
from bridge.protocol import ProtocolError  # noqa: E402

GLASS = (480, 854)
RED = (255, 0, 0)
GREEN = (0, 255, 0)
BLUE = (0, 0, 255)
MEASURED_AT = 1_700_000_000_000.0
DELAY_MS = [40, 80, 120]  # three distinct per-frame delays...
LOOP_MS = sum(DELAY_MS)  # ...summing to one 240 ms loop
# Timestamp aligned to the loop (T % 240 == 0), so the phase in each
# assertion reads straight off DELAY_MS.
T = float(int(MEASURED_AT) - (int(MEASURED_AT) % LOOP_MS))


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def unified_state(**overrides):
    base = {
        "track": {"title": "Selector Test", "artist": "LyricVision",
                  "album": "Scene", "artworkUrl": ""},
        "lyric": {"current_line": "first line", "next_line": "second line"},
        "progressMs": 40000,
        "offsetMs": 0,
        "measuredAt": MEASURED_AT,
        "durationMs": 180000,
        "isPlaying": True,
        "settings": {"lcdFps": 10},
    }
    base.update(overrides)
    return base


def with_scene(state, scene):
    settings = dict(state.get("settings") or {})
    settings["scene"] = scene
    return dict(state, settings=settings)


def color_scene():
    return {"version": 1, "background": {"kind": "color", "color": "#123456"},
            "overlays": []}


def gif_bg(source, **overrides):
    bg = {"kind": "gif", "source": source, "rotation": 0, "flipH": False,
          "scale": 1, "panX": 0, "panY": 0, "fit": "fit"}
    bg.update(overrides)
    return {"version": 1, "background": bg, "overlays": []}


def save_gif(frames, root, name, **kwargs):
    """Write an animated GIF fixture with Pillow. Generated, never committed."""
    path = os.path.join(str(root), name)
    frames[0].save(path, format="GIF", save_all=True, append_images=frames[1:],
                   **kwargs)
    return name


def solid(*colors):
    return [Image.new("RGB", (10, 10), color) for color in colors]


def three_frame_gif(root, name="three.gif"):
    return save_gif(solid(RED, GREEN, BLUE), root, name, duration=DELAY_MS)


def selector(scene, root, now_ms):
    return lcd_bridge.gif_frame_index_at(scene, root, now_ms)


# --------------------------------------------------------------------------
# Selector: one timestamp -> one frame, via phase = now_ms % loop_ms
# --------------------------------------------------------------------------

def test_selector_walks_a_full_loop_at_exact_boundaries(tmp_path):
    name = three_frame_gif(tmp_path)
    scene, root = gif_bg(name), str(tmp_path)
    # Half-open intervals [start, end): a phase landing EXACTLY on a
    # boundary selects the NEW frame -- at that instant the previous
    # frame's delay has fully elapsed. Walk every edge of the 240 ms loop.
    cases = [(0, 0), (39, 0), (40, 1), (119, 1), (120, 2), (239, 2),
             (240, 0)]
    for phase, expected in cases:
        assert selector(scene, root, T + phase) == expected, phase


def test_selector_is_periodic_and_adjacent_across_boundaries(tmp_path):
    name = three_frame_gif(tmp_path, "period.gif")
    scene, root = gif_bg(name), str(tmp_path)
    # T and T + k*loop_ms are the SAME phase -> the SAME frame, any k.
    # No "scene started at" bookkeeping: the selector is stateless.
    for k in (1, 7, 10 ** 6):
        for stamp in (T, T + 40, T + 120):
            assert selector(scene, root, stamp) == \
                selector(scene, root, stamp + k * LOOP_MS), (k, stamp)
    # Crossing a boundary by one ms moves exactly one frame (adjacent).
    assert selector(scene, root, T + 40 - 1) == 0
    assert selector(scene, root, T + 40) == 1
    assert selector(scene, root, T + 120 - 1) == 1
    assert selector(scene, root, T + 120) == 2


def test_non_gif_scene_is_zero_without_touching_the_filesystem(
        tmp_path, monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("a non-GIF scene must not open media")

    monkeypatch.setattr(lcd_bridge, "_load_media_bytes", boom)
    # Nonexistent root: anything that tried to open it would fail loudly.
    ghost = str(tmp_path / "does-not-exist")
    image = {"version": 1,
             "background": {"kind": "image", "source": "x.png", "rotation": 0,
                            "flipH": False, "scale": 1, "panX": 0, "panY": 0,
                            "fit": "fit"},
             "overlays": []}
    video = dict(image, background=dict(image["background"], kind="video"))
    for scene in (color_scene(),
                  {"version": 1, "background": {"kind": "none"},
                   "overlays": []},
                  image, video):
        assert selector(scene, ghost, T) == 0, scene["background"]["kind"]


def test_invalid_scene_is_protocol_error_not_zero(tmp_path):
    # Same family as scene_refresh_ms: validate FIRST, then dispatch.
    for bad in (None, {"version": 2, "background": {"kind": "none"},
                       "overlays": []}):
        with pytest.raises(ProtocolError):
            selector(bad, str(tmp_path), T)


# --------------------------------------------------------------------------
# Selector guards: loop_ms <= 0 / missing / zero durations
# --------------------------------------------------------------------------

def test_selector_guards_empty_or_non_positive_loop_ms(tmp_path, monkeypatch):
    name = three_frame_gif(tmp_path)
    scene, root = gif_bg(name), str(tmp_path)
    assert selector(scene, root, T) == 0  # sanity before the patch
    # _gif_delays can never yield <= 0 in production (missing/zero floors
    # to GIF_DEFAULT_DELAY_MS), so drive the defensive guard directly:
    # frame 0 back, never a ZeroDivisionError.
    for delays in ([], [0, -5]):
        monkeypatch.setattr(lcd_bridge, "_gif_delays",
                            lambda *a, _d=delays, **k: list(_d))
        assert selector(scene, root, T + 40) == 0, delays


def test_zero_or_missing_durations_never_raise_and_stay_in_range(tmp_path):
    # _gif_delay floors missing/0 to GIF_DEFAULT_DELAY_MS (100), so a real
    # loop_ms is always positive; the selector must simply pick a frame.
    zero = save_gif(solid(RED, GREEN), tmp_path, "zero.gif", duration=[0, 0])
    nodur = save_gif(solid(RED, GREEN), tmp_path, "nodur.gif")
    for name in (zero, nodur):
        scene = gif_bg(name)
        for stamp in (T, T + 99, T + 100, T + LOOP_MS, T + LOOP_MS + 150):
            idx = selector(scene, str(tmp_path), stamp)
            assert type(idx) is int and idx in (0, 1), (name, stamp, idx)


# --------------------------------------------------------------------------
# Selector: now_ms edge handling
# --------------------------------------------------------------------------

def test_now_ms_none_negative_huge_float_and_garbage_are_documented(
        tmp_path, monkeypatch):
    name = three_frame_gif(tmp_path)
    scene, root = gif_bg(name), str(tmp_path)

    def at(stamp):
        return selector(scene, root, stamp)

    # None -> live clock (the current_progress convention); freeze it.
    monkeypatch.setattr(lcd_bridge, "_live_clock_ms", lambda: T + 40.0)
    assert at(None) == 1 == at(T + 40)
    # Float stamps are first class (now_ms: Optional[float]).
    assert at(T + 40.0) == at(T + 40) == 1
    # Negative: Python's % wraps the phase into [0, loop_ms) -- the same
    # periodic rule, no special case, no exception.
    assert at(-1.0) == at(T + LOOP_MS - 1) == 2
    # Huge: one O(1) modulo, never a walk over time magnitude.
    assert at(10 ** 18) in (0, 1, 2)
    assert at(1e300) in (0, 1, 2)
    # Garbage that cannot name a phase -> frame 0: fail-safe, no raise.
    for bad in (float("nan"), float("inf"), "not-a-time", True, object()):
        assert at(bad) == 0, bad


# --------------------------------------------------------------------------
# THE HEADLINE: the composed production frame must animate
# --------------------------------------------------------------------------

def test_composed_gif_frame_bytes_advance_with_now_ms(tmp_path, monkeypatch):
    # The defect: render_portrait forwarded the frame_index default 0, so
    # the panel showed GIF frame 0 forever while the preview animated.
    # fit=fill covers the whole canvas, so background pixels the lyrics
    # view never paints (e.g. 2,2) change color with the frame.
    monkeypatch.setattr(lcd_bridge, "MEDIA_ROOT", str(tmp_path))
    name = three_frame_gif(tmp_path, "live.gif")
    # Paused playback freezes the extrapolated clock, so ANY byte
    # difference between the two stamps comes from the background alone.
    state = with_scene(unified_state(isPlaying=False),
                       gif_bg(name, fit="fill"))
    first = lcd_bridge.render_portrait(state, GLASS, T)  # phase 0 -> frame 0
    later = lcd_bridge.render_portrait(state, GLASS, T + 40)  # -> frame 1
    frozen = first.tobytes() == later.tobytes()
    assert not frozen, (
        "composed GIF frame did not advance: render_portrait returned "
        "identical bytes at T (phase 0) and T+40 (phase 40)"
    )
    assert first.getpixel((2, 2)) != later.getpixel((2, 2))
    # Same stamp twice -> identical bytes: the selector is stateless.
    again = lcd_bridge.render_portrait(state, GLASS, T)
    identical = again.tobytes() == first.tobytes()
    assert identical, "same now_ms must produce byte-identical frames"


def test_explicit_frame_index_still_pins_the_frame(tmp_path, monkeypatch):
    monkeypatch.setattr(lcd_bridge, "MEDIA_ROOT", str(tmp_path))
    name = three_frame_gif(tmp_path, "pin.gif")
    state = with_scene(unified_state(isPlaying=False),
                       gif_bg(name, fit="fill"))
    pinned = lcd_bridge.render_portrait(state, GLASS, T, frame_index=2)
    derived = lcd_bridge.render_portrait(state, GLASS, T + 120)  # -> frame 2
    matched = pinned.tobytes() == derived.tobytes()
    assert matched, "explicit frame_index=2 must equal the derived phase 120"
    other = lcd_bridge.render_portrait(state, GLASS, T)  # frame 0
    assert pinned.getpixel((2, 2)) != other.getpixel((2, 2))


def test_non_gif_composed_frame_is_stable_across_now_ms(tmp_path, monkeypatch):
    # Isolate the background: paused state + static color scene, so the
    # only possible mover (the GIF selector) must NOT move anything.
    monkeypatch.setattr(lcd_bridge, "MEDIA_ROOT", str(tmp_path))
    state = with_scene(unified_state(isPlaying=False), color_scene())
    early = lcd_bridge.render_portrait(state, GLASS, T)
    late = lcd_bridge.render_portrait(state, GLASS, T + 12_345)
    assert (early.mode, early.size) == (late.mode, late.size)
    stable = early.tobytes() == late.tobytes()
    assert stable, "a non-GIF scene must not change with now_ms"
