<div align="center">

# agents-generator

**One command. Your entire AI agent rule stack. Generated from your real codebase.**

[![skills.sh](https://skills.sh/b/OJPalenzuela/agents-generator)](https://skills.sh/OJPalenzuela/agents-generator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![agents.md](https://img.shields.io/badge/agents.md-compatible-green)](https://agents.md)
[![version](https://img.shields.io/badge/version-1.1.1-blue)](https://github.com/OJPalenzuela/agents-generator/releases)

</div>

---

## What It Does

**Before**: Your AI agent gives generic advice because it doesn't know your project. Different stack, same suggestions.

**After**: Your agent has an `AGENTS.md` that matches what you *actually* use — every command, convention, and architecture decision derived from your real `package.json`, config files, and directory structure.

```bash
npx skills add OJPalenzuela/agents-generator
```

Then in any project:

```
create AGENTS.md
```

## What You Get

From a **Next.js + Bun + Tailwind + Vitest** project, the skill produces:

```
AGENTS.md                          ← Commands, conventions, verification cycle, PR rules
.agents/rules/
  architecture.md                  ← Stack diagram, routes, data flow
  frontend-patterns.md             ← Components, state, trust boundaries
  server-actions.md                ← Entry points, error handling, rate limiting
  testing.md                       ← "74 tests in 5 files", vitest commands
  git-workflow.md                  ← Conventional commits, pre-commit checks
```

Rules that don't apply (backend without NestJS, database without ORM) are **skipped automatically**.

The generated `AGENTS.md` opens with real content, not placeholders:

```
## Setup commands
- Install deps: `bun install`
- Start dev: `bun dev`
- Run tests: `bun run test:run`

## Essential Commands
| bun dev          | Next.js dev server  |
| bun run test:run | Vitest single-run   |
| bun doctor       | react-doctor check  |

## Verification Cycle
bunx tsc --noEmit → bun run lint → bun run test:run → bun doctor
```

**Minimal mode** — single file following the agents.md standard:

```
## Setup commands
- Install deps: `pnpm install` · Run tests: `pnpm test`

## Code style
- TypeScript strict mode · No `any` types · UI in Spanish, code in English

## Testing instructions
- Run `pnpm test` before merging · Add tests for code you change

## PR instructions
- Conventional commits · No AI attribution in commits
```

## Monorepo Support

Detects workspaces and generates per-package `AGENTS.md` files:

```
packages/db/AGENTS.md        ← Prisma client, build command, entrypoints
packages/validation/AGENTS.md ← Zod schemas, exports map
apps/dashboard/AGENTS.md     ← Next.js, vitest, port 3000
```

## Modes

| Mode | Command | Output |
|------|---------|--------|
| **Full** (default) | `create AGENTS.md` | Rich AGENTS.md + 6-10 companion rule files |
| **Minimal** | `create a simple AGENTS.md` | Single ~30-line AGENTS.md (agents.md standard) |
| **Update** | `update AGENTS.md` | Diff existing, regenerate only what changed |
| **Dry-run** | `preview AGENTS.md` | Show what would be generated, write nothing |

## Usage

**Install:**

```bash
npx skills add OJPalenzuela/agents-generator
```

Or manually:

```bash
git clone https://github.com/OJPalenzuela/agents-generator ~/.config/opencode/skills/agents-generator
```

**Run** from any project:

```
create AGENTS.md              # Full mode
create a simple AGENTS.md     # Minimal mode
update AGENTS.md              # Update existing
preview AGENTS.md             # Dry-run
```

**After generation**, review your setup:
- Commit `.agents/rules/` — they're part of your project documentation
- Add `.agents/backups/` to `.gitignore` — backups don't need to be committed
- Run the verification cycle once to confirm every command works

## Detection

Reads your project and detects **16 categories** automatically:

| Category | Examples |
|----------|----------|
| Package manager | bun, pnpm, npm, yarn |
| Framework + router | Next.js (App/Pages Router), NestJS, Vite, Astro, Express |
| CSS | Tailwind, shadcn/ui, CSS Modules, styled-components |
| Testing | Vitest, Jest, Playwright, Cypress |
| ORM + provider | Prisma (postgres/sqlite), Drizzle, Knex, Mongoose |
| Validation | Zod, Yup, class-validator, plain TypeScript |
| State | Zustand, Redux, Jotai, React Query, SWR |
| API pattern | Server Actions, tRPC, GraphQL, REST |
| Forms, i18n, Auth | react-hook-form, next-intl, NextAuth, Clerk |
| Monorepo | pnpm workspaces, Turborepo, Nx, Lerna |

Plus: design token extraction, @import for existing docs, confidence scoring, managed blocks, multi-platform output.

## Quality Guarantees

- **Validates commands** — every command verified against `package.json` scripts before writing
- **No placeholders** — output scanned for `{{`, `TODO`, `...` — rejected if any remain
- **Backup before overwrite** — existing files copied to `.agents/backups/` with timestamp
- **Line limits** — 300-line soft cap, 500-line hard cap
- **agents.md compatible** — follows the standard used by 60k+ open-source projects

## License

MIT — see [LICENSE](LICENSE)
