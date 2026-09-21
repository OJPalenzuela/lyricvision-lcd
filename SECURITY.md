# Security Policy

## Scope

LyricVision LCD desktop app (Electron shell) and the Python USB bridge
sidecar on Windows. Out of scope: Spotify Web API, LRCLIB service,
Thermalright firmware, and third-party tools (TRCC, SignalRGB).

There is no project backend. The app talks directly to Spotify and
LRCLIB from the local machine; no project server receives user data.

## Reporting a vulnerability

Do not open a public issue for security problems. Report privately via
GitHub Security Advisories for OJPalenzuela/lyricvision-lcd:

https://github.com/OJPalenzuela/lyricvision-lcd/security/advisories/new

Include: affected version, component (app or bridge), description,
and reproduction steps if safe to share.

Never include tokens, credentials, client secrets, or USB serials in
any report. Diagnostics exports are redacted by design.

## Disclosure

The project follows a 90-day responsible disclosure practice: reported
issues are investigated privately, fixes ship when ready, and public
details follow after a fix or after 90 days. No bounty program is
offered.

## Data handling notes

Spotify tokens are stored only in the OS credential vault through
Electron safeStorage; plaintext token storage is rejected by design.
Client ID is stored in the local settings file. Lyrics cache stays on
the local disk. See docs/privacy-data.md for details.

## Status

Windows-only v0.1, unsigned binaries. Windows SmartScreen will warn on
the installer until code signing lands. See docs/code-signing.md.
