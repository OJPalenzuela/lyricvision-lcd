"""Sidecar scene retention: `settings.scene` is the ONE retained field (S2-T8a).

The shell's scene fan-out (createSceneFanout in src/main.js) omits
`settings.scene` from a state push while its content digest is unchanged, so
a multi-megabyte embedded scene does not cross the pipe on every ~2 s push.
Every OTHER field of the envelope keeps full-replace semantics; only `scene`
is retained, and that retention lives in lcd_bridge.apply_scene_retention --
applied where main() drains a freshly parsed envelope, before the frame loop
renders it.

Hardware-free: no USB, no network. Rendering goes through Pillow only.
"""

import copy
import inspect
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from bridge import lcd_bridge  # noqa: E402

GLASS = (480, 854)
# A time base far from the live clock so extrapolation is explicit.
MEASURED_AT = 1_700_000_000_000.0
NOW = MEASURED_AT + 40_000.0
LEGACY_BG = (10, 13, 20)
# The scene background where the lyrics view never paints (top-left corner),
# same probe tests/test_compose_frame.py uses to prove the background layer.
SCENE_BG = "#102030"
SCENE_BG_RGB = (0x10, 0x20, 0x30)


@pytest.fixture(autouse=True)
def reset_fallback_warning():
    # _warn_scene_fallback dedupes through a module global; these tests
    # assert on warning text, so every one of them starts from a clean slate.
    previous = lcd_bridge._SCENE_FALLBACK_LAST
    lcd_bridge._SCENE_FALLBACK_LAST = None
    yield
    lcd_bridge._SCENE_FALLBACK_LAST = previous


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def unified_state(**overrides):
    base = {
        "track": {"title": "Retention Test", "artist": "LyricVision",
                  "album": "S2-T8a", "artworkUrl": ""},
        "lyric": {"current_line": "first line", "next_line": "second line"},
        "progressMs": 40000,
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


def color_scene(color=SCENE_BG):
    return {"version": 1, "background": {"kind": "color", "color": color},
            "overlays": []}


def invalid_scene():
    # version is only ever 1; this fails validate_scene on the field path.
    return {"version": 2, "background": {"kind": "none"}, "overlays": []}


def drain(state, last):
    """One drain step: a newly parsed envelope in, (state, retained) out."""
    return lcd_bridge.apply_scene_retention(state, last)


def validated(scene):
    return lcd_bridge.validate_scene(scene)


def same_pixels(a, b):
    return (a.mode, a.size) == (b.mode, b.size) and a.tobytes() == b.tobytes()


def render(state):
    return lcd_bridge.render_portrait(state, GLASS, NOW)


def lyrics_view(state):
    return lcd_bridge.render_unified(state, GLASS, NOW)


# --------------------------------------------------------------------------
# Rule 1: key absent -> retain; no scene ever received -> today's lyrics view
# --------------------------------------------------------------------------

def test_absent_scene_key_with_no_prior_scene_keeps_lyrics_view():
    # Today's behaviour, preserved: a sidecar that has never received a
    # scene renders the legacy lyrics canvas when the key is absent.
    out, last = drain(unified_state(), None)
    assert "scene" not in out["settings"]
    assert last is None
    assert lcd_bridge._scene_from_state(out) is None
    assert same_pixels(render(out), lyrics_view(out))


def test_valid_scene_push_is_used_and_remembered():
    scene = color_scene()
    out, last = drain(with_scene(unified_state(), scene), None)
    assert last == validated(scene)
    assert out["settings"]["scene"] == validated(scene)
    rendered = render(out)
    assert rendered.getpixel((2, 2)) == SCENE_BG_RGB
    assert not same_pixels(rendered, lyrics_view(out))


def test_absent_scene_key_keeps_rendering_the_last_valid_scene():
    # THE S2-T8a regression: the fan-out omits settings.scene on every push
    # whose digest is unchanged, and the drain used to replace the state
    # wholesale -- so the key vanished ~2 s after the edit landed and
    # render_portrait fell back to the legacy lyrics canvas.
    scene = color_scene()
    _, last = drain(with_scene(unified_state(), scene), None)

    stripped = unified_state()  # settings carry no scene key at all
    out, last = drain(stripped, last)

    assert out["settings"]["scene"] == validated(scene)
    assert last == validated(scene)
    rendered = render(out)
    # Exactly what a push that DID carry the scene would have rendered...
    delivered = render(with_scene(stripped, scene))
    assert same_pixels(rendered, delivered)
    # ...the same scene, still on the panel, not the lyrics fallback.
    assert rendered.getpixel((2, 2)) == SCENE_BG_RGB
    assert not same_pixels(rendered, lyrics_view(stripped))


def test_retention_survives_consecutive_absent_key_pushes():
    scene = color_scene()
    _, last = drain(with_scene(unified_state(), scene), None)
    retained = last
    for _ in range(4):
        out, last = drain(unified_state(), last)
        assert out["settings"]["scene"] == validated(scene)
        assert last == retained
        assert render(out).getpixel((2, 2)) == SCENE_BG_RGB


# --------------------------------------------------------------------------
# Rule 2: explicit null -> clear, no resurrection
# --------------------------------------------------------------------------

def test_explicit_null_clears_retention():
    scene = color_scene()
    _, last = drain(with_scene(unified_state(), scene), None)
    assert last is not None

    cleared = unified_state()
    cleared["settings"] = {"lcdFps": 10, "scene": None}
    out, last = drain(cleared, last)
    assert last is None
    assert lcd_bridge._scene_from_state(out) is None
    assert same_pixels(render(out), lyrics_view(out))

    # A later absent-key push must NOT resurrect what null cleared.
    out, last = drain(unified_state(), last)
    assert last is None
    assert "scene" not in out["settings"]
    assert lcd_bridge._scene_from_state(out) is None


# --------------------------------------------------------------------------
# Rule 3: invalid -> clear + deduped warning, never retained
# --------------------------------------------------------------------------

def test_invalid_scene_clears_retention_and_warns_once(capsys):
    scene = color_scene()
    _, last = drain(with_scene(unified_state(), scene), None)
    assert last is not None

    out, last = drain(with_scene(unified_state(), invalid_scene()), last)
    err = capsys.readouterr().err
    # Fail-safe direction: a scene we cannot validate is a scene we must
    # not draw -- the previously retained scene is dropped, not kept.
    assert last is None
    assert out["settings"]["scene"] is None
    assert lcd_bridge._scene_from_state(out) is None
    assert same_pixels(render(out), lyrics_view(out))
    assert "scene disabled" in err

    # Deduped: the same broken scene twice must log once, not once per push.
    out, last = drain(with_scene(unified_state(), invalid_scene()), last)
    assert capsys.readouterr().err == ""
    assert last is None


def test_valid_scene_after_invalid_is_not_latched():
    out, last = drain(with_scene(unified_state(), invalid_scene()), None)
    assert last is None

    fixed = color_scene("#204060")
    out, last = drain(with_scene(unified_state(), fixed), last)
    assert last == validated(fixed)
    rendered = render(out)
    assert rendered.getpixel((2, 2)) == (0x20, 0x40, 0x60)
    assert not same_pixels(rendered, lyrics_view(out))


# --------------------------------------------------------------------------
# Retention is SCENE-scoped: every other field still replaces wholesale
# --------------------------------------------------------------------------

def test_other_fields_still_replace_wholesale_when_scene_is_omitted():
    scene = color_scene()
    first, last = drain(with_scene(unified_state(), scene), None)

    # A later push that omits `scene` but changes everything else.
    following = unified_state()
    following["lyric"] = {"current_line": "changed line", "next_line": "gone"}
    following["settings"] = {"lcdFps": 5}
    del following["isPlaying"]  # present in the previous push, absent now
    following["track"] = {"title": "Next Track", "artist": "Other",
                          "album": "", "artworkUrl": ""}
    out, last = drain(following, last)

    # Retained: the scene, and ONLY the scene.
    assert out["settings"]["scene"] == validated(scene)
    assert last == validated(scene)
    # Everything else is the NEW envelope -- this must never become a merge.
    assert lcd_bridge.fps_from_state(out) == 5
    assert lcd_bridge.fps_from_state(first) == 10  # inputs stay untouched
    assert out["lyric"]["current_line"] == "changed line"
    assert out["track"]["title"] == "Next Track"
    assert "isPlaying" not in out


def test_apply_scene_retention_does_not_mutate_its_inputs():
    scene = color_scene()
    pushed = with_scene(unified_state(), scene)
    pushed_snapshot = copy.deepcopy(pushed)
    out, last = drain(pushed, None)
    assert pushed == pushed_snapshot

    stripped = unified_state()
    stripped_snapshot = copy.deepcopy(stripped)
    out2, _ = drain(stripped, last)
    assert stripped == stripped_snapshot
    assert out2 is not stripped
    assert out2["settings"] is not stripped["settings"]


# --------------------------------------------------------------------------
# Wiring: the loop must drain THROUGH the retention step
# --------------------------------------------------------------------------

def test_main_drains_every_envelope_through_scene_retention():
    # Wiring pin: the pure step is only useful if main() calls it INSTEAD of
    # `state = new_state`. Reintroducing the bare wholesale replace is
    # exactly the S2-T8a regression (the scene vanishes one push after an
    # edit), so both halves are asserted against the real loop source.
    source = inspect.getsource(lcd_bridge.main)
    assert "state, last_scene = apply_scene_retention(new_state, last_scene)" in source
    assert "state = new_state" not in source


# --------------------------------------------------------------------------
# Non-dict `settings`: malformed input is preserved, never rewritten (S2-T8c)
# --------------------------------------------------------------------------

def test_non_dict_settings_is_never_rewritten_whatever_last_holds():
    """A malformed `settings` must come back EXACTLY as received.

    Before S2-T8c, `scope = {}` plus a retained `last` rebuilt settings as
    {"scene": last} -- silently REPLACING the bad value, so the input shape
    changed depending on whether a scene had ever been retained (asymmetric
    with `last is None`, which left it alone). Retention applies to dict
    settings only; a non-dict keeps its shape for downstream handling.
    """
    prior = color_scene()
    for bad_settings in ("malformed", ["not", "a", "dict"]):
        for last in (None, prior):
            state = unified_state(settings=bad_settings)
            out, retained = drain(state, last)
            assert out is state, bad_settings
            assert out["settings"] is bad_settings, bad_settings
            assert retained is last, (bad_settings, last is None)

    # ...and the dict path still retains: the guard must not swallow it.
    state = unified_state()
    out, retained = drain(state, prior)
    assert out["settings"]["scene"] == validated(prior)
    assert retained == validated(prior)
