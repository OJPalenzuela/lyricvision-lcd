"""S1-T7b: refresh-policy wake-up, wake-on-state, dirty flag, ack routing. pytest.

Run from the repo root:
    .venv/Scripts/python.exe -m pytest tests/test_render_pacer.py -v

The live render loop needs a USB device, so every decision it makes is
factored into pure functions -- bounded_wait_seconds, wait_for_state,
drain_envelopes and FramePacer.plan -- and covered here hardware-free. The
only part pytest cannot execute is the wiring inside main(), which
test_loop_wiring_pins_the_gates pins at the source level instead.

Binding constraints proven here:
  1. the blocking wait is ALWAYS <= STATUS_INTERVAL_S (1 Hz status
     heartbeat must outlive the 1-hour static sentinel; >5 s without
     status AND ack restarts the sidecar -- src/main.js + src/hardening.js);
  2. a drained seq is acked EVEN IF its frame is skipped (the shell's
     pendingAcks never clears without its ack) while the legacy
     every-painted-frame ack (spawn baseline: 3 acks, seqs 6,6,6) survives;
  3. a fresh envelope ends the wait immediately (wake-on-state) and the
     consumed envelope is CARRIED into the next drain, never re-queued
     (re-put would order an older seq behind a newer one and break
     drain-to-latest / scene retention newest-wins);
  4. the cadence may only get lazier than today -- never faster than
     1/lcdFps; lcdFps/DEFAULT_FPS stays the render-rate ceiling.
"""

import os
import queue
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import lcd_bridge  # noqa: E402

MEASURED_AT = 1_700_000_000_000.0
NOW = MEASURED_AT + 40_000.0


def playing_state(**overrides):
    """State with a live extrapolated clock (measuredAt present)."""
    base = {
        "track": {"title": "Pacer Test", "artist": "LyricVision"},
        "lyric": {"current_line": "first line", "next_line": "second line"},
        "progressMs": 40000,
        "offsetMs": 0,
        "measuredAt": MEASURED_AT,
        "durationMs": 180000,
        "isPlaying": True,
        "settings": {"lcdFps": 10},
    }
    base.update(overrides)
    return base


def paused_state(**overrides):
    state = playing_state(**overrides)
    state["isPlaying"] = False
    return state


def spawn_demo_state(**overrides):
    """tests/test_shell_spawn.js's exact demo state: isPlaying true but NO
    measuredAt/updatedAt, so extrapolation is static and the composite key
    cannot change on its own (the --once force rationale, pinned below)."""
    base = {
        "track": {"title": "Spawn test", "artist": "LyricVision"},
        "lyric": {"current_line": "ack line 6", "next_line": "next"},
        "progressMs": 6000,
        "durationMs": 180000,
        "isPlaying": True,
        "settings": {"lcdFps": 30},
    }
    base.update(overrides)
    return base


def gif_scene(name):
    bg = {"kind": "gif", "source": name, "rotation": 0, "flipH": False,
          "scale": 1, "panX": 0, "panY": 0, "fit": "fit"}
    return {"version": 1, "background": bg, "overlays": []}


def save_two_frame_gif(root, name):
    from PIL import Image
    path = os.path.join(str(root), name)
    frames = [Image.new("RGB", (32, 32), (255, 0, 0)),
              Image.new("RGB", (32, 32), (0, 0, 255))]
    frames[0].save(path, format="GIF", save_all=True,
                   append_images=frames[1:], duration=[100, 100], loop=0)
    return name


# --------------------------------------------------------------------------
# Bounded wait: heartbeat bound (constraint 1) + lcdFps ceiling (constraint 4)
# --------------------------------------------------------------------------

def test_static_hour_sentinel_wait_is_capped_end_to_end():
    # frame_refresh_ms says 1 HOUR for a static scene; the wait actually
    # taken must return within STATUS_INTERVAL_S (+slack) so the ~1 Hz
    # status heartbeat -- and the shell's 5 s watchdog -- survive.
    state = paused_state()
    refresh = lcd_bridge.frame_refresh_ms(state, None, media_root=".")
    assert refresh == lcd_bridge.REFRESH_STATIC_MS  # 3_600_000

    pacer = lcd_bridge.FramePacer()
    plan = pacer.plan(state, None, now_ms=NOW, fps=10)
    assert plan.wait_s <= lcd_bridge.STATUS_INTERVAL_S

    pending = queue.Queue()
    started = time.monotonic()
    assert lcd_bridge.wait_for_state(pending, plan.wait_s) is None
    elapsed = time.monotonic() - started
    assert elapsed <= lcd_bridge.STATUS_INTERVAL_S + 0.5
    # Headroom proof: 5 consecutive waits still fit the >5 s watchdog
    # window (src/hardening.js restarts the sidecar after 5 s with no
    # status AND no ack -- the dirty flag must never stop heartbeats).
    assert plan.wait_s * 5 <= 5.0


def test_wait_never_faster_than_lcdfps():
    # Constraint 4: the refresh policy may only get LAZIER than today's
    # blind 1/fps sleep, never faster. Video's 33 ms verdict still floors
    # at 1/fps; a broken/absent policy falls back to exactly today's cadence.
    assert lcd_bridge.DEFAULT_FPS == 10
    assert lcd_bridge.fps_from_state({}) == 10
    # 1.0/10 and the literal 0.1 are the same double, so equality is exact.
    assert lcd_bridge.bounded_wait_seconds(10, lcd_bridge.REFRESH_VIDEO_MS) == 0.1
    assert lcd_bridge.bounded_wait_seconds(30, lcd_bridge.REFRESH_VIDEO_MS) >= 1.0 / 30.0
    assert lcd_bridge.bounded_wait_seconds(10, None) == 0.1
    assert lcd_bridge.bounded_wait_seconds(10, 0) == 0.1
    assert lcd_bridge.bounded_wait_seconds(10, -250) == 0.1
    assert lcd_bridge.bounded_wait_seconds(10, float("nan")) == 0.1
    assert lcd_bridge.bounded_wait_seconds(None, None) == 0.1


def test_playing_scene_waits_the_playing_verdict_not_the_fps_tick():
    # Playing: frame_refresh_ms = 250 ms (4 checks per displayed second);
    # at lcdFps 10 the effective wait is 250 ms (lazier than today's
    # 100 ms, within the policy), at lcdFps 30 it is still >= 1/30.
    state = playing_state()
    pacer = lcd_bridge.FramePacer()
    plan = pacer.plan(state, None, now_ms=NOW, fps=10)
    assert plan.wait_s == 0.25
    plan_30 = lcd_bridge.FramePacer().plan(state, None, now_ms=NOW, fps=30)
    assert plan_30.wait_s >= 1.0 / 30.0


# --------------------------------------------------------------------------
# Wake-on-state + carry (constraint 3)
# --------------------------------------------------------------------------

def test_wait_for_state_ends_early_on_envelope():
    # The loop's wait is pending.get(timeout=...): an envelope arriving at
    # ~60 ms must return long before the 3 s timeout. A design that slept
    # blind (time.sleep + get_nowait after) would take the full 3 s and
    # fail the elapsed assertion.
    pending = queue.Queue()
    threading.Timer(0.06, lambda: pending.put((7, {"n": 7}))).start()
    started = time.monotonic()
    item = lcd_bridge.wait_for_state(pending, 3.0)
    elapsed = time.monotonic() - started
    assert item == (7, {"n": 7})
    assert elapsed < 1.0


def test_wait_for_state_times_out_to_none():
    pending = queue.Queue()
    started = time.monotonic()
    assert lcd_bridge.wait_for_state(pending, 0.15) is None
    assert 0.10 <= time.monotonic() - started < 1.5


def test_enqueued_a_then_during_wait_b_final_state_is_b():
    # The task's exact scenario: enqueue seq A, the wait consumes it
    # (carried), seq B arrives during the wait, the next drain must apply
    # BOTH in order with B LAST (newest wins). If the consumed envelope
    # were re-queued with put(), it would land BEHIND B, the final applied
    # state would be A's, and scene retention's newest-wins would break.
    pending = queue.Queue()
    pending.put((1, {"marker": "A"}))
    carried = lcd_bridge.wait_for_state(pending, 0.05)  # consumes A
    assert carried == (1, {"marker": "A"})
    pending.put((2, {"marker": "B"}))                   # arrives during the wait
    items = lcd_bridge.drain_envelopes(pending, carried)
    assert [seq for seq, _ in items] == [1, 2]          # A first, never re-put
    assert pending.empty()                              # nothing left behind
    applied = None
    for _seq, new_state in items:                       # drain-to-latest
        applied = new_state
    assert applied["marker"] == "B"


def test_drain_without_carry_keeps_fifo_order():
    pending = queue.Queue()
    for seq in (3, 4, 5):
        pending.put((seq, {"marker": seq}))
    items = lcd_bridge.drain_envelopes(pending, None)
    assert [seq for seq, _ in items] == [3, 4, 5]
    assert pending.empty()


# --------------------------------------------------------------------------
# Dirty flag (acceptance criterion 4) + GIF never frozen
# --------------------------------------------------------------------------

def test_unchanged_key_skips_then_state_change_repaints():
    pacer = lcd_bridge.FramePacer()
    state = paused_state()
    first = pacer.plan(state, None, now_ms=NOW, fps=10)
    assert first.render is True                     # first frame always paints
    again = pacer.plan(state, None, now_ms=NOW, fps=10)
    assert again.render is False                    # unchanged -> SKIP (observable gate)
    changed = paused_state(lyric={"current_line": "second line",
                                  "next_line": "third line"})
    assert pacer.plan(changed, None, now_ms=NOW, fps=10).render is True


def test_playing_time_bucket_tick_repaints_but_same_bucket_skips():
    # The key rides the PLAYING REFRESH VERDICT (250 ms), not the displayed
    # second: no tick inside one bucket (skip), a bucket boundary within
    # frame_refresh_ms repaints. The offsets below are inside / past ONE
    # 250 ms bucket -- they were +900/+1100 when the bucket was 1000 ms,
    # which would now be 3 buckets apart and assert the wrong thing.
    pacer = lcd_bridge.FramePacer()
    state = playing_state()
    assert pacer.plan(state, None, now_ms=NOW, fps=10).render is True
    assert pacer.plan(state, None, now_ms=NOW + 100, fps=10).render is False
    assert pacer.plan(state, None, now_ms=NOW + 300, fps=10).render is True


def test_playing_bucket_width_is_the_playing_refresh_verdict():
    # Single-sourcing proof: the bucket width IS REFRESH_PLAYING_MS, so the
    # key can never repaint lazier than frame_refresh_ms prescribes while
    # playing (a 1000 ms bucket collapsed paint-while-playing to ~1 Hz and
    # turned the bar's ~0.42 s pixel steps into 2 px jumps once a second).
    # NOW sits exactly on a boundary (progress 80_000 ms), so the last ms
    # of a bucket still skips and the first ms of the next one repaints.
    bucket_ms = lcd_bridge.REFRESH_PLAYING_MS
    assert bucket_ms == 250
    pacer = lcd_bridge.FramePacer()
    state = playing_state()          # progress at NOW = 40_000 + 40_000
    assert lcd_bridge.current_progress(state, NOW) % bucket_ms == 0
    assert pacer.plan(state, None, now_ms=NOW, fps=10).render is True
    assert pacer.plan(state, None, now_ms=NOW + bucket_ms - 1,
                      fps=10).render is False          # still one bucket
    assert pacer.plan(state, None, now_ms=NOW + bucket_ms,
                      fps=10).render is True           # boundary crossed
    # ~300 ms with NO state change flips the key; ~100 ms (same bucket)
    # leaves it clean -- the exact cadence frame_refresh_ms prescribes.
    tick = lcd_bridge.FramePacer()
    assert tick.plan(state, None, now_ms=NOW, fps=10).render is True
    assert tick.plan(state, None, now_ms=NOW + 100, fps=10).render is False
    assert tick.plan(state, None, now_ms=NOW + 300, fps=10).render is True


def test_paused_static_scene_never_repaints_as_wall_clock_advances():
    # Acceptance criterion 4 MUST survive the 250 ms bucket: while paused
    # current_progress is frozen, so the bucket stops ticking and the key
    # stays byte-identical no matter how far the wall clock runs. If the
    # bucket were derived from wall time instead of progress, this fails.
    pacer = lcd_bridge.FramePacer()
    state = paused_state()
    assert pacer.plan(state, None, now_ms=NOW, fps=10).render is True
    base_key = lcd_bridge.composite_frame_key(state, None, now_ms=NOW)
    for delta_ms in (lcd_bridge.REFRESH_PLAYING_MS, 1000, 60_000, 600_000):
        assert (lcd_bridge.composite_frame_key(state, None,
                                               now_ms=NOW + delta_ms)
                == base_key), f"paused key moved after {delta_ms} ms"
        assert pacer.plan(state, None, now_ms=NOW + delta_ms,
                          fps=10).render is False
    # The 1-hour sentinel verdict still stands (static, not 250 ms).
    assert lcd_bridge.frame_refresh_ms(state, None, media_root=".") == \
        lcd_bridge.REFRESH_STATIC_MS


def test_second_rollover_repaints_within_one_playing_bucket():
    # The m:ss clock text may never sit stale: for EVERY phase of a second,
    # the key at the rollover differs from the key 1..999 ms before it, and
    # the loop is rescheduled within one bucket afterwards.
    bucket_ms = lcd_bridge.REFRESH_PLAYING_MS
    state = playing_state()
    rollover_ms = MEASURED_AT + 1000        # progress 40_000 -> "0:41"
    for lag_ms in range(1, 1000, 37):
        before = lcd_bridge.composite_frame_key(
            state, None, now_ms=rollover_ms - lag_ms)
        after = lcd_bridge.composite_frame_key(state, None,
                                               now_ms=rollover_ms)
        assert before != after, f"stale clock: rollover missed at -{lag_ms} ms"
    pacer = lcd_bridge.FramePacer()
    assert pacer.plan(state, None, now_ms=rollover_ms - 50,
                      fps=10).render is True
    assert pacer.plan(state, None, now_ms=rollover_ms - 30,
                      fps=10).render is False      # same second, same bucket
    plan = pacer.plan(state, None, now_ms=rollover_ms, fps=10)
    assert plan.render is True                     # text changed -> repaint
    assert plan.wait_s * 1000 <= bucket_ms         # looked at again <= 250 ms


def test_gif_background_is_not_frozen_by_dirty_check(tmp_path):
    # The key's frame_index component follows the GIF's own phase: same
    # phase -> skip, next GIF frame -> repaint, even with a frozen clock
    # (paused state, so neither digest nor bucket can move it).
    name = save_two_frame_gif(tmp_path, "anim.gif")
    scene = gif_scene(name)
    state = paused_state()
    base_ms = MEASURED_AT  # epoch ms divisible by loop_ms (200 ms) -> phase 0
    pacer = lcd_bridge.FramePacer()
    assert pacer.plan(state, scene, now_ms=base_ms, fps=10,
                      media_root=str(tmp_path)).render is True
    assert pacer.plan(state, scene, now_ms=base_ms + 50, fps=10,
                      media_root=str(tmp_path)).render is False   # same frame 0
    assert pacer.plan(state, scene, now_ms=base_ms + 150, fps=10,
                      media_root=str(tmp_path)).render is True    # frame 1: NOT frozen
    # GIF delay (100 ms) drives the wait, floored at 1/lcdFps -- never 1 h.
    wait = pacer.plan(state, scene, now_ms=base_ms + 150, fps=10,
                      media_root=str(tmp_path)).wait_s
    assert 0.1 <= wait <= lcd_bridge.STATUS_INTERVAL_S


# --------------------------------------------------------------------------
# Ack routing (constraint 2)
# --------------------------------------------------------------------------

def test_drained_seq_is_acked_even_when_frame_is_skipped():
    pacer = lcd_bridge.FramePacer()
    state = spawn_demo_state()          # frozen clock: key never changes
    assert pacer.plan(state, None, now_ms=NOW, fps=30).ack_seq is None
    pacer.note_drain(6)                 # envelope drained, pixels unchanged
    skipped = pacer.plan(state, None, now_ms=NOW, fps=30)
    assert skipped.render is False
    assert skipped.ack_seq == 6         # the owed ack (pendingAcks leak guard)
    quiet = pacer.plan(state, None, now_ms=NOW, fps=30)
    assert quiet.render is False
    assert quiet.ack_seq is None        # acked once, not spammed


def test_every_painted_frame_still_reacks_current_seq():
    # Legacy contract the spawn baseline depends on: ONE drained seq,
    # N painted frames -> N acks all carrying that seq. Production (no
    # force): each repaint below is forced by a real state change.
    pacer = lcd_bridge.FramePacer()
    pacer.note_drain(7)
    seqs = []
    for i in range(3):
        state = spawn_demo_state(lyric={"current_line": f"ack line {i}",
                                        "next_line": "next"})
        plan = pacer.plan(state, None, now_ms=NOW, fps=30)
        assert plan.render is True
        if plan.ack_seq is not None:
            seqs.append(plan.ack_seq)
    assert seqs == [7, 7, 7]


def test_force_once_bypasses_dirty_flag():
    # `--once` is documented "tests only" (src/bridge-spawn.js:46). Its demo
    # state has isPlaying:true with NO measuredAt, so the composite key is
    # frozen; --once must keep painting every iteration or `--once 3` hangs.
    pacer = lcd_bridge.FramePacer(force=True)
    state = spawn_demo_state()
    pacer.note_drain(6)
    seqs = []
    for _ in range(3):
        plan = pacer.plan(state, None, now_ms=NOW, fps=30)
        assert plan.render is True
        seqs.append(plan.ack_seq)
    assert seqs == [6, 6, 6]            # the observed hardware baseline
    # Production (no force): the same frozen state paints exactly once.
    prod = lcd_bridge.FramePacer()
    prod.note_drain(6)
    assert prod.plan(state, None, now_ms=NOW, fps=30).render is True
    assert prod.plan(state, None, now_ms=NOW, fps=30).render is False


# --------------------------------------------------------------------------
# Fail-safe: a broken scene never kills the loop
# --------------------------------------------------------------------------

def test_unreadable_media_fails_safe_to_paint_then_recovers(tmp_path):
    # Shape-valid scene, missing file (deleted after config): plan() must
    # paint the fallback at today's cadence, never raise, and -- crucially
    # -- invalidate the cached key so the NEXT healthy plan repaints
    # instead of leaving the fallback stuck on the panel.
    broken = gif_scene("deleted-after-config.gif")
    state = paused_state()
    healthy_scene = gif_scene(save_two_frame_gif(tmp_path, "ok.gif"))
    root = str(tmp_path)

    pacer = lcd_bridge.FramePacer()
    assert pacer.plan(state, None, now_ms=NOW, fps=10,
                      media_root=root).render is True          # legacy key cached

    fail = pacer.plan(state, broken, now_ms=NOW, fps=10,
                      media_root=root)
    assert fail.render is True                                # fail-safe paint
    assert fail.wait_s == 0.1                                 # 1/fps fallback
    recovered = pacer.plan(state, None, now_ms=NOW, fps=10,
                           media_root=root)
    assert recovered.render is True                           # key invalidated
    # Healthy scene path still works afterwards.
    ok = pacer.plan(state, healthy_scene, now_ms=NOW, fps=10,
                    media_root=root)
    assert ok.render is True
    assert ok.ack_seq is None


# --------------------------------------------------------------------------
# Wiring guard: main() needs USB, so pin the loop's gates at source level
# --------------------------------------------------------------------------

def test_loop_wiring_pins_the_gates():
    here = os.path.dirname(os.path.abspath(__file__))
    source_path = os.path.join(os.path.dirname(here), "bridge", "lcd_bridge.py")
    with open(source_path, "r", encoding="utf-8") as handle:
        source = handle.read()
    # Constraint 3+1: the blind sleep is gone; the wait is the bounded,
    # envelope-interruptible one, and the consumed envelope is carried.
    assert "time.sleep(" not in source, "blind time.sleep reintroduced"
    assert "wait_for_state(pending" in source, "wake-on-state not wired"
    # Pin the CARRY ARGUMENT, not just the callee: `drain_envelopes(pending)`
    # alone would still pass if main() passed None/literal instead of the
    # envelope the wake-up consumed, silently dropping it (older seq would
    # then be re-ordered behind a newer one on the next push). main() names
    # that envelope `carried`.
    assert "drain_envelopes(pending, carried)" in source, \
        "carry-into-drain not wired (carried envelope dropped)"
    # Dirty flag: paint happens only behind the plan's gate.
    assert "if plan.render:" in source, "dirty gate not wired"
    assert "pacer.note_drain(" in source, "drained-seq ack not wired"
