---
phase: 02-webhook-ingest
verified: 2026-05-21T19:36:00Z
status: gaps_found
score: 5/6 must-haves verified
overrides_applied: 0
gaps:
  - truth: "X-Webhook-Secret header is NOT logged in Pino access logs (redacted)"
    status: failed
    reason: "createLogger() in logger.ts is dead code — index.ts builds Pino inline without importing logger.ts. The active redact array at index.ts:31 omits req.headers['x-webhook-secret']. T-02-06 mitigation is not applied in the running app."
    artifacts:
      - path: "src/lib/logger.ts"
        issue: "createLogger is exported but never imported anywhere in the codebase. The redact list here (including x-webhook-secret) has no effect."
      - path: "src/index.ts"
        issue: "Line 31 redact array: ['*.connectionString', '*.DATABASE_URL', '*.password'] — x-webhook-secret is absent. This is the logger that actually runs."
    missing:
      - "Add \"req.headers['x-webhook-secret']\" to the redact array in src/index.ts at line 31, OR wire index.ts to import and use createLogger() from src/lib/logger.ts"
---

# Phase 2: Webhook Ingest Verification Report

**Phase Goal:** Every WhatsApp message arriving via Evolution API is authenticated, enqueued, normalized, and persisted to PostgreSQL — with 200 ack sent before any queue processing, per-message error isolation, and X-Webhook-Secret never appearing in logs.

**Verified:** 2026-05-21T19:36:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| #  | Truth                                                                                                  | Status      | Evidence                                                                                                                     |
|----|--------------------------------------------------------------------------------------------------------|-------------|------------------------------------------------------------------------------------------------------------------------------|
| 1  | POST /webhook/evolution with wrong/missing X-Webhook-Secret returns 401                               | VERIFIED    | auth.ts: timing-safe comparison with length guard; webhook.test.ts cases 1-2 pass (401, {error:'Unauthorized'})             |
| 2  | POST /webhook/evolution with correct secret returns 200 {ok:true} before queue job completes          | VERIFIED    | webhook.ts:43 `await reply.send({ok:true})` is the first statement, before `void fastify.queue.add()`. Timing test passes (elapsed < 80ms with 100ms mock delay) |
| 3  | The 200 response is sent via `await reply.send({ ok: true })` BEFORE `void fastify.queue.add(...)`   | VERIFIED    | webhook.ts:43-53 — send is line 43, queue.add is line 53. Order is correct. webhook.test.ts timing test confirms.          |
| 4  | Each message is wrapped in its own try/catch — a thrown error on one message does not stop siblings  | VERIFIED    | webhook.ts:58-72 — per-message try/catch with explicit "Do NOT rethrow" comment. Sibling isolation test passes.             |
| 5  | A failed message job emits fastify.log.error with {messageId, errorCode, phase: 'persist'}           | VERIFIED    | webhook.ts:62-69 — log.error called with {messageId, errorCode, phase:'persist', err}. webhook.test.ts error-log test passes.|
| 6  | X-Webhook-Secret header is NOT logged in Pino access logs (redacted)                                  | FAILED      | logger.ts has the correct redact path but createLogger() is never called. index.ts:31 builds Pino inline, omitting x-webhook-secret from the redact array. |
| 7  | fastify.queue and webhook routes are registered in index.ts                                           | VERIFIED    | index.ts:13,15 — imports present. index.ts:43,48 — `await app.register(queuePlugin)` before `await api.register(webhookRoutes)`. Correct order confirmed. |
| 8  | npx vitest run exits 0 — full suite green including webhook.test.ts                                   | VERIFIED    | Executed: 41 tests / 6 files — all passed. auth(8) + ingest(15) + persist(3) + webhook(7) + config(5) + health(3).          |

**Score:** 7/8 truths verified (one FAILED — security gap)

**Phase goal as stated requires "X-Webhook-Secret never appearing in logs". Truth 6 FAILS — the mitigation is dead code.**

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/plugins/queue.ts` | PQueue Fastify plugin (fastify.queue decorator) | VERIFIED | fp-wrapped, name:'queue', dependencies:['config'], reads INGEST_CONCURRENCY, error listener in PT-BR |
| `src/lib/auth.ts` | makeWebhookAuthHandler factory | VERIFIED | Exports makeWebhookAuthHandler; timingSafeEqual + byteLength guard; expectedBuf computed in closure; secret never logged |
| `src/lib/auth.test.ts` | 8 unit tests for INGEST-01 | VERIFIED | All 8 cases present and green |
| `src/services/ingest.ts` | extractMessages + NormalizedMessage | VERIFIED | Exports both; 10-type switch + fromMe filter + array-or-object guard |
| `src/services/ingest.test.ts` | 15 unit tests for INGEST-03 | VERIFIED | 15 cases green |
| `src/services/persist.ts` | persistMessage with onConflictDoNothing | VERIFIED | Single Drizzle call with .onConflictDoNothing(); no logging inside |
| `src/services/persist.test.ts` | 3 unit tests for INGEST-04 (dedup) | VERIFIED | All 3 cases green |
| `tests/fixtures/` | 12 Evolution fixture JSON files | VERIFIED | All 12 files present: text, extended-text, audio, image, video, document, sticker, location, contact, reaction, unknown-type, from-me |
| `src/routes/webhook.ts` | POST /webhook/evolution route | VERIFIED | preHandler:[authHandler], bodyLimit:25MB, passthrough schema, reply-before-queue, per-message try/catch |
| `src/routes/webhook.test.ts` | 7 integration tests | VERIFIED | All 7 behavior cases from plan pass |
| `src/lib/logger.ts` | Updated Pino redact list including x-webhook-secret | STUB/DEAD | File exists with correct redact list, but the function is never called — redaction is not applied to the running app |
| `src/index.ts` | App bootstrap with queuePlugin and webhookRoutes | PARTIAL | queuePlugin and webhookRoutes wired correctly, but inline Pino logger config at line 31 omits x-webhook-secret from redact |

---

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `src/routes/webhook.ts` | `src/lib/auth.ts` | `import.*makeWebhookAuthHandler` | WIRED | webhook.ts:10 imports makeWebhookAuthHandler; used at line 27 |
| `src/routes/webhook.ts` | `src/services/ingest.ts` | `import.*extractMessages` | WIRED | webhook.ts:11 imports extractMessages; used at line 54 |
| `src/routes/webhook.ts` | `src/services/persist.ts` | `import.*persistMessage` | WIRED | webhook.ts:12 imports persistMessage; used at line 59 |
| `src/routes/webhook.ts` | `fastify.queue` | `void fastify.queue.add` | WIRED | webhook.ts:53: `void fastify.queue.add(async () => {` |
| `src/index.ts` | `src/plugins/queue.ts` | `register.*queuePlugin` | WIRED | index.ts:43: `await app.register(queuePlugin)` — after dbPlugin, before withTypeProvider |
| `src/index.ts` | `src/routes/webhook.ts` | `register.*webhookRoutes` | WIRED | index.ts:48: `await api.register(webhookRoutes)` — after healthRoutes |
| `src/plugins/queue.ts` | `fastify.config.INGEST_CONCURRENCY` | `fastify.config.INGEST_CONCURRENCY` | WIRED | queue.ts:16: `concurrency: fastify.config.INGEST_CONCURRENCY` |
| `src/services/persist.ts` | `src/db/schema.ts` | `import.*messages.*from.*db/schema` | WIRED | persist.ts:5-6 imports schema and messages |
| `src/services/ingest.ts` | `src/db/schema.ts` | `import.*NewMessage.*from.*db/schema` | WIRED | ingest.ts:6: `import type { NewMessage } from '../db/schema.js'` |
| `src/lib/logger.ts` | `src/index.ts` | import + usage of createLogger | NOT WIRED | logger.ts is never imported. The file is dead code. |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `src/routes/webhook.ts` | `messages` (NormalizedMessage[]) | `extractMessages(body, log)` → `persistMessage(fastify.db, msg)` | Yes — Drizzle insert from webhook body | FLOWING |
| `src/services/ingest.ts` | `results` | `normalizeMessage(dataItem)` switch on messageType | Yes — 10 cases extract real fields from body | FLOWING |
| `src/services/persist.ts` | (db.insert result) | `db.insert(messages).values(msg).onConflictDoNothing()` | Yes — real Drizzle call | FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Full vitest suite | `npx vitest run` | 41/41 tests passed, 6 files | PASS |
| auth handler 401 on missing header | auth.test.ts case 2 | Green | PASS |
| 200 before queue resolves | webhook.test.ts timing test | elapsed < 80ms with 100ms persist mock | PASS |
| sibling isolation on persist failure | webhook.test.ts isolation test | persistMessage called 2x, good-id processed | PASS |

---

### Probe Execution

Step 7c: SKIPPED — no `scripts/*/tests/probe-*.sh` files declared or present in this phase. Phase is a Node.js service, not a migration/CLI/tooling phase with conventional probes.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| INGEST-01 | 02-01, 02-02 | Timing-safe X-Webhook-Secret validation; 401 on mismatch | PARTIAL | Auth check itself: SATISFIED (timingSafeEqual, 401 paths all correct). Secret-never-in-logs: BLOCKED — redact path in logger.ts is dead code; index.ts inline logger omits it. |
| INGEST-02 | 02-01, 02-02 | 200 {ok:true} immediately, async processing | SATISFIED | reply.send before queue.add confirmed in code and timing test |
| INGEST-03 | 02-01 | All message types handled: text, audio, image, video, document, sticker, location, contact, reaction | SATISFIED | All 10 cases in switch; 15 ingest tests green |
| INGEST-04 | 02-01 | ON CONFLICT DO NOTHING deduplication | SATISFIED | persist.ts:18 `.onConflictDoNothing()`; 3 persist tests green |
| INGEST-05 | 02-01, 02-02 | Per-message error isolation — one failure does not stop siblings | SATISFIED | Per-message try/catch; does not rethrow; isolation test passes |
| INGEST-06 | 02-01, 02-02 | Structured Pino error log with messageId and error details | SATISFIED | log.error({messageId, errorCode, phase:'persist', err}); error-log test passes |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `src/lib/logger.ts` | 7 | Exported function with no import anywhere — dead code | BLOCKER | T-02-06 / INGEST-01 security mitigation not applied; x-webhook-secret appears in access logs in production |
| `src/index.ts` | 31 | Inline Pino redact array missing `"req.headers['x-webhook-secret']"` | BLOCKER | Same root cause as above — active logger does not redact the secret header |
| `src/services/ingest.ts` | 40-42 | No null-guard on `b.data` before array construction | WARNING | If Evolution sends `data: null` (e.g., CONNECTION_UPDATE events), `[null]` is produced, loop crashes on `dataItem.key.fromMe` with TypeError; unhandled exception propagates to queue error handler |
| `src/services/ingest.ts` | 48 | No existence check on `dataItem.key` before property access | WARNING | Malformed items where `key` is missing cause TypeError in the loop |
| `src/services/ingest.ts` | 76 | `sender: data.key.remoteJid` always — `participant` field never read | WARNING | Group message sender identity is lost; sender equals chatId for all group messages, making it impossible to distinguish individual senders |
| `src/services/ingest.ts` | 160-161 | `?? 0` for lat/lng coordinates defaults to Gulf of Guinea (0,0) | INFO | Missing coordinates stored as `(0, 0)` instead of null; pollutes search data |

---

### Human Verification Required

No items requiring human verification were identified for this phase. All must-haves are either programmatically verified or programmatically falsified.

---

## Gaps Summary

**Root Cause:** One root-cause failure produces the single blocker gap.

The `src/lib/logger.ts` `createLogger()` function was written with the correct `x-webhook-secret` redact path, and `src/routes/webhook.ts` references it in a comment ("T-02-06: X-Webhook-Secret redacted in Pino (logger.ts)"). However, `src/index.ts` never imports `logger.ts` — it builds the Pino configuration inline. The inline redact array at `index.ts:31` only contains three paths and omits `"req.headers['x-webhook-secret']"`.

**Effect:** In the running application, every Fastify access log entry for `POST /webhook/evolution` will include the literal value of the `X-Webhook-Secret` header. This directly contradicts the phase goal statement ("X-Webhook-Secret never appearing in logs") and violates T-02-06 and the "secret never logged" aspect of INGEST-01.

**Fix is trivial:** Add `"req.headers['x-webhook-secret']"` to the redact array on `index.ts:31`. Alternatively, import `createLogger` from `logger.ts` and pass the result as the `logger` option to `Fastify()`.

**Secondary findings (non-blocking for phase goal but confirmed correctness defects from CR-03 code review):**
- CR-02 (null data crash) and CR-05 (missing key guard) are crash paths under malformed inputs but do not block the happy-path goal.
- CR-01 (sender identity for groups) is a data quality defect, not a Phase 2 completeness gap (group participant resolution is listed as v2/deferred in REQUIREMENTS.md).

---

_Verified: 2026-05-21T19:36:00Z_
_Verifier: Claude (gsd-verifier)_
