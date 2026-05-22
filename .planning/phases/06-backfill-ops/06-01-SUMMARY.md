---
phase: 6
plan: "06-01"
subsystem: "backfill"
tags: [backfill, cli, evolution-api, cursor-resume, rate-limiting, sync_state]
dependency_graph:
  requires: [config, db-schema, ingest-service, persist-service, enrich-service]
  provides: [backfill-cli, cursor-resume]
  affects: [scripts/backfill.ts, src/config.ts]
tech_stack:
  added: []
  patterns: [cursor-pagination, retry-after-aware-retry, fake-upsert-body, per-message-try-catch]
key_files:
  created:
    - scripts/backfill.ts
  modified:
    - src/config.ts
    - src/config.test.ts
    - src/routes/search.test.ts
    - src/routes/webhook.test.ts
decisions:
  - "Logs translated to PT-BR (aguardando, iniciando, processando, concluido) per CLAUDE.md user-facing log convention"
  - "scripts/ directory created as sibling to src/ — CLI scripts are not part of the server bundle"
  - "EVOLUTION_INSTANCE defaults to 'brainny' matching the project's Evolution instance name"
metrics:
  duration: "~12 minutes"
  completed: "2026-05-22"
  tasks_completed: 3
  files_created: 1
  files_modified: 4
  tests_added: 0
  tests_total: 98
---

# Phase 6 Plan 01: Backfill CLI script Summary

**One-liner:** Cursor-resumable backfill CLI that paginates Evolution /chat/findMessages with Retry-After-aware 429 handling and stores cursors in sync_state (BACKFILL-01, BACKFILL-02).

## What Was Built

`scripts/backfill.ts` — standalone CLI script (tsx-runnable):

- Accepts `--chat <chatId>` to target a single chat, or auto-discovers all chats via `/chat/findChats/{instance}`
- Accepts `--page-size <n>` (default 50) to control Evolution API pagination
- `fetchWithRetry(url, headers, log, maxRetries=5)` — reads `Retry-After` header on 429 responses and sleeps before retry (BACKFILL-01)
- Per-chat cursor loaded from `sync_state` table as `backfill.cursor.{chatId}` before each pagination loop (BACKFILL-02)
- Each page's `records` wrapped as `{ event: 'MESSAGES_UPSERT', data: records }` to feed `extractMessages` without duplicating parsing logic
- Per-message `try/catch` — one failed persist/enrich does not interrupt the batch; error logged with `msgId`
- Cursor upserted after each page to `sync_state` via `onConflictDoUpdate` — restart resumes from last successful page
- Drains pool and calls `process.exit(0)` on completion

`src/config.ts` extended:

- `EVOLUTION_API_KEY: z.string().min(1)` — required API key for Evolution instance
- `EVOLUTION_INSTANCE: z.string().min(1).default('brainny')` — instance name, defaults to project instance

Test fixtures updated in `src/config.test.ts`, `src/routes/search.test.ts` (3 mock config objects), and `src/routes/webhook.test.ts` (1 mock config object) to include `EVOLUTION_API_KEY` and `EVOLUTION_INSTANCE`.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Add EVOLUTION_API_KEY and EVOLUTION_INSTANCE to config.ts + update test fixtures | e5f5bda | src/config.ts, src/config.test.ts, src/routes/search.test.ts, src/routes/webhook.test.ts |
| 2 | Create scripts/backfill.ts with cursor-resumable Evolution pagination | 2198dbe | scripts/backfill.ts |
| 3 | Full suite gate (tsc --noEmit + vitest run) | — (no fixes needed) | — |

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Minor Adjustments

**1. Log messages translated to PT-BR**
- **Found during:** Task 2 (script implementation)
- **Reason:** CLAUDE.md mandates PT-BR for user-facing log messages; plan template had English logs
- **Fix:** Translated all user-facing log strings (e.g., "waiting" → "aguardando", "starting" → "iniciando", "processing chat" → "processando chat", "Fatal backfill error" → "Erro fatal no backfill")
- **Files modified:** scripts/backfill.ts

## Verification

- `npx tsc --noEmit` — exits 0 (no type errors)
- `npx vitest run` — 98 tests pass across 9 test files (unchanged from prior phase)

## Requirements Satisfied

| Requirement | Description | Status |
|-------------|-------------|--------|
| BACKFILL-01 | 429 responses trigger Retry-After-aware wait before retry | satisfied |
| BACKFILL-02 | Cursor stored/loaded from sync_state; rerunning resumes from last cursor | satisfied |

## Known Stubs

None.

## Threat Flags

None — `scripts/backfill.ts` is a CLI tool run manually or via cron, not an HTTP endpoint. It reads from Evolution API (already in the SSRF allowlist derivation pattern) and writes to the same PostgreSQL database. No new network surface introduced.

## Self-Check: PASSED

- [x] scripts/backfill.ts — FOUND (165 lines, contains fetchWithRetry, cursor logic, pipeline reuse)
- [x] src/config.ts — FOUND with EVOLUTION_API_KEY and EVOLUTION_INSTANCE fields
- [x] commit e5f5bda — FOUND (feat(06): add EVOLUTION_API_KEY and EVOLUTION_INSTANCE to config)
- [x] commit 2198dbe — FOUND (feat(06): add scripts/backfill.ts with cursor-resumable Evolution pagination)
- [x] 98 tests pass (vitest run)
- [x] tsc --noEmit exits 0
