"""Preview rendering over the JSONL pipe (S1-T6). pytest-collectable.

Run from the repo root:
    .venv/Scripts/python.exe -m pytest tests/test_preview_render.py -v

Hardware-free: no USB, no network, no shell. Since S1-T6 a valid
preview_request is answered from route_stdin_line with a real base64 PNG
rendered by the SAME render_scene() the panel will use (S1-T7), at the
reduced-resolution cap -- WYSIWYG with the full 480x854 render because
every scene coordinate is a normalized 0-1 fraction of the canvas.

Media containment is exercised against real temp directories created by
the test (system temp, never the repo); MEDIA_ROOT is monkeypatched
per-test, the same in-process way a future trusted caller would set it.
"""

import base64
import io
import json
import os
import random
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from PIL import Image, ImageChops, ImageDraw, ImageStat  # noqa: E402

from bridge import lcd_bridge  # noqa: E402
from bridge.protocol import (  # noqa: E402
    PREVIEW_MAX_BASE64_CHARS,
    PREVIEW_MAX_HEIGHT,
    PREVIEW_MAX_WIDTH,
    PROTOCOL_VERSION,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLASS = (480, 854)
PREVIEW_SIZE = (PREVIEW_MAX_WIDTH, PREVIEW_MAX_HEIGHT)  # (240, 427), exact half

# WYSIWYG tolerance, MEASURED (not guessed) on the pinned Pillow 12.3.0:
# the scene below rendered at 480x854, LANCZOS-downscaled to 240x427 and
# compared per-channel against the 240x427 preview render gives mean
# absolute errors of [1.05, 1.34, 1.49] (overall 1.29 on a 0-255 scale).
# 3.0 keeps ~2x headroom for glyph rasterization and resampling variance
# while still failing any real regression: a mis-scaled or mis-positioned
# render lands in the tens, not in the low single digits.
CHANNEL_MAE_TOLERANCE = 3.0

MEDIA = {"rotation": 0, "flipH": False, "scale": 1, "panX": 0, "panY": 0, "fit": "fit"}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def scene(background=None, overlays=None):
    return {"version": 1, "background": background or {"kind": "none"},
            "overlays": overlays or []}


def color_scene(color="#102030", overlays=None):
    return scene({"kind": "color", "color": color}, overlays)


def image_bg(source, **overrides):
    background = {"kind": "image", "source": source, **MEDIA}
    background.update(overrides)
    return background


def text_overlay(**overrides):
    overlay = {"kind": "text", "text": "hi", "x": 0.5, "y": 0.5, "size": 0.1,
               "rotation": 0, "color": "#ffffff"}
    overlay.update(overrides)
    return overlay


def request(scn=None, **overrides):
    envelope = {
        "v": PROTOCOL_VERSION,
        "cmd": "preview_request",
        "reqId": 7,
        "maxWidth": PREVIEW_MAX_WIDTH,
        "maxHeight": PREVIEW_MAX_HEIGHT,
        "scene": scn if scn is not None else color_scene(),
    }
    envelope.update(overrides)
    return envelope


def route(envelope):
    routed = lcd_bridge.route_stdin_line(json.dumps(envelope))
    assert routed is not None and routed[0] == "reply", routed
    return routed[1]


def error_of(response):
    assert "error" in response, response
    assert "image" not in response, response
    return response["error"]


def decode_png(response):
    """Assert the response carries a base64 payload that opens as a PNG of
    the declared size; return the opened image."""
    assert "error" not in response, response
    assert response["mediaType"] == "image/png", response
    raw = base64.b64decode(response["image"])
    assert raw.startswith(b"\x89PNG\r\n\x1a\n"), raw[:16]
    img = Image.open(io.BytesIO(raw))
    img.load()
    assert img.format == "PNG", img.format
    assert img.size == (response["width"], response["height"]), img.size
    return img


def png_data_url(img):
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def gif_data_url(frames, duration):
    buffer = io.BytesIO()
    frames[0].save(buffer, format="GIF", save_all=True, append_images=frames[1:],
                   duration=duration)
    return "data:image/gif;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def solid_frames(*colors, size=(64, 64)):
    return [Image.new("RGB", size, color) for color in colors]


def on_black(img):
    """Composite an RGBA render over black -- the comparison space, since
    the glass shows RGB and both renders share the same alpha."""
    img = img.convert("RGBA")
    return Image.alpha_composite(Image.new("RGBA", img.size, (0, 0, 0, 255)), img).convert("RGB")


# --------------------------------------------------------------------------
# Happy path: real PNG at the reduced-resolution cap
# --------------------------------------------------------------------------

def test_valid_request_returns_openable_png_at_half_glass() -> None:
    response = route(request(color_scene(overlays=[text_overlay()])))
    assert response["v"] == PROTOCOL_VERSION, response
    assert response["cmd"] == "preview_response", response
    assert response["reqId"] == 7, response
    # Exact half of the 480x854 glass: aspect-preserving by construction.
    assert response["width"] == PREVIEW_MAX_WIDTH == 240, response
    assert response["height"] == PREVIEW_MAX_HEIGHT == 427, response
    img = decode_png(response)
    # WYSIWYG spot check: the color background lands on known pixels.
    assert img.getpixel((10, 10))[:3] == (16, 32, 48), img.getpixel((10, 10))


def test_preview_size_preserves_glass_aspect_inside_the_hint_box() -> None:
    # Full hint -> exact half glass. Narrow width hint -> height follows
    # the 480:854 aspect instead of consuming the whole hint box.
    assert lcd_bridge.preview_size(240, 427) == (240, 427)
    width, height = lcd_bridge.preview_size(100, 427)
    assert (width, height) == (100, 178), (width, height)
    assert abs(width / height - GLASS[0] / GLASS[1]) < 0.01, (width, height)
    # Height-constrained hint, and both dims never exceed the caps.
    width, height = lcd_bridge.preview_size(240, 100)
    assert height == 100 and width <= 240, (width, height)
    assert abs(width / height - GLASS[0] / GLASS[1]) < 0.01, (width, height)


def test_media_root_is_anchored_to_the_sidecar_and_fails_closed() -> None:
    # Provenance pin: MEDIA_ROOT is derived from the sidecar's own file
    # location (mirror of bridge-spawn repoRoot/bridgeScript) -- never from
    # stdin, argv or the request envelope, so no wire message can move it.
    expected = os.path.join(REPO_ROOT, "media")
    assert os.path.realpath(lcd_bridge.MEDIA_ROOT) == os.path.realpath(expected)
    # Fail closed under the default root: a key nobody staged is a typed
    # media_missing, never an open read.
    response = route(request(scene(image_bg("definitely-not-staged-xyz.png"))))
    assert error_of(response)["reason"] == "media_missing", response


# --------------------------------------------------------------------------
# WYSIWYG proof: the preview represents the full-size render
# --------------------------------------------------------------------------

def _wysiwyg_scene():
    """Structured, resampling-sensitive scene: gradient + shapes image with
    rotation/scale/pan plus upright and rotated text overlays."""
    src = Image.new("RGB", (320, 320))
    pixels = src.load()
    for y in range(320):
        for x in range(320):
            pixels[x, y] = (int(40 + 180 * x / 319), int(30 + 120 * y / 319), 160)
    draw = ImageDraw.Draw(src)
    draw.ellipse([60, 40, 260, 240], fill=(240, 90, 40))
    draw.rectangle([0, 250, 320, 275], fill=(20, 220, 120))
    return scene(
        image_bg(png_data_url(src), rotation=10, scale=1.1, panX=0.05,
                 panY=-0.03, fit="fill"),
        [
            text_overlay(text="LyricVision", x=0.5, y=0.3, size=0.08),
            text_overlay(text="scene editor", x=0.4, y=0.7, size=0.05,
                         rotation=12, color="#ff8800"),
        ],
    )


def test_preview_is_wysiwyg_against_downscaled_full_render() -> None:
    """The preview is what the user drags against: it must represent the
    full-size render, not merely be an image.

    Metric: mean absolute error per RGB channel (0-255 scale) between the
    preview render at 240x427 and the SAME scene rendered at 480x854 and
    LANCZOS-downscaled to 240x427, both composited over black.

    Exact equality is NOT achievable: render_scene rasterizes text with
    font_px = round(size * canvas_height) (85px vs 43px here), so glyphs
    are independently hinted and antialiased on two different pixel grids;
    the background is resampled once to each canvas size while the
    reference path is resampled twice (source -> 480x854 -> 240x427); and
    bicubic rotation at two scales samples different source points. The
    measured error (channel means [1.05, 1.34, 1.49], overall 1.29) is the
    resampling/rasterization noise floor, documented inline above.
    """
    scn = _wysiwyg_scene()
    response = route(request(scn))
    preview = on_black(decode_png(response))

    full = lcd_bridge.render_scene(scn, media_root=lcd_bridge.MEDIA_ROOT, size=GLASS)
    reference = on_black(full.resize(PREVIEW_SIZE, Image.LANCZOS))
    assert reference.size == preview.size == PREVIEW_SIZE

    means = ImageStat.Stat(ImageChops.difference(preview, reference)).mean
    assert all(mean <= CHANNEL_MAE_TOLERANCE for mean in means), means


# --------------------------------------------------------------------------
# Every renderable background kind produces a preview; video stays typed
# --------------------------------------------------------------------------

def test_none_background_preview_is_openable_png() -> None:
    decode_png(route(request(scene({"kind": "none"}, [text_overlay()]))))


def test_color_background_preview_is_openable_png() -> None:
    decode_png(route(request(color_scene())))


def test_image_background_from_media_root_produces_preview(monkeypatch, tmp_path) -> None:
    Image.new("RGB", (100, 100), (255, 0, 0)).save(
        os.path.join(str(tmp_path), "solid.png"), format="PNG"
    )
    monkeypatch.setattr(lcd_bridge, "MEDIA_ROOT", str(tmp_path))
    img = decode_png(route(request(scene(image_bg("solid.png", fit="fill")))))
    pixel = img.getpixel((10, 10))
    assert all(abs(pixel[i] - (255, 0, 0)[i]) <= 3 for i in range(3)), pixel


def test_gif_background_preview_uses_documented_default_frame_zero() -> None:
    # The envelope has no frame selector (PREVIEW_REQUEST_KEYS), so the
    # documented default is frame_index=0: render_scene's own default, the
    # first GIF frame -- a deterministic still. Equality against a direct
    # render_scene call proves the preview goes through the SAME code path
    # with that selector.
    frames = solid_frames((255, 0, 0), (0, 255, 0), (0, 0, 255))
    scn = scene({"kind": "gif", "source": gif_data_url(frames, [40, 80, 120]),
                 **MEDIA, "fit": "fill"})
    response = route(request(scn))
    img = decode_png(response)
    pixel = img.getpixel((10, 10))
    assert all(abs(pixel[i] - (255, 0, 0)[i]) <= 3 for i in range(3)), \
        "frame 0 (red) must be the default"

    expected = lcd_bridge.render_scene(
        scn, media_root=lcd_bridge.MEDIA_ROOT, size=PREVIEW_SIZE, frame_index=0
    )
    buffer = io.BytesIO()
    expected.save(buffer, format="PNG")
    assert response["image"] == base64.b64encode(buffer.getvalue()).decode("ascii")


def test_video_background_is_typed_unsupported() -> None:
    error = error_of(route(request(scene(image_bg("x.mp4", kind="video")))))
    assert error["reason"] == "unsupported_background", error
    assert error["field"] == "background.kind", error


# --------------------------------------------------------------------------
# Security-critical: containment refusals in the NEW preview call path
# --------------------------------------------------------------------------

def test_absolute_and_scheme_escapes_are_refused(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(lcd_bridge, "MEDIA_ROOT", str(tmp_path))
    escapes = [
        r"C:\Windows\win.ini",       # absolute Windows path
        r"\\server\share\x.png",     # UNC path
        "/etc/passwd",               # absolute POSIX path
        "file:///C:/x.png",          # file:// URL
        "C:",                        # drive-relative
    ]
    for source in escapes:
        error = error_of(route(request(scene(image_bg(source)))))
        assert error["reason"] == "media_refused", (source, error)
        assert error["field"] == "background.source", (source, error)


def test_nul_source_is_refused_by_validation_before_any_filesystem_touch() -> None:
    # NUL cannot survive validate_scene (_is_source), so the preview path
    # stops it one gate EARLIER than the resolver -- still a typed refusal,
    # never a read: "a" + NUL + "b" built via fromCharCode-equivalent concat.
    source = "a" + "\x00" + "b"
    error = error_of(route(request(scene(image_bg(source)))))
    assert error["reason"] == "invalid_request", error
    assert error["field"] == "background.source", error


def test_symlink_escape_is_refused_in_preview_path(monkeypatch, tmp_path) -> None:
    root = tmp_path / "media"
    root.mkdir()
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    Image.new("RGB", (10, 10), (0, 255, 0)).save(
        os.path.join(str(outside_dir), "outside.png"), format="PNG"
    )
    monkeypatch.setattr(lcd_bridge, "MEDIA_ROOT", str(root))
    problems = []
    source = None
    link = root / "link.png"
    try:
        os.symlink(str(outside_dir / "outside.png"), str(link))
        source = "link.png"
    except OSError as exc:
        # Same fallback chain as tests/test_scene_render.py: file symlinks
        # need a privilege this platform may withhold; a junction does not.
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
                problems.append(f"mklink /J rc={proc.returncode}: {proc.stderr.strip()}")
        except OSError as exc2:
            problems.append(f"mklink /J: {exc2}")
    if source is None:
        pytest.skip("symlink escape could not be set up: " + " | ".join(problems))
    error = error_of(route(request(scene(image_bg(source)))))
    assert error["reason"] == "media_refused", error


# --------------------------------------------------------------------------
# Payload cap: the shared JSONL pipe is never flooded
# --------------------------------------------------------------------------

def _incompressible_noise_source() -> str:
    random.seed(0)  # deterministic: the size relationship below must hold
    noise = Image.frombytes(
        "RGBA", PREVIEW_SIZE,
        bytes(random.randrange(256) for _ in range(PREVIEW_SIZE[0] * PREVIEW_SIZE[1] * 4)),
    )
    return png_data_url(noise)


def test_payload_cap_constant_is_pinned_and_realistic_previews_fit() -> None:
    # 512 KiB of base64. Measured on the pinned Pillow: color+text = 4.3 KB,
    # structured image scene = 44.7 KB -- an order of magnitude of headroom.
    assert PREVIEW_MAX_BASE64_CHARS == 512 * 1024, PREVIEW_MAX_BASE64_CHARS
    assert lcd_bridge.PREVIEW_MAX_BASE64_CHARS == PREVIEW_MAX_BASE64_CHARS
    response = route(request(_wysiwyg_scene()))
    assert len(response["image"]) < PREVIEW_MAX_BASE64_CHARS, len(response["image"])


def test_over_cap_payload_is_typed_error_not_a_flood() -> None:
    # Incompressible noise is the pathological worst case: 240x427 RGBA
    # PNG -> 547,488 base64 chars, over the 524,288 cap. The reply must be
    # a SMALL typed error envelope, never the blob itself.
    source = _incompressible_noise_source()
    assert len(source) > PREVIEW_MAX_BASE64_CHARS, len(source)
    response = route(request(scene(image_bg(source, fit="fill"))))
    error = error_of(response)
    assert error["reason"] == "payload_too_large", error
    # No flood: the answer line itself stays tiny.
    assert len(json.dumps(response)) < 4096, len(json.dumps(response))


# --------------------------------------------------------------------------
# Determinism, correlation and independence
# --------------------------------------------------------------------------

def test_same_scene_same_frame_selector_yields_identical_base64() -> None:
    frames = solid_frames((255, 0, 0), (0, 255, 0), (0, 0, 255))
    scn = scene({"kind": "gif", "source": gif_data_url(frames, [40, 80, 120]), **MEDIA},
                [text_overlay(text="Determinism")])
    envelope = request(scn, reqId=11)
    first = route(envelope)
    second = route(envelope)
    assert "error" not in first and "error" not in second, (first, second)
    assert first["image"] == second["image"]


def test_valid_invalid_valid_requests_are_each_answered_independently() -> None:
    # No deadlock, no cross-talk: every request is answered from its own
    # payload with its own correlation id, in order, whatever came before.
    first = route(request(color_scene(), reqId=1))
    invalid = color_scene(overlays=[text_overlay(x=9)])
    second = route(request(invalid, reqId=2))
    third = route(request(color_scene(), reqId=3))

    assert "error" not in first and first["reqId"] == 1, first
    assert error_of(second)["reason"] == "invalid_request", second
    assert second["reqId"] == 2 and second["error"]["field"] == "overlays[0].x", second
    assert "error" not in third and third["reqId"] == 3, third


def test_preview_unavailable_is_only_the_missing_pillow_fallback(monkeypatch) -> None:
    # Decision record: preview_unavailable left the happy path in S1-T6 and
    # remains ONLY for the genuinely unrenderable condition -- Pillow (the
    # renderer binary) absent. Everything else has a specific reason.
    monkeypatch.setattr(lcd_bridge, "Image", None)
    error = error_of(route(request(color_scene())))
    assert error["reason"] == "preview_unavailable", error
    assert "Pillow" in error["message"], error
