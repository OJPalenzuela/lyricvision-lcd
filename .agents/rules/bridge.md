# Bridge Rules (Python Sidecar)

Adapted backend rules for this project's "backend": a Windows-only Python sidecar that owns USB. No NestJS/HTTP — the contract is stdin/stdout JSONL.

## Module Layout

```text
bridge/
├── lcd_bridge.py    Sidecar entry: handshake, lookup, rotate, encode, bulk transfer
├── protocol.py      Versioned envelope encode/decode (JSONL, seq + ack)
├── lcd_bridge.spec  PyInstaller spec -> resources/lcd_bridge.exe
└── requirements.txt Pinned deps with sha256 hashes (pip-compile workflow)
panels/
└── registry.py      Panel rows: VID/PID, PM/SUB identity, handshake bytes
```

## Wire Contract (I/O contract)

- **stdin** is commands: versioned JSONL envelopes from `src/bridge-spawn.js`, each with `seq`.
- **stdout** is data/status only: one ack per frame, ~1 Hz status lines. Logs and diagnostics go to stderr.
- **Never** mix logs into stdout — it corrupts the envelope stream the shell parses.

## Rules

- Envelope version fields are part of the contract: bump deliberately in both `protocol.py` and `src/bridge-spawn.js`, and keep `bridge/README.md` in sync.
- Every envelope on stdin gets an ack on stdout; lost/duplicate `seq` handling must stay deterministic (see `tests/test_protocol.py`).
- Exit codes are API: `0` clean, `2` crash, `3` blocked (device held by TRCC/SignalRGB). The shell maps these to restart/backoff — do not renumber.
- USB transfer specifics are load-bearing: 16 KiB chunks, ZLP rule, 90° CW rotate into 854x480, JPEG q80 4:2:0. Changing any of these requires physical-hardware validation.
- Panel rows are data, not code: add capability variants in `panels/registry.py`, never by branching on VID/PID in `lcd_bridge.py`.

## Dependency Management

- `bridge/requirements.txt` is generated with `pip-compile --generate-hashes`. To change a pin: edit/create `bridge/requirements.in`, recompile, then verify with `pip install --require-hashes -r bridge\requirements.txt`.
- Never hand-edit hashes or add an unpinned dependency.
- Interpreter: CPython 3.14, win_amd64 — wheels are platform-specific.

## Error Handling

- Bridge failures surface to the shell as exit codes + stderr text, never as partial stdout envelopes.
- Preview mode (`python bridge\lcd_bridge.py --preview "%TEMP%\lv-preview.png"`) renders without USB — use it for visual checks when no hardware is attached.

## Testing

- Hardware-free: `python tests/test_protocol.py`, `python tests/test_bridge.py`, `python tests/test_registry.py`, `python tests/test_cover.py` — all must exit 0.
- Hardware-dependent: `pnpm run verify:spawn` only with the panel connected and TRCC/SignalRGB closed.
