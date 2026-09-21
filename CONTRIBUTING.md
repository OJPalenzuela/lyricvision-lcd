# Contributing to LyricVision LCD

LyricVision LCD is Windows-only (v0.1), pnpm-only, and built around
real Thermalright USB glass. Contributions are welcome with or
without physical hardware.

## Ways to contribute

- Report reproducible bugs with environment details and redacted logs.
- Report panel compatibility with VID/PID, photos, and detection results.
- Improve lyrics handling, frame rendering, tray UI, or app settings.
- Harden the Python bridge protocol handling (timeouts, recovery, logging).
- Improve docs, troubleshooting steps, and first-run guidance.

## Without hardware vs with hardware

Without a panel you can contribute software and docs changes: shell
logic, lyrics pipeline, caches, UI, tests, and documentation. These
areas run fully hardware-free.

Changes to USB transfer, display output, panel registry rows, or frame
encoding require the physical glass. Untested USB or display changes
are not accepted: every such change must be validated on real hardware.

## Toolchain (Windows)

- Node.js LTS plus pnpm (pnpm-only: never use npm or bun).
- Run `pnpm install`, then `pnpm approve-builds` when prompted for
  build-script approvals (see `pnpm-workspace.yaml`).
- Python 3.14 with a project-local virtual environment for the bridge:

```bat
python -m venv .venv
.venv\Scripts\activate
pip install -r bridge\requirements.txt
```

## Checks without hardware

Hardware-free checks must pass before any pull request:

```bash
python tests/test_registry.py
python tests/test_protocol.py
python tests/test_bridge.py
python tests/test_cover.py
node tests/test_sync_settings.js
node tests/test_hardening.js
```

`node tests/test_shell_spawn.js` needs the physical panel with
TRCC and SignalRGB fully closed. Without glass the bridge exits 3
(`blocked`), so CI runs it with `continue-on-error`. Run it locally
only when glass is connected.

The bridge also renders without USB for visual checks:

```bat
python bridge\lcd_bridge.py --preview "%TEMP%\lv-preview.png"
```

## Diagnostics and privacy

Export diagnostics from the app window and attach the redacted file
to bug reports. Never include tokens, client secrets, USB serial
numbers, or absolute private paths. See
[Troubleshooting](docs/troubleshooting.md) for the export steps and
[Privacy and local data](docs/privacy-data.md) for what stays local.

## Commits

Use conventional commits (`feat:`, `fix:`, `docs:`, `chore:`,
`test:`). Keep diffs minimal and factual. Never commit secrets or
local-only paths.

## Where to open issues

- Bugs: [bug report](.github/ISSUE_TEMPLATE/bug_report.md)
- Features: [feature request](.github/ISSUE_TEMPLATE/feature_request.md)
- Panels: [hardware compatibility report](.github/ISSUE_TEMPLATE/hardware-compatibility.yml)

Start with [Project context](docs/project-context.md) (locked
hardware facts), then [Architecture](docs/architecture.md),
[Troubleshooting](docs/troubleshooting.md), and [FAQ](docs/faq.md).
