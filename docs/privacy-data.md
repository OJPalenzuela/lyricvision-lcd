# Privacy and Local Data

LyricVision LCD stores data on the local Windows machine only. There
is no project backend and nothing is sent to project servers.

## Stored data

| Data | Where | Why |
|------|-------|-----|
| Spotify Client ID | Local settings file | Identify the user-created Spotify app for OAuth |
| Spotify access and refresh tokens | OS credential vault via Electron safeStorage | Keep the session without plaintext storage |
| Lyrics cache (LRCLIB results) | Local disk cache | Speed up repeat plays and offline repeats |
| App settings (stream rate, sync offset, startup) | Local settings file | Restore user preferences across restarts |
| Diagnostics export (on demand only) | Local JSON file chosen by the user | Help debug issues; redacted by design |

## What is not stored or sent

- No client secret is requested or stored; the app is a public client.
- No tokens, serials, or absolute local paths are included in
  diagnostics exports.
- No usage analytics are collected by the project.
- Spotify and LRCLIB requests go directly from the app to those
  services under their own terms; the project operates no proxy.
- Nothing is uploaded to project servers because none exist.

## Data flow

- OAuth runs between the app, the browser, and Spotify only.
- Lyrics lookups run between the app and LRCLIB only.
- USB frames stay between the shell and the local bridge sidecar.
- Diagnostics files are created locally and shared only if the user
  attaches them to a report.

## Redaction

Diagnostics include settings, status, and recent log lines. Tokens,
client secrets, device serials, and absolute local paths are excluded
by design. Do not paste those values into issues when reporting.

## User control

- Reconnect: run Connect again to refresh the session.
- Revoke: remove access in Spotify account settings, then reconnect.
- Clear: uninstall removes local app data; revoke separately in Spotify.

See [Spotify setup](spotify-setup.md) and [Troubleshooting](troubleshooting.md).
