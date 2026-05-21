---
phase: 02-webhook-ingest
plan: 01
subsystem: api
tags: [p-queue, p-retry, fastify-plugin, crypto, vitest, drizzle-orm, pino]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "Fastify app scaffold, Drizzle schema (messages table with NewMessage type), configPlugin with INGEST_CONCURRENCY + WEBHOOK_SECRET, db plugin pattern with fp()"

provides:
  - "fastify.queue decorator (PQueue plugin with INGEST_CONCURRENCY concurrency)"
  - "makeWebhookAuthHandler factory with crypto.timingSafeEqual + length guard (INGEST-01)"
  - "extractMessages + NormalizedMessage for all 10 Evolution message types (INGEST-03)"
  - "persistMessage with onConflictDoNothing for dedup (INGEST-04)"
  - "12 Evolution API fixture JSON files for unit testing"
  - "34-test unit suite: auth (8) + ingest (15) + persist (3) + existing config (5) + health (3)"

affects:
  - "02-02 webhook route plan (depends on auth.ts, ingest.ts, persist.ts, queue plugin)"
  - "03-media-enrichment (uses ingest.ts NormalizedMessage type and persist.ts)"

# Tech tracking
tech-stack:
  added:
    - "p-queue@^9.3.0 — in-process async job queue (Sindre Sorhus)"
    - "p-retry@^6.2.1 — exponential backoff for failed jobs"
  patterns:
    - "fp(plugin, { name, dependencies }) for Fastify plugin decoration — extends db.ts pattern"
    - "makeWebhookAuthHandler factory: secret in closure, Buffer.byteLength guard before timingSafeEqual"
    - "extractMessages: array-or-object data guard for Evolution batching (Pitfall 3)"
    - "normalizeMessage: explicit 10-case switch returning null for unknown types (allow-list pattern)"
    - "JSON fixture imports with { type: 'json' } assertion for Node 22 ESM test data"

key-files:
  created:
    - "src/plugins/queue.ts — fastify.queue PQueue decorator, reads INGEST_CONCURRENCY"
    - "src/lib/auth.ts — makeWebhookAuthHandler timing-safe preHandler factory"
    - "src/lib/auth.test.ts — 8 unit tests for INGEST-01 (all 401 paths + pass-through)"
    - "src/services/ingest.ts — extractMessages + normalizeMessage for 10 message types"
    - "src/services/ingest.test.ts — 15 unit tests for INGEST-03 (all types + base fields)"
    - "src/services/persist.ts — persistMessage with Drizzle onConflictDoNothing"
    - "src/services/persist.test.ts — 3 unit tests for INGEST-04 (dedup chain + void return)"
    - "tests/fixtures/text.json — conversation fixture"
    - "tests/fixtures/extended-text.json — extendedTextMessage fixture"
    - "tests/fixtures/audio.json — audioMessage fixture"
    - "tests/fixtures/image.json — imageMessage fixture"
    - "tests/fixtures/video.json — videoMessage fixture"
    - "tests/fixtures/document.json — documentMessage fixture"
    - "tests/fixtures/sticker.json — stickerMessage fixture"
    - "tests/fixtures/location.json — locationMessage fixture"
    - "tests/fixtures/contact.json — contactsArrayMessage fixture"
    - "tests/fixtures/reaction.json — reactionMessage fixture"
    - "tests/fixtures/unknown-type.json — protocolMessage (should return [])"
    - "tests/fixtures/from-me.json — fromMe=true (should return [])"
  modified:
    - "package.json — added p-queue@^9.3.0, p-retry@^6.2.1 to dependencies"

key-decisions:
  - "Kept fastify-type-provider-zod at ^4.0.2 instead of upgrading to ^6.1 — v5+ requires zod v4 (uses zod/v4/core internally), incompatible with project-pinned zod@^3.25; upgrade broke 3 existing health.test.ts tests with 500 errors"
  - "normalizeMessage uses switch statement (not if/else chain) with explicit 10 cases + null default — more readable and ESLint-friendly than chained ifs"
  - "extractMessages handles Array.isArray(data) defensively for Evolution batching (Pitfall 3 A1 assumption)"

patterns-established:
  - "TDD RED/GREEN cycle: test file written first, verified failing before implementation"
  - "Factory pattern for auth handler: closure captures expectedBuf once, not per-request"
  - "Persist service has no logging — logging is caller's responsibility (route handler)"

requirements-completed: [INGEST-01, INGEST-03, INGEST-04, INGEST-05, INGEST-06]

# Metrics
duration: 8min
completed: 2026-05-21
---

# Phase 02 Plan 01: Services Layer Summary

**p-queue Fastify plugin, timing-safe auth handler with crypto.timingSafeEqual + length guard, 10-type Evolution message normalizer, Drizzle onConflictDoNothing persist service — all with unit tests (34 green)**

## Performance

- **Duration:** 8 min
- **Started:** 2026-05-21T22:14:04Z
- **Completed:** 2026-05-21T22:22:44Z
- **Tasks:** 2
- **Files modified:** 21 (2 modified, 19 created)

## Accomplishments

- p-queue@9.3 and p-retry@6.2.1 installed; fastify-type-provider-zod kept at ^4.x (zod v3 compatibility constraint)
- queue.ts plugin decorates fastify.queue with PQueue reading INGEST_CONCURRENCY; error listener emits PT-BR Pino log
- auth.ts makeWebhookAuthHandler: computes expectedBuf once in closure; rejects non-string headers, length mismatches, and wrong values timing-safely — 401 with no RangeError in any case (T-02-01)
- ingest.ts extractMessages: handles array/single-object data, fromMe filter, 10-type switch returning NormalizedMessage or null, unknown types dropped with info log (T-02-02, T-02-03)
- persist.ts persistMessage: single Drizzle call with onConflictDoNothing — duplicate webhook replays are silent no-ops (T-02-04)
- 12 fixture JSON files covering all Evolution messageType values including edge cases (unknown + fromMe)
- Full test suite: 34 tests across 5 files — all passing

## Task Commits

1. **Task 1: Install deps + queue plugin + auth handler + 12 fixtures** - `a5e7ca2` (feat)
2. **Task 2: Ingest service + persist service + unit tests** - `67ffc39` (feat)

## Files Created/Modified

- `package.json` — added p-queue@^9.3.0, p-retry@^6.2.1
- `src/plugins/queue.ts` — PQueue Fastify plugin (fastify.queue decorator)
- `src/lib/auth.ts` — makeWebhookAuthHandler timing-safe factory
- `src/lib/auth.test.ts` — 8 auth unit tests (all GREEN)
- `src/services/ingest.ts` — extractMessages + normalizeMessage (10 types)
- `src/services/ingest.test.ts` — 15 ingest unit tests (all GREEN)
- `src/services/persist.ts` — persistMessage with onConflictDoNothing
- `src/services/persist.test.ts` — 3 persist unit tests (all GREEN)
- `tests/fixtures/*.json` — 12 Evolution API webhook fixture files

## Decisions Made

- Kept `fastify-type-provider-zod@^4.0.2` instead of upgrading to `^6.1` as the plan specified. v5 and v6 import from `zod/v4/core` internally, which is incompatible with the `zod@^3.25` project constraint even though zod 3.25 ships a v4 compatibility folder. Upgrading to v5 caused 3 health.test.ts failures (500 instead of 200/503). Since CLAUDE.md pins zod to v3, downgrading back to v4.0.2 was the correct resolution.
- normalizeMessage uses `switch` with `case` blocks instead of chained `if/else if` — more readable, avoids implicit fall-through, matches ESLint expectations.
- Array guard for `data` field: `Array.isArray(b.data) ? b.data : [b.data]` — zero cost when Evolution sends single object, prevents silent drops if batching is enabled.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Reverted fastify-type-provider-zod upgrade from ^6.1 to ^5.1, then back to ^4.0.2**
- **Found during:** Task 1 (install and upgrade dependencies)
- **Issue:** Plan specified upgrading `fastify-type-provider-zod` to `^6.1`. Install failed: `ERESOLVE` — `fastify-type-provider-zod@6.1.0` requires `zod@>=4.1.5` but project pins `zod@^3.25`. Attempted `^5.1` as intermediate — npm installed successfully (peer dep says `zod>=3.25.67`) but runtime uses `zod/v4/core` internally, causing existing `health.test.ts` to return 500 instead of 200/503.
- **Fix:** Reverted to `fastify-type-provider-zod@^4.0.2` (the version that was working before). All 3 health tests pass again. `FastifyPluginAsyncZod` is exported by v4 and works correctly with zod v3.
- **Files modified:** `package.json`, `package-lock.json`
- **Verification:** `npx vitest run src/routes/health.test.ts` — 3/3 tests pass
- **Committed in:** `a5e7ca2` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — dependency version conflict)
**Impact on plan:** fastify-type-provider-zod remains at ^4.0.2 instead of ^6.1. Plan 02-02 (webhook route) must use the v4 API (same as health.ts). The `FastifyPluginAsyncZod` type and `serializerCompiler`/`validatorCompiler` are available in v4 — no functional impact on the route plan.

## Issues Encountered

- `fastify-type-provider-zod@^6.1` ERESOLVE peer dep conflict with `zod@^3.25` — resolved by staying at `^4.0.2` (see Deviations)

## User Setup Required

None — no external service configuration required. All work is pure in-process code with no new environment variables, databases, or external APIs.

## Next Phase Readiness

Ready for Plan 02-02 (webhook route):
- `fastify.queue` decorator available after `queuePlugin` registered
- `makeWebhookAuthHandler` ready to attach as `preHandler` on the POST route
- `extractMessages` ready to call inside `fastify.queue.add()`
- `persistMessage` ready to call per-message inside the queue job
- All 12 fixture files available for route integration tests

Concern: Plan 02-02 route uses `FastifyPluginAsyncZod` — must use v4 API (same pattern as health.ts). No `withTypeProvider` needed, just `setValidatorCompiler` + `setSerializerCompiler` in test setup.

---
*Phase: 02-webhook-ingest*
*Completed: 2026-05-21*
