---
phase: 03-media-enrichment
plan: 02
subsystem: api
tags: [fastify, openai, enrichment, webhook, vitest, p-queue, ssrf-guard]

# Dependency graph
requires:
  - phase: 03-media-enrichment
    plan: 01
    provides: "src/plugins/openai.ts (fastify.openai), src/services/enrich.ts (enrichMessage), EVOLUTION_URL in config"

provides:
  - "src/index.ts: openaiPlugin registered after dbPlugin, before queuePlugin"
  - "src/routes/webhook.ts: enrichMessage wired into queue job after persistMessage with isolated try/catch"
  - "allowedHostname derived from fastify.config.EVOLUTION_URL at route handler level (T-03-07)"
  - "phase:'enrich' error isolation — enrich failure logged, not rethrown, processing continues to sibling"
  - "src/routes/webhook.test.ts: 3 new enrichment integration tests — enrichMessage called, failure-safe, per-message isolated"
  - "Full suite: 65 tests green"

affects:
  - "Phase 3 end-to-end pipeline complete: webhook → persist → enrich"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "enrichMessage called after persistMessage with continue in persist catch (skip enrich when persist fails)"
    - "allowedHostname = new URL(fastify.config.EVOLUTION_URL).hostname derived once per request"
    - "vi.mock('../services/enrich.js') + fastify.openai stub in buildApp() for webhook integration tests"
    - "log as unknown as Logger cast for Pino Logger type compatibility in enrichMessage call"

key-files:
  created: []
  modified:
    - "src/index.ts — openaiPlugin import and registration added"
    - "src/routes/webhook.ts — enrichMessage import, allowedHostname derivation, enrich try/catch in queue job"
    - "src/routes/webhook.test.ts — enrich mock, openai stub, EVOLUTION_URL in config, 3 new integration tests"

key-decisions:
  - "allowedHostname derived at route handler level (once per request) not at module level — config is constant at runtime, acceptable per plan"
  - "log as unknown as Logger cast — FastifyBaseLogger is structurally compatible at runtime; pre-existing Logger type mismatch in webhook.ts is out of scope for this plan"
  - "fastify.openai stub decorated as 'any' in test buildApp() — enrichMessage is fully mocked so the object is never called"
  - "EVOLUTION_URL added to test buildApp() config — required by allowedHostname derivation in route handler"

# Metrics
duration: 8min
completed: 2026-05-21
---

# Phase 03 Plan 02: Enrichment Pipeline Wiring Summary

**openaiPlugin registered in index.ts; enrichMessage wired into webhook queue job after persistMessage with per-message error isolation; 3 new integration tests added; 65 total tests green — Phase 3 end-to-end pipeline complete**

## Performance

- **Duration:** 8 min
- **Completed:** 2026-05-21
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- `src/index.ts`: `openaiPlugin` imported and registered after `dbPlugin`, before `queuePlugin` — satisfies `fp()` dependency on `['config']`
- `src/routes/webhook.ts`: `enrichMessage` imported from `../services/enrich.js`
- `allowedHostname` derived once per request from `new URL(fastify.config.EVOLUTION_URL).hostname` (T-03-07 — EVOLUTION_URL validated as URL by Zod at startup, no runtime throw)
- `enrichMessage` called inside the existing `fastify.queue.add()` job after `persistMessage` with its own `try/catch`
- Persist `catch` block uses `continue` — enrichMessage is skipped when persist fails
- Enrich `catch` block logs `phase: 'enrich'` structured error, no rethrow — message stays persisted
- Fire-and-forget pattern preserved: `void fastify.queue.add(...)` unchanged
- `src/routes/webhook.test.ts`: `vi.mock('../services/enrich.js')` prevents real OpenAI calls in tests
- `buildApp()` updated: `EVOLUTION_URL` added to config stub, `fastify.openai` stub decorated
- 3 new integration tests: enrichMessage called with correct args (audio), enrich failure still returns 200, per-message isolation (sibling attempted after first enrich throws)
- Full suite: **65 tests green** (7 test files)

## Task Commits

1. **Task 1: Register openaiPlugin in index.ts + wire enrichMessage into webhook queue job** — `00af569` (feat)
2. **Task 2: Update webhook integration tests + full suite gate** — `6610c3a` (feat)

## Files Created/Modified

- `src/index.ts` — openaiPlugin import + registration
- `src/routes/webhook.ts` — enrichMessage import, allowedHostname, enrich try/catch
- `src/routes/webhook.test.ts` — enrich mock, openai stub, EVOLUTION_URL config, 3 new tests

## Decisions Made

- `allowedHostname` is derived at route handler scope (per request) rather than module scope. Since `fastify.config.EVOLUTION_URL` is constant for the process lifetime this is semantically equivalent — and simpler than plugin-level derivation.
- The `log as unknown as Logger` cast in the `enrichMessage` call silences the TypeScript `FastifyBaseLogger` vs `pino.Logger` mismatch. The pre-existing error on the `extractMessages` call (line 60) is out of scope — it predates this plan. Only the new enrichMessage call was fixed.
- `fastify.openai` is stubbed as `{} as any` in tests — the `enrichMessage` module mock means the stub is never actually called, so type fidelity is unnecessary.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] New enrichMessage call introduced Logger type error**
- **Found during:** Task 1 (TypeScript compile — `npx tsc --noEmit`)
- **Issue:** `enrichMessage` expects `Logger` from `pino`; `fastify.log.child(...)` returns `FastifyBaseLogger`. New error on line 86 introduced by this plan.
- **Fix:** Added `import type { Logger } from 'pino'` and cast `log as unknown as Logger` at the enrichMessage call site. Pre-existing same error on line 60 (`extractMessages` call) left out of scope.
- **Files modified:** `src/routes/webhook.ts`
- **Commit:** `00af569`

**2. [Rule 2 - Missing] EVOLUTION_URL missing from buildApp() test config**
- **Found during:** Task 2 (first test run — `allowedHostname` derivation would throw if EVOLUTION_URL absent)
- **Issue:** `fastify.config.EVOLUTION_URL` is now accessed in the route handler; the test `buildApp()` config stub lacked it.
- **Fix:** Added `EVOLUTION_URL: 'https://evolution.yowa.com.br'` to the config object in `buildApp()`.
- **Files modified:** `src/routes/webhook.test.ts`
- **Commit:** `6610c3a`

## Threat Surface Scan

No new network endpoints or auth paths introduced. Wiring-only plan.

| Threat ID | Mitigation | Status |
|-----------|------------|--------|
| T-03-07 | EVOLUTION_URL parsed via `new URL()` — Zod validates at startup | Implemented in webhook.ts line 55 |
| T-03-08 | p-queue concurrency cap inherited from existing queuePlugin | Accepted — no change needed |
| T-03-09 | Pino logs enrich error internally; never surfaced to HTTP response | Implemented — catch block logs, no rethrow |

## Known Stubs

None. Enrichment pipeline is fully wired end-to-end. No placeholder returns.

## Self-Check: PASSED

- `src/index.ts` contains `openaiPlugin`: FOUND (line 13, 45)
- `src/routes/webhook.ts` contains `enrichMessage`: FOUND (line 14, 83)
- `src/routes/webhook.ts` contains `EVOLUTION_URL`: FOUND (line 55)
- `src/routes/webhook.ts` contains `phase: 'enrich'`: FOUND (line 96)
- `src/routes/webhook.ts` `void fastify.queue.add` present: FOUND (line 59)
- commit `00af569` exists: FOUND
- commit `6610c3a` exists: FOUND
- 65 tests green: VERIFIED

---
*Phase: 03-media-enrichment*
*Completed: 2026-05-21*
