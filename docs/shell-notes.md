# Shell v0.1 notes (LV-05)

Source of truth for scope: `odd/tasks/lyricvision-lcd.md`.
Sidecar contract: `bridge/README.md` (versioned envelopes + ack, exits 0/2/3).

## What the shell does

- `src/main.js` — settings (`%userData%/settings.json`, whitelist + types),
  token vault via `safeStorage` (`%userData%/tokens.bin`, one-way migration
  that wipes plaintext keys), Spotify PKCE S256 + 60 s refresh margin +
  adaptive polling (3 s playing / 15 s idle, `pollInFlight` guard), LRCLIB
  (`/api/get` then scored `/api/search`, timeout + 2 retries backoff+jitter,
  honors 429, disk LRU 200 + 30 d TTL), sidecar lifecycle (versioned
  envelopes with `seq` + ack pairing, exits 2/3 mapped to `lcdStatus`),
  extended `lcdStatus` (ok/degraded/bridge-wedged/panel-unknown/auth-error/
  offline), single-instance, tray with hide, per-user Startup `.lnk`
  (create/remove only, no elevation), TRCC/SignalRGB detect-and-warn.
- `src/bridge-spawn.js` — the exact spawn path (dev `.venv` python with
  `python` fallback; packaged `resources/lcd_bridge.exe`). Pure Node so
  `tests/test_shell_spawn.js` exercises it headless.
- `src/preload.js` — minimal surface (`settings:get/save`,
  `spotify:connect`, `display:list`, `window:minimize/hide/show`,
  `app:refresh`, `startup:set`, push `player-state` + `spotify-auth`).
  `contextIsolation:true`, no tokens to the renderer (only
  `{connected,expiresAt}`).
- `src/renderer/` — vanilla English UI (client-ID connect, FPS slider 5–30,
  status grid, TRCC guide). `textContent` only, meta CSP.

## Paths NOT proven headless (node --check + spawn test only)

These need the app actually running (`pnpm install` then `pnpm start` on
Windows with the panel connected and TRCC/SignalRGB closed):

1. **GUI boot** — `BrowserWindow` creation, `preload.js` bridge
   (`window.lyricvision`), renderer first paint. Headless CI has no
   Electron window. Manual: `pnpm start`, confirm the window renders and
   DevTools shows no CSP violations.
2. **Real tray** — `Tray` icon/menu/click/hide only exist inside Electron.
   Manual: close the window (it should hide, not quit), toggle Show/Hide
   from the tray menu, Quit from the tray menu.
3. **safeStorage vault** — `safeStorage.isEncryptionAvailable()` /
   encrypt/decrypt and the plaintext migration only run in Electron.
   Manual: with a legacy `settings.json` containing `accessToken`, start
   the app, confirm the tokens move to `tokens.bin` and the plaintext
   keys disappear; restart and confirm Spotify stays connected.
4. **OAuth browser round-trip** — PKCE authorize → local
   `http://127.0.0.1:{17321-17331}/callback` → token exchange, including
   the EADDRINUSE fallback chain. Manual: Connect Spotify, occupy 17321
   first (e.g. `python -m http.server 17321`) and confirm the flow still
   completes on a fallback port; block all 11 ports and confirm the
   actionable error surfaces.
5. **Startup `.lnk`** — creation/removal in the per-user Startup folder via
   PowerShell `WScript.Shell`. Manual: toggle Start-with-Windows on/off,
   verify `…\Startup\LyricVision LCD.lnk` appears/disappears, reboot-check
   once.
6. **TRCC/SignalRGB warning path** — `tasklist` parsing only runs on
   Windows in the app. Manual: open TRCC, confirm the UI shows the
   quit-before-claim warning and `lcdStatus` reports degraded/offline with
   the blocked reason; close TRCC and confirm recovery.
7. **Long-horizon behavior** — 60 s refresh margin, watchdog
    (LV-06: bridge-wedged after 5 s without status NOR ack while a stream
    is expected; sidecar auto-restarts with backoff 1 s/2 s/4 s… cap 30 s,
    restart counter visible in `lcdStatus`), 30 d lyrics TTL eviction.
    Manual: soak-test with music playing and watch `lcdStatus` + tray
    tooltip over a token-expiry boundary.

## Manual test checklist (app running)

- [ ] Window boots, no CSP errors in DevTools console.
- [ ] Spotify connect completes; restart keeps the session (vault works).
- [ ] Lyrics advance on the glass; pause → poll cadence drops (15 s idle).
- [ ] FPS slider 5–30 clamps; out-of-range values rejected with notice.
- [ ] `display:list` shows `Vision MAX (PM 11 / SUB 5)`.
- [ ] Kill the bridge process → `lcdStatus` goes bridge-wedged with the
  restart counter, sidecar restarts with backoff.
- [ ] Diagnostics section → Export writes `%userData%/diagnostics-<ts>.json`
  (redacted settings, no tokens/serials) and the UI shows the path.
- [ ] Open TRCC → degraded/blocked warning appears; close → recovers.
- [ ] Tray hide/show/quit; Startup toggle creates/removes the `.lnk`.
