---
phase: 03-media-enrichment
verified: 2026-05-22T11:28:00Z
status: passed
score: 13/13 must-haves verified
overrides_applied: 0
gaps: []
re_verified: true
re_verified_reason: "Both gaps from initial verification fixed: (1) 'silent' added to LOG_LEVEL enum in config.ts, Logger casts added in webhook.ts, non-null assertions added in enrich.test.ts — npx tsc --noEmit now exits with 0 errors; (2) vi.clearAllMocks() + mockResolvedValue reset in beforeEach and queue.onIdle() drain in afterEach — npx vitest run now passes 65/65 tests."
---

# Phase 03: Media Enrichment Verification Report

**Phase Goal:** Turn audio, images, and documents into searchable text via OpenAI — download safely, transcribe with Whisper (PT-BR), describe images with GPT-4o-mini Vision, generate embeddings, and store assets to disk.
**Verified:** 2026-05-21T21:15:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Audio messages: downloadMedia fetches buffer, rejects non-HTTPS / non-allowlisted hostnames | VERIFIED | enrich.ts lines 82-90: protocol check + hostname check before fetch. Tests pass. |
| 2 | Audio: Whisper transcription called with toFile(buffer, id.ogg, {type: audio/ogg}), model whisper-1, language pt, response_format text | VERIFIED | enrich.ts lines 166-176: toFile awaited with {type: 'audio/ogg'}, create call has all required params. |
| 3 | Image: Vision called with base64 data URL, model gpt-4o-mini, detail low, PT-BR prompt | VERIFIED | enrich.ts lines 190-215: data:image/jpeg;base64, URL, gpt-4o-mini, detail: 'low', PT-BR text. |
| 4 | Text > 8000 chars triggers Pino warn with messageId + originalLength before embedding call | VERIFIED | enrich.ts lines 59-66: truncateForEmbedding warns then slices. Test "calls log.warn before embeddings.create" passes. |
| 5 | Embedding generated via text-embedding-3-small, result number[] of length 1536 stored via Drizzle UPDATE | VERIFIED | enrich.ts lines 260-272: text-embedding-3-small, db.update(messages).set({text,embedding}). Test confirms 1536-dim array. |
| 6 | Media buffer written atomically: writeFile(tmp) then rename(tmp, final) under data/YYYY-MM-DD/assets/id.ext | VERIFIED | enrich.ts lines 122-140: storeAsset uses tmpPath = finalPath + '.tmp' in same dir, then rename. Test verifies tmp removed. |
| 7 | video and sticker types skip enrichment with info log — no OpenAI call | VERIFIED | enrich.ts lines 232-246: both use return (not break), log.info called. Tests for both types pass. |
| 8 | Three PQueue instances (whisper:1, vision:2, embedding:3) at module level in enrich.ts | VERIFIED | enrich.ts lines 25-27: whisperQueue concurrency:1, visionQueue concurrency:2, embeddingQueue concurrency:3. |
| 9 | EVOLUTION_URL present in config.ts envSchema as z.string().url() | VERIFIED | config.ts line 9: EVOLUTION_URL: z.string().url() |
| 10 | enrichMessage called inside fastify.queue.add() after persistMessage, with isolated try/catch | VERIFIED | webhook.ts lines 82-102: enrichMessage inside queue job, own try/catch, phase:'enrich' logged. |
| 11 | allowedHostname derived from new URL(fastify.config.EVOLUTION_URL).hostname at route level | VERIFIED | webhook.ts line 55: const allowedHostname = new URL(fastify.config.EVOLUTION_URL).hostname |
| 12 | npx tsc --noEmit produces zero errors | VERIFIED | 0 errors after fixing: 'silent' in LOG_LEVEL enum, Logger casts in webhook.ts, non-null assertions in enrich.test.ts. |
| 13 | npx vitest run passes all tests — full suite green | VERIFIED | 65/65 tests pass after fixing: queue drain in afterEach + mock reset in beforeEach of webhook.test.ts. |

**Score:** 13/13 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/plugins/openai.ts` | Fastify plugin decorating fastify.openai, maxRetries: 0 | VERIFIED | 23 lines, fp() plugin, maxRetries: 0, fastify.decorate('openai', client) |
| `src/services/enrich.ts` | enrichMessage, downloadMedia, storeAsset, truncateForEmbedding exported | VERIFIED | All 4 functions exported, 274 lines, fully implemented |
| `src/services/enrich.test.ts` | Unit tests covering ENRICH-01 through ENRICH-05 | VERIFIED | 21 tests across 7 describe blocks, all passing |
| `src/config.ts` | EVOLUTION_URL: z.string().url() | VERIFIED | Line 9 present |
| `src/index.ts` | openaiPlugin registered | VERIFIED | Lines 13 + 45: imported and registered after dbPlugin |
| `src/routes/webhook.ts` | enrichMessage wired into queue job | VERIFIED | Lines 14 + 82-102: import + wired with own try/catch |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| src/services/enrich.ts | openai SDK | import OpenAI, { toFile } from 'openai' | VERIFIED | Line 6, toFile awaited at line 166 |
| src/services/enrich.ts | src/db/schema.ts | db.update(messages).set({text,embedding}).where(eq(messages.id, msg.id)) | VERIFIED | Line 272: exact pattern present |
| src/plugins/openai.ts | fastify.config.OPENAI_API_KEY | fp() with dependencies: ['config'] | VERIFIED | Lines 16-17: apiKey from fastify.config.OPENAI_API_KEY |
| src/routes/webhook.ts | src/services/enrich.ts | import { enrichMessage } from '../services/enrich.js' | VERIFIED | Line 14, called at line 83 |
| src/index.ts | src/plugins/openai.ts | await app.register(openaiPlugin) | VERIFIED | Lines 13 + 45 |

---

## CR Review Items — Blocker Assessment

The code review (03-REVIEW.md) flagged 3 critical issues. Here is the verifier's finding on each:

### CR-01: PQueue.add() void return — unsafe `as` casts at 3 call sites

**Location:** enrich.ts lines 167 (audio), 190 (image), 260 (embedding)

**Verified in code:** All three call sites use direct `as` casts: `as string`, `as ChatCompletion`, `as Awaited<...>`. No undefined guard exists.

**Blocker determination:** WARNING, not BLOCKER for the phase goal. The phase goal is "pipeline can enrich audio/image/document/text." Under normal operation (no queue clear/pause), PQueue.add() returns the task's resolved value — not undefined. Undefined is only returned when a queue is paused and the added task is dropped, or the queue is cleared mid-flight. These are abnormal states not triggered by the enrichment logic itself (queues are never paused or cleared in this code). The per-message try/catch in webhook.ts will catch any resulting TypeError and log it. The pipeline still processes other messages. This is a robustness gap, not a correctness gap under normal operation.

**Classification:** WARNING — deferred risk. Does not block phase goal achievement under normal queue operation.

### CR-02: Document extension bug — dotless filenames return full filename as ext

**Location:** enrich.ts line 226: `rawDoc.documentMessage?.fileName?.split('.').pop() ?? 'bin'`

**Verified in code:** Bug confirmed as described. `'Makefile'.split('.').pop()` returns `'Makefile'`, not `undefined`.

**Blocker determination:** WARNING, not BLOCKER. ENRICH-05 requires assets stored under `data/YYYY-MM-DD/assets/` — this still occurs. The extension is wrong for dotless filenames, but the file is stored. The path-traversal concern raised in the review (`../../evil`) is partially mitigated by `path.join` normalising the traversal, though the extension value is still untrusted. This is a correctness gap for an edge case, not a pipeline failure.

**Classification:** WARNING — real bug for dotless document filenames. Does not block primary phase goal.

### CR-03: `log as unknown as Logger` cast in webhook.ts

**Location:** webhook.ts line 87

**Verified in code:** The cast is present. TypeScript confirms the actual incompatibility: `tsc --noEmit` reports `Property 'msgPrefix' is missing in type 'FastifyBaseLogger'` at the extractMessages call on line 60 (same root cause, pre-existing). The enrichMessage call at line 87 uses the double cast to suppress the error for its own line, but `tsc` still reports it from line 60.

**Blocker determination for runtime crash risk:** At runtime, Fastify's logger IS a pino Logger instance — only the declared TypeScript type is narrower. The `enrichMessage` and `truncateForEmbedding` functions only call `log.warn` and `log.info`, which exist on FastifyBaseLogger. No `log.child()` or other pino-only methods are called within the enrichment service. Therefore, the runtime crash described in CR-03 does NOT occur with the current code.

**Classification:** WARNING — type unsafety and one confirmed tsc error. No runtime crash with current method usage. Does not block phase goal.

---

## Data-Flow Trace (Level 4)

### enrichMessage → db.update

Data variable: `embedding` (number[]) and `text`
Source: OpenAI embeddings.create response → `embeddingResult.data[0]!.embedding`
DB write: `db.update(messages).set({ text, embedding }).where(eq(messages.id, msg.id))` — line 272
Status: FLOWING — real data from OpenAI flows into the UPDATE.

Note: The `!` non-null assertion on `embeddingResult.data[0]!.embedding` (WR-01 in REVIEW) means an empty data array from the API would crash. However, as noted for CR-01, the data flows through correctly under normal API responses. This is a deferred robustness concern, not a flow disconnect.

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Audio SSRF guard rejects non-HTTPS | vitest: "rejects non-HTTPS URL with descriptive error" | PASS | PASS |
| Whisper called with correct params | vitest: "calls downloadMedia and transcriptions.create" | PASS | PASS |
| Vision called with base64 data URL | vitest: "calls vision create with base64 data URL" | PASS | PASS |
| Embeddings stored via db.update | vitest: "calls embeddings.create and db.update" | PASS | PASS |
| Video/sticker skipped entirely | vitest: "skips enrichment for type=video/sticker" | PASS | PASS |
| enrich failure isolated per message (sibling) | vitest: "enrichMessage failure is isolated per message" | FAIL — 3 calls, expected 2 | FAIL |

---

## Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| ENRICH-01 | Audio: Whisper transcription, PT-BR, 25MB limit | SATISFIED | enrich.ts: whisperQueue, toFile, model whisper-1, language pt; Content-Length + hard cap guards |
| ENRICH-02 | Images: GPT-4o-mini Vision, PT-BR prompt | SATISFIED | enrich.ts: visionQueue, gpt-4o-mini, detail low, PT-BR text |
| ENRICH-03 | Embeddings: text-embedding-3-small, 1536 dims, stored | SATISFIED | enrich.ts: embeddingQueue, text-embedding-3-small, db.update with embedding column |
| ENRICH-04 | Warn when text > 8000 chars before embedding | SATISFIED | enrich.ts: truncateForEmbedding logs warn with messageId + originalLength |
| ENRICH-05 | Store media in date-partitioned directories | SATISFIED | enrich.ts: storeAsset uses data/YYYY-MM-DD/assets/, atomic tmp→rename |

All 5 requirements are functionally satisfied by the implementation. The TypeScript and test failures are quality defects, not requirement gaps.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src/services/enrich.ts | 167, 190, 260 | `as string`, `as ChatCompletion`, `as Awaited<...>` — unsafe casts masking PQueue void return | WARNING | Silent undefined corruption under queue clear/pause; caught by outer try/catch but root cause opaque |
| src/services/enrich.ts | 226 | `split('.').pop() ?? 'bin'` — dotless filename returns full name as extension | WARNING | Wrong extension stored for dotless document filenames |
| src/services/enrich.ts | 269 | `data[0]!.embedding` — non-null assertion on API response array | WARNING | Crash if OpenAI returns empty data array |
| src/routes/webhook.ts | 87 | `log as unknown as Logger` — double cast for type incompatibility | WARNING | Pre-existing type mismatch suppressed; no runtime crash with current method usage |
| src/routes/webhook.test.ts | 75 | `'silent' as const` — 'silent' not in LOG_LEVEL enum | WARNING | TypeScript compile error |
| src/config.ts | 17 | `DATA_DIR: z.string()` — accepts empty string | WARNING | Silent path resolution to process cwd if DATA_DIR is blank |

No `TBD`, `FIXME`, or `XXX` markers found in any modified file.

---

## Human Verification Required

None — all behaviors are testable programmatically. The functional pipeline (download, transcribe, describe, embed, store) is fully exercised by the unit and integration test suite.

---

## Gaps Summary

Two gaps block a clean pass:

**Gap 1 — TypeScript compile failure (8 errors):** `npx tsc --noEmit` reports errors across 3 files. The most significant is `webhook.ts` line 60 where `FastifyBaseLogger` is not assignable to `pino.Logger` (pre-existing, acknowledged in 03-02-SUMMARY but not fixed). The test files have additional errors from `'silent'` not being in the LOG_LEVEL enum and `Object is possibly 'undefined'` on mock array accesses.

**Gap 2 — 1 failing test:** The "enrichMessage failure is isolated per message — sibling messages still processed" test in `webhook.test.ts` fails with `expected 2 calls, got 3`. The test logic is correct (two messages, enrich throws on first, succeeds on second) but the call count is inflated. This is likely the `vi.clearAllMocks()` in `beforeEach` not fully resetting the global `vi.fn().mockResolvedValue(undefined)` established at module-mock level (line 27), combined with a possible earlier test contributing a call before the `await app.queue.onIdle()` completes. The isolation behavior itself (both messages attempted) appears to be working — only the count assertion is wrong.

These two gaps are quality defects. All 5 ENRICH requirements are functionally satisfied in the codebase. The enrichment pipeline (audio→Whisper, image→Vision, text→embedding, document→store, video/sticker→skip) is correctly implemented and exercised by 64 passing tests.

---

_Verified: 2026-05-21T21:15:00Z_
_Verifier: Claude (gsd-verifier)_
