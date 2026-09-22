"""Tests for the GPU telemetry sampler (bridge/gpu_stats.py, task S4-T14).

TDD: this file was written and observed failing before bridge/gpu_stats.py
existed.

No test spawns a real process: the process seam (runner) and the clock are
injected fakes, so the suite must pass on machines with no NVIDIA GPU. The
single opt-in probe at the bottom is skipped unless `nvidia-smi` is on PATH.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import gpu_stats  # noqa: E402
from bridge.gpu_stats import (  # noqa: E402
    CACHE_TTL_S,
    DEFAULT_TIMEOUT_S,
    NEGATIVE_TTL_S,
    QUERY_ARGV,
    QUERY_FIELDS,
    GpuSample,
    GpuSampler,
    parse_nvidia_smi_csv,
)

GOOD_CSV = "55, 37, 445, 8192, 210, 67.50\n"

# Hardcoded independently of QUERY_FIELDS: the sampling contract (what the
# S4-T15 overlay may rely on) must not silently shrink with the source tuple.
EXPECTED_FIELDS = (
    "temperature.gpu",
    "utilization.gpu",
    "memory.used",
    "memory.total",
    "clocks.sm",
    "power.draw",
)


class FakeClock:
    """Deterministic seconds source: cache windows are purely clock-driven."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_runner(outputs=None, error=None):
    """Build a fake process runner; returns (runner, calls).

    Every invocation records (argv, timeout), so tests can assert invocation
    count, argv shape, and the forwarded timeout without spawning anything.
    """
    calls = []

    def runner(argv, *, timeout):
        calls.append((tuple(argv), timeout))
        if error is not None:
            raise error
        if outputs is None:
            return GOOD_CSV
        index = min(len(calls) - 1, len(outputs) - 1)
        return outputs[index]

    return runner, calls


# --- parsing (pure function) ---------------------------------------------


def test_parses_realistic_multifield_line():
    sample = parse_nvidia_smi_csv(GOOD_CSV)
    assert isinstance(sample, GpuSample)
    assert sample.temp_c == 55.0  # primary field, obvious name for S4-T15
    assert sample.util_pct == 37.0
    assert sample.mem_used_mb == 445.0
    assert sample.mem_total_mb == 8192.0
    assert sample.sm_clock_mhz == 210.0
    assert sample.power_w == 67.5


def test_parses_extra_whitespace_and_decimal_values():
    sample = parse_nvidia_smi_csv("  60.5 ,   5  ,  100  ,  24000 ,  1500  ,  120.53  \n")
    assert sample is not None
    assert sample.temp_c == 60.5
    assert sample.util_pct == 5.0
    assert sample.power_w == 120.53


@pytest.mark.parametrize("power_field", ["[N/A]", "N/A", "", "   "])
def test_unusable_power_field_keeps_valid_temperature(power_field):
    line = f"55, 10, 500, 8192, 1200, {power_field}\n"
    sample = parse_nvidia_smi_csv(line)
    assert sample is not None  # one bad field must not discard the sample
    assert sample.temp_c == 55.0
    assert sample.power_w is None


@pytest.mark.parametrize("temp_field", ["N/A", "[N/A]", "", "not-a-number"])
def test_sample_without_usable_temperature_is_none(temp_field):
    line = f"{temp_field}, 10, 500, 8192, 1200, 40.0\n"
    assert parse_nvidia_smi_csv(line) is None


@pytest.mark.parametrize(
    "garbage",
    [None, "", "   \n", "\n\n", "hello world", "not,csv,at,all,foo,bar"],
)
def test_empty_unparseable_or_non_string_output_is_none(garbage):
    assert parse_nvidia_smi_csv(garbage) is None


@pytest.mark.parametrize("bad_temp", ["nan", "NaN", "inf", "-inf", "Infinity"])
def test_non_finite_temperature_yields_no_sample(bad_temp):
    # float("nan") parses without error but is not a reading; the GpuSample
    # docstring promises temp_c on a non-None sample is always real, so a
    # non-finite temperature must degrade to the same state as "N/A".
    line = f"{bad_temp}, 10, 500, 8192, 1200, 40.0\n"
    assert parse_nvidia_smi_csv(line) is None


def test_non_finite_secondary_field_degrades_to_none():
    # An inf reaching the S4-T15 overlay would render as the literal text
    # "inf" on the panel; degrade it exactly like an "n/a" cell.
    sample = parse_nvidia_smi_csv("55, inf, 500, 8192, 1200, 40.0\n")
    assert sample is not None
    assert sample.temp_c == 55.0
    assert sample.util_pct is None


def test_multi_gpu_output_uses_first_device_row():
    text = "77, 1, 10, 100, 10, 5.0\n42, 2, 20, 200, 20, 6.0\n"
    sample = parse_nvidia_smi_csv(text)
    assert sample is not None
    assert sample.temp_c == 77.0


# --- cache window ---------------------------------------------------------


def test_two_reads_within_window_single_invocation():
    clock = FakeClock()
    runner, calls = make_runner()
    sampler = GpuSampler(runner=runner, clock=clock)
    first = sampler.read()
    clock.advance(0.4)
    second = sampler.read()
    assert first is not None
    assert second == first
    assert len(calls) == 1  # two reads inside 1000 ms -> ONE runner invocation


def test_read_after_window_probes_again_and_refreshes_value():
    clock = FakeClock()
    runner, calls = make_runner(outputs=[GOOD_CSV, "77, 5, 1, 2, 3, 4\n"])
    sampler = GpuSampler(runner=runner, clock=clock)
    first = sampler.read()
    assert first is not None
    assert first.temp_c == 55.0
    clock.advance(CACHE_TTL_S)  # exactly at the 1000 ms boundary the cache expires
    second = sampler.read()
    assert second is not None
    assert second.temp_c == 77.0
    assert len(calls) == 2


def test_single_invocation_argv_carries_all_query_fields():
    runner, calls = make_runner()
    GpuSampler(runner=runner, clock=FakeClock()).read()
    assert len(calls) == 1  # ONE process per refresh window
    argv, _ = calls[0]
    assert argv[0] == "nvidia-smi"
    query_args = [arg for arg in argv if arg.startswith("--query-gpu=")]
    assert len(query_args) == 1  # all fields ride in a single argv
    for field in EXPECTED_FIELDS:
        assert field in query_args[0]
    assert set(EXPECTED_FIELDS) <= set(QUERY_FIELDS)
    assert "--format=csv,noheader,nounits" in argv


def test_query_field_order_is_pinned_positionally():
    # POSITIONAL, not membership: nvidia-smi returns columns in exactly the
    # requested order, so a silent reorder of QUERY_FIELDS relabels every
    # value on the panel while set-based assertions stay green.
    assert QUERY_FIELDS == EXPECTED_FIELDS
    runner, calls = make_runner()
    GpuSampler(runner=runner, clock=FakeClock()).read()
    argv, _ = calls[0]
    assert "--query-gpu=" + ",".join(EXPECTED_FIELDS) in argv


def test_parser_maps_distinct_values_to_their_semantics():
    # One distinctive value per column, laid out in QUERY_FIELDS order: each
    # GpuSample attribute must receive ITS OWN column, not merely A column.
    # This is the semantic pin a reorder of QUERY_FIELDS cannot slip past.
    sample = parse_nvidia_smi_csv("72, 31, 100, 2000, 1500, 45.5\n")
    assert sample is not None
    assert sample.temp_c == 72.0
    assert sample.util_pct == 31.0
    assert sample.mem_used_mb == 100.0
    assert sample.mem_total_mb == 2000.0
    assert sample.sm_clock_mhz == 1500.0
    assert sample.power_w == 45.5


def test_runner_receives_subsecond_timeout():
    runner, calls = make_runner()
    GpuSampler(runner=runner, clock=FakeClock()).read()
    _, timeout = calls[0]
    assert timeout == DEFAULT_TIMEOUT_S
    assert timeout < CACHE_TTL_S  # a hung nvidia-smi must fit inside the 1000 ms refresh


# --- graceful absence is a first-class state ------------------------------


def test_file_not_found_returns_none_and_is_negatively_cached():
    clock = FakeClock()
    runner, calls = make_runner(error=FileNotFoundError("nvidia-smi not found"))
    sampler = GpuSampler(runner=runner, clock=clock)
    assert sampler.read() is None  # absence, not an exception
    for _ in range(5):
        clock.advance(1.0)  # t = 5 s ... still inside the re-probe window
        assert sampler.read() is None
    assert len(calls) == 1  # a GPU-less machine must not respawn every second


def test_ttl_and_timeout_constants_stay_within_their_budgets():
    # CACHE_TTL_S mirrors REFRESH_SENSOR_MS = 1000 (bridge/lcd_bridge.py:
    # 1204): two consumers reading within one refresh tick share one spawn.
    # Both values are pinned independently instead of importing the constant,
    # because importing the sidecar module mutates sys.path at import time
    # (bridge/lcd_bridge.py:40) and drags in its USB dependencies.
    assert CACHE_TTL_S * 1000 == 1000  # == REFRESH_SENSOR_MS
    # Below ~10 s a GPU-less machine respawns nvidia-smi in a tight-ish loop;
    # 0.0/negative would respawn on every render tick -- the exact spawn storm
    # NEGATIVE_TTL_S exists to prevent. 30.0 s = ~2 spawns/minute.
    assert NEGATIVE_TTL_S >= 10.0
    # Must stay inside the 1 s refresh budget, far below the 5 s watchdog
    # (src/main.js + src/hardening.js kill the bridge past 5 s without status).
    assert 0.0 < DEFAULT_TIMEOUT_S < 1.0


def test_negative_cache_expires_and_reprobes():
    clock = FakeClock()
    runner, calls = make_runner(error=FileNotFoundError())
    # Explicit small window + LITERAL timeline: the test must not derive its
    # arithmetic from NEGATIVE_TTL_S, or shrinking that constant to 0.0 would
    # keep this test green while reintroducing the spawn storm it guards.
    sampler = GpuSampler(runner=runner, clock=clock, negative_ttl_s=2.0)
    assert sampler.read() is None
    clock.advance(1.0)  # 1.0 s < 2.0 s window: absence still cached
    assert sampler.read() is None
    assert len(calls) == 1
    clock.advance(1.5)  # 2.5 s > 2.0 s window: over, probe again
    assert sampler.read() is None
    assert len(calls) == 2


# --- failure never kills the loop ----------------------------------------


@pytest.mark.parametrize("bad_output", [None, "", "\n", "N/A junk"])
def test_failed_or_empty_probe_returns_none_without_raising(bad_output):
    clock = FakeClock()
    runner, calls = make_runner(outputs=[bad_output])
    sampler = GpuSampler(runner=runner, clock=clock)
    assert sampler.read() is None
    for _ in range(3):
        clock.advance(1.0)  # empty/garbage output is a failed probe as well
        assert sampler.read() is None
    assert len(calls) == 1  # ...so it is negatively cached: no respawn either


def test_timeout_exception_returns_none_and_is_negatively_cached():
    clock = FakeClock()
    runner, calls = make_runner(
        error=subprocess.TimeoutExpired(cmd="nvidia-smi", timeout=DEFAULT_TIMEOUT_S)
    )
    sampler = GpuSampler(runner=runner, clock=clock)
    assert sampler.read() is None
    clock.advance(2.0)
    assert sampler.read() is None
    assert len(calls) == 1  # timeout is a failure too: negatively cached


def test_arbitrary_runner_exception_cannot_escape():
    runner, calls = make_runner(error=RuntimeError("boom"))
    sampler = GpuSampler(runner=runner, clock=FakeClock())
    assert sampler.read() is None  # broad outer guard: the render loop must survive
    assert len(calls) == 1


class OneShotFaultClock(FakeClock):
    """Clock that raises on exactly one call, then recovers.

    GpuSampler.read()'s outer guard explicitly anticipates a raising injected
    clock; the sampler must record that fault as a failure WITHOUT leaving a
    still-"fresh" positive-cache entry behind.
    """

    def __init__(self, fault_on_call: int) -> None:
        super().__init__()
        self.calls = 0
        self.fault_on_call = fault_on_call

    def __call__(self) -> float:
        self.calls += 1
        if self.calls == self.fault_on_call:
            raise RuntimeError("injected clock fault")
        return self.now


def test_runner_failure_after_cached_success_returns_none():
    clock = FakeClock()
    calls = []

    def runner(argv, *, timeout):
        calls.append(tuple(argv))
        if len(calls) == 1:
            return GOOD_CSV
        raise RuntimeError("nvidia-smi vanished mid-session")

    sampler = GpuSampler(runner=runner, clock=clock)
    first = sampler.read()
    assert first is not None
    assert first.temp_c == 55.0
    clock.advance(CACHE_TTL_S)
    assert sampler.read() is None  # failure never escapes the loop
    assert len(calls) == 2


def test_failure_after_success_drops_stale_sample():
    # A runner failure can only be reached AFTER the positive cache expired
    # (the cache check short-circuits every read until then), so the only way
    # a failure coexists with a still-fresh sample is an exception escaping
    # _read() BEFORE the cache check -- a raising injected clock. That is
    # exactly the path _mark_failed()'s clearing lines must protect.
    clock = OneShotFaultClock(fault_on_call=3)  # read #1: now, then _sample_at
    runner, calls = make_runner()
    sampler = GpuSampler(runner=runner, clock=clock)
    first = sampler.read()
    assert first is not None
    assert first.temp_c == 55.0
    assert len(calls) == 1
    clock.advance(0.5)  # t = 0.5 s: still INSIDE the 1 s positive cache
    assert sampler.read() is None  # the fault is a failure: no escape, no sample
    clock.advance(0.1)  # t = 0.6 s: the positive cache would still be "fresh"
    assert sampler.read() is None  # ...so a stale sample must NOT come back
    assert len(calls) == 1  # failure is negatively cached: still one spawn


# --- default runner (subprocess seam, monkeypatched: never spawns) -------


def test_default_runner_maps_nonzero_exit_to_none(monkeypatch):
    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 1, stdout=GOOD_CSV, stderr="driver error")

    monkeypatch.setattr(gpu_stats.subprocess, "run", fake_run)
    assert gpu_stats.run_nvidia_smi(QUERY_ARGV, timeout=DEFAULT_TIMEOUT_S) is None


def test_default_runner_forwards_timeout_to_subprocess(monkeypatch):
    seen = {}

    def fake_run(argv, **kwargs):
        seen.update(kwargs)
        return subprocess.CompletedProcess(argv, 0, stdout=GOOD_CSV, stderr="")

    monkeypatch.setattr(gpu_stats.subprocess, "run", fake_run)
    assert gpu_stats.run_nvidia_smi(QUERY_ARGV, timeout=DEFAULT_TIMEOUT_S) == GOOD_CSV
    assert seen["timeout"] == DEFAULT_TIMEOUT_S  # every subprocess is bounded


def test_default_runner_swallows_spawn_errors(monkeypatch):
    def fake_run(argv, **kwargs):
        raise FileNotFoundError("nvidia-smi")

    monkeypatch.setattr(gpu_stats.subprocess, "run", fake_run)
    assert gpu_stats.run_nvidia_smi(QUERY_ARGV, timeout=DEFAULT_TIMEOUT_S) is None


# --- optional real-binary probe ------------------------------------------


@pytest.mark.skipif(shutil.which("nvidia-smi") is None, reason="nvidia-smi not on PATH")
def test_real_probe_returns_sample_or_none_without_raising():
    """Opt-in: only runs where the binary exists; must never raise either way."""
    result = GpuSampler().read()
    assert result is None or isinstance(result, GpuSample)
