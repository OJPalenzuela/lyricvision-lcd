# Changelog

All notable changes to this project are documented here.
Source of truth for scope and acceptance: `odd/tasks/lyricvision-lcd.md`.

## [v0.1.0] - 2026-09-20

Initial Windows-only v0.1 line:

- Scaffold (LV-03): repo structure, pnpm-only configs, `panels/registry.py`, versioned bridge protocol constants, plain-assert smoke tests, docs.
- Bridge v0.1 (LV-04): USB handshake, registry lookup, portrait render + 90° CW rotate + JPEG q80 encode, ACK/heartbeat with backpressure.
- Shell v0.1 (LV-05): Spotify PKCE auth, adaptive polling, LRCLIB lyrics pipeline, tray, extended `lcdStatus`.
- Hardening (LV-06): timeouts, retry with backoff/jitter, safeStorage token vault with plaintext migration, input validation.
- Sync tuning (LV-08): timestamp-based progress, 2 s poll while playing, manual `offsetMs`.
- Unified layout (LV-09): cover + lyrics in a single view; playback time/bar fix.

Notes:

- Unsigned binaries: v0.1 ships without code signing. Windows SmartScreen will warn on the installer. This blocks public release, not local dev/packaging.
- Tests: no formal runner yet; `tests/` ships as plain-assert smoke scripts runnable with `python tests/*.py`.
- Packaging (LV-07): Windows installer builds and runs (maintainer-tested); clean-machine validation still open.
- Release notes: `docs/release-notes-v0.1.0.md`.
