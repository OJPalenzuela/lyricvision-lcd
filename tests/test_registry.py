"""Smoke test for panels/registry.py. pytest-collectable AND script-runnable.

Run from the repo root any of these ways:
    .venv/Scripts/python.exe -m pytest tests/test_registry.py -v
    python tests/test_registry.py
    python -m tests.test_registry
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from panels.registry import ROTATE_90_CW, lookup  # noqa: E402


def test_vision_max_row() -> None:
    # Vision MAX row: exact PM/SUB pair from the live handshake.
    max_panel = lookup(11, 5)
    assert max_panel.known, "PM11/SUB5 must resolve to a known panel"
    assert max_panel.buffer_size == (854, 480), max_panel.buffer_size
    assert max_panel.glass_size == (480, 854), max_panel.glass_size
    assert max_panel.orientation == "portrait", max_panel.orientation
    assert max_panel.rotation == ROTATE_90_CW, max_panel.rotation
    assert max_panel.encoding == "jpeg", max_panel.encoding


def test_vision_360_family() -> None:
    # Vision 360 family rows: known PMs map to 480x480 regardless of sub.
    for pm in (72, 129):
        row = lookup(pm, 0)
        assert row.known, f"PM{pm} must resolve to a known panel"
        assert row.buffer_size == (480, 480), (pm, row.buffer_size)
        assert row.glass_size == (480, 480), (pm, row.glass_size)


def test_unknown_fallback() -> None:
    # Unknown fallback: explicit, never a silent guess.
    unknown = lookup(99, 99)
    assert unknown.name == "unknown", unknown.name
    assert unknown.known is False, "fallback must be marked not-known"


def main() -> None:
    test_vision_max_row()
    test_vision_360_family()
    test_unknown_fallback()

    print("test_registry: OK (Vision MAX + Vision 360x2 + unknown fallback)")


if __name__ == "__main__":
    main()
