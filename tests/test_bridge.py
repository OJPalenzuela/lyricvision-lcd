"""Smoke test for bridge/lcd_bridge.py (LV-04). Plain asserts, no runner needed.

Run from the repo root either way:
    python tests/test_bridge.py
    python -m tests.test_bridge
"""

import contextlib
import io
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import lcd_bridge  # noqa: E402
from bridge.protocol import (  # noqa: E402
    CMD_FRAME,
    MAGIC,
    OFF_CMD,
    OFF_H,
    OFF_MAGIC,
    OFF_PAYLOAD_LEN,
    OFF_W,
    build_frame_header,
)
from panels.registry import VISION_MAX, lookup  # noqa: E402


class FakeEndpoint:
    """Captures bulk writes like a pyusb endpoint."""

    def __init__(self):
        self.writes = []

    def write(self, data, timeout=None):
        self.writes.append(bytes(data))
        return len(data)

    def read(self, size, timeout=None):
        raise AssertionError("read should not be called in send_frame tests")


def main() -> None:
    from PIL import Image

    # 1. Rotation mapping (glass-verified sense): portrait top-blue/bottom-red
    #    -> buffer left-red/right-blue via rot90cw; inverse buffer pattern
    #    -> portrait top-blue/bottom-red.
    W, H = 480, 854
    portrait = Image.new("RGB", (W, H))
    for y in range(H):
        for x in range(W):
            portrait.putpixel((x, y), (0, 0, 255) if y < H // 2 else (255, 0, 0))
    buf = lcd_bridge.portrait_to_buffer(portrait, "rot90cw")
    assert buf.size == (854, 480), buf.size
    assert buf.getpixel((0, 240)) == (255, 0, 0), "buffer left must be red"
    assert buf.getpixel((853, 240)) == (0, 0, 255), "buffer right must be blue"

    inv = Image.new("RGB", (854, 480))
    for y in range(480):
        for x in range(854):
            inv.putpixel((x, y), (255, 0, 0) if x < 427 else (0, 0, 255))
    back = inv.transpose(Image.ROTATE_90)  # buffer -> portrait inverse
    assert back.size == (480, 854), back.size
    assert back.getpixel((240, 0)) == (0, 0, 255), "portrait top must be blue"
    assert back.getpixel((240, 853)) == (255, 0, 0), "portrait bottom must be red"

    # 2. Header goes through the protocol builder with w=854 h=480.
    fake = FakeEndpoint()
    payload = bytes(range(256)) * 4  # 1024 bytes
    lcd_bridge.send_frame(fake, VISION_MAX, payload)
    header = fake.writes[0]
    assert len(header) == 64, len(header)
    assert header == build_frame_header(854, 480, CMD_FRAME, len(payload))
    assert struct.unpack_from("<I", header, OFF_MAGIC)[0] == MAGIC
    assert struct.unpack_from("<I", header, OFF_CMD)[0] == 2
    assert struct.unpack_from("<H", header, OFF_W)[0] == 854
    assert struct.unpack_from("<H", header, OFF_H)[0] == 480
    assert struct.unpack_from("<I", header, OFF_PAYLOAD_LEN)[0] == len(payload)
    # Payload reassembles from the remaining writes (last write may be ZLP).
    body = b"".join(w for w in fake.writes[1:] if w)
    assert body == payload, "chunked payload must reassemble exactly"

    # 3. Unknown PM exits 2 with a panel-unknown status line (mocked USB).
    assert lookup(99, 99).known is False
    try:
        lcd_bridge.resolve_panel(99, 99)
    except lcd_bridge.UnknownPanelError as exc:
        status = lcd_bridge.unknown_status(exc.pm, exc.sub)
        assert status["status"] == "panel-unknown", status
    else:
        raise AssertionError("resolve_panel(99, 99) must raise UnknownPanelError")

    real_open = lcd_bridge.open_device
    real_handshake = lcd_bridge.do_handshake
    lcd_bridge.open_device = lambda serial=None: (object(), object(), object())
    lcd_bridge.do_handshake = lambda ep_out, ep_in, timeout_ms=2000: (99, 99)
    lcd_bridge.close_device = lambda dev: None
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            code = lcd_bridge.main(["--once", "1"])
    finally:
        lcd_bridge.open_device = real_open
        lcd_bridge.do_handshake = real_handshake
    assert code == 2, code
    assert "panel-unknown" in captured.getvalue(), captured.getvalue()

    # 4. fps clamp: default 10, floor 5, ceiling 30.
    assert lcd_bridge.clamp_fps(None) == 10
    assert lcd_bridge.clamp_fps("garbage") == 10
    assert lcd_bridge.clamp_fps(2) == 5
    assert lcd_bridge.clamp_fps(4) == 5
    assert lcd_bridge.clamp_fps(5) == 5
    assert lcd_bridge.clamp_fps(10) == 10
    assert lcd_bridge.clamp_fps(30) == 30
    assert lcd_bridge.clamp_fps(99) == 30
    assert lcd_bridge.fps_from_state({}) == 10
    assert lcd_bridge.fps_from_state({"settings": {"lcdFps": 1}}) == 5
    assert lcd_bridge.fps_from_state({"settings": {"lcdFps": 60}}) == 30
    assert lcd_bridge.fps_from_state({"settings": {"lcdFps": 15}}) == 15

    # 5. Stdin envelopes: versioned + legacy.
    seq, state = lcd_bridge.parse_state_line(
        '{"v":1,"seq":7,"cmd":"state","state":{"track":{"title":"T"}}}'
    )
    assert (seq, state) == (7, {"track": {"title": "T"}}), (seq, state)
    seq, state = lcd_bridge.parse_state_line(
        '{"type":"state","state":{"track":{"title":"L"}}}'
    )
    assert seq is None and state == {"track": {"title": "L"}}, (seq, state)
    assert lcd_bridge.parse_state_line("not json") == (None, None)
    assert lcd_bridge.parse_state_line("") == (None, None)

    # 6. UTF-8 stdin: lyrics survive the bytes->str decode (Windows cp1252
    #    would mangle them into mojibake like "canciÃ³n").
    import json as _json

    lyric = {"track": {"title": "Corazón ñoño 日本語 🎵"}}
    wire = _json.dumps({"v": 1, "seq": 9, "cmd": "state", "state": lyric},
                       ensure_ascii=False).encode("utf-8")
    seq, state = lcd_bridge.parse_state_line(wire.decode("utf-8"))
    assert seq == 9, seq
    assert state == lyric, state
    assert "Ã" not in state["track"]["title"], state

    # 7. LV-08 sync progress: timestamp base with frozen now, updatedAt
    #    fallback, clamp, static fallback, and extract_display wiring.
    #    Playing states extrapolate; paused states stay static (no time drift).
    base = {"progressMs": 10000, "measuredAt": 1000000, "offsetMs": 0, "isPlaying": True}
    assert lcd_bridge.current_progress(base, 1002500) == 12500
    assert lcd_bridge.current_progress({**base, "offsetMs": -1500}, 1002500) == 11000
    assert lcd_bridge.current_progress({**base, "offsetMs": 500}, 1002500) == 13000
    # No measuredAt -> legacy updatedAt base (playing only).
    assert lcd_bridge.current_progress(
        {"progressMs": 5000, "updatedAt": 2000000, "isPlaying": True}, 2001000) == 6000
    # measuredAt wins over updatedAt when both are present.
    assert lcd_bridge.current_progress(
        {"progressMs": 5000, "measuredAt": 2000000, "updatedAt": 1000000,
         "isPlaying": True}, 2001000) == 6000
    # Clamp: negative extrapolation never goes below 0 (playing).
    assert lcd_bridge.current_progress(
        {"progressMs": 1000, "measuredAt": 5000, "offsetMs": -10000,
         "isPlaying": True}, 5000) == 0
    # Paused: no extrapolation even when now >> measuredAt (bar/time freeze).
    paused = {"progressMs": 10000, "measuredAt": 1000000, "offsetMs": 0, "isPlaying": False}
    assert lcd_bridge.current_progress(paused, 1002500) == 10000
    assert lcd_bridge.current_progress(paused, 1999999) == 10000
    assert lcd_bridge.current_progress({**paused, "offsetMs": 500}, 1999999) == 10500
    assert lcd_bridge.current_progress({**paused, "offsetMs": -15000}, 1999999) == 0
    # Paused nested in track scope freezes too.
    assert lcd_bridge.current_progress(
        {"track": {"progressMs": 10000, "isPlaying": False},
         "measuredAt": 1000000}, 1999999) == 10000
    # Missing isPlaying defaults to paused (static, never extrapolates).
    assert lcd_bridge.current_progress(
        {"progressMs": 10000, "measuredAt": 1000000}, 1999999) == 10000
    # No base at all -> static progressMs (+ offset), still clamped.
    assert lcd_bridge.current_progress({"progressMs": 3000}, 9999999) == 3000
    assert lcd_bridge.current_progress({"progressMs": 3000, "offsetMs": -5000}, 9999999) == 0
    assert lcd_bridge.current_progress({}, 12345) == 0
    assert lcd_bridge.current_progress({"progressMs": "garbage", "measuredAt": "nope"}, 12345) == 0
    # extract_display extrapolates with a frozen clock and stays static
    # for legacy states without any base.
    shown = lcd_bridge.extract_display({**base, "durationMs": 180000}, now_ms=1002500)
    assert shown["progressMs"] == 12500, shown
    frozen = lcd_bridge.extract_display({**paused, "durationMs": 180000}, now_ms=1999999)
    assert frozen["progressMs"] == 10000, frozen
    assert frozen["isPlaying"] is False, frozen
    legacy = lcd_bridge.extract_display({"progressMs": 45000, "durationMs": 180000}, now_ms=9999999)
    assert legacy["progressMs"] == 45000, legacy

    print("test_bridge: OK (rotation + header 854x480 + exit2 + fps clamp + envelopes + sync progress)")


if __name__ == "__main__":
    main()
