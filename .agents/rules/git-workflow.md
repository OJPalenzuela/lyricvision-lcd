# Git Workflow

## Approval Rules

- **NO commits** without the user validating the code first — show the diff.
- **NO branches** unless explicitly requested.
- **NO push** unless instructed.
- Before touching code: show plan (files to touch + proposed commits).
- After applying: show commands run and results (typecheck/tests/build).

## Commit Convention

Conventional Commits (English):

```
feat: <brief description>
fix: <brief description>
refactor: <brief description>
test: <brief description>
chore: <brief description>
docs: <brief description>
```

Rules:

- One commit per logical change.
- Short imperative messages, no trailing period.
- **No "Co-Authored-By" or AI attribution.**
- Never commit secrets, tokens, USB serial numbers, or absolute private paths.

Examples from this repo's history:

```
feat(renderer): rewrite UI with React and shadcn/ui
feat(renderer): add Vite + React + Tailwind toolchain
feat: LyricVision LCD v0.1 with product docs
```

## Pre-Commit Verification

Before committing, run the part of the cycle that matches the change:

```bash
npx tsc --noEmit            # any TS/TSX
pnpm run build              # renderer changes
python tests/test_registry.py && python tests/test_protocol.py && \
python tests/test_bridge.py && python tests/test_cover.py && \
node tests/test_sync_settings.js && node tests/test_hardening.js
```

If any applicable step fails, do not commit. Fix and retry. There is no lint/format step — none is configured.

## Branches

Default base: `main`.

Format: `feature/<slug>`, `fix/<slug>` (current work uses `feat/ui-modernization` style).

- Keep diffs minimal and factual; rebase/merge policy is the maintainer's call — never force-push shared branches.
- `pnpm-lock.yaml` is the only lockfile; never commit npm/yarn/bun artifacts.

## PRs

- One goal per PR; use `.github/pull_request_template.md` (what changed / quick path for reviewers / out of scope / checklist).
- Hardware-affecting changes (USB transfer, frame encoding, registry rows) require physical-panel validation before the PR is acceptable — see CONTRIBUTING.md.
