"""Smoke test for LV-09 unified layout (plain asserts, no runner needed).

Single portrait view 480x854: art + title/artist/album + current (+ next
attenuated) + play/pause icon + cur/total time + proportional bar.

Run from the repo root either way:
    python tests/test_cover.py
    python -m tests.test_cover
"""

import os
import sys
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import lcd_bridge  # noqa: E402


def _unified_state(**overrides):
    base = {
        "track": {
            "title": "Unified Test",
            "artist": "LyricVision",
            "album": "Mockup",
            "artworkUrl": "",
        },
        "lyric": {"current_line": "current line here", "next_line": "next line here"},
        "progressMs": 40000,
        "durationMs": 180000,
        "isPlaying": True,
        "settings": {"lcdFps": 10},
    }
    base.update(overrides)
    return base


def _bar_frac(img):
    """Fraction of the bottom bar filled (blue fill vs dark track)."""
    w, h = img.size
    margin = 28
    bar_y = h - 56
    bar_h = 8
    bar_w = w - 2 * margin
    y = bar_y + bar_h // 2
    fill = 0
    for x in range(margin, margin + bar_w):
        _r, g, bl = img.getpixel((x, y))
        if bl > 150 and g > 100:
            fill += 1
    return fill / bar_w


def main() -> None:
    from PIL import Image, ImageDraw

    # 1. LRU intacta: 30 entries fit, the 31st evicts the oldest.
    lcd_bridge.clear_art_cache()
    for i in range(30):
        lcd_bridge._art_cache_put(
            f"http://example.invalid/art{i}.jpg", Image.new("RGB", (8, 8), (i, i, i))
        )
    assert len(lcd_bridge._art_cache) == 30, len(lcd_bridge._art_cache)
    for _url, (_img, _ts) in lcd_bridge._art_cache.items():
        assert isinstance(_ts, float), type(_ts)
        break
    lcd_bridge._art_cache_put(
        "http://example.invalid/art30.jpg", Image.new("RGB", (8, 8), (9, 9, 9))
    )
    assert len(lcd_bridge._art_cache) == 30, len(lcd_bridge._art_cache)
    assert "http://example.invalid/art0.jpg" not in lcd_bridge._art_cache, "oldest must evict at 31"
    assert "http://example.invalid/art30.jpg" in lcd_bridge._art_cache
    assert "http://example.invalid/art1.jpg" in lcd_bridge._art_cache
    lcd_bridge.clear_art_cache()
    assert len(lcd_bridge._art_cache) == 0

    # 2. Fallback sin arte nunca levanta (empty + None + bad-shape URLs).
    for bad in ("", None, 123, {}, []):
        state = _unified_state(
            track={"title": "T", "artist": "A", "album": "Al", "artworkUrl": bad}
        )
        img = lcd_bridge.render_unified(state, now_ms=1700000000000)
        assert img.size == (480, 854), img.size
    # Failed fetch cached as None: same URL retries once total.
    lcd_bridge.clear_art_cache()
    with mock.patch(
        "urllib.request.urlopen", side_effect=OSError("boom")
    ) as fake_open:
        assert lcd_bridge.fetch_artwork("http://example.invalid/dead.jpg") is None
        assert lcd_bridge.fetch_artwork("http://example.invalid/dead.jpg") is None
        assert fake_open.call_count == 1, fake_open.call_count
    with mock.patch("urllib.request.urlopen") as fake_open:
        assert lcd_bridge.fetch_artwork("") is None
        assert lcd_bridge.fetch_artwork(None) is None
        assert fake_open.call_count == 0
    lcd_bridge.clear_art_cache()
    tiny = Image.new("RGB", (100, 100), (0, 0, 0))
    d = ImageDraw.Draw(tiny)
    lcd_bridge.draw_play_icon(d, 10, 10, 22)
    lcd_bridge.draw_pause_icon(d, 10, 40, 22)
    lcd_bridge.draw_note_icon(d, 50, 50, 40)

    # 3. m:ss format.
    assert lcd_bridge.format_time(0) == "0:00"
    assert lcd_bridge.format_time(1000) == "0:01"
    assert lcd_bridge.format_time(61000) == "1:01"
    assert lcd_bridge.format_time(151000) == "2:31"
    assert lcd_bridge.format_time(200000) == "3:20"
    assert lcd_bridge.format_time(3599000) == "59:59"
    assert lcd_bridge.format_time(3600000) == "60:00"
    assert lcd_bridge.format_time(-5000) == "0:00"
    for garbage in (None, "abc", float("nan"), True, {}, []):
        assert lcd_bridge.format_time(garbage) == "0:00", garbage

    # 4. Unificado 480x854 + rotacion a 854x480; dispatcher siempre unificado.
    lcd_bridge.clear_art_cache()
    unified = lcd_bridge.render_unified(_unified_state(), now_ms=1700000000000)
    assert unified.size == (480, 854), unified.size
    buf = lcd_bridge.portrait_to_buffer(unified, "rot90cw")
    assert buf.size == (854, 480), buf.size
    for layout in ("lyrics", "cover", "grid", None):
        st = _unified_state()
        if layout is None:
            st.pop("layout", None)
            st.get("settings", {}).pop("layout", None)
        else:
            st["layout"] = layout
            st["settings"] = {"lcdFps": 10, "layout": layout}
        via = lcd_bridge.render_portrait(st, now_ms=1700000000000)
        assert via.size == (480, 854), (layout, via.size)
    # Same content differing only in layout renders identically (ignored).
    a = lcd_bridge.render_portrait(_unified_state(layout="lyrics", settings={"lcdFps": 10, "layout": "lyrics"}), now_ms=1700000000000)
    b_img = lcd_bridge.render_portrait(_unified_state(layout="cover", settings={"lcdFps": 10, "layout": "cover"}), now_ms=1700000000000)
    assert a.tobytes() == b_img.tobytes(), "layout must be ignored (identical pixels)"
    paused = lcd_bridge.render_unified(_unified_state(isPlaying=False), now_ms=1700000000000)
    assert paused.size == (480, 854), paused.size
    demo = lcd_bridge.demo_state()
    shown = lcd_bridge.extract_display(demo, now_ms=9999999)
    assert lcd_bridge.format_time(shown["progressMs"]) == "2:31", shown
    assert lcd_bridge.format_time(shown["durationMs"]) == "3:20", shown
    # Demo alias: lyrics|cover give the same unified fixture.
    assert lcd_bridge.demo_state("lyrics")["progressMs"] == lcd_bridge.demo_state("cover")["progressMs"]
    lcd_bridge.clear_art_cache()

    # 5. Tiempo avanza entre states + barra proporcional (frozen clock).
    frozen_base = 1700000000000
    frozen_now = frozen_base + 10000
    early = _unified_state(progressMs=30000, measuredAt=frozen_base, durationMs=180000)
    late = _unified_state(progressMs=90000, measuredAt=frozen_base, durationMs=180000)
    e_early = lcd_bridge.extract_display(early, now_ms=frozen_now)
    e_late = lcd_bridge.extract_display(late, now_ms=frozen_now)
    assert e_early["progressMs"] == 40000, e_early
    assert e_late["progressMs"] == 100000, e_late
    assert lcd_bridge.format_time(e_early["progressMs"]) == "0:40", e_early
    assert lcd_bridge.format_time(e_late["progressMs"]) == "1:40", e_late
    lcd_bridge.clear_art_cache()
    img_early = lcd_bridge.render_unified(early, now_ms=frozen_now)
    img_late = lcd_bridge.render_unified(late, now_ms=frozen_now)
    f_early = _bar_frac(img_early)
    f_late = _bar_frac(img_late)
    assert f_late > f_early + 0.15, (f_early, f_late)
    assert abs(f_early - 40000 / 180000) < 0.10, (f_early, "expected ~0.22")
    assert abs(f_late - 100000 / 180000) < 0.10, (f_late, "expected ~0.55")
    lcd_bridge.clear_art_cache()

    # 5b. Paused freeze (regression): same paused base at two clocks ->
    # identical progress, time, and bar (nothing advances while paused).
    frozen_paused = _unified_state(
        progressMs=30000, measuredAt=frozen_base, durationMs=180000, isPlaying=False)
    p1 = lcd_bridge.extract_display(frozen_paused, now_ms=frozen_base + 1000)
    p2 = lcd_bridge.extract_display(frozen_paused, now_ms=frozen_base + 60000)
    assert p1["progressMs"] == p2["progressMs"] == 30000, (p1, p2)
    assert lcd_bridge.format_time(p1["progressMs"]) == "0:30", p1
    lcd_bridge.clear_art_cache()
    img_p1 = lcd_bridge.render_unified(frozen_paused, now_ms=frozen_base + 1000)
    img_p2 = lcd_bridge.render_unified(frozen_paused, now_ms=frozen_base + 60000)
    assert img_p1.tobytes() == img_p2.tobytes(), "paused frames must be identical"
    assert _bar_frac(img_p1) == _bar_frac(img_p2)
    lcd_bridge.clear_art_cache()

    # 6. Regresion bug A: measuredAt=0 (sentinel viejo) -> estatico, no ~29M min.
    assert lcd_bridge.current_progress({"progressMs": 10000, "measuredAt": 0}, 1700000000000) == 10000
    assert lcd_bridge.current_progress({"progressMs": 10000, "measuredAt": -5}, 1700000000000) == 10000
    assert lcd_bridge.current_progress({"progressMs": 0, "measuredAt": 0}, 1700000000000) == 0
    assert lcd_bridge.current_progress({"isPlaying": False}, 1700000000000) == 0
    idle = lcd_bridge.extract_display({"isPlaying": False}, now_ms=1700000000000)
    assert idle["progressMs"] == 0, idle
    assert lcd_bridge.format_time(idle["progressMs"]) == "0:00", idle
    # Dos states con sentinel no se saturan: la barra sigue proporcional.
    s1 = _unified_state(progressMs=10000, measuredAt=0, durationMs=180000)
    # drop measuredAt key presence but keep sentinel value path via explicit 0
    s2 = _unified_state(progressMs=60000, measuredAt=0, durationMs=180000)
    e1 = lcd_bridge.extract_display(s1, now_ms=1700000000000)
    e2 = lcd_bridge.extract_display(s2, now_ms=1700000000000)
    assert e1["progressMs"] == 10000, e1
    assert e2["progressMs"] == 60000, e2
    lcd_bridge.clear_art_cache()
    f1 = _bar_frac(lcd_bridge.render_unified(s1, now_ms=1700000000000))
    f2 = _bar_frac(lcd_bridge.render_unified(s2, now_ms=1700000000000))
    assert f1 < 0.20, (f1, "sentinel bar must not pin at 100%")
    assert f2 > f1, (f1, f2)
    lcd_bridge.clear_art_cache()

    # 7. Whitelist compat: se acepta pero se ignora al renderizar.
    assert lcd_bridge.is_valid_layout("lyrics") is True
    assert lcd_bridge.is_valid_layout("cover") is True
    for bad in ("grid", "", " ", None, 123, 1.5, True, False, [], {}, b"lyrics",
                "LYRICS", "Cover", "COVER", "lyrics "):
        assert lcd_bridge.is_valid_layout(bad) is False, repr(bad)
    assert lcd_bridge.normalize_layout("lyrics") == "lyrics"
    assert lcd_bridge.normalize_layout("cover") == "cover"
    for bad in ("grid", "", None, 123, [], {}):
        assert lcd_bridge.normalize_layout(bad) == "lyrics", repr(bad)
    shown = lcd_bridge.extract_display(_unified_state(), now_ms=1700000000000)
    assert shown["album"] == "Mockup", shown

    print("test_cover: OK (unified 480x854->854x480 + time advance + proportional bar + fallback + lru + sentinel regression)")


if __name__ == "__main__":
    main()
