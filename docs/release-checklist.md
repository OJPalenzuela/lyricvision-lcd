# Release Checklist (v0.1.0)

Honest status of what a v0.1.0 release still requires. Nothing here
is promised for a specific date. Code signing has no local
workaround — it is a public blocker, not a local packaging step.

## Build artifacts

- [ ] Python sidecar builds with PyInstaller (`bridge\lcd_bridge.spec`,
      onefile) and produces `dist\lcd_bridge.exe`.
- [ ] Sidecar exe staged to `resources\` before packing, so the
      packaged shell resolves it (see `packaging.md`).
- [ ] Shell packs with electron-builder (`pnpm dist`, NSIS
      one-click installer) and produces the `Setup.exe` artifact.

## Clean-machine validation (Windows)

- [ ] Fresh Windows 10/11 x64 machine, no dev tools installed.
- [ ] Install succeeds from the `Setup.exe` artifact.
- [ ] Uninstall removes the app cleanly.
- [ ] Start-with-Windows toggle creates and removes the per-user
      Startup shortcut.

## Functional validation (real hardware)

- [ ] Real OAuth flow completes with a user-created client ID.
- [ ] Playback shows cover art, progress, and synced lyrics on a
      physical Vision MAX panel (PM 11 / SUB 5).
- [ ] Bridge restart path observed live (kill sidecar, confirm
      `bridge-wedged` status plus auto-restart with backoff).

## Publishing

- [ ] `Setup.exe` attached to a manually created GitHub Release.
- [ ] Install guide and first-run guide verified against that Release.

## Public blocker (not local)

- [ ] Code signing: v0.1.0 ships unsigned, so Windows SmartScreen
      reports an unknown publisher. Signing is required before any
      public release and is tracked here openly — it is not
      something local packaging can resolve.

## Notes

- Source of truth for product scope: `odd/tasks/lyricvision-lcd.md`
  (LV-07 packaging). This checklist adds the release-facing
  validation around it without changing that scope.
- No dates are given and signing is not promised for any specific
  release. Items check off only against real artifacts and real
  hardware, never against plans.
