# Roadmap

Direction for LyricVision LCD. No dates — order only. Source of truth for scope and acceptance is `odd/tasks/lyricvision-lcd.md`; notable changes land in [CHANGELOG](CHANGELOG.md).

## v0.1 (current line)

- LV-07 Packaging: PyInstaller sidecar plus electron-builder installer, CI pre-pack smoke. Open.
- Polish the end-user path: install guide, troubleshooting, first-run behavior with the panel connected.
- Sync tuning follow-up (LV-08b, if needed): send full LRC lines to the bridge if the current timestamp-base progress plus manual offset still feels coarse.

## v0.2 (next)

- Code signing for the installer and sidecar so SmartScreen no longer warns on unknown publisher.
- Packaged CJK font bundled with the sidecar (no user install step); v0.1 CJK rendering is best-effort.
- pytest adoption with a red-green-refactor cycle for the current plain-assert smoke scripts.
- Manual GUI verification backlog from `docs/shell-notes.md` (boot, tray, vault migration, OAuth round-trip, Startup shortcut, TRCC warning path, long-horizon soak).

## Future (exploring)

- Broader panel coverage beyond Vision MAX and the Vision 360 family.
- Richer on-glass views (queue, playback controls feedback) while keeping the single unified layout.
- Publish flow: signed Releases, install verification, contribution process in [CONTRIBUTING](CONTRIBUTING.md).
