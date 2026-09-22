# AGENTS.md

> Compatible with the [agents.md](https://agents.md) standard. Specific rules in `.agents/rules/` — architecture, frontend patterns, bridge, testing, git workflow.

<!-- AGENTS-GENERATED-START -->

## Project Overview

LyricVision LCD is a Windows-only Electron app that shows Spotify synced lyrics on Thermalright USB LCD panels (Vision MAX / Vision 360): the Electron shell owns auth, polling, lyrics, rendering, and tray; a Python sidecar owns all USB I/O.

> Detailed docs: @CONTRIBUTING.md, @docs/architecture.md

## Setup commands

- Install dependencies: `pnpm install` (pnpm-only; then `pnpm approve-builds` if prompted)
- Python bridge venv: `python -m venv .venv` then `.venv\Scripts\activate` and `pip install -r bridge\requirements.txt`
- Dev mode (Vite + Electron): `pnpm run dev`
- Production build: `pnpm run build`
- Run built app: `pnpm run start`

Read first before changing behavior: [docs/project-context.md](docs/project-context.md) (locked hardware facts), then [docs/architecture.md](docs/architecture.md) and [bridge/README.md](bridge/README.md) (wire contract).

## Source Files

```text
src/main.js            Electron main: PKCE auth, polling, LRCLIB cache, tray, sidecar lifecycle
src/preload.js         Context bridge (renderer gets {connected, expiresAt} only — never tokens)
src/bridge-spawn.js    Spawns the Python sidecar, pairs versioned envelopes + acks
src/hardening.js       Settings whitelist/type validation helpers
src/renderer/          React 19 + Vite + Tailwind 4 renderer (App.tsx, components/ui/, lib/)
bridge/lcd_bridge.py   Python sidecar: handshake, rotate, JPEG encode, bulk USB transfer
bridge/protocol.py     Versioned stdin/stdout JSONL protocol
panels/registry.py     Panel registry (VID/PID, identities, handshake bytes)
tests/                 Vitest (renderer + main-process helpers) + pytest (bridge/panels), plus legacy plain-assert scripts
docs/                  Architecture, hardware, packaging, troubleshooting docs
```

## Feature map

| Feature | Files |
|---------|-------|
| Spotify auth / polling | `src/main.js` |
| Lyrics fetch + cache | `src/main.js` (LRCLIB + disk LRU/TTL) |
| Renderer UI | `src/renderer/App.tsx`, `src/renderer/components/ui/` |
| Renderer ↔ main IPC | `src/preload.js`, `src/renderer/lib/bridge.ts` |
| Sidecar spawn / ack | `src/bridge-spawn.js` |
| USB transfer / frames | `bridge/lcd_bridge.py`, `bridge/protocol.py` |
| Panel support rows | `panels/registry.py` |
| Hardening / settings validation | `src/hardening.js` |

## Essential Commands

| Command | Purpose | When |
| ------- | ------- | ---- |
| `pnpm run dev` | Vite dev server + Electron shell | Fast iteration |
| `pnpm run build` | Production renderer build (`dist/renderer`) | Before committing renderer changes |
| `npx tsc --noEmit` | TypeScript strict check (renderer only) | Before committing TS/TSX changes |
| `pnpm test` | Vitest: renderer + main-process suites (6 files, 130 tests) | Hardware-free, before committing JS/TS changes |
| `pnpm test:py` | pytest: bridge/panels suites (26 tests) | Hardware-free, before committing Python changes |
| `pnpm test:all` | Both runners in sequence | Full hardware-free check before committing |
| `python tests/test_registry.py` etc. | Legacy standalone Python smokes | Quick hardware-free spot-check |
| `node tests/test_hardening.js` etc. | Legacy standalone Node smokes | Quick hardware-free spot-check |
| `pnpm run verify:spawn` | Bridge spawn test | Only with physical panel connected |
| `pnpm run pack` / `pnpm run dist` | electron-builder dir / NSIS installer | Release packaging only |

## Verification Cycle

After every code change. Do not mark work complete without passing the relevant checks:

```bash
# 1. Type check (renderer)
npx tsc --noEmit

# 2. Build
pnpm run build

# 3. JS/TS suites (Vitest, hardware-free)
pnpm test

# 4. Python suites (pytest, hardware-free)
pnpm test:py

# (or both runners at once: pnpm test:all)

# 5. Legacy standalone smokes (still runnable directly)
python tests/test_registry.py
python tests/test_protocol.py
python tests/test_bridge.py
python tests/test_cover.py
node tests/test_sync_settings.js
node tests/test_hardening.js
```

`pnpm run verify:spawn` (`tests/test_shell_spawn.js`) needs the physical panel with TRCC and SignalRGB closed; without glass the bridge exits 3. Run it only when hardware is connected.

There is no lint or format script configured — do not invent one.

## Before committing

1. Run the relevant part of the Verification Cycle above; all commands must exit 0.
2. New behavior needs a new test in `tests/`: a Vitest test (`tests/renderer/*.test.*` or `tests/unit/*.test.js`) or a pytest test (`tests/test_*.py` with a real `test_*` function) (see `.agents/rules/testing.md`).
3. No secrets, tokens, USB serial numbers, or absolute private paths in the diff or tests.
4. `pnpm-lock.yaml` updated if dependencies changed; no npm/bun lockfiles ever.

## Code Style

- Renderer: TypeScript strict mode, no `any`, no `as any`. Import UI bits via the `@/` alias (`@/components/ui/...`).
- Styling: Tailwind 4 classes only. shadcn/ui atomic components live in `src/renderer/components/ui/` — extend those, don't fork them.
- Main process and tests are CommonJS (`'use strict'` at top), plain Node APIs, no new runtime deps in the shell.
- Comments explain *why* (protocol, security, hardware constraints), not *what*.

## Hard Rules

1. **pnpm-only.** `preinstall` runs `only-allow pnpm`. Never introduce npm/yarn/bun artifacts or lockfiles.
2. **Tokens never leave the main process.** They live in `safeStorage`; the renderer receives only `{connected, expiresAt}`. Never write tokens to plaintext, logs, settings JSON, or the renderer.
3. **USB belongs to the Python sidecar.** The UI/shell never touches USB directly; all frame state flows over the versioned stdin/stdout JSONL protocol.

## Prohibitions

- **Never** use `any` or `as any` in `src/renderer/`.
- **Never** commit secrets, tokens, serial numbers, or absolute private paths.
- **Never** edit `dist/` or `build/` output by hand.
- **Never** add "Co-Authored-By" or AI attribution to commits.

## Boundaries

**Ask first:** changes to USB transfer, frame encoding, or `panels/registry.py` rows — these require validation on physical hardware before acceptance. Dependency additions outside existing stacks.

**Never:** force-push shared branches, commit credentials/`.env`, weaken the CSP or `setWindowOpenHandler(deny)` hardening in `src/main.js`.

## Generated artifacts

Source-first: edit `src/`, `bridge/`, `panels/`. `dist/` and `build/` are rebuilt by `pnpm run build` / `pnpm run pack` — never hand-edit them.

## Global Conventions

- Package manager: pnpm 12.5.1 (`packageManager` field). Python: 3.14 in a project-local `.venv`.
- Path alias: `@/*` → `src/renderer/*` (tsconfig `paths` + Vite alias).
- Windows-only v0.1: commands in docs use `.\Scripts\` / `bridge\` style where relevant.
- Validation style: Vitest (`pnpm test`) for renderer + main-process helpers, pytest (`pnpm test:py`) for bridge/panels; legacy plain-assert scripts still run directly by interpreter.
- Every fetch in the main process uses `AbortSignal.timeout(8000)`; no `Atomics.wait` anywhere (async only).
- Docs live in `docs/`; keep README, docs, and inline comments consistent when behavior changes.

## Architecture decisions

- **Why two processes:** one owner of USB (Python sidecar) keeps WinUSB/PyUSB failures out of the Electron shell; the shell owns everything user-facing. See `.agents/rules/architecture.md`.
- **Why pnpm:** enforced by `only-allow` preinstall; workspace/build approvals live in `pnpm-workspace.yaml`.
- **Why both runners plus legacy scripts:** Vitest and pytest own the structured suites (fast, hardware-free, CI-enforced); the legacy plain-assert scripts stay runnable standalone for the quick hardware-free pre-commit spot-check.

## Gotchas

- Renderer is built with `base: './'` — a root-absolute `/assets/...` path renders a blank window under `file://`.
- Dev CSP is relaxed by a Vite plugin; production CSP comes from the meta tag in `src/renderer/index.html` — don't loosen it.
- `resources/lcd_bridge.exe` is a packaged artifact shipped via `extraResources`; rebuild it from `bridge/` (see `docs/packaging.md`) instead of hand-editing.
- Signed-in users' Spotify OAuth fallback port is 17322–17331 (17321 is dead).

## Git SSH troubleshooting

If Git fails with `sign_and_send_pubkey` or `Permission denied` against `git@github.com`:
- **Do NOT** switch the remote to HTTPS or retry repeatedly.
- Ask the user to ensure their SSH agent is available and unlocked.

## Definition of Done

1. Relevant Verification Cycle commands all exit 0, results reported honestly (including skipped/hardware-blocked ones).
2. New behavior covered by a test in `tests/` (Vitest or pytest; see `.agents/rules/testing.md`).
3. Docs updated where behavior or commands changed (`README.md`, `docs/`, `CONTRIBUTING.md`).
4. No secrets/serials/private paths in code, tests, or docs.
5. Conventional commit, no AI attribution.

## Contribution guardrails

- Hardware rule (CONTRIBUTING): USB/display/registry changes must be validated on a physical panel — untested hardware changes are not accepted.
- Diagnostics attached to bug reports must be redacted (no tokens, client secrets, serials, absolute paths).
- Issue templates live in `.github/ISSUE_TEMPLATE/`.

## Releasing

1. Update `docs/release-notes-<tag>.md`.
2. Tag `v*` — `.github/workflows/release.yml` builds the unsigned NSIS Setup.exe + `checksums.txt`.
3. Signing is not wired yet (v0.1 ships unsigned); do not claim signed artifacts.

## PR instructions

- Pick ONE goal per PR; frame the title to reflect it (Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- Fill the template in `.github/pull_request_template.md`: what changed, quick path for reviewers (file + command + expected exit), out of scope, checklist.
- One commit per logical change, short imperative message, no trailing period, **no AI attribution**.

## Rule files

- [Architecture](.agents/rules/architecture.md) — process split, stack, data flow
- [Frontend patterns](.agents/rules/frontend-patterns.md) — React/Tailwind/shadcn/ui, state, trust boundaries
- [Bridge protocol](.agents/rules/bridge.md) — Python sidecar, JSONL contract, USB rules
- [Testing](.agents/rules/testing.md) — test runners, commands, new-test rules
- [Git workflow](.agents/rules/git-workflow.md) — commits, branches, pre-commit cycle

## CodeGraph

This repo is indexed by CodeGraph — prefer `codegraph explore "<symbol names or question>"` over grep/find for locating or understanding code.

<!-- AGENTS-GENERATED-END -->

## Context & Token Discipline (human-maintained — outside the managed block)

Two tools are required for gathering code context in this repo. This section lives outside `AGENTS-GENERATED` on purpose: the `agents-generator` skill rewrites everything between the markers on update, so anything placed inside would be lost.

### CodeGraph — always first

`.codegraph/` is indexed and live. Before any `grep`, `find`, or file read:

```bash
codegraph explore "<symbol names or question>"
```

- One call returns the symbols' verbatim source, the call paths between them (including dynamic dispatch), and the blast radius of what depends on them.
- Prefer it for "how does X work", "where is X", and "what reaches Y" questions — it answers in one round-trip what a grep/read loop answers in dozens.
- Do not re-verify CodeGraph output with grep; it comes from a full AST parse. Read raw files only for configs/docs or details CodeGraph does not index.
- If the index is missing or stale for a path, say so and fall back to direct reads — never silently guess.

### rtk — token-optimized command output

`rtk` is a CLI proxy that filters and summarizes noisy output *before* it enters the model's context. Reach for it on chatty commands:

| Instead of | Use | Why |
| --- | --- | --- |
| `ls`, `tree`, `find` | `rtk ls`, `rtk tree`, `rtk find` | compact listings |
| `cat`/`read` on a big file | `rtk read` | intelligent filtering |
| `grep`, `rg` | `rtk grep`, `rtk rg` | strips whitespace, groups by file |
| `git diff`, `git log` | `rtk diff`, `rtk log` | changed lines only, deduped |
| `git status`, general git | `rtk git` | compact output |
| `pnpm …` | `rtk pnpm …` | ultra-compact output |
| `pip`/`npm` audits, `pip list` | `rtk deps` | dependency summary |
| any build/test/lint run | `rtk err <command>` | errors and warnings only |
| any test run | `rtk test <command>` | failures only |

**Exit codes are preserved** (verified: a child exiting `3` yields `rtk err … → 3`, and `0 → 0`). So `rtk err` / `rtk test` are safe inside the Verification Cycle — a failing step still fails.

Two rules keep this honest:

1. **Filtered output is for context economy, not for declaring a pass.** The Verification Cycle still requires the real commands to exit `0`; `rtk err` narrows *what you read*, never *what you measure*.
2. **On any failure, re-run without `rtk`** to get the full, unfiltered output before diagnosing. A summary is a starting point, never the evidence you report.
