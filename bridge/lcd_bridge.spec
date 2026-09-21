# -*- mode: python ; coding: utf-8 -*-
"""LyricVision LCD — PyInstaller spec for the bridge sidecar (RC-06).

Builds a Windows onefile exe consumed packaged as
`<resources>/lcd_bridge.exe` (see `src/bridge-spawn.js`).

UNSIGNED: v0.1 ships with no code signing. The exe and the NSIS
installer both trigger Windows SmartScreen warnings. This blocks
public release, not local dev/packaging.

Usage (from repo root):
    pyinstaller bridge/lcd_bridge.spec
"""

block_cipher = None

import os

# Anchor at the repo root regardless of CWD: SPECPATH is the directory
# containing this spec file (bridge/), so its parent is the repo root.
# (PyInstaller 6.x resolves relative Analysis paths against the spec
# directory, which previously produced bridge/bridge/lcd_bridge.py.)
SPEC_ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))


a = Analysis(
    [os.path.join(SPEC_ROOT, 'bridge', 'lcd_bridge.py')],
    pathex=[SPEC_ROOT],
    binaries=[],
    # No data files needed: panels/registry.py is pure code, bundled via
    # hiddenimports below (not via datas).
    datas=[],
    hiddenimports=['bridge.protocol', 'panels.registry'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='lcd_bridge',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    # Windowed: no console window pops up next to the Electron shell.
    # stdio pipes (stdin JSONL / stdout JSONL / stderr logs) still work
    # when the shell spawns with stdio pipe/pipe/pipe.
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
