# Roadmap

Direction for LyricVision LCD. No dates — order only. Source of truth for scope and acceptance is `odd/tasks/lyricvision-lcd.md`; notable changes land in [CHANGELOG](CHANGELOG.md).

## v0.1 (current line)

- Polish the end-user path: install guide, troubleshooting, first-run behavior with the panel connected.
- Sync tuning follow-up (LV-08b, if needed): send full LRC lines to the bridge if the current timestamp-base progress plus manual offset still feels coarse.
- Honest exclusivity copy: the status line reads "No exclusive holder detected" but `detectExclusivityHolders()` only scans `tasklist` for `trcc.exe`/`signalrgb.exe` — it never inspects the real device handle. Reword so the UI does not claim more than it verifies.
- Resolved: dev-loop correctness — `scripts/dev.js` now spawns Vite with `--strictPort` (via `buildViteArgs()`), so a busy 5173 fails loudly instead of auto-incrementing away from the hardcoded `VITE_URL`; and `killAll()` tree-kills on Windows with `spawnSync('taskkill', ['/PID', pid, '/T', '/F'])` instead of a bare `child.kill()` SIGTERM, which never reached the `cmd.exe` wrapper the spawns create with `shell: true`. The decisions are pinned as pure functions and the dispatch is covered in `tests/unit/dev-script.test.js` (deleting the `taskkill` branch fails the suite). Real Ctrl-C orphan behaviour on a physical Windows session is not machine-verified.
- Resolved: dev docs drift — `README.md` presented `pnpm start` (= `build && electron .`) as the developer command; it now points at `pnpm run dev`, and its stale "no formal test runner is configured yet" note was replaced with the actual Vitest/pytest runners. `AGENTS.md` and `docs/shell-notes.md` already used `pnpm start` correctly. The `docs/packaging.md` claim that packaging stays local was corrected too: `release.yml` packs on `v*` tags.
- Resolved: sidecar shutdown crash (exit `3221225477` / `0xC0000005`) — the daemon stdin reader held a lock on the shared `BufferedReader` while shutdown finalized `sys.stdin`. Fixed in `bridge/lcd_bridge.py` by reading from `os.fdopen(os.dup(0), "rb")` instead (commit `342bd94`). Now exercised on hardware: `pnpm run verify:spawn` exits 0 with 3 acks (seqs 6,6,6) against the connected panel.
- Resolved: first frame arrived with no ack (`expected 3 acks, got 2`) — `reader.start()` ran after `open_device()`; it now runs before USB bring-up in `bridge/lcd_bridge.py` (commit `342bd94`). Not covered by an automated assertion: none of the 26 pytest cases checks ack ordering, and the only `expected N acks` check lives in `tests/test_shell_spawn.js`, which is hardware-gated behind `pnpm run verify:spawn`.
- Resolved: renderer test suite — `pnpm test` (Vitest 5 + React Testing Library) now covers behaviour parity in `tests/renderer/App.test.tsx`: settings load/save (`populates all five controls from getSettings`, `sends exactly the five whitelisted keys`), slider ranges (`FPS slider is bounded 5–30`, `sync offset spans −2…2 s` clamped to ±2000 ms), startup toggle rollback (`optimistically, then rolls back when setStartup rejects`), listener cleanup (`subscribes to both channels and unsubscribes both on unmount`), status rendering (`maps lcdStatus %s onto the header badge`, all six kinds). Suite total 145 tests across 6 files.
- Resolved: pytest adoption — all four Python smoke scripts (`test_bridge`, `test_cover`, `test_protocol`, `test_registry`) are pytest-collectable with 26 `def test_*` functions and stay dual-mode via `if __name__ == "__main__":`, so `pnpm test:py` and CI both run them. Their Node counterparts (`test_hardening.js`, `test_sync_settings.js`) have Vitest mirrors in `tests/unit/main-process.test.js`; only the hardware-gated `tests/test_shell_spawn.js` stays plain.
- Resolved: LV-07 packaging — all three named deliverables already exist: the PyInstaller spec (`bridge/lcd_bridge.spec`, tracked), the electron-builder installer (`build` config in `package.json`, NSIS x64, `extraResources` → `resources/lcd_bridge.exe`), and CI pre-pack smoke (`smoke.yml` on every push/PR; `release.yml` runs the same smokes as a gate before packing on `v*` tags). What remains is split out: signing is its own v0.2 item, and no workflow packs on pull requests — only on tags.

## v0.2 (next)

- Code signing for the installer and sidecar so SmartScreen no longer warns on unknown publisher.
- Packaged CJK font bundled with the sidecar (no user install step); v0.1 CJK rendering is best-effort.
- Manual GUI verification backlog from `docs/shell-notes.md` (boot, tray, vault migration, OAuth round-trip, Startup shortcut, TRCC warning path, long-horizon soak).
- Album art in the renderer: `player.track.artworkUrl` already reaches the UI but production CSP is `img-src 'self' data:` by design. Showing it needs an explicit, scoped CSP decision (e.g. allow only the Spotify CDN) plus an `onError` fallback.
- Feature documentation in-repo: `odd/` is gitignored, so the ODD feature documents and this roadmap's source of truth never travel with the repo or reach a PR reviewer.

## Future (exploring)

- Broader panel coverage beyond Vision MAX and the Vision 360 family.
- Richer on-glass views (queue, playback controls feedback) while keeping the single unified layout.
- Publish flow: signed Releases, install verification, contribution process in [CONTRIBUTING](CONTRIBUTING.md).
