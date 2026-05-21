---
phase: "01-foundation"
plan: "01"
subsystem: "toolchain"
tags: ["typescript", "eslint", "vitest", "zod", "config", "scaffold"]
dependency_graph:
  requires: []
  provides:
    - "package.json ESM scaffold with all Phase 1 scripts"
    - "tsconfig.json TypeScript 5.9 strict config"
    - "eslint.config.ts no-console:error enforcement"
    - "src/config.ts Zod env schema + loadConfig() fail-fast"
    - "OPS-02 covered by 5 passing unit tests"
  affects:
    - "All subsequent plans (depend on toolchain being correct)"
    - "01-02: Fastify app builds on this scaffold"
tech_stack:
  added:
    - "fastify@5.8.5"
    - "fastify-plugin@5.1.0"
    - "fastify-type-provider-zod@5.1.0 (v5, not v6 — see deviations)"
    - "drizzle-orm@0.45.2"
    - "pg@8.21.0"
    - "zod@3.25.76"
    - "pino@9.14.0"
    - "dotenv@17.4.2"
    - "typescript@5.9.3"
    - "tsx@4.22.3"
    - "drizzle-kit@0.31.10"
    - "vitest@2.1.9"
    - "eslint@9.39.4"
    - "typescript-eslint@8.x"
    - "jiti@2.7.0 (required by ESLint 9 for TypeScript config files)"
  patterns:
    - "Zod safeParse(process.env) with fail-fast process.exit(1)"
    - "ESLint 9 flat config with strictTypeChecked + no-console:error"
    - "ESM module (type: module + moduleResolution: nodenext)"
key_files:
  created:
    - "package.json"
    - "tsconfig.json"
    - "eslint.config.ts"
    - ".prettierrc"
    - "vitest.config.ts"
    - ".env.example"
    - ".gitignore"
    - "src/config.ts"
    - "src/config.test.ts"
  modified: []
decisions:
  - "Used fastify-type-provider-zod@^5.1 instead of ^6.1 — v6 requires zod@>=4.1.5, incompatible with constraint zod@^3.25"
  - "Used moduleResolution: nodenext instead of node20 — node20 is not valid as moduleResolution in TypeScript 5.9 (only as module target)"
  - "Installed jiti as dev dependency — required by ESLint 9 to load eslint.config.ts TypeScript files"
  - "Used Object.create(null) in tests for clean env isolation — avoids @typescript-eslint/no-dynamic-delete on delete process.env[key]"
metrics:
  duration: "~9 minutes"
  completed: "2026-05-21"
  tasks_completed: 2
  files_created: 9
---

# Phase 01 Plan 01: Toolchain Scaffold + src/config.ts Summary

**One-liner:** ESM TypeScript 5.9 project scaffold with Zod env validation (loadConfig fail-fast), ESLint 9 no-console enforcement, and 5 passing OPS-02 unit tests.

## What Was Built

Full project toolchain scaffold for the `brainny` WhatsApp intelligence pipeline:

1. **package.json** — ESM mode (`"type": "module"`), all 11 npm scripts, all Phase 1 production and dev dependencies installed
2. **tsconfig.json** — TypeScript 5.9 strict config (`module: node20`, `moduleResolution: nodenext`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`)
3. **eslint.config.ts** — ESLint 9 flat config with `typescript-eslint` strictTypeChecked + `no-console: error` across `src/`
4. **.prettierrc** — Standard formatting config (singleQuote, trailingComma: all, printWidth: 100)
5. **vitest.config.ts** — Test config with `environment: node`
6. **.env.example** — All 12 env var placeholders
7. **.gitignore** — node_modules, dist, .env
8. **src/config.ts** — Zod `envSchema` + `Env` type + `loadConfig()` fail-fast function (OPS-02)
9. **src/config.test.ts** — 5 unit tests covering all OPS-02 behaviors

## TDD Gate Compliance

- RED commit: `b3cc81e` — failing tests (config.ts did not exist)
- GREEN commit: `3cdc1cd` — implementation + lint fixes, 5/5 tests passing
- REFACTOR: not needed (code matches Pattern 4 exactly)

## Verification Results

| Check | Command | Result |
|-------|---------|--------|
| Unit tests | `npx vitest run src/config.test.ts` | 5/5 PASS |
| TypeScript | `npx tsc --noEmit` | EXIT 0 |
| ESLint | `npx eslint src --max-warnings 0` | EXIT 0 |
| package.json type | `node -e "...type"` | "module" |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] fastify-type-provider-zod v6 incompatible with zod@^3.25**
- **Found during:** Task 1 — npm install
- **Issue:** `fastify-type-provider-zod@6.1.0` requires `peer zod@">=4.1.5"`. Plan specified `^6.1` but CLAUDE.md hard-constrains `zod@^3.25`. The two are mutually incompatible.
- **Fix:** Used `fastify-type-provider-zod@^5.1` which declares `peer zod@">=3.25.67"`, fully compatible with zod@^3.25 and fastify@^5.
- **Files modified:** `package.json`, `package-lock.json`
- **Commit:** `a15871a`

**2. [Rule 3 - Blocking] moduleResolution "node20" not valid in TypeScript 5.9**
- **Found during:** Task 2 — `tsc --noEmit`
- **Issue:** `tsconfig.json` with `"moduleResolution": "node20"` causes `TS6046: Argument for '--moduleResolution' option must be: 'node10', 'classic', 'node16', 'nodenext', 'bundler'`. TypeScript 5.9 accepts `node20` as a `module` target but not as a `moduleResolution` strategy.
- **Fix:** Changed `moduleResolution` from `"node20"` to `"nodenext"`. The `"module": "node20"` (the new TypeScript 5.9 value) remains unchanged.
- **Files modified:** `tsconfig.json`
- **Commit:** `3cdc1cd`

**3. [Rule 3 - Blocking] ESLint 9 requires jiti for TypeScript config files**
- **Found during:** Task 2 — ESLint verification
- **Issue:** `eslint.config.ts` is a TypeScript file. ESLint 9 requires the `jiti` package to load TypeScript configuration files. Without it: `Error: The 'jiti' library is required for loading TypeScript configuration files.`
- **Fix:** Installed `jiti` as a dev dependency. This is a well-known ESLint 9 requirement for TypeScript config files.
- **Files modified:** `package.json`, `package-lock.json`
- **Commit:** `3cdc1cd`

**4. [Rule 1 - Bug] Test used delete on dynamic key — @typescript-eslint/no-dynamic-delete**
- **Found during:** Task 2 — ESLint on src/config.test.ts
- **Issue:** Original test used `delete process.env[key]` in a for-loop which violates `@typescript-eslint/no-dynamic-delete` (strictTypeChecked preset).
- **Fix:** Replaced with `process.env = Object.create(null) as NodeJS.ProcessEnv` in `beforeEach` to start each test with a completely clean env object. This is cleaner and avoids all dynamic delete patterns.
- **Files modified:** `src/config.test.ts`
- **Commit:** `3cdc1cd`

## Known Stubs

None. All exported symbols (`envSchema`, `Env`, `loadConfig`) are fully implemented.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes introduced. T-01-01 (fieldErrors in console.error) and T-01-02 (fail-fast on missing vars) are both addressed per the threat model.

## Self-Check: PASSED

- [x] `package.json` exists with `"type": "module"` and all 11 scripts
- [x] `tsconfig.json` exists with `"module": "node20"` and `"strict": true`
- [x] `eslint.config.ts` exists with `'no-console': 'error'`
- [x] `src/config.ts` exports `envSchema`, `Env`, `loadConfig`
- [x] `src/config.test.ts` — 5 tests passing
- [x] Commits exist: a15871a (scaffold), b3cc81e (RED), 3cdc1cd (GREEN)
