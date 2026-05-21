---
phase: 02-webhook-ingest
plan: 02
subsystem: api
tags: [fastify, webhook, p-queue, pino, vitest, zod, tdd, auth]

# Dependency graph
requires:
  - phase: 02-webhook-ingest
    plan: 02-01
    provides: "makeWebhookAuthHandler, extractMessages, persistMessage, queuePlugin, 12 fixtures"

provides:
  - "POST /webhook/evolution route with preHandler auth + fire-and-forget queue (INGEST-02)"
  - "Per-message error isolation with Pino structured error log (INGEST-05, INGEST-06)"
  - "Pino redact: req.headers['x-webhook-secret'] suppressed from access logs (T-02-06)"
  - "index.ts wired: queuePlugin (after dbPlugin) + webhookRoutes (after healthRoutes)"
  - "7 webhook integration tests (all GREEN)"
  - "Full test suite: 41 tests across 6 files — all GREEN"

affects:
  - "03-media-enrichment (uses POST /webhook/evolution as entry point)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "reply-then-enqueue: await reply.send({ok:true}) BEFORE void fastify.queue.add() (Pitfall 2)"
    - "passthrough Zod body schema: z.object({...}).passthrough() for Evolution webhook tolerance (Pitfall 6)"
    - "route-level bodyLimit: 25MB on /webhook/evolution only; other routes keep 10MB default (Pitfall 7)"
    - "per-message try/catch inside queue.add() job — sibling isolation without rethrowing (INGEST-05)"
    - "child logger per job: fastify.log.child({module, event}) for structured correlation"
    - "TDD RED/GREEN: test file written first, verified failing, then implementation makes it GREEN"

key-files:
  created:
    - "src/routes/webhook.ts — POST /webhook/evolution route plugin (FastifyPluginAsyncZod)"
    - "src/routes/webhook.test.ts — 7 integration tests covering all 7 behavior cases"
  modified:
    - "src/lib/logger.ts — added req.headers['x-webhook-secret'] to Pino redact list"
    - "src/index.ts — added queuePlugin and webhookRoutes registrations"

key-decisions:
  - "reply.send() called BEFORE void fastify.queue.add() — ensures 200 is sent before any queue work begins (INGEST-02 / RESEARCH Pitfall 2)"
  - "webhookBodySchema uses z.passthrough() — loose top-level validation; inner payload parsed defensively in services/ingest.ts (RESEARCH Pitfall 6)"
  - "bodyLimit 25MB set only on the webhook route; global default remains 10MB (RESEARCH Pitfall 7 / T-02-08)"
  - "preHandler: [authHandler] on route directly, not as global hook — auth is route-scoped (T-02-10)"
  - "Per-message try/catch does NOT rethrow — error is logged with Pino and processing continues for siblings (INGEST-05)"

# Metrics
duration: 3min
completed: 2026-05-21
---

# Phase 02 Plan 02: Webhook Route Summary

**POST /webhook/evolution route: timing-safe auth preHandler, passthrough Zod body schema, reply-then-enqueue fire-and-forget pattern with per-message error isolation — full Phase 2 pipeline end-to-end**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-21T22:26:44Z
- **Completed:** 2026-05-21T22:29:31Z
- **Tasks:** 2
- **Files modified:** 4 (2 modified, 2 created)

## Accomplishments

- `src/routes/webhook.ts` created: `POST /webhook/evolution` with `preHandler: [authHandler]` (timing-safe auth), `bodyLimit: 25 * 1024 * 1024`, passthrough Zod schema, reply-before-queue pattern, per-message try/catch with Pino structured error logging
- `src/routes/webhook.test.ts` created: 7 integration tests covering all 7 required behavior cases — all GREEN after TDD cycle
- `src/lib/logger.ts` updated: `req.headers['x-webhook-secret']` added to Pino redact list — secret never appears in access logs (T-02-06)
- `src/index.ts` updated: `queuePlugin` registered after `dbPlugin` (Pitfall 5 guard), `webhookRoutes` registered after `healthRoutes`
- Full vitest suite: **41 tests / 6 files — all GREEN** (auth + ingest + persist + config + health + webhook)
- Phase 2 pipeline complete: Evolution → POST /webhook/evolution → auth → 200 ack → p-queue → extractMessages → persistMessage → messages table

## Task Commits

1. **Task 1: Webhook route + Pino redact + route integration tests** - `9d2d704` (feat)
2. **Task 2: Wire queuePlugin and webhookRoutes into index.ts + full suite gate** - `adc116b` (feat)

## Files Created/Modified

- `src/routes/webhook.ts` — POST /webhook/evolution route plugin (FastifyPluginAsyncZod, no fp())
- `src/routes/webhook.test.ts` — 7 integration tests (all 7 INGEST behavior cases covered)
- `src/lib/logger.ts` — Pino redact list extended with x-webhook-secret
- `src/index.ts` — queuePlugin + webhookRoutes registrations added

## Decisions Made

- **reply-then-enqueue order** — `await reply.send({ok:true})` is the first line in the handler body, before `void fastify.queue.add()`. The timing test (case 4) validates this: response arrives in under 80ms while `persistMessage` has a 100ms artificial delay.
- **passthrough schema** — `webhookBodySchema` uses `.passthrough()` so any new top-level Evolution fields (e.g., `apikey`, `serverUrl`) never cause a 400. Inner structure validation is entirely delegated to `services/ingest.ts` with its explicit type allow-list.
- **route-level bodyLimit** — 25MB set only on `/webhook/evolution`. The global Fastify `bodyLimit` remains 10MB for all other routes (health, future search).

## Deviations from Plan

None — plan executed exactly as written.

- fastify-type-provider-zod v4.0.2 (from Wave 1 constraint) works correctly with `FastifyPluginAsyncZod` — no deviation needed for route typing.
- All 7 test cases pass with exact behavior specified in the plan.

## Known Stubs

None — no placeholder data, hardcoded empty values, or TODOs in the implementation.

## Threat Flags

No new security surface introduced beyond what the plan's threat model covers. All threats mitigated as specified:
- T-02-06: Pino redact entry added to `logger.ts`
- T-02-07: passthrough schema implemented
- T-02-08: route-level bodyLimit 25MB
- T-02-09: per-message try/catch prevents queue stall
- T-02-10: preHandler on route directly

## Self-Check: PASSED

- `src/routes/webhook.ts` — EXISTS
- `src/routes/webhook.test.ts` — EXISTS
- `src/lib/logger.ts` — MODIFIED (x-webhook-secret in redact)
- `src/index.ts` — MODIFIED (queuePlugin + webhookRoutes registered)
- Commit `9d2d704` — EXISTS (`feat(02-02): webhook route + Pino redact update + route integration tests`)
- Commit `adc116b` — EXISTS (`feat(02-02): wire queuePlugin and webhookRoutes into index.ts + full suite gate`)
- `npx vitest run` — 41/41 tests passing

---
*Phase: 02-webhook-ingest*
*Completed: 2026-05-21*
