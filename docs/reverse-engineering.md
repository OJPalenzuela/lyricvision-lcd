# Reverse engineering notes

How the closed Thermalright USB protocol was identified and turned
into the open bridge in this repo. Facts only: everything below was
observed against real glass or follows directly from
`docs/project-context.md`, `panels/registry.py`, and
`bridge/protocol.py`.

## USB identification

The panel exposes USBDISPLAY **87AD:70DB** on interface 0, class
**0xFF**, with bulk **OUT 0x01 / IN 0x81** and wMaxPacketSize
**512**. The driver path is WinUSB with no Zadig step. TRCC and
SignalRGB open the device exclusively, so only one program can claim
it at a time.

## Panel registry and PM/SUB identity

Identity comes from the handshake response: **PM at byte 24** and
**SUB at byte 36** (`PM_OFFSET`, `SUB_OFFSET`). `panels/registry.py`
maps each pair through `lookup(pm, sub)` to a `PanelProfile`:

- Vision MAX: PM **11** / SUB **5**, buffer **854x480**, glass
  **480x854** portrait, rotation `rot90cw`, JPEG.
- Vision 360 family: PM **72** / **129**, any SUB, **480x480**
  square, no rotation, JPEG.
- Anything else returns the explicit `UNKNOWN` sentinel
  (`known=False`). The bridge never guesses silently.

## Handshake and frame header

The 64-byte handshake carries magic `12 34 56 78` plus `"SSCRM-V1"`
and echoes PM/SUB back. Each frame sends command **2** with a 64-byte
little-endian header (`build_frame_header`): magic u32 at 0, command
at 4, width at 8, height at 12, mode 2 (JPEG) at `0x38`, payload
length at `0x3C`.

## Encoding and bulk streaming

Frames are JPEG quality 80, 4:2:0. Payloads go out in **16 KiB**
chunks (`CHUNK_SIZE`, `iter_chunks`) with a zero-length packet when
the total is an exact multiple of 512 bytes (`BULK_PACKET`).

## ACK, heartbeat, and backpressure

The shell sends versioned JSONL state with `seq` over stdin. The
bridge answers with `{"type":"ack","seq":N}` per rendered frame and
`{"type":"status"}` at about 1 Hz, plus heartbeat monitoring with
automatic restart and backoff. Exits: 0 clean, 2 unknown panel, 3
device busy or absent.

## Orientation

The app composes portrait at glass resolution (**480x854**), then
rotates 90 degrees clockwise into the **854x480** USB buffer
(`ROTATE_90_CW`, equivalent to `np.rot90(img, k=-1)`).

## Physical validation (Vision MAX)

Validated live on glass at full bleed (**410880 px**): an orange
320x240 frame letterboxed by width, a green 480x854 frame with the
wrong rotation sense, red/blue halves landing blue-top/red-bottom,
and ARRIBA/ABAJO markers upright with no mirror. The firmware blanks
without a continuous stream (about 5 fps minimum, default 10).

## Further reading

- Panel rows and lookup rules: `panels/registry.py`
- Wire constants and chunking: `bridge/protocol.py`
- Sidecar flags (`--preview`, `--once`): `bridge/README.md`
- App and bridge split: [Architecture](architecture.md)
