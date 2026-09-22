# Packaging (RC-06, LV-07 partial — no signing)

v0.1 ships **unsigned**. Both the sidecar exe and the NSIS installer
trigger Windows SmartScreen warnings ("Unknown publisher"). This blocks
public release, not local dev/packaging.

## 1. Build the sidecar exe

From the repo root (Windows, project venv with bridge deps installed):

```bat
pyinstaller bridge\lcd_bridge.spec
```

Expected output:

```text
dist\lcd_bridge.exe
```

Spec notes (`bridge/lcd_bridge.spec`): PyInstaller onefile, `console=False`
(no console window; stdio pipes to the Electron shell still work),
`name='lcd_bridge'`, `pathex=['bridge']`. `panels/registry.py` is pure
code bundled via `hiddenimports`, so `datas` stays empty.

## 2. Stage the exe for electron-builder

```bat
mkdir resources 2>nul
copy dist\lcd_bridge.exe resources\lcd_bridge.exe
```

`src/bridge-spawn.js` resolves the packaged sidecar as
`<process.resourcesPath>/lcd_bridge.exe`. The `extraResources` entry in
`package.json` copies local `resources/lcd_bridge.exe` there **if present
at pack time** — staging the file before `pack`/`dist` is required,
otherwise the packaged app falls back to nothing (no dev `python`
fallback when `app.isPackaged`).

Dev (unpackaged) needs no staging: the shell spawns
`.venv/python bridge/lcd_bridge.py` with a `python` PATH fallback.

## 3. Build the shell

```bat
pnpm pack   :: electron-builder --dir (unpackaged directory, fastest check)
pnpm dist   :: electron-builder --win nsis (one-click installer)
```

pnpm-only: `preinstall` rejects npm (`only-allow pnpm`).

## 4. Unsigned SmartScreen notice

No `win.certificateFile` / `cscLink` is configured. Windows shows
SmartScreen / "Unknown publisher" prompts for both the exe and the
installer. Expected until a signing step lands (out of scope for RC-06).

## 5. CI coverage

CI smoke (`smoke.yml`) runs on every push and pull request and covers
**pre-pack checks only**: `pnpm install`,
`pip install -r bridge/requirements.txt`, and the hardware-free
Python/Node smokes. It does **not** run PyInstaller or electron-builder
(heavy, needs the Windows toolchain).

Release CI (`release.yml`) runs on `v*` tags: the same hardware-free
smokes gate the build, then `pyinstaller bridge\lcd_bridge.spec` stages
`resources\lcd_bridge.exe` and `electron-builder --win nsis` produces the
unsigned installer plus checksums. Pull requests never pack — only tags do.
