# Testing Strategy

## Runner

Two structured runners own the suites, with the legacy scripts kept runnable standalone:

- **Vitest** (jsdom + React Testing Library) for `src/renderer/**` and main-process helpers — `pnpm test` runs 6 files, 130 tests, 0 skipped. Config in `vitest.config.ts`, setup in `tests/setup.ts`.
- **pytest** for `bridge/` and `panels/` — `pnpm test:py` runs 26 tests across the 4 `tests/test_*.py` files (pytest itself lives in `requirements-dev.txt`).
- **Legacy plain-assert scripts** still run directly by interpreter (`python tests/test_registry.py`, `node tests/test_hardening.js`) and still exit 0; their coverage now also exists as Vitest/pytest suites.
- **Hardware integration** (`tests/test_shell_spawn.js`) stays behind `pnpm run verify:spawn` / `pnpm test:integration` and is never run by `pnpm test`.

| Command | Purpose |
| ------- | ------- |
| `pnpm test` | Vitest: all JS/TS suites (6 files, 130 tests) — hardware-free |
| `pnpm test:py` | pytest: all Python suites (26 tests) — hardware-free |
| `pnpm test:all` | Both runners in sequence, non-zero exit propagates — hardware-free |
| `python tests/test_registry.py` | Panel registry rows (11 asserts, standalone) |
| `python tests/test_protocol.py` | JSONL envelope/ack protocol (19 asserts, standalone) |
| `python tests/test_bridge.py` | Bridge behavior without USB (57 asserts, standalone) |
| `python tests/test_cover.py` | Frame/cover composition (59 asserts, standalone) |
| `node tests/test_sync_settings.js` | Settings sync + whitelist (33 asserts, standalone) |
| `node tests/test_hardening.js` | Hardening validators (62 asserts, standalone) |
| `pnpm run verify:spawn` | Shell ↔ bridge spawn pairing — **hardware only** (also `pnpm test:integration`) |

Total: 6 Vitest files (130 tests) + 4 pytest files (26 tests) + legacy standalone scripts (146 Python + 95 Node asserts, still exit 0). `tests/test_shell_spawn.js` is hardware-gated: it exits 3 (`blocked`) without a panel and CI runs it `continue-on-error`.

## Test Files

```text
tests/
├── renderer/                 Vitest suites for the React UI (jsdom default)
│   ├── App.test.tsx          app shell, settings load, sliders (19 tests)
│   └── bridge-helpers.test.ts  renderer bridge helpers (15 tests)
├── unit/                     Vitest suites for main-process helpers (node environment)
│   ├── pure-helpers.test.js  pure helpers (30 tests)
│   ├── main-process.test.js  settings validation/sync (24 tests)
│   ├── main-oauth-cache.test.js  OAuth flow + LRCLIB cache (25 tests)
│   └── main-status-diagnostics.test.js  status/diagnostics (17 tests)
├── setup.ts                  Vitest setup file
├── test_registry.py          panels/registry.py rows and handshake bytes (pytest-collectable, also script-runnable)
├── test_protocol.py          bridge/protocol.py envelope round-trips, seq/ack (pytest-collectable, also script-runnable)
├── test_bridge.py            lcd_bridge.py logic with USB stubbed out (pytest-collectable, also script-runnable)
├── test_cover.py             portrait 480x854 cover+lyrics composition (pytest-collectable, also script-runnable)
├── test_sync_settings.js     main-process settings validation/sync (plain-assert, run with `node <file>`)
├── test_hardening.js         src/hardening.js whitelist/type checks (plain-assert, run with `node <file>`)
└── test_shell_spawn.js       src/bridge-spawn.js end-to-end spawn (needs glass)
```

## Running Specific Tests

```bash
# Full hardware-free suites (what CI and pre-PR require)
pnpm test:all

# One runner at a time
pnpm test
pnpm test:py

# A single Vitest file
npx vitest run tests/unit/main-process.test.js

# A single pytest file, optionally filtered to one test
pytest tests/test_bridge.py -k <name>

# Legacy standalone scripts, one file at a time
python tests/test_protocol.py
node tests/test_hardening.js
```

Success criterion: exit code 0. Skipped or hardware-blocked checks are reported as skipped, never as passing.

## Patterns

- Vitest suites use real assertions with React Testing Library for components; USB and network are stubbed by injecting fakes or exercising pure functions — don't open real devices in a hardware-free test.
- Renderer tests run under jsdom (the default); main-process tests in `tests/unit/` carry `// @vitest-environment node` at the top. Renderer imports use the `@/` alias.
- Python tests import from `bridge/` and `panels/` via `tests/__init__.py` package layout; Node tests `require()` the CommonJS modules directly.
- Tests must be deterministic and offline: no Spotify network calls, no USB, no writes outside temp paths.

## When Writing New Tests

- Renderer UI or renderer helpers: `tests/renderer/*.test.{ts,tsx}` with no environment override (jsdom). Main-process helpers: `tests/unit/*.test.js` with `// @vitest-environment node` at the top.
- Python bridge/panels code: `tests/test_*.py` with real `test_*` functions, so pytest always collects at least one test and can never pass vacuously on zero collection.
- Cover behavior, not implementation: protocol edge cases, validation rejections, exit-code mapping.
- New tests must pass on a machine with **no** panel attached — hardware-only checks go in the `verify:spawn` / `test:integration` path.

## Verification

After changes to `src/renderer/`:

```bash
npx tsc --noEmit
pnpm run build
pnpm test
```

After changes to `src/main.js`, `src/hardening.js`, `src/bridge-spawn.js`, `bridge/`, or `panels/`:

```bash
pnpm test
pnpm test:py
```

The legacy standalone scripts (`python tests/test_registry.py`, `node tests/test_hardening.js`, and the rest of the per-file rows above) remain a valid quick spot-check but the runners are the gate.

Report results honestly: `command: exit N`. Skipped or hardware-blocked checks are reported as skipped, never as passing.
