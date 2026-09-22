# Roadmap

Direction for LyricVision LCD. No dates — order only. Source of truth for scope and acceptance is `odd/tasks/lyricvision-lcd.md`; notable changes land in [CHANGELOG](CHANGELOG.md).

## v0.1 (current line)

- LV-07 Packaging: PyInstaller sidecar plus electron-builder installer, CI pre-pack smoke. Open.
- Polish the end-user path: install guide, troubleshooting, first-run behavior with the panel connected.
- Sync tuning follow-up (LV-08b, if needed): send full LRC lines to the bridge if the current timestamp-base progress plus manual offset still feels coarse.
- Renderer test suite: the React + shadcn/ui rewrite has no automated coverage yet — add a runner and cover behaviour parity (settings load/save, slider ranges, startup toggle rollback, listener cleanup, status rendering).
- Dev-loop correctness: `scripts/dev.js` polls a hardcoded 5173 while plain `vite` auto-increments, so Electron can attach to the wrong server (use `--strictPort`); its `child.kill()` sends SIGTERM, which Win32 ignores, leaving orphaned vite/electron processes after Ctrl-C (needs `taskkill /T /F`).
- Dev docs drift: `pnpm start` now means `build && electron .` (production). Docs and comments that still describe it as the dev command must move to `pnpm run dev`.
- Honest exclusivity copy: the status line reads "No exclusive holder detected" but `detectExclusivityHolders()` only scans `tasklist` for `trcc.exe`/`signalrgb.exe` — it never inspects the real device handle. Reword so the UI does not claim more than it verifies.

## v0.2 (next)

- Code signing for the installer and sidecar so SmartScreen no longer warns on unknown publisher.
- Packaged CJK font bundled with the sidecar (no user install step); v0.1 CJK rendering is best-effort.
- pytest adoption with a red-green-refactor cycle for the current plain-assert smoke scripts.
- Manual GUI verification backlog from `docs/shell-notes.md` (boot, tray, vault migration, OAuth round-trip, Startup shortcut, TRCC warning path, long-horizon soak).
- Album art in the renderer: `player.track.artworkUrl` already reaches the UI but production CSP is `img-src 'self' data:` by design. Showing it needs an explicit, scoped CSP decision (e.g. allow only the Spotify CDN) plus an `onError` fallback.
- Feature documentation in-repo: `odd/` is gitignored, so the ODD feature documents and this roadmap's source of truth never travel with the repo or reach a PR reviewer.

## Future (exploring)

- Broader panel coverage beyond Vision MAX and the Vision 360 family.
- Richer on-glass views (queue, playback controls feedback) while keeping the single unified layout.
- Publish flow: signed Releases, install verification, contribution process in [CONTRIBUTING](CONTRIBUTING.md).
