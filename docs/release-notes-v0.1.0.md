# Release Notes v0.1.0

Status: Windows installer release. The attached installer was built for
this tag and tested by the maintainer on real hardware.

## Highlights

Initial public release for LyricVision LCD: Spotify-synced lyrics,
cover artwork, and progress on a Thermalright USB LCD panel.

## Features

- Spotify sign-in with OAuth 2.0 PKCE (S256), no client secret required.
- Synced lyrics pipeline via LRCLIB, with local cache for repeat plays.
- Cover artwork, playback progress bar, and current plus next line view.
- Unified on-glass layout for cover and lyrics in a single view.
- Vision MAX rendering path: portrait composition with 90-degree rotation
  and JPEG encoding.
- Python bridge with versioned JSONL protocol, per-frame ACK, and
  heartbeat with backpressure handling.
- System tray with LCD status and hide-to-tray behavior.
- Start-with-Windows toggle (per-user, no elevation).
- Conflict detection for TRCC and SignalRGB with quit-before-claim warning.
- Bridge recovery with automatic restart and backoff on wedge or exit.
- Manual lyric sync offset for early or late lines.
- Adjustable stream rate for glass updates.
- Redacted diagnostics export safe to attach to bug reports.

## Compatibility

- Primary: Peerless Assassin 120 Vision MAX (PM 11 / SUB 5).
- Experimental: Vision 360 family (PM 72 / 129, any SUB).
  Present as a registry entry only; not physically validated here.
- Anything else reports an explicit unknown-panel state.

## Known limitations

- Windows 10/11 x64 only.
- Ships unsigned: Windows SmartScreen will warn about an unknown publisher.
- Synced lyrics are not available for every track; cover and progress
  remain visible when lyrics are missing.
- Only one program can own the USB device; TRCC and SignalRGB must be
  closed before claiming the panel.
- No formal test runner yet; smoke checks are plain-assert scripts.
- Installer validation so far is maintainer-tested on one machine;
  reports from fresh Windows installs are welcome via the bug template.

## Feedback

Report panel mismatches with PM/SUB values and the redacted
diagnostics export. Do not include tokens, secrets, or serials.
See [Troubleshooting](troubleshooting.md) for the export steps.

## References

- Full history: [CHANGELOG](../CHANGELOG.md).
- Release validation: [Release checklist](release-checklist.md).
- End-user install: [Install](install.md).
- Signing research: [Code signing](code-signing.md).
