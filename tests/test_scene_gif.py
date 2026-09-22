"""Animated GIF backgrounds: frames, delays, disposal, bounds (S1-T5). pytest-collectable.

Run from the repo root:
    .venv/Scripts/python.exe -m pytest tests/test_scene_gif.py -v

Hardware-free: no USB, no network. render_scene is additive and is NOT
wired into the live frame loop (that swap is S1-T7, hardware-gated), so
every test calls it directly with an explicit frame_index. Every GIF
fixture is generated with Pillow inside the test (tmp_path = system temp,
never the repo) -- no binary GIF is ever committed.
"""

import base64
import io
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from PIL import Image, ImageSequence  # noqa: E402

from bridge import lcd_bridge  # noqa: E402

GLASS = (480, 854)
RED = (255, 0, 0)
GREEN = (0, 255, 0)
BLUE = (0, 0, 255)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def save_gif(frames, root, name, **kwargs):
    """Write an animated GIF fixture with Pillow. Generated, never committed."""
    path = os.path.join(str(root), name)
    if len(frames) == 1:
        frames[0].save(path, format="GIF")
    else:
        frames[0].save(
            path, format="GIF", save_all=True, append_images=frames[1:], **kwargs
        )
    return name


def gif_bg(source, **overrides):
    bg = {"kind": "gif", "source": source, "rotation": 0, "flipH": False,
          "scale": 1, "panX": 0, "panY": 0, "fit": "fit"}
    bg.update(overrides)
    return {"version": 1, "background": bg, "overlays": []}


def render(scene, media_root, frame_index=0, size=None):
    kwargs = {"media_root": str(media_root), "frame_index": frame_index}
    if size is not None:
        kwargs["size"] = size
    return lcd_bridge.render_scene(scene, **kwargs)


def rgb(img, xy):
    return img.getpixel(xy)[:3]


def close(px, expected, tol=3):
    return all(abs(px[i] - expected[i]) <= tol for i in range(3))


def solid_frames(*colors, size=(100, 100)):
    return [Image.new("RGB", size, color) for color in colors]


# --------------------------------------------------------------------------
# Frame selection: one selector value -> one frame, asserted on pixels
# --------------------------------------------------------------------------

def test_three_frames_select_distinct_pixels_with_distinct_delays(tmp_path):
    name = save_gif(solid_frames(RED, GREEN, BLUE), tmp_path, "three.gif",
                    duration=[40, 80, 120])
    scene = gif_bg(name, fit="fill")
    seen = []
    for index, color in ((0, RED), (1, GREEN), (2, BLUE)):
        img = render(scene, tmp_path, frame_index=index)
        assert img.size == GLASS
        px = rgb(img, (240, 427))
        assert close(px, color), f"frame {index}: {px} !~ {color}"
        seen.append(px)
    # The three selectors must return three DIFFERENT frames, not one frame
    # three times: every sampled pixel must differ from the others.
    assert seen[0] != seen[1] and seen[1] != seen[2] and seen[0] != seen[2]
    # Fixture sanity: Pillow must report the three distinct per-frame delays
    # (milliseconds). This pins what the refresh policy later reads.
    with Image.open(os.path.join(str(tmp_path), name)) as im:
        durations = [f.info.get("duration") for f in ImageSequence.Iterator(im)]
    assert durations == [40, 80, 120]


def test_selector_past_last_frame_wraps(tmp_path):
    name = save_gif(solid_frames(RED, GREEN, BLUE), tmp_path, "wrap.gif",
                    duration=[40, 80, 120])
    scene = gif_bg(name, fit="fill")
    f0 = render(scene, tmp_path, frame_index=0)
    f1 = render(scene, tmp_path, frame_index=1)
    f2 = render(scene, tmp_path, frame_index=2)
    # 3 % 3 == 0: wrapping, not clamping (clamping would give frame 2's blue).
    assert render(scene, tmp_path, frame_index=3).tobytes() == f0.tobytes()
    assert render(scene, tmp_path, frame_index=4).tobytes() == f1.tobytes()
    # 10**9 % 3 == 1 -> frame 1. A clamp would land on frame 2 (blue), so
    # this discriminates wrap from clamp AND proves the huge index does not
    # iterate a billion times (the walk stops at the wrapped target).
    assert render(scene, tmp_path, frame_index=10**9).tobytes() == f1.tobytes()
    assert close(rgb(f2, (240, 427)), BLUE)


def test_negative_or_non_int_frame_index_is_rejected(tmp_path):
    name = save_gif(solid_frames(RED), tmp_path, "single.gif")
    scene = gif_bg(name)
    for bad in (-1, 1.5, True, "0"):
        with pytest.raises(ValueError):
            render(scene, tmp_path, frame_index=bad)


# --------------------------------------------------------------------------
# Partial frames + disposal: proven, not assumed
# --------------------------------------------------------------------------

def test_partial_frames_compose_with_disposal(tmp_path):
    # Classic GIF optimization: frame 0 is the full canvas, later frames are
    # stored as PARTIAL rectangles with disposal=1 (leave in place). A naive
    # renderer that pastes only the stored tile would show holes.
    base = Image.new("RGB", (100, 100), (0, 0, 0))
    f1 = base.copy()
    f1.paste(RED, (0, 0, 50, 50))
    f2 = f1.copy()
    f2.paste(GREEN, (50, 50, 100, 100))
    name = save_gif([base, f1, f2], tmp_path, "partial.gif",
                    duration=[40, 80, 120], disposal=[1, 1, 1])
    # Pin what the file ACTUALLY stores (Pillow 12.3.0, pinned in
    # bridge/requirements.txt): frame 1's stored tile is the 50x50 delta,
    # not the full canvas. This is the premise the composition test needs.
    with Image.open(os.path.join(str(tmp_path), name)) as im:
        im.seek(0)
        im.load()
        im.seek(1)
        assert im.tile, "frame 1 must have a stored tile"
        assert im.tile[0].extents == (0, 0, 50, 50), im.tile[0].extents
        im.seek(2)
        assert im.tile[0].extents == (50, 50, 100, 100), im.tile[0].extents
    # size=(100,100) + fit=fit on a 100x100 source is an identity transform,
    # so source pixels map 1:1 onto canvas pixels: exact assertions.
    scene = gif_bg(name, fit="fit")
    frame2 = render(scene, tmp_path, frame_index=2, size=(100, 100))
    # Composed output of frame 2 must contain ALL three frames' contributions:
    assert close(rgb(frame2, (10, 10)), RED), "red from partial frame 1"
    assert close(rgb(frame2, (75, 75)), GREEN), "green from partial frame 2"
    assert rgb(frame2, (75, 10)) == (0, 0, 0), "untouched base from frame 0"
    # Frame 0 in isolation is the plain base.
    frame0 = render(scene, tmp_path, frame_index=0, size=(100, 100))
    assert rgb(frame0, (10, 10)) == (0, 0, 0)
    assert rgb(frame0, (75, 75)) == (0, 0, 0)


# --------------------------------------------------------------------------
# Delay defaults: 0 / missing never yields a 0 ms interval
# --------------------------------------------------------------------------

def test_zero_and_missing_duration_never_yield_zero_ms(tmp_path):
    two = solid_frames(RED, GREEN, size=(10, 10))
    zero = save_gif(list(two), tmp_path, "zero.gif", duration=[0, 0])
    nodur = save_gif(list(two), tmp_path, "nodur.gif")
    for name in (zero, nodur):
        scene = gif_bg(name, fit="fill")
        for index in (0, 1):
            wait = lcd_bridge.scene_refresh_ms(
                scene, media_root=str(tmp_path), frame_index=index
            )
            # Documented default: absent or 0 -> 100 ms (the usual
            # Pillow/browser convention). Never 0, never negative.
            assert wait == lcd_bridge.GIF_DEFAULT_DELAY_MS == 100
        # Rendering both frames still works (no hang, no crash).
        for index in (0, 1):
            assert render(scene, tmp_path, frame_index=index).size == GLASS


# --------------------------------------------------------------------------
# Determinism
# --------------------------------------------------------------------------

def test_same_scene_and_selector_twice_is_byte_identical(tmp_path):
    name = save_gif(solid_frames(RED, GREEN, BLUE), tmp_path, "det.gif",
                    duration=[40, 80, 120])
    scene = gif_bg(name, fit="fill", rotation=37, flipH=True, scale=1.3,
                   panX=0.1, panY=-0.05)
    first = render(scene, tmp_path, frame_index=2)
    second = render(scene, tmp_path, frame_index=2)
    assert first.tobytes() == second.tobytes()
    buf0, buf1 = io.BytesIO(), io.BytesIO()
    first.save(buf0, format="PNG")
    second.save(buf1, format="PNG")
    assert buf0.getvalue() == buf1.getvalue()


# --------------------------------------------------------------------------
# The full transform set applies to GIF frames, exactly as to image frames
# --------------------------------------------------------------------------

def test_gif_rotation_swaps_known_halves(tmp_path):
    halves = Image.new("RGB", (200, 200), BLUE)
    halves.paste(RED, (0, 0, 200, 100))
    name = save_gif([halves], tmp_path, "halves.gif")
    base = render(gif_bg(name, fit="fill", rotation=0), tmp_path)
    turned = render(gif_bg(name, fit="fill", rotation=90), tmp_path)
    # Same geometry contract as image backgrounds (S1-T4 tests):
    assert close(rgb(base, (50, 400)), RED)
    assert close(rgb(turned, (50, 400)), BLUE)
    assert close(rgb(turned, (430, 400)), RED)


def test_gif_fit_letterboxes_and_fill_covers(tmp_path):
    wide = Image.new("RGB", (200, 100), GREEN)
    name = save_gif([wide], tmp_path, "wide.gif")
    fitted = render(gif_bg(name, fit="fit"), tmp_path)
    covered = render(gif_bg(name, fit="fill"), tmp_path)
    assert fitted.getpixel((240, 50)) == (0, 0, 0, 0), "fit must letterbox"
    assert close(rgb(fitted, (240, 427)), GREEN)
    assert close(rgb(covered, (240, 50)), GREEN), "fill must not letterbox"
    assert close(rgb(covered, (10, 10)), GREEN)


# --------------------------------------------------------------------------
# Media-root containment applies unchanged to GIF sources
# --------------------------------------------------------------------------

def test_gif_sources_outside_media_root_are_refused(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    escapes = [
        r"C:\Windows\win.ini",           # absolute Windows path
        "/etc/passwd",                    # absolute POSIX path
        r"\\server\share\x.gif",          # UNC path
        "file:///C:/x.gif",               # file:// URL
        "C:",                             # drive-relative
    ]
    for source in escapes:
        with pytest.raises(lcd_bridge.SceneRenderError) as exc:
            render(gif_bg(source), root)
        assert exc.value.reason == "media_refused", source
        assert not isinstance(exc.value, OSError), source


def test_gif_data_url_decodes_inline_without_filesystem(tmp_path):
    buf = io.BytesIO()
    frames = solid_frames(RED, GREEN, size=(10, 10))
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:],
                   duration=[40, 80])
    source = "data:image/gif;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    # media_root does not exist: a data: URL must never touch the filesystem.
    img = lcd_bridge.render_scene(
        gif_bg(source, fit="fill"), media_root=str(tmp_path / "does-not-exist"),
        frame_index=1,
    )
    assert close(rgb(img, (240, 427)), GREEN)


def test_missing_gif_key_is_typed_not_oserror(tmp_path):
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        render(gif_bg("nope.gif"), tmp_path)
    assert exc.value.reason == "media_missing"
    assert not isinstance(exc.value, OSError)


# --------------------------------------------------------------------------
# Resource bounds: pathological input -> typed error, never OOM/hang
# --------------------------------------------------------------------------

def test_absurd_frame_count_is_typed(tmp_path):
    frames = [Image.new("RGB", (8, 8), (i % 200, 0, 0))
              for i in range(lcd_bridge.SCENE_MAX_GIF_FRAMES + 1)]
    name = save_gif(frames, tmp_path, "many.gif", duration=100)
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        render(gif_bg(name), tmp_path)
    assert exc.value.reason == "media_too_large"
    assert not isinstance(exc.value, OSError)


def test_absurd_dimensions_are_typed(tmp_path):
    # A real, fully decodable GIF one pixel past the per-side cap: the cap
    # must fire BEFORE any frame is decoded.
    width = lcd_bridge.SCENE_MAX_GIF_DIM + 1
    name = save_gif([Image.new("RGB", (width, 50), RED)], tmp_path, "wide.gif")
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        render(gif_bg(name), tmp_path)
    assert exc.value.reason == "media_too_large"
    assert not isinstance(exc.value, OSError)


def test_decompression_bomb_is_typed(tmp_path):
    # Hand-crafted header: logical screen 65535x65535 = 4,294,836,225 px,
    # far past Pillow's MAX_IMAGE_PIXELS (observed 89,478,485 on the pinned
    # Pillow 12.3.0), so Image.open raises DecompressionBombError. That must
    # surface as our typed size error, never as a raw traceback.
    blob = bytearray(b"GIF89a")
    blob += struct.pack("<HH", 65535, 65535) + b"\x00\x00\x00"
    blob += b"\x2C" + struct.pack("<HHHH", 0, 0, 10, 10) + b"\x00"
    blob += b"\x02\x02\x04\x00" + b"\x00" + b"\x3B"
    (tmp_path / "bomb.gif").write_bytes(bytes(blob))
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        render(gif_bg("bomb.gif"), tmp_path)
    assert exc.value.reason == "media_too_large"
    assert not isinstance(exc.value, OSError)


def test_oversized_gif_payload_is_typed(tmp_path):
    # Byte cap is checked BEFORE open(): bounds the n_frames header scan
    # (every GIF frame costs >= ~25 bytes on disk) and the decode work.
    (tmp_path / "fat.gif").write_bytes(b"\x00" * (lcd_bridge.SCENE_MAX_GIF_BYTES + 1))
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        render(gif_bg("fat.gif"), tmp_path)
    assert exc.value.reason == "media_too_large"
    assert not isinstance(exc.value, OSError)


def test_non_gif_bytes_under_gif_kind_are_typed(tmp_path):
    path = os.path.join(str(tmp_path), "not.gif")
    Image.new("RGB", (10, 10), RED).save(path, format="PNG")
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        render(gif_bg("not.gif"), tmp_path)
    assert exc.value.reason == "media_unreadable"
    assert not isinstance(exc.value, OSError)
