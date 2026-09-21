# FAQ

Short answers for LyricVision LCD v0.1 (Windows-only).

## Which panels are supported?

The primary target is the Peerless Assassin 120 Vision MAX,
validated against real hardware. The Vision 360 family is listed
as experimental compatibility only: it has a registry row but no
physical validation in this project, so it is not promised to work.
Anything else reports an explicit `unknown` panel state and never
a silent guess. See `docs/project-context.md` for the locked values.

## Does it work on Linux or macOS?

No. v0.1 is Windows 10/11 x64 only. USB transport depends on the
WinUSB driver path and the installer targets Windows.

## Do I need TRCC installed?

No. TRCC is not required and must be fully closed while the app
runs. TRCC opens the panel exclusively, so the app cannot claim
the device until TRCC (and SignalRGB, if present) is quit.

## Why does SignalRGB conflict with the app?

Only one program can own the USB device at a time. SignalRGB, like
TRCC, holds the panel exclusively. Quit both completely (check the
system tray), reconnect USB if needed, then restart the app. More
steps: `docs/troubleshooting.md`.

## Do I need Spotify Premium?

Playback-state polling uses the Spotify Web API currently-playing
endpoint, which follows Spotify's own API rules for what it returns
per account type and playback context. If the API reports no active
playback, the app has nothing to display. A free Spotify account
plus a Spotify application client ID is enough to sign in; what the
API exposes for a given session is decided by Spotify, not by this app.

## Where are my Spotify tokens stored?

Locally, in the OS credential vault through Electron safeStorage.
Tokens are never written as plaintext and never leave the machine
except for Spotify API calls. The diagnostics export is redacted by
design and contains no tokens or device serials.

## Why does SmartScreen warn on install?

v0.1 ships unsigned, so Windows SmartScreen reports an unknown
publisher. Only proceed if the installer came from the project
Releases page. Signing is planned but not promised for any
specific release.

## Why is there no lyric line for this track?

LRCLIB has no synced lyrics for that track, or the title and artist
did not match an entry. Instrumental tracks and very new releases
are the most common cases. The display keeps showing cover art and
progress; cached hits are kept for 30 days.
