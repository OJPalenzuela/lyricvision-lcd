"""Composed frame, composite dirty key and refresh policy (S1-T7a). pytest.

Run from the repo root:
    .venv/Scripts/python.exe -m pytest tests/test_compose_frame.py -v

Layer-order contract under test: background -> lyrics view -> scene overlays.
The composite dirty key must cover scene || display-state || frame_index ||
time bucket -- scene_digest alone would freeze live lyrics behind a static
background (independent-verification MAJOR, S1-T5).

Hardware-free: no USB, no network (artworkUrl is always empty, so
render_unified never calls fetch_artwork), no shell.openExternal.
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from PIL import Image  # noqa: E402

from bridge import lcd_bridge  # noqa: E402
from bridge.protocol import ProtocolError  # noqa: E402


GLASS = (480, 854)
LEGACY_BG = (10, 13, 20)
# A time base far from the live clock so every extrapolation is explicit.
MEASURED_AT = 1_700_000_000_000.0
NOW = MEASURED_AT + 40_000.0


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def unified_state(**overrides):
    base = {
        "track": {
            "title": "Compose Test",
            "artist": "LyricVision",
            "album": "Scene",
            "artworkUrl": "",
        },
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


def blank_scene():
    return {"version": 1, "background": {"kind": "none"}, "overlays": []}


def color_scene(color="#123456", overlays=None):
    return {"version": 1, "background": {"kind": "color", "color": color},
            "overlays": overlays or []}


def text_overlay(**overrides):
    overlay = {"kind": "text", "text": "Hi", "x": 0.5, "y": 0.5,
               "size": 0.1, "rotation": 0, "color": "#ff0000"}
    overlay.update(overrides)
    return overlay


def image_bg(source, **overrides):
    bg = {"kind": "image", "source": source, "rotation": 0, "flipH": False,
          "scale": 1, "panX": 0, "panY": 0, "fit": "fit"}
    bg.update(overrides)
    return {"version": 1, "background": bg, "overlays": []}


def gif_bg(source, **overrides):
    return dict(image_bg(source), background=dict(image_bg(source)["background"],
                                                  kind="gif", **overrides))


def save_gif(frames, root, name, **kwargs):
    path = os.path.join(str(root), name)
    frames[0].save(path, format="GIF", save_all=True,
                   append_images=frames[1:], **kwargs)
    return name


def same_pixels(a, b):
    return (a.mode, a.size) == (b.mode, b.size) and a.tobytes() == b.tobytes()


GPU_TEMP = {"kind": "gpu-temp", "x": 0.5, "y": 0.5, "size": 0.1,
            "rotation": 0, "color": "#ffffff"}


# --------------------------------------------------------------------------
# render_unified base= (non-regression: no base == today's output)
# --------------------------------------------------------------------------

def test_render_unified_without_base_matches_pre_filled_base():
    # Supplying a base pre-filled with today's fresh-canvas color must draw
    # exactly what the no-base path draws: the base branch replaces only the
    # Image.new() line, nothing else in the draw pipeline may differ.
    state = unified_state()
    fresh = lcd_bridge.render_unified(state, GLASS, NOW)
    base = Image.new("RGB", GLASS, LEGACY_BG)
    onto = lcd_bridge.render_unified(state, GLASS, NOW, base=base)
    assert same_pixels(fresh, onto)
    # The base was genuinely used (drawn onto), not ignored.
    assert onto is base
    # Two no-base calls stay deterministic but are distinct objects.
    again = lcd_bridge.render_unified(state, GLASS, NOW)
    assert again is not fresh
    assert same_pixels(fresh, again)


def test_render_unified_incompatible_base_falls_back_to_fresh_canvas():
    # Wrong size (and wrong mode) bases are ignored -- fail-safe to today's
    # output instead of raising on the production render path.
    state = unified_state()
    small = Image.new("RGB", (10, 10), (255, 0, 0))
    out = lcd_bridge.render_unified(state, GLASS, NOW, base=small)
    assert out is not small
    assert out.size == GLASS and out.mode == "RGB"
    assert same_pixels(out, lcd_bridge.render_unified(state, GLASS, NOW))
    rgba = Image.new("RGBA", GLASS, (255, 0, 0, 255))
    out2 = lcd_bridge.render_unified(state, GLASS, NOW, base=rgba)
    assert out2.mode == "RGB"
    assert same_pixels(out2, lcd_bridge.render_unified(state, GLASS, NOW))


# --------------------------------------------------------------------------
# Regression guarantee: no scene / blank scene == today's frame
# --------------------------------------------------------------------------

def test_no_scene_state_frame_byte_identical_to_unified():
    # The live-loop rewire must add NOTHING when settings carry no scene.
    state = unified_state()
    legacy = lcd_bridge.render_unified(state, GLASS, NOW)
    assert same_pixels(lcd_bridge.render_portrait(state, GLASS, NOW), legacy)


def test_blank_scene_frame_byte_identical_to_unified():
    # background none + overlays [] composes to the exact legacy bytes:
    # a transparent background flattened over today's canvas color is
    # today's canvas color, and an empty overlay list draws nothing.
    state = unified_state()
    legacy = lcd_bridge.render_unified(state, GLASS, NOW)
    blank = with_scene(state, blank_scene())
    assert same_pixels(lcd_bridge.render_portrait(blank, GLASS, NOW), legacy)
    assert same_pixels(
        lcd_bridge.render_frame(state, blank_scene(), media_root=os.devnull,
                                glass=GLASS, now_ms=NOW),
        legacy,
    )


def test_frame_without_scene_is_legacy_path():
    state = unified_state()
    legacy = lcd_bridge.render_unified(state, GLASS, NOW)
    assert same_pixels(
        lcd_bridge.render_frame(state, None, media_root=os.devnull,
                                glass=GLASS, now_ms=NOW),
        legacy,
    )


# --------------------------------------------------------------------------
# Layer order: background -> lyrics view -> scene overlays
# --------------------------------------------------------------------------

def test_composition_order_background_view_overlay():
    scene = color_scene(
        "#123456",
        overlays=[text_overlay(text="OVER", x=0.5, y=0.19, size=0.08,
                               color="#00ff00")],
    )
    frame = lcd_bridge.render_frame(unified_state(), scene,
                                    media_root=os.devnull, glass=GLASS,
                                    now_ms=NOW)
    assert frame.mode == "RGB"
    # 1. Background where the lyrics view does not paint: today's view
    #    never touches the top-left corner, the scene background does.
    assert frame.getpixel((2, 2)) == (0x12, 0x34, 0x56)
    # 2. The lyrics view paints OVER the background: the art box (gradient
    #    fallback for an empty artworkUrl) is not the background color.
    art_pixel = frame.getpixel((240, 184))
    assert art_pixel != (0x12, 0x34, 0x56)
    # 3. The scene overlay paints ON TOP of both: pure overlay ink inside
    #    the art box (over lyrics-view pixels), composited at alpha 255.
    greens = sum(
        1 for x in range(80, 400, 4) for y in range(24, 344, 4)
        if frame.getpixel((x, y)) == (0, 255, 0)
    )
    assert greens > 0, "overlay ink must land above the lyrics view"


def test_scene_background_layer_and_overlays_recompose_render_scene():
    # render_scene (the preview's single-call path) must stay byte-identical
    # to background-then-overlays of the same scene: the split into layers
    # may not change what either layer paints.
    scene = color_scene("#204060",
                        overlays=[text_overlay(text="Layer", x=0.3, y=0.4)])
    root = os.devnull
    whole = lcd_bridge.render_scene(scene, media_root=root, size=GLASS)
    bg = lcd_bridge.render_scene_background(scene, media_root=root, size=GLASS)
    lcd_bridge.draw_scene_overlays(bg, scene)
    assert whole.mode == bg.mode == "RGBA"
    assert whole.tobytes() == bg.tobytes()


def test_background_only_layer_has_no_overlay_ink():
    scene = color_scene("#123456",
                        overlays=[text_overlay(text="INK", x=0.5, y=0.5,
                                               size=0.2, color="#00ff00")])
    bg = lcd_bridge.render_scene_background(scene, media_root=os.devnull,
                                            size=GLASS)
    assert bg.mode == "RGBA"
    assert bg.getpixel((2, 2))[:3] == (0x12, 0x34, 0x56)
    assert not any(
        bg.getpixel((x, y))[:3] == (0, 255, 0)
        for x in range(0, GLASS[0], 4) for y in range(0, GLASS[1], 4)
    )


# --------------------------------------------------------------------------
# BINDING acceptance: the composite dirty key covers live state
# --------------------------------------------------------------------------

def test_static_scene_lyric_change_dirties_key_and_frame():
    scene = color_scene("#123456", overlays=[text_overlay(text="badge")])
    a = unified_state()
    b = with_lyric(unified_state(), "turn the page", "keep reading")
    key_a = lcd_bridge.composite_frame_key(a, scene, now_ms=NOW)
    key_b = lcd_bridge.composite_frame_key(b, scene, now_ms=NOW)
    assert key_a != key_b, "a scene-only key would freeze live lyrics"
    frame_a = lcd_bridge.render_frame(a, scene, media_root=os.devnull,
                                      glass=GLASS, now_ms=NOW)
    frame_b = lcd_bridge.render_frame(b, scene, media_root=os.devnull,
                                      glass=GLASS, now_ms=NOW)
    assert frame_a.tobytes() != frame_b.tobytes()


def with_lyric(state, current, nxt):
    return dict(state, lyric={"current_line": current, "next_line": nxt})


def test_static_scene_progress_advance_dirties():
    scene = color_scene("#123456")
    a = unified_state()
    b = dict(a, progressMs=41000)
    assert lcd_bridge.composite_frame_key(a, scene, now_ms=NOW) != \
        lcd_bridge.composite_frame_key(b, scene, now_ms=NOW)


def test_progress_clock_ticks_dirty_the_key_without_state_change():
    # Same state object, same scene: only the wall clock advances. The
    # extrapolated m:ss clock changes every second while playing, so the
    # time bucket must catch it with zero state change.
    scene = color_scene("#123456")
    state = unified_state()
    t0 = MEASURED_AT + 50_000.0
    k0 = lcd_bridge.composite_frame_key(state, scene, now_ms=t0)
    k_same_second = lcd_bridge.composite_frame_key(state, scene, now_ms=t0 + 400)
    k_next_second = lcd_bridge.composite_frame_key(state, scene, now_ms=t0 + 1000)
    assert k_same_second == k0, "one bucket == one displayed second"
    assert k_next_second != k0, "a new displayed second must dirty the key"


def test_paused_clock_does_not_dirty_the_key():
    # Paused: extrapolation is frozen, so the bucket is frozen too -- this
    # is what lets the static sentinel stand when playback is stopped.
    scene = color_scene("#123456")
    state = unified_state(isPlaying=False)
    t0 = MEASURED_AT + 50_000.0
    assert lcd_bridge.composite_frame_key(state, scene, now_ms=t0) == \
        lcd_bridge.composite_frame_key(state, scene, now_ms=t0 + 60_000)


def test_gif_frame_index_distinguishes_frames():
    # An animating GIF's scene_digest is constant across frames (S1-T5
    # finding); frame_index in the composite key is what separates them.
    scene = gif_bg("anim.gif")
    assert lcd_bridge.composite_frame_key(unified_state(), scene,
                                          now_ms=NOW, frame_index=0) != \
        lcd_bridge.composite_frame_key(unified_state(), scene,
                                       now_ms=NOW, frame_index=1)


def test_key_insertion_order_alone_does_not_dirty():
    scene_a = color_scene("#123456", overlays=[text_overlay(text="x")])
    scene_b = {
        "overlays": [
            {"color": "#ff0000", "rotation": 0, "size": 0.1, "y": 0.5,
             "x": 0.5, "text": "x", "kind": "text"},
        ],
        "background": {"color": "#123456", "kind": "color"},
        "version": 1,
    }
    state_a = unified_state()
    state_b = {
        "settings": {"lcdFps": 10},
        "isPlaying": True,
        "durationMs": 180000,
        "measuredAt": MEASURED_AT,
        "offsetMs": 0,
        "progressMs": 40000,
        "lyric": {"next_line": "second line", "current_line": "first line"},
        "track": {"artworkUrl": "", "album": "Scene", "artist": "LyricVision",
                  "title": "Compose Test"},
    }
    assert lcd_bridge.composite_frame_key(state_a, scene_a, now_ms=NOW) == \
        lcd_bridge.composite_frame_key(state_b, scene_b, now_ms=NOW)


def test_lcd_fps_change_dirties_the_key():
    # settings.lcdFps is part of the display-relevant subset.
    scene = color_scene("#123456")
    a = unified_state()
    b = dict(a, settings={"lcdFps": 30})
    assert lcd_bridge.composite_frame_key(a, scene, now_ms=NOW) != \
        lcd_bridge.composite_frame_key(b, scene, now_ms=NOW)


def test_every_display_relevant_field_dirties_the_key():
    # The digest must be sensitive to EVERY value that changes pixels:
    # each mutation below is a field render_unified (or the extrapolated
    # clock behind it) reads.
    scene = color_scene("#123456")
    base = unified_state()
    base_key = lcd_bridge.composite_frame_key(base, scene, now_ms=NOW)

    def track_with(**overrides):
        track = dict(base["track"])
        track.update(overrides)
        return dict(base, track=track)

    variants = {
        "title": track_with(title="Other Title"),
        "artist": track_with(artist="Other Artist"),
        "album": track_with(album="Other Album"),
        "artworkUrl": track_with(artworkUrl="https://example.invalid/a.png"),
        "next_line": dict(base, lyric={"current_line": "first line",
                                       "next_line": "changed"}),
        "progressMs": dict(base, progressMs=41000),
        "offsetMs": dict(base, offsetMs=500),
        "measuredAt": dict(base, measuredAt=MEASURED_AT + 1500),
        "isPlaying": dict(base, isPlaying=False),
        "durationMs": dict(base, durationMs=200000),
        "lcdFps": dict(base, settings={"lcdFps": 30}),
    }
    for field, mutated in variants.items():
        assert lcd_bridge.composite_frame_key(mutated, scene, now_ms=NOW) != \
            base_key, field


def test_display_state_digest_is_deterministic_and_order_insensitive():
    a = unified_state()
    b = dict(reversed(list(a.items())))
    assert lcd_bridge.display_state_digest(a, now_ms=NOW) == \
        lcd_bridge.display_state_digest(b, now_ms=NOW)
    assert lcd_bridge.display_state_digest(a, now_ms=NOW) == \
        lcd_bridge.display_state_digest(a, now_ms=NOW)
    assert lcd_bridge.display_state_digest(unified_state(
        track=dict(unified_state()["track"], title="Other")),
        now_ms=NOW) != lcd_bridge.display_state_digest(a, now_ms=NOW)


def test_invalid_scene_rejects_in_composite_key():
    with pytest.raises(ProtocolError):
        lcd_bridge.composite_frame_key(
            unified_state(),
            {"version": 2, "background": {"kind": "none"}, "overlays": []},
            now_ms=NOW,
        )


# --------------------------------------------------------------------------
# Refresh policy: finite positive ints, minimum-combined
# --------------------------------------------------------------------------

def assert_interval(wait):
    # FAIL-SAFE invariant: finite positive int. 0/negative busy-spins the
    # loop; float/inf/NaN corrupt deadline arithmetic.
    assert type(wait) is int, (wait, type(wait))
    assert wait > 0
    assert wait < float("inf")


def test_refresh_no_scene_paused_returns_static_sentinel(tmp_path):
    wait = lcd_bridge.frame_refresh_ms(unified_state(isPlaying=False), None,
                                       media_root=str(tmp_path), now_ms=NOW)
    assert_interval(wait)
    assert wait == lcd_bridge.REFRESH_STATIC_MS


def test_refresh_while_playing_is_bounded(tmp_path):
    wait = lcd_bridge.frame_refresh_ms(unified_state(), color_scene(),
                                       media_root=str(tmp_path), now_ms=NOW)
    assert_interval(wait)
    assert wait == lcd_bridge.REFRESH_PLAYING_MS
    assert wait <= 250, "the m:ss clock must re-render several times per second"


def test_refresh_static_playing_dirties_at_clock_rate_not_sentinel(tmp_path):
    # The binding failure mode: static scene + playing must NOT return the
    # large sentinel (that freezes the progress clock at the next second).
    scene = color_scene("#123456", overlays=[text_overlay()])
    wait = lcd_bridge.frame_refresh_ms(unified_state(), scene,
                                       media_root=str(tmp_path), now_ms=NOW)
    assert wait < lcd_bridge.REFRESH_STATIC_MS
    assert_interval(wait)


def test_refresh_gif_returns_frame_delay(tmp_path):
    frames = [Image.new("RGB", (10, 10), c)
              for c in ((255, 0, 0), (0, 255, 0))]
    name = save_gif(frames, tmp_path, "anim.gif", duration=[40, 80])
    scene = gif_bg(name)
    root = str(tmp_path)
    paused = unified_state(isPlaying=False)
    assert lcd_bridge.frame_refresh_ms(paused, scene, media_root=root,
                                       now_ms=NOW, frame_index=0) == 40
    assert lcd_bridge.frame_refresh_ms(paused, scene, media_root=root,
                                       now_ms=NOW, frame_index=1) == 80
    # Playing combines by MINIMUM: gif delay 40 < playing bound.
    assert lcd_bridge.frame_refresh_ms(unified_state(), scene,
                                       media_root=root, now_ms=NOW,
                                       frame_index=0) == 40


def test_refresh_slow_gif_playing_takes_playing_bound(tmp_path):
    frames = [Image.new("RGB", (10, 10), (1, 2, 3)),
              Image.new("RGB", (10, 10), (4, 5, 6))]
    name = save_gif(frames, tmp_path, "slow.gif", duration=[900, 900])
    wait = lcd_bridge.frame_refresh_ms(unified_state(), gif_bg(name),
                                       media_root=str(tmp_path), now_ms=NOW,
                                       frame_index=0)
    assert wait == lcd_bridge.REFRESH_PLAYING_MS


def test_refresh_gpu_temp_returns_sensor_interval(tmp_path):
    scene = dict(color_scene(), overlays=[GPU_TEMP])
    wait = lcd_bridge.frame_refresh_ms(unified_state(isPlaying=False), scene,
                                       media_root=str(tmp_path), now_ms=NOW)
    assert_interval(wait)
    assert wait == lcd_bridge.REFRESH_SENSOR_MS == 1000


def test_refresh_all_branches_return_finite_positive_ints(tmp_path):
    frames = [Image.new("RGB", (10, 10), (9, 9, 9))]
    gif_name = save_gif(frames, tmp_path, "one.gif", duration=[33])
    video = {"version": 1,
             "background": {"kind": "video", "source": "clip.mp4",
                            "rotation": 0, "flipH": False, "scale": 1,
                            "panX": 0, "panY": 0, "fit": "fit"},
             "overlays": []}
    cases = [
        (unified_state(isPlaying=False), None),
        (unified_state(), None),
        (unified_state(isPlaying=False), blank_scene()),
        (unified_state(), color_scene()),
        (unified_state(isPlaying=False), color_scene()),
        (unified_state(), gif_bg(gif_name)),
        (unified_state(isPlaying=False), gif_bg(gif_name)),
        (unified_state(isPlaying=False), dict(color_scene(),
                                               overlays=[GPU_TEMP])),
        (unified_state(isPlaying=False), video),
        (unified_state(), video),
    ]
    for state, scene in cases:
        wait = lcd_bridge.frame_refresh_ms(state, scene,
                                           media_root=str(tmp_path),
                                           now_ms=NOW, frame_index=0)
        assert_interval(wait)


# --------------------------------------------------------------------------
# Fail-safe: an invalid/unusable stored scene never blanks the panel
# --------------------------------------------------------------------------

@pytest.mark.parametrize("bad_scene", [
    {"version": 2, "background": {"kind": "none"}, "overlays": []},
    {"background": {"kind": "none"}, "overlays": []},
    "not-a-dict",
    42,
    None,
    {"version": 1, "background": {"kind": "telepathy"}, "overlays": []},
])
def test_invalid_stored_scene_falls_back_to_lyrics_view(bad_scene):
    # Whatever is stored under settings.scene, the composed path must hand
    # back exactly today's lyrics frame: no exception, no black screen.
    state = with_scene(unified_state(), bad_scene)
    out = lcd_bridge.render_portrait(state, GLASS, NOW)
    assert same_pixels(out, lcd_bridge.render_unified(state, GLASS, NOW))


def test_missing_media_falls_back_to_lyrics_view():
    # Valid scene shape, unreadable media: SceneRenderError must not escape
    # the live producer -- the lyrics view renders instead. "absent.png" is
    # not in the repo's media/ root, so the read fails closed (media_missing)
    # without touching anything but a stat().
    state = with_scene(unified_state(), image_bg("absent.png"))
    out = lcd_bridge.render_portrait(state, GLASS, NOW)
    assert same_pixels(out, lcd_bridge.render_unified(state, GLASS, NOW))


def test_unsupported_video_and_gpu_temp_fall_back_to_lyrics_view():
    # Valid-but-unimplemented kinds (S3/S2) must degrade to lyrics view
    # today, never to SceneRenderError on the live path.
    video = {"version": 1,
             "background": {"kind": "video", "source": "clip.mp4",
                            "rotation": 0, "flipH": False, "scale": 1,
                            "panX": 0, "panY": 0, "fit": "fit"},
             "overlays": []}
    gpu = dict(color_scene(), overlays=[GPU_TEMP])
    for scene in (video, gpu):
        state = with_scene(unified_state(), scene)
        out = lcd_bridge.render_portrait(state, GLASS, NOW)
        assert same_pixels(out, lcd_bridge.render_unified(state, GLASS, NOW)), \
            scene["background"]["kind"]


def test_no_traceback_escapes_render_portrait(capsys):
    state = with_scene(unified_state(), "garbage")
    lcd_bridge.render_portrait(state, GLASS, NOW)
    captured = capsys.readouterr()
    assert "Traceback" not in captured.out
    assert "Traceback" not in captured.err


# --------------------------------------------------------------------------
# Media containment still REFUSED through the composed path (new caller)
# --------------------------------------------------------------------------

ESCAPES = [
    r"C:\Windows\win.ini",
    "/etc/passwd",
    r"\\server\share\x.png",
    "file:///C:/x.png",
    "C:",
]


@pytest.mark.parametrize("source", ESCAPES)
def test_composed_path_refuses_media_escapes(source, tmp_path):
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        lcd_bridge.render_frame(unified_state(), image_bg(source),
                                media_root=str(tmp_path), glass=GLASS,
                                now_ms=NOW)
    assert exc.value.reason == "media_refused"
    assert not isinstance(exc.value, OSError)


def test_composed_path_refuses_nul_source(tmp_path):
    # NUL never reaches the resolver: validate_scene rejects it first, so
    # the refusal family here is ProtocolError (invalid), not media_refused.
    with pytest.raises(ProtocolError):
        lcd_bridge.render_frame(unified_state(), image_bg("ok\x00.png"),
                                media_root=str(tmp_path), glass=GLASS,
                                now_ms=NOW)


def test_composed_path_refuses_junction_escape(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    Image.new("RGB", (10, 10), (255, 0, 0)).save(
        outside_dir / "outside.png", format="PNG")
    source = None
    problems = []
    link = root / "link.png"
    try:
        os.symlink(str(outside_dir / "outside.png"), str(link))
        source = "link.png"
    except OSError as exc:
        problems.append(f"os.symlink: {exc}")
        junction = root / "lnk"
        try:
            proc = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(junction), str(outside_dir)],
                capture_output=True, text=True, timeout=30,
            )
            if proc.returncode == 0:
                source = "lnk/outside.png"
            else:
                problems.append(f"mklink /J rc={proc.returncode}")
        except OSError as exc2:
            problems.append(f"mklink /J: {exc2}")
    if source is None:
        pytest.skip("symlink escape could not be set up: " + " | ".join(problems))
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        lcd_bridge.render_frame(unified_state(), image_bg(source),
                                media_root=str(root), glass=GLASS, now_ms=NOW)
    assert exc.value.reason == "media_refused"


def test_live_path_with_escape_scene_falls_back_to_lyrics_view(tmp_path, monkeypatch):
    # render_portrait pins MEDIA_ROOT; point it at a temp root so the probe
    # is hermetic, then confirm the escape degrades to the lyrics view.
    monkeypatch.setattr(lcd_bridge, "MEDIA_ROOT", str(tmp_path))
    state = with_scene(unified_state(), image_bg(r"C:\Windows\win.ini"))
    out = lcd_bridge.render_portrait(state, GLASS, NOW)
    assert same_pixels(out, lcd_bridge.render_unified(state, GLASS, NOW))
