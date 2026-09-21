# Install (Windows end users)

LyricVision LCD shows synced Spotify lyrics on a Thermalright USB LCD panel. This guide covers a standard install. No developer tools are required.

## Requirements

- Windows 10 or 11 (64-bit).
- A supported Thermalright USB LCD panel, connected over USB. The Peerless Assassin 120 Vision MAX is the primary target; anything else is best-effort only (see the [FAQ](faq.md)).
- A Spotify application client ID (free; no client secret needed). How to create one: [Spotify setup](spotify-setup.md).
- An internet connection (Spotify polling and LRCLIB lyrics).
- TRCC and SignalRGB closed — they hold the panel exclusively.

## Steps

1. Go to the project **Releases** page and download the latest Windows installer (`.exe`).
2. Run the installer. Windows SmartScreen will warn about an unknown publisher because v0.1 ships unsigned — click "More info" → "Run anyway", but proceed only if you downloaded it from Releases.
3. Connect the panel over USB if it is not already connected.
4. Quit TRCC and SignalRGB completely (check the system tray).
5. Start LyricVision LCD from the Start menu.
6. Paste your Spotify client ID into the Client ID field and click Connect, then complete the browser sign-in. Details: [Spotify setup](spotify-setup.md).
7. Press play in Spotify. Cover art, progress, and synced lyrics appear on the panel within a few seconds. Full walkthrough: [First run](first-run.md).
8. Optional: adjust the stream rate (FPS slider, 5–30, default 10) and the lyric sync offset (−2000 ms to +2000 ms) to taste.

## If something goes wrong

- Panel busy or blank, unknown panel, no lyrics, or lyrics out of sync: see [troubleshooting](troubleshooting.md).
- Spotify sign-in problems: confirm the client ID has no extra spaces and that the redirect back to the app completes in the browser. More: [Spotify setup](spotify-setup.md).
- Short answers on panels, accounts, tokens, and SmartScreen: [FAQ](faq.md).

## Notes

- Tokens are stored in the OS credential vault, never as plaintext.
- Diagnostics export (in the app window) writes a redacted JSON file with no tokens or serials — safe to attach to bug reports.
- What still blocks a v0.1.0 public release (signing, clean-machine validation): [release checklist](release-checklist.md).

## Next steps

- First launch walkthrough with expected app states: [First run](first-run.md).
- Build and packaging internals (PyInstaller sidecar, electron-builder NSIS): [packaging](packaging.md).
