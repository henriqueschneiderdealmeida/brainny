---
phase: 5
plan: "05-02"
subsystem: "materializer"
tags: [materialization, node-cron, graceful-shutdown, overlap-guard, index]
dependency_graph:
  requires: [materialize-service, config, queue-plugin]
  provides: [cron-scheduler, graceful-shutdown]
  affects: [src/index.ts, obsidian-vault]
tech_stack:
  added: []
  patterns: [overlap-guard-boolean, graceful-shutdown-drain, cron-schedule]
key_files:
  created: []
  modified:
    - src/index.ts
    - src/config.ts
    - src/routes/search.test.ts
    - src/routes/webhook.test.ts
decisions:
  - "MATERIALIZER_CRON used from config (not hardcoded '*/5 * * * *') to allow overriding schedule via env var"
  - "app.log cast as unknown as Logger to bridge FastifyBaseLogger vs pino Logger type gap — both share the same shape at runtime"
  - "TIMEZONE added as separate field from TZ (Node standard env var) to avoid conflicts with system timezone env"
metrics:
  duration: "~10 minutes"
  completed: "2026-05-22"
  tasks_completed: 3
  files_created: 0
  files_modified: 4
  tests_added: 0
  tests_total: 98
---

# Phase 5 Plan 02: Wire cron into index.ts + graceful shutdown Summary

**One-liner:** node-cron scheduler wired into index.ts with boolean overlap guard, per-tick structured logging, and SIGTERM/SIGINT graceful drain (MAT-01).

## What Was Built

`src/index.ts` now registers a `node-cron` task after `app.listen()`:

- `cron.schedule(config.MATERIALIZER_CRON, handler, { timezone: config.TIMEZONE, noOverlap: true })` — uses MATERIALIZER_CRON from config for flexibility
- `materializerRunning` boolean guard — skips tick and logs `materializer: tick skipped (already running)` if previous tick is still executing
- Each tick logs: `materializer: tick started` on entry; `{ filesWritten, messagesProcessed, durationMs }` on success; `{ err }` on error
- `shutdown(signal)` async function: stops cron task, drains `app.queue.onIdle()`, then `app.close()` — registered for both SIGTERM and SIGINT

`src/config.ts` extended:

- `DATA_DIR: z.string().default('./data')` — was required, now has safe default so tests and dev boot without env var
- `TIMEZONE: z.string().default('America/Sao_Paulo')` — dedicated cron timezone field

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Extend config.ts with DATA_DIR default and TIMEZONE | 5b7c584 | src/config.ts |
| 2 | Wire cron + overlap guard in index.ts; fix test fixtures | 3417987 | src/index.ts, src/routes/search.test.ts, src/routes/webhook.test.ts |
| 3 | Full suite gate (tsc --noEmit + vitest run) | — (no fixes needed, both pass) | — |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] FastifyBaseLogger not assignable to pino Logger**
- **Found during:** Task 3 (tsc --noEmit gate)
- **Issue:** `runMaterialize` expects `Logger` from `'pino'`; `app.log` is typed as `FastifyBaseLogger` — structurally compatible at runtime but TypeScript treats them as distinct types due to the `msgPrefix` property
- **Fix:** Import `type { Logger } from 'pino'` in index.ts and cast `app.log as unknown as Logger`
- **Files modified:** src/index.ts
- **Commit:** 3417987 (included in Task 2 commit)

**2. [Rule 1 - Bug] Test fixture mock configs missing TIMEZONE field**
- **Found during:** Task 3 (tsc --noEmit gate)
- **Issue:** Adding TIMEZONE to the Zod schema made it required in the `Env` type; test config fixtures in search.test.ts (4 occurrences) and webhook.test.ts (1 occurrence) did not include it — TypeScript TS2345 errors
- **Fix:** Added `TIMEZONE: 'America/Sao_Paulo'` to all mock config objects in both test files
- **Files modified:** src/routes/search.test.ts, src/routes/webhook.test.ts
- **Commit:** 3417987 (included in Task 2 commit)

**3. [Deviation] MATERIALIZER_CRON used from config instead of hardcoded `*/5 * * * *`**
- **Reason:** config.ts already had `MATERIALIZER_CRON` env var; using it keeps the schedule overridable without code changes — strictly better than hardcoding
- **Impact:** Minimal — default is `*/5 * * * *` matching the plan requirement

## Verification

- `npx tsc --noEmit` — exits 0 (no type errors)
- `npx vitest run` — 98 tests pass across 9 test files

## Requirements Satisfied

| Requirement | Description | Status |
|-------------|-------------|--------|
| MAT-01 | node-cron scheduler with overlap guard registered in index.ts | satisfied |

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or external calls introduced. The cron tick calls runMaterialize which reads DB and writes local files (already analyzed in 05-01).

## Self-Check: PASSED

- [x] src/index.ts — FOUND and contains cron.schedule + overlap guard + shutdown handler
- [x] src/config.ts — FOUND with DATA_DIR default and TIMEZONE field
- [x] commit 5b7c584 — FOUND (feat(05): add DATA_DIR default and TIMEZONE env vars to config)
- [x] commit 3417987 — FOUND (feat(05): wire node-cron materializer tick into index.ts)
- [x] 98 tests pass (vitest run)
- [x] tsc --noEmit exits 0
