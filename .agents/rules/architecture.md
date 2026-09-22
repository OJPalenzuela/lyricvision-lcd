# Architecture Rules

## Single App Structure

Two processes with one owner of USB. The Electron shell handles everything user-facing (auth, polling, lyrics, cache, render, tray); the Python sidecar owns all USB I/O (handshake, lookup, rotate, encode, bulk transfer). The UI never touches USB directly.

```text
lyricvision-lcd/
├── src/                  Electron shell (CommonJS main + React renderer)
│   ├── main.js           Auth, polling, cache, tray, sidecar lifecycle
│   ├── preload.js        Context bridge (tokens never cross it)
│   ├── bridge-spawn.js   Sidecar spawn + envelope/ack pairing
│   ├── hardening.js      Settings whitelist/type validation
│   └── renderer/         Vite root (React 19 + Tailwind 4 + shadcn/ui)
├── bridge/               Python sidecar (CPython 3.14, pinned reqs with hashes)
│   ├── lcd_bridge.py     Handshake, rotate 90° CW, JPEG q80, bulk out
│   └── protocol.py       Versioned stdin/stdout JSONL protocol
├── panels/registry.py    Panel rows: VID/PID, PM/SUB identity, handshake bytes
├── tests/                Plain-assert smoke scripts (Python + Node)
├── docs/                 Architecture, hardware, packaging, troubleshooting
└── resources/lcd_bridge.exe   Packaged sidecar (rebuild, never hand-edit)
```

## Stack

| Layer | Technology | Version |
| ----- | ---------- | ------- |
| Shell | Electron | 44.4.3 |
| Bundler / dev server | Vite | ^8.3.0 |
| UI | React | ^19.3.0 |
| Styling | Tailwind CSS (via @tailwindcss/vite) | ^4.3.3 |
| UI components | shadcn/ui-style atoms + Radix UI | react-checkbox/label/slider/slot |
| Language | TypeScript (strict, noEmit, renderer only) | ^7.0.2 |
| Sidecar | CPython | 3.14 |
| USB / imaging | pyusb, Pillow, numpy, libusb-package | pinned + hash in `bridge/requirements.txt` |
| Packaging | electron-builder (NSIS x64, unsigned v0.1) | 26.15.3 |
| Package manager | pnpm (pnpm-only) | 12.5.1 |

## Data Flow

```text
Spotify Web API --> Electron Main (PKCE auth, adaptive polling: 2-4 s active / 15 s idle)
Electron Main --> LRCLIB lyrics + disk LRU/TTL cache --> Renderer UI (480x854 portrait layout)
Electron Main -- stdin JSONL (versioned envelopes, seq) --> Python Bridge
Python Bridge: handshake (PM/SUB) -> registry lookup -> rotate 90 deg CW -> JPEG q80 4:2:0 -> 16 KiB bulk out (ZLP rule)
Python Bridge -- stdout (status ~1 Hz, ack per frame) --> Electron Main --> tray + lcdStatus
Failure path: exit 2 (crash) / exit 3 (blocked, e.g. TRCC/SignalRGB holding the device) -> auto-restart with backoff
```

## Process ownership

| Concern | Owner |
| ------- | ----- |
| Spotify auth, tokens (safeStorage), polling | Electron shell |
| Lyrics fetch + cache, frame composition | Electron shell |
| Renderer UI, tray, settings, Startup .lnk | Electron shell |
| USB handshake, transfer, rotate, encode | Python sidecar |
| Health: seq/ack, heartbeat, ~1 Hz status | Both (contract in `bridge/README.md`) |

## Rules

- One owner of USB: only `bridge/lcd_bridge.py` opens the device. Never add WinUSB/PyUSB calls to the shell or renderer.
- The renderer loads over `file://` in production (`base: './'`) and `http://localhost:5173` in dev (`ELECTRON_RENDERER_URL`).
- Renderer privileges stay minimal: meta CSP + `setWindowOpenHandler(deny)` in `src/main.js` are load-bearing hardening — do not weaken.
- Panel capabilities come from `panels/registry.py` rows, never hard-coded VID/PID checks elsewhere.
