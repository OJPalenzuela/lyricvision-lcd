"""GPU telemetry sampler for the sidecar render loop (task S4-T14).

Why this lives in the Python sidecar and not the Node main process
(orchestrator design decision, condensed -- why, not what):

  * the sidecar's scene refresh policy already carries REFRESH_SENSOR_MS = 1000
    for gpu-temp overlays (bridge/lcd_bridge.py), so the 1 s cadence belongs to
    this process's loop instead of a second timer in another process;
  * routing the value through the display state would change
    display_state_digest every second and force a full panel repaint even for
    static scenes -- exactly the waste S1-T7b's dirty flag removed;
  * zero protocol change: the v:1 wire format stays untouched, no new field.

Mechanism: one stdlib ``subprocess`` call to ``nvidia-smi`` per refresh window
-- no new dependency, no UAC prompt, ~1000 ms cadence. This module is
deliberately standalone and NOT wired into render_scene(): integration is
task S4-T15's job.

Contracts enforced by tests/test_gpu_stats.py:

  * ONE argv / ONE process per probe carries every query field;
  * successful samples are cached for CACHE_TTL_S; failed probes are
    negatively cached for NEGATIVE_TTL_S so a machine without an NVIDIA GPU
    attempts a probe at most once per 30 s instead of respawning a process
    every second forever;
  * graceful absence (missing binary, nonzero exit, timeout, empty or garbage
    output) is a first-class state: read() returns None, never raises.
"""

from __future__ import annotations

import csv
import math
import subprocess
import time
from typing import Callable, NamedTuple, Optional

# One query, one process: temperature is primary (the overlay's headline
# number); the other fields ride along for the S4-T15 overlay without ever
# costing a second spawn. nounits returns the driver's NATIVE unit: for
# temperature.gpu that is degrees Celsius on NVIDIA drivers, so the *_c field
# names are a contract with the driver, not a conversion this module performs.
QUERY_FIELDS = (
    "temperature.gpu",
    "utilization.gpu",
    "memory.used",
    "memory.total",
    "clocks.sm",
    "power.draw",
)

QUERY_ARGV = (
    "nvidia-smi",
    "--query-gpu=" + ",".join(QUERY_FIELDS),
    "--format=csv,noheader,nounits",
)

# Single source for column positions: the argv above asks for these columns in
# this order and the parser below reads them by the SAME map, so reordering
# QUERY_FIELDS can never make the parser read a column the driver did not put
# there. An index map (not a CSV header) is the only option: the argv requests
# noheader, so no header row exists to parse.
_FIELD_INDEX = {name: i for i, name in enumerate(QUERY_FIELDS)}

# Positive cache window: mirrors REFRESH_SENSOR_MS (1000 ms). Two consumers
# reading within one refresh tick share a single nvidia-smi process, so even a
# hot render loop costs at most one spawn per second.
CACHE_TTL_S = 1.0

# Negative cache (re-probe) window: a GPU-less machine must not respawn
# nvidia-smi every second forever. 30 s caps that at ~2 attempts/minute (30x
# fewer spawns) while still recovering within 30 s of a driver, WSL passthrough
# or eGPU appearing.
NEGATIVE_TTL_S = 30.0

# Timeout: sub-second, inside the 1000 ms refresh budget with >= 250 ms of
# headroom, so a hung nvidia-smi can never blow the loop's watchdog.
DEFAULT_TIMEOUT_S = 0.75

# What drivers emit instead of a number; each is "field unavailable", not an
# error. power.draw does this on many cards while idle.
_MISSING = frozenset({"", "n/a", "[n/a]", "[not supported]"})

Runner = Callable[..., Optional[str]]  # (argv, *, timeout) -> stdout | None
Clock = Callable[[], float]  # monotonic seconds


class GpuSample(NamedTuple):
    """One GPU reading; fields the driver refused to report are None.

    temp_c is the primary field (S4-T15's obvious entry point). A sample
    without a usable temperature is never constructed -- the parser returns
    None instead, so temp_c on a non-None sample is always real.
    """

    temp_c: float  # temperature.gpu
    util_pct: Optional[float]  # utilization.gpu
    mem_used_mb: Optional[float]  # memory.used
    mem_total_mb: Optional[float]  # memory.total
    sm_clock_mhz: Optional[float]  # clocks.sm
    power_w: Optional[float]  # power.draw; often None while idle


def _parse_field(cell: object) -> Optional[float]:
    """Tolerant per-field float parse; unparseable -> None, never raises.

    Total on purpose: one bad field must not discard a sample whose
    temperature is valid, so per-field tolerance is the contract, not a
    nicety. ``split()[0]`` also absorbs a stray unit suffix ("67.5 W") even
    though the argv asks for nounits -- format drift must not kill the sample.
    """
    if not isinstance(cell, str):
        return None
    stripped = cell.strip()
    if stripped.lower() in _MISSING:
        return None
    parts = stripped.split()
    if not parts:
        return None
    try:
        value = float(parts[0])
    except ValueError:
        return None
    # "nan"/"inf" parse without error but are not readings: a non-finite
    # temperature would break GpuSample's "temp_c is always real" contract,
    # and a non-finite secondary field would render as the literal text "inf"
    # on the panel. Treat non-finite exactly like an "n/a" cell: field absent.
    return value if math.isfinite(value) else None


def parse_nvidia_smi_csv(text: object) -> Optional[GpuSample]:
    """Pure parse of ``nvidia-smi --query-gpu=... --format=csv,noheader,nounits``.

    Total: non-string, empty, ragged or garbage output yields None instead of
    raising (driver output is untrusted input on a render path). Column
    positions come from _FIELD_INDEX (derived from QUERY_FIELDS), so argv and
    parser cannot drift; on multi-GPU machines the FIRST device row wins --
    deterministic, matching nvidia-smi's enumeration order. Temperature is the
    primary field: no usable temperature -> None. Every other field degrades to
    None independently.
    """
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        rows = [row for row in csv.reader(text.splitlines()) if any(c.strip() for c in row)]
    except Exception:  # csv.Error on ragged/huge fields -- the parser must be total
        return None
    if not rows:
        return None
    cells = rows[0]

    def field(name: str) -> Optional[float]:
        index = _FIELD_INDEX[name]
        return _parse_field(cells[index]) if index < len(cells) else None

    temp = field("temperature.gpu")
    if temp is None:
        return None
    return GpuSample(
        temp_c=temp,
        util_pct=field("utilization.gpu"),
        mem_used_mb=field("memory.used"),
        mem_total_mb=field("memory.total"),
        sm_clock_mhz=field("clocks.sm"),
        power_w=field("power.draw"),
    )


def run_nvidia_smi(argv, *, timeout: float) -> Optional[str]:
    """Default runner: spawn nvidia-smi once, return stdout or None on ANY failure.

    Nonzero exit (missing driver, WSL without GPU passthrough, ...) maps to
    None, and subprocess.run enforces ``timeout`` by killing the child first,
    so a hung nvidia-smi dies instead of outliving the refresh budget.
    FileNotFoundError/PermissionError are swallowed here as well -- though
    GpuSampler.read() guards the runner regardless, because the seam is
    injectable and must never be trusted to behave.
    """
    try:
        completed = subprocess.run(
            [str(arg) for arg in argv],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (subprocess.SubprocessError, OSError):
        # FileNotFoundError (no binary), TimeoutExpired (child killed), ...
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout


class GpuSampler:
    """Caching, absence-tolerant GPU sampler with injected runner + clock seams.

    Both seams exist so pytest covers every path without spawning a process:
    ``runner`` is the process spawn, ``clock`` a monotonic-seconds source --
    no unmockable ``time.monotonic()`` call buried inside the logic. Defaults
    are the real subprocess runner and ``time.monotonic``.

    Threading contract for S4-T15 (the sidecar is single-threaded): call
    read() ONLY from the render/main loop thread, keep ONE shared instance,
    and never raise timeout_s above ~4 s. This state has no lock on purpose;
    with one shared instance the worst case per iteration is the 1.0 s cache
    window plus one 0.75 s spawn (~1.75 s) against the 5 s bridge watchdog,
    while a fresh instance per call could spawn ~7 nvidia-smi processes in one
    iteration and breach 5000 ms.
    """

    def __init__(
        self,
        runner: Optional[Runner] = None,
        *,
        clock: Optional[Clock] = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        cache_ttl_s: float = CACHE_TTL_S,
        negative_ttl_s: float = NEGATIVE_TTL_S,
    ) -> None:
        self._runner: Runner = runner if runner is not None else run_nvidia_smi
        self._clock: Clock = clock if clock is not None else time.monotonic
        self._timeout_s = timeout_s
        self._cache_ttl_s = cache_ttl_s
        self._negative_ttl_s = negative_ttl_s
        self._sample: Optional[GpuSample] = None
        self._sample_at: Optional[float] = None
        self._failed_at: Optional[float] = None

    def read(self) -> Optional[GpuSample]:
        """Current sample, or None. NEVER raises -- the broad guard is intentional.

        This runs inside the render loop, where an escaping exception can take
        the panel down, so any unexpected failure degrades to "no telemetry" --
        the same first-class state as a machine with no NVIDIA GPU.
        """
        try:
            return self._read()
        except Exception:
            self._mark_failed()
            return None

    def _read(self) -> Optional[GpuSample]:
        now = self._clock()
        if self._sample is not None and self._sample_at is not None:
            if (now - self._sample_at) < self._cache_ttl_s:
                return self._sample
        if self._failed_at is not None and (now - self._failed_at) < self._negative_ttl_s:
            return None  # failed recently: absence is cached, no respawn
        raw = self._runner(QUERY_ARGV, timeout=self._timeout_s)
        sample = parse_nvidia_smi_csv(raw)
        if sample is None:
            self._mark_failed()
            return None
        self._sample = sample
        self._sample_at = self._clock()
        self._failed_at = None
        return sample

    def _mark_failed(self) -> None:
        """Negatively cache this failure and drop the stale sample.

        Dropping is deliberate: after an explicit failed probe, honest "no
        data" beats silently stale numbers. The clock call itself is guarded
        because the failure path must never raise (an injected clock could;
        time.monotonic cannot) -- with a broken clock this degrades to None
        with no respawns, the safe direction.
        """
        self._sample = None
        self._sample_at = None
        try:
            self._failed_at = self._clock()
        except Exception:
            self._failed_at = None
