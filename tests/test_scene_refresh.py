"""Scene content digest + dirty-flag refresh policy (S1-T5). pytest-collectable.

Run from the repo root:
    .venv/Scripts/python.exe -m pytest tests/test_scene_refresh.py -v

Hardware-free: no USB, no network. Both functions are pure and ADDITIVE --
they are currently unreached by the live frame loop (the dirty-flag loop
replacing the blind 1/fps cadence is S1-T7, hardware-gated). GIF fixtures
are generated with Pillow inside the test; nothing binary is committed.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402
from PIL import Image  # noqa: E402

from bridge import lcd_bridge  # noqa: E402
from bridge.protocol import ProtocolError  # noqa: E402


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def save_gif(frames, root, name, **kwargs):
    path = os.path.join(str(root), name)
    frames[0].save(
        path, format="GIF", save_all=True, append_images=frames[1:], **kwargs
    )
    return name


def gif_bg(source, **overrides):
    bg = {"kind": "gif", "source": source, "rotation": 0, "flipH": False,
          "scale": 1, "panX": 0, "panY": 0, "fit": "fit"}
    bg.update(overrides)
    return {"version": 1, "background": bg, "overlays": []}


def text_overlay(**overrides):
    overlay = {"kind": "text", "text": "Hi", "x": 0.5, "y": 0.5,
               "size": 0.1, "rotation": 0, "color": "#ff0000"}
    overlay.update(overrides)
    return overlay


GPU_TEMP = {"kind": "gpu-temp", "x": 0.5, "y": 0.5, "size": 0.1,
            "rotation": 0, "color": "#ffffff"}


# --------------------------------------------------------------------------
# Digest: key-order insensitive, value/order sensitive
# --------------------------------------------------------------------------

def test_digest_ignores_json_key_insertion_order():
    # Two logically identical scenes whose objects were built with the keys
    # inserted in opposite orders.
    a = {
        "version": 1,
        "background": {"kind": "color", "color": "#102030"},
        "overlays": [
            {"kind": "text", "text": "one", "x": 0.2, "y": 0.3, "size": 0.1,
             "rotation": 0, "color": "#ffffff"},
            {"kind": "text", "text": "two", "x": 0.8, "y": 0.7, "size": 0.2,
             "rotation": 45, "color": "#000000"},
        ],
    }
    b = {
        "overlays": [
            {"color": "#ffffff", "rotation": 0, "size": 0.1, "y": 0.3,
             "x": 0.2, "text": "one", "kind": "text"},
            {"color": "#000000", "rotation": 45, "size": 0.2, "y": 0.7,
             "x": 0.8, "text": "two", "kind": "text"},
        ],
        "background": {"color": "#102030", "kind": "color"},
        "version": 1,
    }
    assert lcd_bridge.scene_digest(a) == lcd_bridge.scene_digest(b)


def test_digest_changes_on_any_value_change():
    base = {
        "version": 1,
        "background": {"kind": "color", "color": "#102030"},
        "overlays": [
            {"kind": "text", "text": "Hi", "x": 0.5, "y": 0.5, "size": 0.1,
             "rotation": 0, "color": "#ff0000"},
        ],
    }
    baseline = lcd_bridge.scene_digest(base)
    # Deterministic: same scene in -> same digest out.
    assert lcd_bridge.scene_digest(base) == baseline
    variants = [
        # `version` is deliberately absent: only version=1 validates, so a
        # changed version is an INVALID scene -- covered by the ProtocolError
        # test below, not by digest comparison.
        dict(base, background={"kind": "color", "color": "#102031"}),
        dict(base, overlays=[dict(base["overlays"][0], x=0.51)]),
        dict(base, overlays=[dict(base["overlays"][0], color="#ff0001")]),
        dict(base, overlays=[dict(base["overlays"][0], text="Bye")]),
        # Kind swap must stay schema-valid: a gpu-temp overlay carries no
        # `text` key, so rebuilding the text overlay with kind=gpu-temp
        # would be an unknown-key rejection, not a digest difference.
        dict(base, overlays=[GPU_TEMP]),
        dict(base, overlays=[]),
        dict(base, overlays=[base["overlays"][0], GPU_TEMP]),
    ]
    for i, changed in enumerate(variants):
        assert lcd_bridge.scene_digest(changed) != baseline, f"variant {i}"


def test_digest_changes_on_overlay_order_swap():
    base = {
        "version": 1,
        "background": {"kind": "none"},
        "overlays": [
            text_overlay(text="first", x=0.2),
            text_overlay(text="second", x=0.8),
        ],
    }
    swapped = dict(base, overlays=[base["overlays"][1], base["overlays"][0]])
    assert lcd_bridge.scene_digest(base) != lcd_bridge.scene_digest(swapped)


def test_digest_rejects_invalid_scene_as_protocol_error():
    with pytest.raises(ProtocolError):
        lcd_bridge.scene_digest({"version": 2, "background": {"kind": "none"},
                                 "overlays": []})


# --------------------------------------------------------------------------
# Refresh policy
# --------------------------------------------------------------------------

def test_static_scene_returns_finite_sentinel(tmp_path):
    # The sentinel is a FINITE upper bound -- never infinity, never 0, never
    # negative. See the protocol-invariant comment on REFRESH_STATIC_MS in
    # bridge/lcd_bridge.py for why finite is the fail-safe choice.
    sentinel = lcd_bridge.REFRESH_STATIC_MS
    assert isinstance(sentinel, int)
    assert 0 < sentinel < float("inf")
    static_scenes = [
        {"version": 1, "background": {"kind": "none"}, "overlays": []},
        {"version": 1, "background": {"kind": "color", "color": "#102030"},
         "overlays": []},
        {"version": 1, "background": {"kind": "color", "color": "#102030"},
         "overlays": [text_overlay()]},
        # An image background is static too -- and computing that verdict
        # must NOT touch the filesystem (source need not exist).
        {"version": 1,
         "background": {"kind": "image", "source": "does-not-exist.png",
                        "rotation": 0, "flipH": False, "scale": 1,
                        "panX": 0, "panY": 0, "fit": "fit"},
         "overlays": [text_overlay()]},
    ]
    for scene in static_scenes:
        wait = lcd_bridge.scene_refresh_ms(scene, media_root=str(tmp_path))
        assert wait == sentinel, scene


def test_gpu_temp_overlay_returns_sensor_interval(tmp_path):
    scene = {"version": 1, "background": {"kind": "none"},
             "overlays": [GPU_TEMP]}
    wait = lcd_bridge.scene_refresh_ms(scene, media_root=str(tmp_path))
    assert wait == lcd_bridge.REFRESH_SENSOR_MS == 1000


def test_video_returns_documented_placeholder(tmp_path):
    scene = {"version": 1,
             "background": {"kind": "video", "source": "clip.mp4",
                            "rotation": 0, "flipH": False, "scale": 1,
                            "panX": 0, "panY": 0, "fit": "fit"},
             "overlays": []}
    wait = lcd_bridge.scene_refresh_ms(scene, media_root=str(tmp_path))
    # Documented TODO until S3-T12: this is a finite ~30fps placeholder for
    # the container's playback rate, never the static sentinel.
    assert wait == lcd_bridge.REFRESH_VIDEO_MS
    assert 0 < wait <= 100


def test_gif_returns_each_frames_own_delay(tmp_path):
    frames = [Image.new("RGB", (10, 10), color)
              for color in ((255, 0, 0), (0, 255, 0), (0, 0, 255))]
    name = save_gif(frames, tmp_path, "anim.gif", duration=[40, 80, 120])
    scene = gif_bg(name)
    root = str(tmp_path)
    # Each selector value waits out the delay of ITS OWN frame...
    assert lcd_bridge.scene_refresh_ms(scene, media_root=root, frame_index=0) == 40
    assert lcd_bridge.scene_refresh_ms(scene, media_root=root, frame_index=1) == 80
    assert lcd_bridge.scene_refresh_ms(scene, media_root=root, frame_index=2) == 120
    # ...and past the last frame the selector wraps, so the policy wraps too.
    assert lcd_bridge.scene_refresh_ms(scene, media_root=root, frame_index=3) == 40


def test_gif_policy_takes_minimum_with_sensor(tmp_path):
    frames = [Image.new("RGB", (10, 10), (1, 2, 3)),
              Image.new("RGB", (10, 10), (4, 5, 6))]
    name = save_gif(frames, tmp_path, "fast.gif", duration=[40, 40])
    scene = dict(gif_bg(name), overlays=[GPU_TEMP])
    wait = lcd_bridge.scene_refresh_ms(scene, media_root=str(tmp_path),
                                       frame_index=0)
    # Most urgent driver wins: the gif's 40 ms, not the sensor's 1000 ms.
    assert wait == 40


def test_refresh_rejects_invalid_scene_as_protocol_error(tmp_path):
    with pytest.raises(ProtocolError):
        lcd_bridge.scene_refresh_ms(
            {"version": 2, "background": {"kind": "none"}, "overlays": []},
            media_root=str(tmp_path),
        )
