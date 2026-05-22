---
phase: 03-media-enrichment
plan: 01
subsystem: api
tags: [openai, whisper, vision, embeddings, p-queue, p-retry, pgvector, fastify-plugin, vitest, ssrf-guard]

# Dependency graph
requires:
  - phase: 02-webhook-ingest
    provides: "fastify.queue decorator, NormalizedMessage type, persistMessage, configPlugin with OPENAI_API_KEY"

provides:
  - "src/plugins/openai.ts: fastify.openai OpenAI client decorator, maxRetries:0"
  - "src/services/enrich.ts: enrichMessage, downloadMedia, storeAsset, truncateForEmbedding exports"
  - "SSRF guard in downloadMedia: HTTPS-only + hostname allowlist from EVOLUTION_URL env (T-03-01)"
  - "Content-Length pre-check + 25MB hard cap in downloadMedia (T-03-02)"
  - "Three PQueue singletons: whisperQueue(1), visionQueue(2), embeddingQueue(3)"
  - "p-retry withRetry wrapper: retries:4, randomize:true, AbortError on 4xx non-429"
  - "EVOLUTION_URL z.string().url() added to envSchema in config.ts"
  - "21-test unit suite for ENRICH-01 through ENRICH-05 (all green)"

affects:
  - "03-02 webhook wiring plan (uses fastify.openai, enrichMessage, EVOLUTION_URL config)"

# Tech tracking
tech-stack:
  added:
    - "openai@^5.23 — Whisper transcription, GPT-4o-mini Vision, text-embedding-3-small embeddings"
  patterns:
    - "fp() OpenAI plugin with maxRetries:0 (mirrors db.ts pattern; T-03-05)"
    - "downloadMedia: HTTPS check + hostname allowlist before fetch (T-03-01)"
    - "toFile(buffer, name, { type }) — awaited separately before transcriptions.create (Pitfall 1)"
    - "ChatCompletion cast for visionQueue result to access .choices"
    - "video/sticker cases use return (not break) to prevent caption-text from embedding"
    - "vi.clearAllMocks() in global beforeEach to prevent mock bleed across describe blocks"

key-files:
  created:
    - "src/plugins/openai.ts — OpenAI Fastify plugin (fastify.openai, maxRetries:0)"
    - "src/services/enrich.ts — enrichMessage, downloadMedia, storeAsset, truncateForEmbedding"
    - "src/services/enrich.test.ts — 21 unit tests covering ENRICH-01 through ENRICH-05"
  modified:
    - "src/config.ts — EVOLUTION_URL: z.string().url() added to envSchema"
    - "src/config.test.ts — VALID_ENV updated to include EVOLUTION_URL"
    - "package.json — openai@^5.23 added to dependencies"

key-decisions:
  - "toFile called with { type: 'audio/ogg' } not { contentType } — FilePropertyBag uses 'type' not 'contentType' (TypeScript d.ts confirmed)"
  - "video and sticker use return not break — prevents msg.text caption from being embedded (behavior intent: skip ALL enrichment)"
  - "ChatCompletion explicit cast for visionQueue.add result — avoids union type with Stream<ChatCompletionChunk>"
  - "EVOLUTION_URL added to config.ts envSchema (not hardcoded in enrich.ts) — allows SSRF allowlist to be config-driven per deployment"
  - "p-retry mock returns fn() directly in tests — avoids real delays while preserving call-through semantics"

# Metrics
duration: 12min
completed: 2026-05-21
---

# Phase 03 Plan 01: OpenAI Plugin, Config Extension, and Enrichment Service Summary

**openai@^5.23 installed; EVOLUTION_URL added to config schema; OpenAI Fastify plugin (maxRetries:0) and full enrichment service (downloadMedia with SSRF guard, Whisper/Vision/Embeddings via three PQueue singletons, atomic storeAsset) with 21 passing unit tests**

## Performance

- **Duration:** 12 min
- **Completed:** 2026-05-21
- **Tasks:** 2
- **Files modified:** 6 (3 modified, 3 created)

## Accomplishments

- `openai@^5.23` installed and in `package.json` dependencies
- `EVOLUTION_URL: z.string().url()` added to `envSchema` in `src/config.ts` — hostname extracted at call site for SSRF allowlist (T-03-01)
- `src/plugins/openai.ts`: fp() plugin decorating `fastify.openai` with OpenAI client, `maxRetries: 0` (T-03-05 — p-retry owns all retry logic)
- `src/services/enrich.ts`: `enrichMessage`, `downloadMedia`, `storeAsset`, `truncateForEmbedding` exported
- Three module-level PQueue singletons: `whisperQueue({concurrency:1, intervalCap:3})`, `visionQueue({concurrency:2, intervalCap:10})`, `embeddingQueue({concurrency:3, intervalCap:20})`
- SSRF guard: HTTPS-only + hostname must match `allowedHostname` param (derived from `EVOLUTION_URL`) before any `fetch()` (T-03-01)
- Content-Length checked before `arrayBuffer()`; 25MB hard cap after download (T-03-02)
- `toFile` awaited separately with `{ type: 'audio/ogg' }` before `transcriptions.create` (Pitfall 1 guard)
- `withRetry`: p-retry v6 with `randomize: true` (not `jitter: 'full'` — Pitfall 6 guard), `AbortError` on 4xx non-429
- Atomic asset write: `writeFile(tmpPath) → rename(tmpPath, finalPath)` in same directory (Pitfall 7 guard)
- video/sticker: `return` (not `break`) to skip all enrichment including caption embedding
- 21 unit tests across 7 describe blocks — all 62 project tests green

## Task Commits

1. **Task 1: Install openai, update config, create OpenAI plugin + enrich service** — `33406c1` (feat)
2. **Task 2: Unit tests for enrich.ts + auto-fixes** — `5e54d50` (feat)

## Files Created/Modified

- `package.json` — `openai@^5.23` in dependencies
- `src/config.ts` — `EVOLUTION_URL: z.string().url()` in envSchema
- `src/plugins/openai.ts` — OpenAI Fastify plugin
- `src/services/enrich.ts` — enrichment service with all exports
- `src/services/enrich.test.ts` — 21 unit tests
- `src/config.test.ts` — VALID_ENV updated with EVOLUTION_URL

## Decisions Made

- `toFile` uses `{ type: 'audio/ogg' }` not `{ contentType }` — the TypeScript d.ts for `FilePropertyBag` uses the DOM standard `type` property. The RESEARCH.md showed `{contentType}` (wrong) — caught at compile time.
- video/sticker use `return` instead of `break` so that a video message with a caption does not produce an embedding. The plan intent ("no OpenAI call") extends to skipping the embedding step entirely.
- `ChatCompletion` type cast on `visionQueue.add()` result — the return type is a union with `Stream<ChatCompletionChunk>` when `stream` is not specified; casting avoids TS error accessing `.choices`.
- Pre-existing TS errors in `webhook.ts` and `webhook.test.ts` (pre-date this plan, confirmed via stash) left out of scope.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] toFile option was `contentType` in plan/research but must be `type`**
- **Found during:** Task 1 (TypeScript compile)
- **Issue:** Plan and RESEARCH.md showed `{ contentType: 'audio/ogg' }` but TypeScript reported `'contentType' does not exist in type 'FilePropertyBag'`. The DOM FilePropertyBag uses `type`.
- **Fix:** Changed to `await toFile(audioBuf, ..., { type: 'audio/ogg' })`
- **Files modified:** `src/services/enrich.ts`
- **Commit:** `33406c1`

**2. [Rule 1 - Bug] video/sticker: break allowed caption text to flow into embedding**
- **Found during:** Task 2 (test failure — embeddings.create called for video msg)
- **Issue:** `break` exits the switch but `text = msg.text ?? null` is set before the switch. A video with a caption would have `text = 'caption'` after `break`, then embed it — violating plan intent ("no OpenAI call").
- **Fix:** Changed `break` to `return` in both video and sticker cases
- **Files modified:** `src/services/enrich.ts`
- **Commit:** `5e54d50`

**3. [Rule 1 - Bug] config.test.ts VALID_ENV missing EVOLUTION_URL caused 3 test failures**
- **Found during:** Task 2 (full suite run after enrich tests passed)
- **Issue:** Adding `EVOLUTION_URL` as required to envSchema caused config tests that provided all-but-DATABASE_URL to also miss EVOLUTION_URL, causing extra fields in the failure message — and tests that provided VALID_ENV to fail because VALID_ENV didn't include EVOLUTION_URL.
- **Fix:** Added `EVOLUTION_URL: 'https://evolution.yowa.com.br'` to VALID_ENV and the partial-env test block
- **Files modified:** `src/config.test.ts`
- **Commit:** `5e54d50`

## Threat Surface Scan

No new network endpoints or auth paths introduced (service layer only, no routes). The SSRF mitigations from the plan's threat model are implemented:

| Threat ID | Mitigation | Implemented |
|-----------|------------|-------------|
| T-03-01 | HTTPS-only + hostname allowlist in downloadMedia | YES — lines 72-82 of enrich.ts |
| T-03-02 | Content-Length check + 25MB hard cap | YES — lines 87-99 of enrich.ts |
| T-03-04 | truncateForEmbedding caps at 8000 chars | YES — lines 54-61 of enrich.ts |
| T-03-05 | maxRetries:0 on OpenAI client | YES — openai.ts line 18 |

## Known Stubs

None — enrichment service is fully implemented. No placeholder returns or hardcoded empty values.

## Self-Check: PASSED

- `src/plugins/openai.ts` exists: FOUND
- `src/services/enrich.ts` exists: FOUND
- `src/services/enrich.test.ts` exists: FOUND
- commit `33406c1` exists: FOUND
- commit `5e54d50` exists: FOUND
- All 62 tests green: VERIFIED

---
*Phase: 03-media-enrichment*
*Completed: 2026-05-21*
