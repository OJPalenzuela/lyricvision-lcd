# LyricVision LCD — project context (carryover for future sessions)

> LV-03 scaffold doc. Source of truth for scope/acceptance is
> `odd/tasks/lyricvision-lcd.md`.

## Problem

Display Spotify synced lyrics on a Thermalright USB LCD. Requirements verified
against real hardware:

- **App layer:** full app (auth, polling, lyrics, tray) with tested panel
  tables, versioned bridge protocol with ACK, and automated tests.
- **USB layer:** correct layout (handshake, PM/SUB identity) verified
  against the real glass, plus a complete app layer.

This repo implements both layers to those requirements.

## Why this repo exists

The user owns a **Peerless Assassin 120 Vision MAX** whose exact USB
profile (PM=11/SUB=5, landscape-buffer + 90° CW software rotation) was
reverse-engineered **live against the real glass**. No existing project
drives this panel with lyrics. This repo is that project.

## Infra decided (LV-02, 6 blocks)

1. **Electron shell (latest LTS)** — UI, tray, Spotify auth/polling,
   lyrics pipeline; `com.lyricvision.app`, NSIS per-user oneClick.
2. **Hardened Python sidecar (PyInstaller onefile)** — owns all USB I/O
   via PyUSB/WinUSB; pinned deps with hashes (`bridge/requirements.txt`).
3. **Versioned bridge protocol with ACK/heartbeat/backpressure** —
   project requirement (designed LV-02, built LV-04).
4. **Spotify PKCE + adaptive polling (2–4 s active / 15 s idle)** —
   tokens stored in safeStorage (LV-05/06).
5. **LRCLIB synced-lyrics source + LRU/TTL caches** — project requirement.
6. **Render portrait 480×854 → rotate 90° CW → JPEG q80 4:2:0 →
   854×480 buffer** — project choice (q80); continuous stream (~5 fps
   minimum tested) because the firmware blanks without it.

## Registry final (LV-01, locked)

| Panel | PM | SUB | USB buffer | Glass | Transform | Encoding |
|---|---|---|---|---|---|---|
| Peerless Assassin 120 Vision MAX | 11 | 5 | 854×480 landscape | 480×854 portrait | rot90cw | JPEG |
| Vision 360 family | 72 / 129 | any | 480×480 | 480×480 square | none | JPEG |
| anything else | — | — | — | — | — | explicit `unknown`, never a silent guess |

Transport: USBDISPLAY **87AD:70DB**, interface 0 class **0xFF**, bulk
**OUT 0x01 / IN 0x81**, wMaxPacketSize **512**, WinUSB driver (no Zadig).

## Transform locked

`ROTATE_90_CW` (`panels/registry.py`): the app composes portrait at glass
resolution and rotates 90° clockwise into the landscape USB buffer —
`dst(x', y') = src(W-1-y', x')`, i.e. `np.rot90(img, k=-1)`.

## Glass evidence (observed live, LV-01)

- Orange 320×240 letterbox → firmware fits by width + letterboxes.
- Green 480×854 wrong-orientation frame → rotation sense still off at that point.
- Red/blue halves landing blue-top/red-bottom → correct rotation sense.
- ARRIBA/ABAJO markers upright and placed → no mirror, full-bleed
  410880 px confirmed, continuous stream required (panel blanks otherwise).

## Handshake (locked)

64 bytes: magic echo `12 34 56 78` + `"SSCRM-V1"`;
**PM = resp[24] = 11**, **SUB = resp[36] = 5**.
Frame = cmd **2** + 64-byte header (magic u32 LE @0, cmd @4, w LE @8,
h LE @12, mode 2 @0x38, payload len LE @0x3C) + JPEG payload in
**16 KiB** chunks + **ZLP when total % 512 == 0**.

## Exclusivity warning

**TRCC and SignalRGB open the device exclusively.** The design must
detect that condition and tell the user to quit those tools before
claiming (detection/reporting only — the probe itself is NOT LV-03).

## Design decisions (locked)

- **USB layer:** handshake layout, PM/SUB identity, bulk endpoint map,
  verified against real hardware.
- **App layer:** Electron shell, polling loop, LRCLIB pipeline —
  hardened (safeStorage, ACK protocol, q80, fully async).
- **Rejected by design:** plaintext tokens, JSONL no-ACK pipe, fixed q90,
  `Atomics.wait` blocking, unpinned Python deps.

## Package manager

pnpm-only (`packageManager` pinned, `preinstall: only-allow pnpm`, `pnpm-lock.yaml` committed, build approvals in `pnpm-workspace.yaml`); pnpm over bun because bun cannot run the Electron runtime.

## Pointers
- Acceptance: `odd/tasks/lyricvision-lcd.md`; implementation: `panels/`,
  `bridge/`, `tests/`, `docs/`.

## Checklist LV

- [x] LV-01 panel characterized live
- [x] LV-02 infra decided
- [x] LV-03 scaffold (this doc + structure/configs/registry/protocol/smokes)
- [x] LV-04 bridge v0.1 (handshake, lookup, render+rotate+encode, ACK/heartbeat)
- [x] LV-05 shell v0.1 (auth, polling, lyrics, tray, lcdStatus)
- [x] LV-06 hardening (timeouts, retry/backoff, safeStorage, validation)
- [ ] LV-07 packaging (PyInstaller + electron-builder, CI smoke) — open
- [x] LV-08 sync tuning (timestamp-base progress, 2s poll while playing, manual offsetMs)
- [x] LV-09 unified layout (cover+lyrics in a single view; time/bar fix)
