"""Preview request/response envelope (S0-T2). pytest-collectable.

Run from the repo root:
    .venv/Scripts/python.exe -m pytest tests/test_preview_protocol.py -v

Hardware-free: no USB, no network. The sidecar never renders here — until
S1-T6 every valid preview_request must be answered with the typed
``preview_unavailable`` error instead of an image or a silent drop.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import lcd_bridge  # noqa: E402
from bridge.protocol import (  # noqa: E402
    PREVIEW_MAX_HEIGHT,
    PREVIEW_MAX_WIDTH,
    PROTOCOL_VERSION,
    ProtocolError,
    build_preview_response,
    validate_preview_request,
    validate_scene,
)

FIXTURES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "scene-shapes.json"
)

MEDIA = {"rotation": 0, "flipH": False, "scale": 1, "panX": 0, "panY": 0, "fit": "fit"}


class _OverlaysWithProps(list):
    """Python stand-in for JS ``Object.assign(arr, {evil: 1})``: a list
    subclass can own non-index properties, which firstNonIndexKey rejects."""


def valid_scene():
    return {
        "version": 1,
        "background": {
            "kind": "image",
            "source": "bg.png",
            "rotation": 0,
            "flipH": False,
            "scale": 1,
            "panX": 0,
            "panY": 0,
            "fit": "fit",
        },
        "overlays": [
            {"kind": "text", "text": "hi", "x": 0.5, "y": 0.5, "size": 0.1,
             "rotation": 0, "color": "#ffffff"}
        ],
    }


def request_envelope(**overrides):
    envelope = {
        "v": PROTOCOL_VERSION,
        "cmd": "preview_request",
        "reqId": 7,
        "maxWidth": PREVIEW_MAX_WIDTH,
        "maxHeight": PREVIEW_MAX_HEIGHT,
        "scene": valid_scene(),
    }
    envelope.update(overrides)
    return envelope


def expect_reject(envelope, field, reason="invalid_request"):
    try:
        validate_preview_request(envelope)
    except ProtocolError as exc:
        assert exc.reason == reason, (exc.reason, reason)
        assert exc.field == field, (exc.field, field)
    else:
        raise AssertionError(f"expected rejection on field {field!r}")


def gpu_overlay():
    return {"kind": "gpu-temp", "x": 0.5, "y": 0.5, "size": 0.1,
            "rotation": 0, "color": "#ffffff"}


def test_preview_request_round_trip() -> None:
    # A valid request survives the JSONL wire and validates into a
    # correlated, size-checked request; the response builders emit the pair.
    wire = json.dumps(request_envelope())
    request = validate_preview_request(json.loads(wire))
    assert request["reqId"] == 7, request["reqId"]
    # Reduced-resolution cap, pinned here AND in the Vitest suite so the two
    # copies cannot drift apart silently.
    assert request["maxWidth"] == PREVIEW_MAX_WIDTH == 240, request["maxWidth"]
    assert request["maxHeight"] == PREVIEW_MAX_HEIGHT == 427, request["maxHeight"]
    assert request["scene"] == valid_scene(), request["scene"]

    ok = build_preview_response(
        7, image="aGVsbG8=", media_type="image/jpeg", width=240, height=427
    )
    back = json.loads(json.dumps(ok))
    assert back["v"] == PROTOCOL_VERSION, back
    assert back["cmd"] == "preview_response", back
    assert back["reqId"] == 7, back
    assert back["mediaType"] == "image/jpeg", back
    assert back["width"] == 240 and back["height"] == 427, back
    assert back["image"] == "aGVsbG8=", back
    assert "error" not in back, back


def test_preview_request_rejects_bad_coordinates() -> None:
    over = request_envelope()
    over["scene"]["overlays"][0]["x"] = 1.5
    expect_reject(over, "overlays[0].x")
    under = request_envelope()
    under["scene"]["overlays"][0]["y"] = -0.1
    expect_reject(under, "overlays[0].y")


def test_preview_request_rejects_unknown_key() -> None:
    # Envelope level and scene level are both unknown-key strict.
    envelope_level = request_envelope(evil=True)
    expect_reject(envelope_level, "evil")
    scene_level = request_envelope()
    scene_level["scene"]["evil"] = True
    expect_reject(scene_level, "evil")


def test_preview_request_rejects_bad_kind() -> None:
    background = request_envelope()
    background["scene"]["background"] = {"kind": "hologram"}
    expect_reject(background, "background.kind")
    overlay = request_envelope()
    overlay["scene"]["overlays"][0]["kind"] = "needle"
    expect_reject(overlay, "overlays[0].kind")


def test_preview_request_rejects_bad_color() -> None:
    shorthand = request_envelope()
    shorthand["scene"]["background"] = {"kind": "color", "color": "#fff"}
    expect_reject(shorthand, "background.color")
    named = request_envelope()
    named["scene"]["overlays"][0]["color"] = "#GGGGGG"
    expect_reject(named, "overlays[0].color")


def test_preview_request_rejects_overlays_cap() -> None:
    over = request_envelope()
    over["scene"]["overlays"] = [gpu_overlay() for _ in range(33)]
    expect_reject(over, "overlays")
    at_cap = request_envelope()
    at_cap["scene"]["overlays"] = [gpu_overlay() for _ in range(32)]
    assert validate_preview_request(at_cap)["scene"]["overlays"][0]["kind"] == "gpu-temp"


def test_preview_request_rejects_traversal_and_nul_source() -> None:
    # background.source later reaches a filesystem read: reject traversal and
    # NUL at the envelope, before any downstream code sees the value.
    posix = request_envelope()
    posix["scene"]["background"] = {"kind": "image", "source": "a/../b.png", **MEDIA}
    expect_reject(posix, "background.source")
    windows = request_envelope()
    windows["scene"]["background"] = {"kind": "video", "source": "..\\evil.png", **MEDIA}
    expect_reject(windows, "background.source")
    nul = request_envelope()
    nul["scene"]["background"] = {"kind": "gif", "source": "a\x00b", **MEDIA}
    expect_reject(nul, "background.source")


def test_preview_request_rejects_bad_size_hint() -> None:
    wide = request_envelope(maxWidth=PREVIEW_MAX_WIDTH + 1)
    expect_reject(wide, "maxWidth")
    zero = request_envelope(maxHeight=0)
    expect_reject(zero, "maxHeight")


def test_preview_request_rejects_bad_req_id() -> None:
    text = request_envelope(reqId="abc")
    expect_reject(text, "reqId")
    # bool is an int subclass in Python but `typeof true === 'number'` is
    # false in JS — a boolean must not pass as a correlation id here either.
    boolean = request_envelope(reqId=True)
    expect_reject(boolean, "reqId")


def test_version_mismatch_rejected() -> None:
    wrong_version = request_envelope(v=2)
    expect_reject(wrong_version, None, reason="version_mismatch")

    routed = lcd_bridge.route_stdin_line(json.dumps(wrong_version))
    assert routed is not None and routed[0] == "reply", routed
    response = routed[1]
    assert response["cmd"] == "preview_response", response
    assert response["reqId"] == 7, response  # still correlated
    assert response["error"]["reason"] == "version_mismatch", response

    # Non-preview envelope on an unknown version is rejected before its cmd is
    # even considered: an unpaired version cannot be interpreted at all.
    alien = lcd_bridge.route_stdin_line('{"v":9,"cmd":"frobnicate"}')
    assert alien[0] == "reply", alien
    assert alien[1]["cmd"] == "error", alien
    assert alien[1]["error"]["reason"] == "version_mismatch", alien


def test_unknown_message_type_rejected() -> None:
    routed = lcd_bridge.route_stdin_line('{"v":1,"seq":4,"cmd":"frobnicate"}')
    assert routed is not None and routed[0] == "reply", routed
    envelope = routed[1]
    assert envelope["v"] == PROTOCOL_VERSION, envelope
    assert envelope["cmd"] == "error", envelope
    assert envelope["error"]["reason"] == "unknown_cmd", envelope
    assert "frobnicate" in envelope["error"]["message"], envelope


def test_malformed_state_envelope_answered() -> None:
    # Known cmd, broken payload: a clear reason instead of a silent drop.
    routed = lcd_bridge.route_stdin_line('{"v":1,"cmd":"state","state":"garbage"}')
    assert routed is not None and routed[0] == "reply", routed
    assert routed[1]["cmd"] == "error", routed
    assert routed[1]["error"]["reason"] == "invalid_request", routed


def test_preview_unavailable_typed_error() -> None:
    routed = lcd_bridge.route_stdin_line(json.dumps(request_envelope()))
    assert routed is not None and routed[0] == "reply", routed
    response = routed[1]
    assert response["v"] == PROTOCOL_VERSION, response
    assert response["cmd"] == "preview_response", response
    assert response["reqId"] == 7, response
    assert response["error"]["reason"] == "preview_unavailable", response
    assert "S1-T6" in response["error"]["message"], response
    assert "image" not in response, response


def test_invalid_scene_answered_with_field() -> None:
    bad = request_envelope()
    bad["scene"]["overlays"][0]["x"] = 9
    routed = lcd_bridge.route_stdin_line(json.dumps(bad))
    assert routed is not None and routed[0] == "reply", routed
    response = routed[1]
    assert response["reqId"] == 7, response
    assert response["error"]["reason"] == "invalid_request", response
    assert response["error"]["field"] == "overlays[0].x", response


def test_state_lines_still_route_to_the_queue() -> None:
    # The shipped pairing must not change: versioned, legacy and bare state
    # envelopes keep flowing to the render loop untouched.
    versioned = lcd_bridge.route_stdin_line(
        '{"v":1,"seq":7,"cmd":"state","state":{"track":{"title":"T"}}}'
    )
    assert versioned == ("state", 7, {"track": {"title": "T"}}), versioned
    legacy = lcd_bridge.route_stdin_line('{"type":"state","state":{"layout":"cover"}}')
    assert legacy == ("state", None, {"layout": "cover"}), legacy


def test_noise_stays_silent() -> None:
    # Blank/non-JSON/non-object lines are transport noise, not messages: they
    # keep the historical tolerance (no reply storm for a stray newline).
    for line in ("", "   ", "not json", "null", "[1,2]", "42"):
        assert lcd_bridge.route_stdin_line(line) is None, line


def materialize(entry):
    """Reproduce the two shapes JSON cannot express (same hints the Vitest
    suite consumes in tests/unit/scene-validation.test.js)."""
    hints = entry.get("materialize")
    shape = entry["shape"]
    if hints is None:
        return shape
    if not isinstance(shape, dict) or not isinstance(shape.get("overlays"), list):
        return shape
    for index in hints.get("deleteOverlays", []):
        # Python lists cannot be sparse: None occupies the same validator
        # path as the JS hole (the element reads as undefined there).
        shape["overlays"][index] = None
    extra = hints.get("extraOverlayProps")
    if extra is not None:
        overlays = _OverlaysWithProps(shape["overlays"])
        for key, value in extra.items():
            setattr(overlays, key, value)
        shape["overlays"] = overlays
    return shape


def test_scene_corpus_lockstep_with_hardening() -> None:
    """Pin the Python copy of validateScene to the SAME 42-shape corpus that
    pins src/hardening.js validateScene and the renderer's isScene. A rule
    change on either side then fails a suite instead of drifting silently."""
    with open(FIXTURES, encoding="utf-8") as handle:
        shapes = json.load(handle)["shapes"]
    assert len(shapes) == 42, len(shapes)

    mismatches = []
    for entry in shapes:
        name = entry["name"]
        try:
            validate_scene(materialize(entry))
        except ProtocolError as exc:
            if entry["expect"] != "invalid":
                mismatches.append(f"{name}: rejected (field={exc.field!r}) but corpus says valid")
                continue
            if exc.field != entry.get("field"):
                mismatches.append(
                    f"{name}: field {exc.field!r} != corpus {entry.get('field')!r}"
                )
            if exc.reason != "invalid_request":
                mismatches.append(f"{name}: reason {exc.reason!r} != 'invalid_request'")
        else:
            if entry["expect"] != "valid":
                mismatches.append(f"{name}: accepted but corpus says invalid field={entry.get('field')!r}")
    assert mismatches == [], mismatches
