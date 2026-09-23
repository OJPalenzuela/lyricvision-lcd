"""Base Spotify widget placement contract and Pillow rendering (S7-T24a).

The scene field is optional. A scene without it must preserve the pre-change
render, while each keyed override must visibly move the corresponding widget.

The exact PNG bytes are an environment pin, not the portable correctness
contract: they require Pillow==12.3.0 (bridge/requirements.txt), FreeType, and
the same font file used to capture the fixture. The exact assertion therefore
skips visibly on another resolved font; font-independent behavior remains
pinned by render equivalence, destination-region differences, and observed
geometry below.
"""

import copy
import io
import os
from pathlib import Path

import PIL
import pytest
from PIL import Image, ImageChops, features

from bridge import lcd_bridge
from bridge.protocol import ProtocolError, validate_scene
from tests.test_compose_frame import GLASS, NOW, blank_scene, unified_state, with_scene


FIXTURE = Path(__file__).resolve().parent / "fixtures" / "unified-default-480x854.png"
EXPECTED_FIXTURE_FONT = r"C:\Windows\Fonts\seguiemj.ttf"
BASE_WIDGETS = ("cover", "title", "artist", "progress", "lyrics")
VALID_BASE_PLACEMENTS = {
    "cover": {"x": 0.2, "y": 0.8, "size": 0.2},
    "title": {"x": 0.8, "y": 0.1, "size": 0.05},
    "artist": {"x": 0.2, "y": 0.9, "size": 0.04},
    "progress": {"x": 0.2, "y": 0.1, "size": 0.3},
    "lyrics": {"x": 0.2, "y": 0.9, "size": 0.08},
}


def scene_with_base(widget=None, placement=None):
    scene = blank_scene()
    if widget is not None:
        scene["basePlacements"] = {widget: placement or VALID_BASE_PLACEMENTS[widget]}
    return scene


def render_scene_live(scene, state=None):
    return lcd_bridge.render_frame(
        state or unified_state(),
        scene,
        media_root=os.devnull,
        glass=GLASS,
        now_ms=NOW,
    )


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def changed_pixels(left, right, region):
    assert left.mode == right.mode == "RGB"
    assert left.size == right.size == GLASS
    box = (
        max(0, region[0]),
        max(0, region[1]),
        min(GLASS[0], region[2]),
        min(GLASS[1], region[3]),
    )
    difference = ImageChops.difference(left.crop(box), right.crop(box))
    raw = difference.tobytes()
    return sum(
        raw[offset] != 0 or raw[offset + 1] != 0 or raw[offset + 2] != 0
        for offset in range(0, len(raw), 3)
    )


def resolved_fixture_font():
    font = lcd_bridge.load_font(28, bold=True)
    path = getattr(font, "path", None)
    return path if isinstance(path, str) else "<Pillow default>"


def require_fixture_environment():
    resolved = resolved_fixture_font()
    expected = os.path.normcase(os.path.abspath(EXPECTED_FIXTURE_FONT))
    actual = (
        os.path.normcase(os.path.abspath(resolved))
        if resolved != "<Pillow default>"
        else resolved
    )
    if (
        PIL.__version__ != "12.3.0"
        or not features.check_module("freetype2")
        or actual != expected
    ):
        pytest.skip(
            "exact PNG fixture requires Pillow==12.3.0, FreeType, and font "
            f"{EXPECTED_FIXTURE_FONT}; resolved font {resolved}"
        )


def render_unified_with_base(widget, placement, glass=GLASS, state=None):
    return lcd_bridge.render_unified(
        unified_state() if state is None else state,
        glass,
        NOW,
        base_placements={widget: placement},
    )


def difference_bounds(left, right, region):
    assert left.mode == right.mode == "RGB"
    assert left.size == right.size
    box = (
        max(0, region[0]),
        max(0, region[1]),
        min(left.size[0], region[2]),
        min(left.size[1], region[3]),
    )
    bounds = ImageChops.difference(left.crop(box), right.crop(box)).getbbox()
    assert bounds is not None
    return bounds


class RecordingDraw:
    def __init__(self, draw):
        self._draw = draw
        self.lines = []
        self.texts = []
        self.rounded_rectangles = []

    def line(self, points, *args, **kwargs):
        self.lines.append((points, args, kwargs))
        return self._draw.line(points, *args, **kwargs)

    def text(self, position, text, *args, **kwargs):
        self.texts.append((position, text, args, kwargs))
        return self._draw.text(position, text, *args, **kwargs)

    def rounded_rectangle(self, box, *args, **kwargs):
        self.rounded_rectangles.append((box, args, kwargs))
        return self._draw.rounded_rectangle(box, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._draw, name)


# --------------------------------------------------------------------------
# Validator: optional, keyed, strict x/y/size placement values
# --------------------------------------------------------------------------


def test_validator_accepts_optional_complete_base_placement_map() -> None:
    scene = blank_scene()
    scene["basePlacements"] = copy.deepcopy(VALID_BASE_PLACEMENTS)
    assert validate_scene(scene) == scene


@pytest.mark.parametrize(
    ("base_placements", "field"),
    [
        (None, "basePlacements"),
        ([], "basePlacements"),
        ({"unknown": {"x": 0.5, "y": 0.5, "size": 0.1}}, "basePlacements.unknown"),
        ({"cover": {"x": 0.5, "y": 0.5}}, "basePlacements.cover.size"),
        ({"cover": {"x": 1.1, "y": 0.5, "size": 0.1}}, "basePlacements.cover.x"),
        ({"cover": {"x": 0.5, "y": -0.1, "size": 0.1}}, "basePlacements.cover.y"),
        (
            {"cover": {"x": 0.5, "y": 0.5, "size": float("nan")}},
            "basePlacements.cover.size",
        ),
        ({"cover": {"x": True, "y": 0.5, "size": 0.1}}, "basePlacements.cover.x"),
        (
            {"cover": {"x": 0.5, "y": 0.5, "size": 0.1, "extra": True}},
            "basePlacements.cover.extra",
        ),
        (
            {"cover": {"x": 0.5, "y": 0.5, "size": 0.1, "rotation": 90}},
            "basePlacements.cover.rotation",
        ),
    ],
)
def test_validator_rejects_malformed_base_placements(base_placements, field) -> None:
    scene = blank_scene()
    scene["basePlacements"] = base_placements
    with pytest.raises(ProtocolError) as caught:
        validate_scene(scene)
    assert caught.value.reason == "invalid_request"
    assert caught.value.field == field


# --------------------------------------------------------------------------
# Byte-identical default captured from the pre-change renderer
# --------------------------------------------------------------------------


def test_no_base_placement_override_is_byte_identical_to_prechange_fixture() -> None:
    require_fixture_environment()
    expected_png = FIXTURE.read_bytes()
    state = unified_state()
    no_scene = lcd_bridge.render_portrait(state, GLASS, NOW)
    assert png_bytes(no_scene) == expected_png

    empty_map_scene = blank_scene()
    empty_map_scene["basePlacements"] = {}
    for scene in (blank_scene(), empty_map_scene):
        with_field = render_scene_live(scene, state)
        assert png_bytes(with_field) == expected_png
        difference = ImageChops.difference(no_scene, with_field)
        assert difference.getbbox() is None


def test_absent_empty_and_null_base_placement_values_keep_one_legacy_render() -> None:
    # Persisted null is rejected upstream; None is the renderer's normalized
    # value for both an absent field and an explicit-null lookup result.
    state = unified_state()
    renders = (
        lcd_bridge.render_unified(state, GLASS, NOW),
        lcd_bridge.render_unified(state, GLASS, NOW, base_placements={}),
        lcd_bridge.render_unified(state, GLASS, NOW, base_placements=None),
    )
    encoded = tuple(png_bytes(render) for render in renders)
    assert encoded[0] == encoded[1] == encoded[2]


# --------------------------------------------------------------------------
# Per-widget behavioral pins: movement must change pixels in the target region
# --------------------------------------------------------------------------


def test_cover_placement_changes_the_cover_region_and_rotated_buffer() -> None:
    baseline = render_scene_live(blank_scene())
    moved = render_scene_live(scene_with_base("cover"))
    assert changed_pixels(baseline, moved, (0, 500, 210, 854)) > 0

    baseline_buffer = lcd_bridge.portrait_to_buffer(baseline, "rot90cw")
    moved_buffer = lcd_bridge.portrait_to_buffer(moved, "rot90cw")
    assert baseline_buffer.size == moved_buffer.size == (854, 480)
    assert baseline_buffer.tobytes() != moved_buffer.tobytes()


def test_title_placement_changes_the_title_region() -> None:
    baseline = render_scene_live(blank_scene())
    moved = render_scene_live(scene_with_base("title"))
    assert changed_pixels(baseline, moved, (280, 0, 480, 180)) > 0


def test_artist_placement_changes_the_destination_and_clears_the_original() -> None:
    state = unified_state(track=dict(unified_state()["track"], artist="A", album=""))
    destination = (390, 470, 480, 570)
    original = (0, 420, 300, 480)
    moved_placement = {"x": 0.9, "y": 0.6, "size": 0.05}
    control_placement = {"x": 0.1, "y": 0.6, "size": 0.05}
    baseline = render_scene_live(blank_scene(), state)
    moved = render_scene_live(scene_with_base("artist", moved_placement), state)
    control = render_scene_live(scene_with_base("artist", control_placement), state)

    assert changed_pixels(baseline, moved, destination) > 0
    assert changed_pixels(baseline, moved, original) > 0
    assert changed_pixels(control, moved, original) == 0
    assert changed_pixels(baseline, control, destination) == 0


def test_artist_placement_also_moves_a_nonempty_album() -> None:
    state = unified_state(track=dict(unified_state()["track"], artist="A", album="B"))
    placement = {"x": 0.9, "y": 0.6, "size": 0.05}
    baseline = render_scene_live(blank_scene(), state)
    moved = render_scene_live(scene_with_base("artist", placement), state)

    assert changed_pixels(baseline, moved, (0, 458, 300, 490)) > 0
    assert changed_pixels(baseline, moved, (410, 510, 460, 560)) > 0


def test_progress_placement_changes_the_progress_region() -> None:
    baseline = render_scene_live(blank_scene())
    moved = render_scene_live(scene_with_base("progress"))
    assert changed_pixels(baseline, moved, (0, 0, 260, 160)) > 0


def test_lyrics_placement_changes_the_lyrics_region() -> None:
    baseline = render_scene_live(blank_scene())
    moved = render_scene_live(scene_with_base("lyrics"))
    assert changed_pixels(baseline, moved, (0, 650, 300, 854)) > 0


def test_legacy_no_override_geometry_matches_the_documented_constants(
    monkeypatch,
) -> None:
    recorder = []
    draw_factory = lcd_bridge.ImageDraw.Draw

    def recording_factory(image):
        draw = RecordingDraw(draw_factory(image))
        recorder.append(draw)
        return draw

    monkeypatch.setattr(lcd_bridge.ImageDraw, "Draw", recording_factory)
    state = unified_state()
    lcd_bridge.render_unified(state, GLASS, NOW)
    draw = recorder[0]

    art_start, art_end = draw.lines[0][0]
    assert art_start == (80, 24)
    assert art_end == (400, 24)
    cover_size = art_end[0] - art_start[0]
    assert cover_size == 320

    title_call = next(call for call in draw.texts if call[1] == state["track"]["title"])
    assert title_call[0] == (28, 24 + cover_size + 16)

    progress_box = draw.rounded_rectangles[0][0]
    assert progress_box == [28, 798, 452, 806]
    assert progress_box[2] - progress_box[0] == 424


def test_cover_size_is_a_portrait_width_fraction_from_rendered_bounds() -> None:
    placement = {"x": 0.2, "y": 0.75, "size": 0.25}
    bounds = []
    for width in (480, 960):
        glass = (width, 854)
        baseline = lcd_bridge.render_unified(unified_state(), glass, NOW)
        moved = render_unified_with_base("cover", placement, glass)
        bounds.append(difference_bounds(baseline, moved, (0, 500, 400, 854)))

    narrow_width = bounds[0][2] - bounds[0][0] - 1
    wide_width = bounds[1][2] - bounds[1][0] - 1
    # The fallback cover's outer rectangle includes its right/bottom stroke.
    assert narrow_width == round(placement["size"] * 480)
    assert wide_width == round(placement["size"] * 960)


def test_title_size_is_a_portrait_height_fraction_from_rendered_bounds() -> None:
    state = unified_state(
        track=dict(unified_state()["track"], title="I", artist="", album="")
    )
    placement = {"x": 0.8, "y": 0.2, "size": 0.25}
    heights = []
    for height in (854, 1708):
        glass = (480, height)
        baseline = lcd_bridge.render_unified(state, glass, NOW)
        moved = render_unified_with_base("title", placement, glass, state)
        bounds = difference_bounds(baseline, moved, (300, 0, 480, round(height * 0.4)))
        heights.append(bounds[3] - bounds[1])

    # Width is fixed; only portrait-height scaling can double the glyph bounds.
    assert 1.9 * heights[0] <= heights[1] <= 2.1 * heights[0]


def test_scene_retention_keeps_validated_base_placements() -> None:
    scene = scene_with_base("cover")
    pushed = with_scene(unified_state(), scene)
    retained, last = lcd_bridge.apply_scene_retention(pushed, None)
    assert last == validate_scene(scene)
    assert retained["settings"]["scene"] == validate_scene(scene)
