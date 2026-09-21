# Hardware support

Windows 10/11 x64 only. Only one program can own the panel at a time:
quit TRCC and SignalRGB completely before starting the app.

## Panel matrix (v0.1)

| Panel | Status | USB buffer | Glass | Transform |
|---|---|---|---|---|
| Peerless Assassin 120 Vision MAX (PM 11 / SUB 5) | Tested, primary target | 854x480 landscape | 480x854 portrait | rotate 90 deg CW in software |
| Vision 360 family (PM 72 / 129, any SUB) | Experimental, not validated | 480x480 | 480x480 square | none |
| Anything else | Not supported | — | — | explicit `unknown` fallback, never a silent guess |

The Vision 360 rows exist in `panels/registry.py` for identification
but have no physical validation in this project, so they are not
declared compatible. Unknown panels surface as `panel-unknown`
(bridge exit 2) instead of receiving wrong pixels. A `blocked` or
`no-device` status (bridge exit 3) means the device is busy or
absent: quit TRCC and SignalRGB, reconnect USB, and retry.

## Expectations

- Tested (Vision MAX): bug reports with repro steps and redacted logs.
- Experimental (Vision 360): compatibility reports welcome; fixes need glass validation.
- Unknown panels: identification reports only; no display changes without the panel.

## How to report a panel

1. Quit TRCC and SignalRGB, reconnect USB, and note what each tool
   reports.
2. Open a [hardware compatibility report](../.github/ISSUE_TEMPLATE/hardware-compatibility.yml)
   with VID/PID, Windows version, panel photos, a Device Manager
   screenshot, and detection results.
3. Attach the redacted diagnostics export (never include tokens,
   secrets, USB serials, or private paths).
4. Keep the panel connected if a maintainer asks for a follow-up
   capture; USB and display changes require validation on real glass.

Background on the protocol: [Reverse engineering notes](reverse-engineering.md).
Stuck? See [Troubleshooting](troubleshooting.md) and [FAQ](faq.md).
