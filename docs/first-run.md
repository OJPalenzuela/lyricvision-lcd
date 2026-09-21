# First Run

This guide takes a fresh install to lyrics on the glass. It assumes
the installer already ran — see [install](install.md) otherwise —
and that you have a Spotify application client ID ready. If not,
create one first: [Spotify setup](spotify-setup.md).

## Steps

1. Connect the Thermalright USB LCD panel over USB.
2. Quit TRCC and SignalRGB completely (check the system tray, not
   just the window). They hold the panel exclusively.
3. Start LyricVision LCD from the Start menu.
4. Paste your Spotify client ID into the **Client ID** field and
   click **Connect**, then complete the browser sign-in.
5. Press play in Spotify.
6. Within a few seconds, cover art, progress, and synced lyrics
   appear on the panel.
7. Optional: adjust the stream rate (FPS slider, 5–30, default 10)
   and the lyric sync offset (−2000 ms to +2000 ms) to taste.

## Expected states

Check the status grid in the app window:

- **Spotify Connected** — the OAuth flow completed and playback
  polling is running. If not: see [Spotify setup](spotify-setup.md),
  then [troubleshooting](troubleshooting.md).
- **Lyrics Synced** — LRCLIB returned synced lines for this track
  and they advance with the music. If the panel shows art but no
  lines, the track likely has no synced lyrics — see
  [troubleshooting](troubleshooting.md) and the [FAQ](faq.md).
- **Bridge Healthy** — the Python sidecar is running and answering
  heartbeats. A `bridge-wedged` state means no heartbeat arrived
  for over 5 s; the shell restarts the sidecar automatically with
  backoff. If it persists: see [troubleshooting](troubleshooting.md).
- **LCD Connected** — the panel answered the handshake with a known
  PM/SUB pair (Vision MAX: PM 11 / SUB 5). A `panel-unknown` or
  busy state means another program holds the device or the model
  is not in the registry — quit TRCC/SignalRGB, reconnect USB, and
  see [troubleshooting](troubleshooting.md).

## If it still fails

1. Export diagnostics from the Diagnostics section in the app window.
2. The file is redacted by design — safe to attach to bug reports.
3. Check the [FAQ](faq.md) for account, panel, and SmartScreen notes.
4. Confirm what remains open for v0.1.0 in
   [release-checklist](release-checklist.md) before reporting
   installer or signing behavior as a bug.
