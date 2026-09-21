# Troubleshooting

Common problems and fixes for LyricVision LCD v0.1 (Windows-only).

## Panel is busy or not found

**Symptom:** the app reports `blocked`, `no-device`, or the bridge exits with code 3.

**Cause:** TRCC and SignalRGB open the panel exclusively. Only one program can own the USB device at a time.

**Fix:**

1. Quit TRCC and SignalRGB completely (check the system tray, not just the window).
2. Unplug the USB cable, wait 5 seconds, plug it back in.
3. Restart the app and press play in Spotify.

## Unknown panel (bridge exit 2)

**Symptom:** `lcdStatus` shows `panel-unknown`, or the bridge exits with code 2.

**Cause:** the handshake returned a PM/SUB pair with no registry row. v0.1 supports Vision MAX (PM 11 / SUB 5) and the Vision 360 family (PM 72 / 129, any SUB). Anything else is an explicit `unknown` fallback, never a silent guess.

**Fix:** confirm the panel model. If it is a supported panel and still fails, export diagnostics (below) and report the PM/SUB values shown in the status line.

## Bridge exits 2 vs 3

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Clean shutdown | None |
| 2 | Unknown panel | Check the panel model (see above) |
| 3 | Device busy or absent | Quit TRCC/SignalRGB, reconnect USB |

The shell restarts the sidecar automatically with backoff (1 s, 2 s, 4 s, capped at 30 s). A `bridge-wedged` status means no heartbeat or ack arrived for over 5 s while a stream was expected.

## SmartScreen warns on install

**Symptom:** Windows SmartScreen says "Unknown publisher" for the installer or the app.

**Cause:** v0.1 ships unsigned. This is expected and documented; signing is planned but not promised for any specific release.

**Fix:** only proceed if you downloaded the installer from the project Releases page. Click "More info" → "Run anyway". Never bypass SmartScreen for binaries from other sources.

## No lyrics for this track

**Symptom:** the panel shows cover art and progress but no lyric lines.

**Cause:** LRCLIB has no synced lyrics for that track, or the track metadata did not match any entry. Instrumental tracks and very new releases are the most common cases.

**Fix:** none required — the display keeps showing progress. If most tracks lack lyrics, check that the Spotify track title and artist look correct, then try again later (the app caches hits for 30 days).

## Lyrics feel early or late

**Symptom:** lines change noticeably before or after the vocals.

**Fix:** adjust the sync offset slider in the app window (range −2000 ms to +2000 ms, 0 by default). Move it in 100 ms steps while a song with clear vocals plays. Positive values delay the lines; negative values advance them.

## Exporting diagnostics

1. In the app window, open the Diagnostics section.
2. Click "Export diagnostics".
3. Share the generated `diagnostics-<timestamp>.json` file when reporting an issue.

The export is redacted by design: it contains settings, status, and recent log lines, but never tokens or device serials. Do not paste tokens, client secrets, or absolute local paths into issue reports.
