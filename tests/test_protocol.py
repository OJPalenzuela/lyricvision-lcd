"""Smoke test for bridge/protocol.py. pytest-collectable AND script-runnable.

Run from the repo root any of these ways:
    .venv/Scripts/python.exe -m pytest tests/test_protocol.py -v
    python tests/test_protocol.py
    python -m tests.test_protocol
"""

import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.protocol import (  # noqa: E402
    BULK_PACKET,
    CMD_FRAME,
    HEADER_SIZE,
    MAGIC,
    MODE_JPEG,
    OFF_CMD,
    OFF_H,
    OFF_MAGIC,
    OFF_MODE,
    OFF_PAYLOAD_LEN,
    OFF_W,
    build_frame_header,
    iter_chunks,
    parse_handshake,
)


def real_handshake_vector() -> bytes:
    """64-byte response shaped like the live PM11/SUB5 capture."""
    resp = bytearray(64)
    resp[0:4] = bytes((0x12, 0x34, 0x56, 0x78))  # magic echo
    resp[4:12] = b"SSCRM-V1"
    resp[24] = 11  # PM
    resp[36] = 5  # SUB
    return bytes(resp)


def test_handshake_parses_real_vector() -> None:
    pm, sub = parse_handshake(real_handshake_vector())
    assert (pm, sub) == (11, 5), (pm, sub)


def test_handshake_short_raises() -> None:
    # Short responses must raise, never return a guessed default.
    try:
        parse_handshake(b"\x00" * 10)
    except ValueError:
        pass
    else:
        raise AssertionError("short handshake must raise ValueError")


def test_frame_header_layout() -> None:
    header = build_frame_header(854, 480, CMD_FRAME, 1894)
    assert len(header) == HEADER_SIZE == 64, len(header)
    assert struct.unpack_from("<I", header, OFF_MAGIC)[0] == MAGIC
    assert header[OFF_MAGIC : OFF_MAGIC + 4] == bytes((0x12, 0x34, 0x56, 0x78))
    assert struct.unpack_from("<I", header, OFF_CMD)[0] == 2
    assert struct.unpack_from("<H", header, OFF_W)[0] == 854
    assert struct.unpack_from("<H", header, OFF_H)[0] == 480
    assert header[OFF_MODE] == MODE_JPEG == 2
    assert struct.unpack_from("<I", header, OFF_PAYLOAD_LEN)[0] == 1894


def test_chunks_single_without_zlp() -> None:
    # 1894 % 512 == 358 -> single chunk, no ZLP.
    assert 1894 % BULK_PACKET == 358
    chunks = list(iter_chunks(bytes(1894)))
    assert len(chunks) == 1, len(chunks)
    assert len(chunks[0][0]) == 1894
    assert chunks[0][1] is False, "1894-byte payload must not need ZLP"


def test_chunks_zlp_on_packet_boundary() -> None:
    chunks = list(iter_chunks(bytes(1024)))
    assert len(chunks) == 1 and chunks[0][1] is True, "1024 % 512 == 0 needs ZLP"


def test_chunks_multi_only_last_needs_zlp() -> None:
    payload = bytes(16 * 1024 + 512)  # total % 512 == 0
    chunks = list(iter_chunks(payload))
    assert len(chunks) == 2, len(chunks)
    assert chunks[0] == (payload[: 16 * 1024], False), "first chunk never needs ZLP"
    assert chunks[1][1] is True, "last chunk on a packet boundary needs ZLP"


def test_chunks_multi_no_zlp_when_unaligned() -> None:
    chunks = list(iter_chunks(bytes(16 * 1024 + 100)))
    assert [flag for _, flag in chunks] == [False, False]


def test_chunks_empty_yields_nothing() -> None:
    assert list(iter_chunks(b"")) == []


def main() -> None:
    test_handshake_parses_real_vector()
    test_handshake_short_raises()
    test_frame_header_layout()
    test_chunks_single_without_zlp()
    test_chunks_zlp_on_packet_boundary()
    test_chunks_multi_only_last_needs_zlp()
    test_chunks_multi_no_zlp_when_unaligned()
    test_chunks_empty_yields_nothing()

    print("test_protocol: OK (handshake + header + chunk/ZLP)")


if __name__ == "__main__":
    main()
