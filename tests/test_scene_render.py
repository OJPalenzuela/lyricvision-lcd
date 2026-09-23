"""Scene renderer: backgrounds, transforms, text overlays (S1-T4). pytest-collectable.

Run from the repo root:
    .venv/Scripts/python.exe -m pytest tests/test_scene_render.py -v

Hardware-free: no USB, no network. render_scene is additive and is NOT
wired into the live frame loop (that swap is S1-T7, hardware-gated), so
every test calls it directly. Media containment is exercised against a
real temp directory created by the test (system temp, never the repo).
"""

import base64
import io
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from PIL import Image  # noqa: E402

from bridge import lcd_bridge  # noqa: E402
from bridge.protocol import ProtocolError  # noqa: E402

FIXTURES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "scene-shapes.json"
)

GLASS = (480, 854)
RED = (255, 0, 0)
BLUE = (0, 0, 255)
GREEN = (0, 255, 0)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def render(scene, media_root):
    return lcd_bridge.render_scene(scene, media_root=str(media_root))


def image_bg(source, **overrides):
    bg = {"kind": "image", "source": source, "rotation": 0, "flipH": False,
          "scale": 1, "panX": 0, "panY": 0, "fit": "fit"}
    bg.update(overrides)
    return {"version": 1, "background": bg, "overlays": []}


def scene_of(background, overlays=None):
    return {"version": 1, "background": background, "overlays": overlays or []}


def text_overlay(**overrides):
    overlay = {"kind": "text", "text": "Hi", "x": 0.5, "y": 0.5,
               "size": 0.1, "rotation": 0, "color": "#ff0000"}
    overlay.update(overrides)
    return overlay


def save_png(img, root, name):
    path = os.path.join(str(root), name)
    img.save(path, format="PNG")
    return name


def halves_image():
    """200x200: top half red, bottom half blue (rotation probe)."""
    img = Image.new("RGB", (200, 200), BLUE)
    img.paste(RED, (0, 0, 200, 100))
    return img


def sides_image():
    """200x200: left half red, right half blue (flip probe)."""
    img = Image.new("RGB", (200, 200), BLUE)
    img.paste(RED, (0, 0, 100, 200))
    return img


def close(px, rgb, tol=3):
    """Resampling keeps solid regions exact in theory; fp rounding earns a
    small tolerance so the assertion tests geometry, not LANCZOS rounding."""
    return all(abs(px[i] - rgb[i]) <= tol for i in range(3))


def ink_center(img):
    """Center of the non-transparent ink. Alpha-band only: the canvas is
    background-less in these tests, so alpha > 0 == drawn pixel."""
    bbox = img.getchannel("A").getbbox()
    assert bbox is not None, "expected drawn ink"
    return ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)


# --------------------------------------------------------------------------
# Backgrounds: none / color
# --------------------------------------------------------------------------

def test_background_none_is_transparent(tmp_path):
    img = render(scene_of({"kind": "none"}), tmp_path)
    assert img.size == GLASS
    assert img.getpixel((0, 0)) == (0, 0, 0, 0)
    assert img.getpixel((240, 427)) == (0, 0, 0, 0)
    assert img.getpixel((479, 853)) == (0, 0, 0, 0)
    # The size parameter honors fraction math for the future preview scale.
    small = lcd_bridge.render_scene(
        scene_of({"kind": "none"}), media_root=str(tmp_path), size=(240, 427)
    )
    assert small.size == (240, 427)


def test_background_color_fills_known_pixels(tmp_path):
    img = render(scene_of({"kind": "color", "color": "#102030"}), tmp_path)
    for coord in ((0, 0), (240, 427), (479, 853)):
        assert img.getpixel(coord) == (16, 32, 48, 255), coord
    # Mixed case stays a legal hex color (corpus: color-mixed-case).
    mixed = render(scene_of({"kind": "color", "color": "#AbCdEf"}), tmp_path)
    assert mixed.getpixel((240, 427)) == (171, 205, 239, 255)


# --------------------------------------------------------------------------
# Background image: fit / fill, rotation, flip, scale, pan
# --------------------------------------------------------------------------

def test_image_fit_letterboxes_and_fill_covers(tmp_path):
    save_png(Image.new("RGB", (200, 100), GREEN), tmp_path, "letter.png")
    fitted = render(image_bg("letter.png", fit="fit"), tmp_path)
    # fit: 200x100 -> 480x240 centered -> transparent bars top/bottom.
    assert fitted.getpixel((240, 427))[:3] == GREEN
    assert fitted.getpixel((240, 50)) == (0, 0, 0, 0), "fit must letterbox"
    assert fitted.getpixel((10, 10)) == (0, 0, 0, 0)
    covered = render(image_bg("letter.png", fit="fill"), tmp_path)
    # fill: cover-crop -> no bars anywhere.
    assert covered.getpixel((240, 50))[:3] == GREEN, "fill must not letterbox"
    assert covered.getpixel((10, 10))[:3] == GREEN


def test_rotation_90_changes_known_pixels_and_360_is_identity(tmp_path):
    save_png(halves_image(), tmp_path, "halves.png")
    base = render(image_bg("halves.png", fit="fill", rotation=0), tmp_path)
    turned = render(image_bg("halves.png", fit="fill", rotation=90), tmp_path)
    same = render(image_bg("halves.png", fit="fill", rotation=360), tmp_path)
    # Baseline: the top (red) half sits above the seam everywhere.
    assert close(base.getpixel((50, 400)), RED)
    # 90 degrees CLOCKWISE (CSS convention): top edge -> right edge, so the
    # same screen point now samples the bottom (blue) half...
    assert close(turned.getpixel((50, 400)), BLUE)
    # ...and the right side of the screen samples the original top half.
    assert close(turned.getpixel((430, 400)), RED)
    # 360 degrees must return to the original byte for byte.
    assert same.tobytes() == base.tobytes()


def test_flip_h_mirrors(tmp_path):
    save_png(sides_image(), tmp_path, "sides.png")
    plain = render(image_bg("sides.png", fit="fill"), tmp_path)
    flipped = render(image_bg("sides.png", fit="fill", flipH=True), tmp_path)
    assert close(plain.getpixel((50, 400)), RED)
    assert close(plain.getpixel((430, 400)), BLUE)
    assert close(flipped.getpixel((50, 400)), BLUE)
    assert close(flipped.getpixel((430, 400)), RED)


def test_scale_shrinks_coverage(tmp_path):
    save_png(Image.new("RGB", (100, 100), RED), tmp_path, "solid.png")
    full = render(image_bg("solid.png", fit="fit", scale=1), tmp_path)
    half = render(image_bg("solid.png", fit="fit", scale=0.5), tmp_path)
    # scale=1: 480x480 block centered vertically covers y=200.
    assert close(full.getpixel((240, 200)), RED)
    # scale=0.5: 240x240 block -> y=200 falls outside (letterbox).
    assert half.getpixel((240, 200)) == (0, 0, 0, 0)


def test_pan_x_shifts_image_in_canvas_space(tmp_path):
    save_png(Image.new("RGB", (100, 100), RED), tmp_path, "solid.png")
    base = render(image_bg("solid.png", fit="fit"), tmp_path)
    panned = render(image_bg("solid.png", fit="fit", panX=0.25), tmp_path)
    assert close(base.getpixel((60, 400)), RED)
    # +0.25 of canvas width = +120px: x=60 falls off the left edge of the
    # block, x=300 stays inside.
    assert panned.getpixel((60, 400)) == (0, 0, 0, 0)
    assert close(panned.getpixel((300, 400)), RED)


def test_pan_y_shifts_image_in_canvas_space(tmp_path):
    save_png(Image.new("RGB", (100, 100), RED), tmp_path, "solid.png")
    base = render(image_bg("solid.png", fit="fit"), tmp_path)
    panned = render(image_bg("solid.png", fit="fit", panY=0.25), tmp_path)
    assert close(base.getpixel((240, 250)), RED)
    # +0.25 of canvas height = +~214px: the 480px block (y in [187,667))
    # slides down, so y=250 leaves it and y=500 enters it.
    assert panned.getpixel((240, 250)) == (0, 0, 0, 0)
    assert close(panned.getpixel((240, 500)), RED)


# --------------------------------------------------------------------------
# Text overlays
# --------------------------------------------------------------------------

def test_text_lands_centered_and_moves_with_x(tmp_path):
    scene = scene_of({"kind": "none"}, [text_overlay(x=0.5, y=0.5)])
    cx, cy = ink_center(render(scene, tmp_path))
    assert abs(cx - 240) <= 20, cx
    assert abs(cy - 427) <= 20, cy
    moved = scene_of({"kind": "none"}, [text_overlay(x=0.1, y=0.5)])
    mx, my = ink_center(render(moved, tmp_path))
    assert abs(mx - 48) <= 20, mx
    assert abs(my - 427) <= 20, my
    assert mx < cx - 100, "changing x must move the overlay"


def test_text_rotation_reorients_the_ink(tmp_path):
    upright = scene_of(
        {"kind": "none"},
        [text_overlay(text="HELLO", size=0.05, rotation=0, color="#ffffff")],
    )
    turned = scene_of(
        {"kind": "none"},
        [text_overlay(text="HELLO", size=0.05, rotation=90, color="#ffffff")],
    )
    img0 = render(upright, tmp_path)
    img90 = render(turned, tmp_path)
    b0 = img0.getchannel("A").getbbox()
    b90 = img90.getchannel("A").getbbox()
    w0, h0 = b0[2] - b0[0], b0[3] - b0[1]
    w90, h90 = b90[2] - b90[0], b90[3] - b90[1]
    assert w0 > h0, "upright text must be wider than tall"
    assert h90 > w90, "rotated text must be taller than wide"


# --------------------------------------------------------------------------
# Determinism
# --------------------------------------------------------------------------

def test_same_scene_twice_yields_byte_identical_png(tmp_path):
    save_png(Image.new("RGB", (100, 100), RED), tmp_path, "solid.png")
    bg = image_bg("solid.png", fit="fill", rotation=37, flipH=True,
                  scale=1.3, panX=0.1, panY=-0.05)["background"]
    scene = scene_of(
        bg,
        [text_overlay(text="Determinism", rotation=15, x=0.3, y=0.7)],
    )
    first = render(scene, tmp_path)
    second = render(scene, tmp_path)
    assert first.tobytes() == second.tobytes()
    buf0, buf1 = io.BytesIO(), io.BytesIO()
    first.save(buf0, format="PNG")
    second.save(buf1, format="PNG")
    assert buf0.getvalue() == buf1.getvalue()


# --------------------------------------------------------------------------
# Media-root containment
# --------------------------------------------------------------------------

def test_media_inside_root_loads(tmp_path):
    save_png(Image.new("RGB", (100, 100), RED), tmp_path, "inside.png")
    img = render(image_bg("inside.png", fit="fit"), tmp_path)
    assert close(img.getpixel((240, 427)), RED)


def test_sources_outside_media_root_are_refused(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    escapes = [
        r"C:\Windows\win.ini",           # absolute Windows path
        "/etc/passwd",                    # absolute POSIX path
        r"\\server\share\x.png",          # UNC path
        "file:///C:/x.png",               # file:// URL
        "C:",                             # drive-relative
    ]
    for source in escapes:
        with pytest.raises(lcd_bridge.SceneRenderError) as exc:
            render(image_bg(source), root)
        assert exc.value.reason == "media_refused", source
        assert not isinstance(exc.value, OSError), source


def test_symlink_escape_is_refused(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    outside_png = outside_dir / "outside.png"
    Image.new("RGB", (10, 10), RED).save(outside_png, format="PNG")
    problems = []
    source = None
    link = root / "link.png"
    try:
        os.symlink(str(outside_png), str(link))
        source = "link.png"
    except OSError as exc:
        # File symlinks need a privilege this platform may withhold; a
        # directory junction does not. Report exactly what failed either way.
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
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        render(image_bg(source), root)
    assert exc.value.reason == "media_refused"


def test_dotdot_is_refused_even_without_validation(tmp_path):
    # Defense in depth: validate_scene rejects ".." segments, but containment
    # must not depend on it. Call the resolver directly, skipping validation.
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        lcd_bridge._resolve_media_source("../secret.png", str(tmp_path))
    assert exc.value.reason == "media_refused"


def test_nul_is_refused_even_without_validation(tmp_path):
    # Defense in depth, same reasoning as above: validate_scene rejects NUL,
    # but this resolver is documented and tested as a standalone gate. A NUL
    # that slips through yields a path raising ValueError (not OSError) at
    # open() time, which would escape the OSError containment handlers in
    # any future caller that skips the isfile() guard.
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        lcd_bridge._resolve_media_source("ok.png\x00.png", str(tmp_path))
    assert exc.value.reason == "media_refused"
    assert "\x00" not in str(exc.value)


def test_missing_key_is_typed_not_oserror(tmp_path):
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        render(image_bg("nope.png"), tmp_path)
    assert exc.value.reason == "media_missing"
    assert not isinstance(exc.value, OSError)


def test_data_url_decodes_inline_without_filesystem(tmp_path):
    buf = io.BytesIO()
    Image.new("RGB", (100, 100), GREEN).save(buf, format="PNG")
    source = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    # media_root does not exist: a data: URL must never touch the filesystem.
    img = lcd_bridge.render_scene(
        image_bg(source), media_root=str(tmp_path / "does-not-exist")
    )
    assert close(img.getpixel((240, 427)), GREEN)


def test_undecodable_media_is_typed(tmp_path):
    cases = [
        "data:image/png;base64,iVBORw0KGgo=",  # valid b64, truncated PNG
        "data:image/png;base64,***not-b64***",  # invalid b64
        "data:image/png;base64",                 # missing ',' separator
    ]
    for source in cases:
        with pytest.raises(lcd_bridge.SceneRenderError) as exc:
            render(image_bg(source), tmp_path)
        assert exc.value.reason == "media_unreadable", source


# --------------------------------------------------------------------------
# Unsupported vs invalid
# --------------------------------------------------------------------------

# gif is implemented since S1-T5 (see tests/test_scene_gif.py); video stays
# unsupported until S3-T12 and must be checked BEFORE the source is touched.
@pytest.mark.parametrize("kind", ["video"])
def test_unsupported_background_kind_is_typed(kind, tmp_path):
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        render(image_bg("x.png", kind=kind), tmp_path)
    assert exc.value.reason == "unsupported_background"
    assert exc.value.field == "background.kind"


def test_gpu_temp_overlay_is_typed_unsupported(tmp_path):
    scene = scene_of({"kind": "none"}, [
        {"kind": "gpu-temp", "x": 0.5, "y": 0.5, "size": 0.1,
         "rotation": 0, "color": "#ffffff"},
    ])
    with pytest.raises(lcd_bridge.SceneRenderError) as exc:
        render(scene, tmp_path)
    assert exc.value.reason == "unsupported_overlay"
    assert exc.value.field == "overlays[0].kind"


def test_invalid_scene_raises_protocol_error_not_scene_error(tmp_path):
    bad = {"version": 2, "background": {"kind": "none"}, "overlays": []}
    with pytest.raises(ProtocolError) as exc:
        render(bad, tmp_path)
    assert exc.value.reason == "invalid_request"
    assert exc.value.field == "version"
    # The two error families must stay disjoint: "unsupported" and
    # "refused" are SceneRenderError, "invalid" is ProtocolError, and
    # neither may ever be a raw OSError.
    assert not issubclass(lcd_bridge.SceneRenderError, ProtocolError)
    assert not issubclass(lcd_bridge.SceneRenderError, OSError)
    assert not issubclass(lcd_bridge.SceneRenderError, ValueError)


# --------------------------------------------------------------------------
# Shared corpus (tests/fixtures/scene-shapes.json)
# --------------------------------------------------------------------------

# Expected render outcome per corpus-valid shape. Valid means "shape-valid",
# not "renderable": the binding media policy refuses out-of-root sources
# (C:/...), video and gpu-temp are unimplemented here (S3-T12), and the
# corpus' data URIs are deliberately truncated: the PNG one fails decode,
# and the gif one ("R0lGODlhAQABA", 13 chars) is invalid base64, so its
# bytes never reach the GIF decoder. Anything else (ProtocolError, OSError,
# unexpected exception) fails this test.
CORPUS_VALID_OUTCOMES = {
    "default-scene": "render",
    "background-none": "unsupported_overlay",
    "background-color": "unsupported_overlay",
    "background-image": "media_refused",
    "background-gif": "media_unreadable",
    "background-video": "unsupported_background",
    "rotation-degrees": "media_missing",
    "color-mixed-case": "unsupported_overlay",
    "source-smile-double-dot": "media_missing",
    "source-data-uri": "media_unreadable",
    "overlays-at-cap": "unsupported_overlay",
}


def test_shared_corpus_valid_shapes_have_expected_outcomes(tmp_path):
    with open(FIXTURES, encoding="utf-8") as handle:
        shapes = json.load(handle)["shapes"]
    valid = [s for s in shapes if s["expect"] == "valid"]
    assert set(CORPUS_VALID_OUTCOMES) == {s["name"] for s in valid}
    for shape in valid:
        expected = CORPUS_VALID_OUTCOMES[shape["name"]]
        if expected == "render":
            img = render(shape["shape"], tmp_path)
            assert img.size == GLASS, shape["name"]
        else:
            with pytest.raises(lcd_bridge.SceneRenderError) as exc:
                render(shape["shape"], tmp_path)
            assert exc.value.reason == expected, shape["name"]


def test_shared_corpus_invalid_shapes_fail_validation(tmp_path):
    with open(FIXTURES, encoding="utf-8") as handle:
        shapes = json.load(handle)["shapes"]
    # "materialize" shapes are valid as plain JSON; their invalidity only
    # exists after JS/Python-specific mutations covered by the S0-T1 suites.
    invalid = [
        s for s in shapes
        if s["expect"] == "invalid" and "materialize" not in s
    ]
    assert invalid, "corpus must pin invalid shapes"
    for shape in invalid:
        with pytest.raises(ProtocolError) as exc:
            render(shape["shape"], tmp_path)
        assert exc.value.field == shape["field"], shape["name"]
        assert not isinstance(exc.value, lcd_bridge.SceneRenderError)


# --------------------------------------------------------------------------
# Text-length defence in depth (S2-T8c)
# --------------------------------------------------------------------------

def test_render_refuses_overlong_text_before_drawing(tmp_path):
    """render_scene validates FIRST (lcd_bridge.render_scene -> validate_scene),
    so the typed validation reason wins at the public entry point once S2-T8c
    moves the length gate into validate_scene."""
    over = "a" * (lcd_bridge.SCENE_MAX_TEXT_CHARS + 1)
    scene = scene_of({"kind": "none"}, [text_overlay(text=over)])
    with pytest.raises(ProtocolError) as caught:
        render(scene, tmp_path)
    assert caught.value.reason == "text_too_long", caught.value.reason
    assert caught.value.field == "overlays[0].text", caught.value.field


def test_draw_layer_keeps_its_own_text_cap():
    """Defence in depth unchanged: a caller that SKIPS validation still hits
    the render-side raise in _draw_text_overlay (same typed reason, same cap
    constant)."""
    canvas = Image.new("RGBA", (480, 854), (0, 0, 0, 0))
    over = "a" * (lcd_bridge.SCENE_MAX_TEXT_CHARS + 1)
    with pytest.raises(lcd_bridge.SceneRenderError) as caught:
        lcd_bridge._draw_text_overlay(canvas, text_overlay(text=over), 0)
    assert caught.value.reason == "text_too_long", caught.value.reason
    assert caught.value.field == "overlays[0].text", caught.value.field
