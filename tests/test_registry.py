"""Smoke test for panels/registry.py. Plain asserts, no runner needed.

Run from the repo root either way:
    python tests/test_registry.py
    python -m tests.test_registry
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from panels.registry import ROTATE_90_CW, lookup  # noqa: E402


def main() -> None:
    # Vision MAX row: exact PM/SUB pair from the live handshake.
    max_panel = lookup(11, 5)
    assert max_panel.known, "PM11/SUB5 must resolve to a known panel"
    assert max_panel.buffer_size == (854, 480), max_panel.buffer_size
    assert max_panel.glass_size == (480, 854), max_panel.glass_size
    assert max_panel.orientation == "portrait", max_panel.orientation
    assert max_panel.rotation == ROTATE_90_CW, max_panel.rotation
    assert max_panel.encoding == "jpeg", max_panel.encoding

    # Vision 360 family rows: known PMs map to 480x480 regardless of sub.
    for pm in (72, 129):
        row = lookup(pm, 0)
        assert row.known, f"PM{pm} must resolve to a known panel"
        assert row.buffer_size == (480, 480), (pm, row.buffer_size)
        assert row.glass_size == (480, 480), (pm, row.glass_size)

    # Unknown fallback: explicit, never a silent guess.
    unknown = lookup(99, 99)
    assert unknown.name == "unknown", unknown.name
    assert unknown.known is False, "fallback must be marked not-known"

    print("test_registry: OK (Vision MAX + Vision 360x2 + unknown fallback)")


if __name__ == "__main__":
    main()
