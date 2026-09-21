"""Version-0 wire constants for the Thermalright USB LCD bridge.

LV-03 scope: pure constants and pure helpers only. No USB I/O here;
the live bridge (claim, handshake exchange, streaming loop) lands in LV-04.

Transport recap (locked, LV-01): USBDISPLAY 87AD:70DB, interface 0
class 0xFF, bulk OUT endpoint 0x01 / IN 0x81, wMaxPacketSize 512,
WinUSB driver, no Zadig needed.
"""

import struct
from typing import Iterator, Tuple

# --- Handshake (64 bytes, host -> device then device -> host) ---
HANDSHAKE_SIZE = 64
HANDSHAKE_MAGIC = bytes((0x12, 0x34, 0x56, 0x78))  # echoed back by device
HANDSHAKE_TAG = b"SSCRM-V1"
PM_OFFSET = 24  # panel model byte in the device response
SUB_OFFSET = 36  # panel sub-model byte in the device response

# --- Frame header (64 bytes, little-endian) ---
HEADER_SIZE = 64
MAGIC = 0x78563412  # u32 LE @0; on the wire: 12 34 56 78
OFF_MAGIC = 0
OFF_CMD = 4  # u32 LE: command id
OFF_W = 8  # u16 LE: buffer width
OFF_H = 12  # u16 LE: buffer height
OFF_MODE = 0x38  # u8: payload mode (2 = JPEG)
OFF_PAYLOAD_LEN = 0x3C  # u32 LE: payload byte length

CMD_FRAME = 2  # still-image frame command
MODE_JPEG = 2

# Panel model value that selects RGB565 big-endian raw encoding
# instead of JPEG (kept as a constant so LV-04 never hardcodes it).
PM_RGB565BE = 32

# --- Bulk streaming ---
CHUNK_SIZE = 16 * 1024  # payload split into 16 KiB bulk writes
BULK_PACKET = 512  # wMaxPacketSize; a transfer ending on this boundary needs a ZLP


def parse_handshake(resp: bytes) -> Tuple[int, int]:
    """Extract ``(pm, sub)`` from a raw handshake response.

    Raises ``ValueError`` on short/empty responses instead of returning
    a guessed default.
    """
    if len(resp) <= SUB_OFFSET:
        raise ValueError(
            f"handshake response too short: {len(resp)} bytes, "
            f"need more than {SUB_OFFSET}"
        )
    return resp[PM_OFFSET], resp[SUB_OFFSET]


def build_frame_header(w: int, h: int, cmd: int, payload_len: int) -> bytes:
    """Build the 64-byte little-endian frame header.

    Layout: magic u32 @0, cmd u32 @4, w u16 @8, h u16 @12,
    mode u8 @0x38, payload length u32 @0x3C; all other bytes zero.
    """
    header = bytearray(HEADER_SIZE)
    struct.pack_into("<I", header, OFF_MAGIC, MAGIC)
    struct.pack_into("<I", header, OFF_CMD, cmd)
    struct.pack_into("<H", header, OFF_W, w)
    struct.pack_into("<H", header, OFF_H, h)
    header[OFF_MODE] = MODE_JPEG
    struct.pack_into("<I", header, OFF_PAYLOAD_LEN, payload_len)
    return bytes(header)


def iter_chunks(payload: bytes) -> Iterator[Tuple[bytes, bool]]:
    """Yield ``(chunk, need_zlp)`` pairs for a frame payload.

    Payload goes out in 16 KiB bulk writes. ``need_zlp`` is True only on
    the last chunk when the total payload length is an exact multiple of
    the 512-byte bulk packet size (a transfer ending on a packet boundary
    must be terminated with a zero-length packet). Empty payloads yield
    nothing.
    """
    total = len(payload)
    zlp = total > 0 and total % BULK_PACKET == 0
    for offset in range(0, total, CHUNK_SIZE):
        chunk = payload[offset : offset + CHUNK_SIZE]
        last = offset + CHUNK_SIZE >= total
        yield chunk, (zlp and last)
