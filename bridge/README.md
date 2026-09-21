# Bridge v0.1 (LV-04)

Python sidecar that owns all USB I/O: stdin JSONL → render portrait →
rotate 90° CW → JPEG q80 4:2:0 → bulk to 87AD:70DB.

Source of truth for scope: `odd/tasks/lyricvision-lcd.md`.
LV-05 (Electron shell) is out of scope here.

## Dev setup (project-local venv)

```bat
cd <repo-root>
python -m venv .venv
.venv\Scripts\activate
pip install -r bridge\requirements.txt
```

> End users install **nothing**: PyInstaller bundles the interpreter plus
> Pillow/pyusb/numpy into the single sidecar exe shipped inside the app
> `dist`. `requirements.txt` and the venv above are dev-only.

## Run

```bat
.venv\Scripts\activate
python bridge\lcd_bridge.py --help
python bridge\lcd_bridge.py --preview "%TEMP%\lv-preview.png"
echo {"type":"state","state":{"track":{"title":"T","artist":"A"},"lyric":{"current_line":"hola","next_line":"mundo"},"progressMs":1000,"durationMs":3000,"isPlaying":true,"settings":{"lcdFps":10}}}} | python bridge\lcd_bridge.py --once 3
```

- `--serial`: USB serial to claim (default: first 87AD:70DB found).
- `--once N`: send N frames then exit (for tests).
- `--preview PATH`: render one portrait PNG and exit **without USB**.

## Wire contract

- stdin JSONL: `{"v":1,"seq":N,"cmd":"state","state":{...}}` or legacy
  `{"type":"state","state":{...}}`. `state` carries `track{title,artist}`,
  `lyric{current_line,next_line}`, `progressMs/isPlaying`,
  `settings{lcdFps}` (clamped 5–30, default 10).
- stdout JSONL: `{"type":"status",...}` ~1 Hz (panel, pm/sub, fps, queue)
  and `{"type":"ack","seq":N}` per rendered frame that used a seq.
- Human logs go to stderr. Exits: 0 ok, 2 unknown panel (`panel-unknown`
  status line), 3 device busy/absent (`blocked`/`no-device`, e.g. quit
  TRCC/SignalRGB which hold the device exclusively — retry is LV-05's job).

## Fonts (v0.1)

Chain: DejaVuSans if present → seguiemj → segoeui → arial → PIL default.
CJK glyphs are best-effort in v0.1; a packaged CJK font (bundled with the
PyInstaller exe, no user install) lands after v0.1.
