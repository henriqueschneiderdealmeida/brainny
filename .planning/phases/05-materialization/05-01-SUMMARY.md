---
phase: 5
plan: "05-01"
subsystem: "materializer"
tags: [materialization, markdown, obsidian, node-cron, atomic-write, pgvector]
dependency_graph:
  requires: [persist, schema]
  provides: [materialize-service]
  affects: [obsidian-vault]
tech_stack:
  added: [node-cron@4.2.1]
  patterns: [atomic-write, tz-aware-grouping, vi.hoisted-mock-pattern]
key_files:
  created:
    - src/services/materialize.ts
    - src/services/materialize.test.ts
  modified:
    - package.json
    - package-lock.json
decisions:
  - "safeFilename replaces @, ., :, /, \\ with underscore and collapses runs — produces valid cross-platform filenames from chatId"
  - "vi.hoisted() required for vitest when mocking node:fs/promises with top-level vi.fn() references — standard vi.mock factory hoisting causes ReferenceError"
  - "Intl.DateTimeFormat('fr-CA') chosen for YYYY-MM-DD output (ISO date without time) — no external date library needed"
metrics:
  duration: "~12 minutes"
  completed: "2026-05-22"
  tasks_completed: 4
  files_created: 2
  files_modified: 2
  tests_added: 20
  tests_total: 98
---

# Phase 5 Plan 01: Materialize service + tests Summary

**One-liner:** Atomic Markdown materializer querying last 48h from DB, grouping by (date, chatId), writing per-chat-per-day files to Obsidian vault with YAML frontmatter (MAT-02, MAT-03, MAT-04).

## What Was Built

`src/services/materialize.ts` exports:

- `runMaterialize(db, dataDir, tz, log)` — queries `messages` table for last 48h window, groups rows by tz-aware date + chatId, renders Markdown per group, writes each file atomically (MAT-02, MAT-03, MAT-04)
- `safeFilename(chatId)` — converts WhatsApp JID chars into valid filesystem components
- `renderDay(chatId, chatName, date, msgs, generatedAt, tz)` — renders Appendix C template: YAML frontmatter + `## HH:MM — Name  [type]` message sections
- `writeAtomic(filePath, content)` — writes to `{path}.tmp` then renames to final path (MAT-04)

`src/services/materialize.test.ts` — 20 unit tests covering all required behaviors via mocked `node:fs/promises`.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Install node-cron@^4.2.0 | a59d554 | package.json, package-lock.json |
| 2 | Create materialize.ts service | bb60b93 | src/services/materialize.ts |
| 3 | Create materialize.test.ts | 07dd04b | src/services/materialize.test.ts |
| 4 (fix) | Fix vi.hoisted() mock pattern | 9b2e9da | src/services/materialize.test.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] vi.mock factory hoisting caused ReferenceError**
- **Found during:** Task 4 (full suite gate)
- **Issue:** vitest hoists `vi.mock()` calls before module-scope `const` declarations, so the `mockMkdir`, `mockWriteFile`, `mockRename` constants referenced in the factory body were not yet initialized — threw `Cannot access 'mockMkdir' before initialization`
- **Fix:** Wrapped mock `vi.fn()` declarations in `vi.hoisted()` — this is the canonical vitest pattern for mocks that need to be referenced inside a `vi.mock` factory
- **Files modified:** src/services/materialize.test.ts
- **Commit:** 9b2e9da

## Verification

- `npx tsc --noEmit` — exits 0 (no type errors)
- `npx vitest run` — 98 tests pass across 9 test files (20 new tests in materialize.test.ts)

## Requirements Satisfied

| Requirement | Description | Status |
|-------------|-------------|--------|
| MAT-02 | Query last 48h window (yesterday + today) | satisfied |
| MAT-03 | Render Appendix C Markdown template per (date, chat) | satisfied |
| MAT-04 | Atomic write: tmp file → rename | satisfied |

## Known Stubs

None — all exported functions are fully implemented and tested.

## Threat Flags

None — materialize.ts reads from DB and writes local files; no new network endpoints or auth paths introduced.

## Self-Check: PASSED

- [x] src/services/materialize.ts — FOUND
- [x] src/services/materialize.test.ts — FOUND
- [x] commit a59d554 — FOUND (chore: install node-cron)
- [x] commit bb60b93 — FOUND (feat: materialize service)
- [x] commit 07dd04b — FOUND (test: materialize.test.ts)
- [x] commit 9b2e9da — FOUND (fix: vi.hoisted mock pattern)
- [x] 98 tests pass (vitest run)
- [x] tsc --noEmit exits 0
