# PITFALLS.md — brainny WhatsApp Ingestion Pipeline

> **Purpose**: Catalog of known pitfalls that MUST be avoided in the brainny re-implementation. Each item is mapped to the phase where it should be addressed, with detection, prevention, and verification guidance.
>
> **Stack**: Node.js 22, TypeScript, Fastify 5, Drizzle ORM, PostgreSQL + pgvector, OpenAI SDK v5, Evolution API.
>
> **Legend**:
> - `[CRITICAL-REGRESSION]` — caused a bug in the previous implementation; MUST NOT recur.
> - `[HIGH]` — likely to cause production incidents.
> - `[MEDIUM]` — degrades quality, performance, or DX.
> - `[LOW]` — papercut / footgun.

---

## Phase Map (quick index)

| Phase | Focus | Pitfalls |
|---|---|---|
| P0 | Bootstrap / Tooling | DRIZZLE-1, DRIZZLE-3, FASTIFY-1, FASTIFY-3 |
| P1 | DB schema & migrations | PGVECTOR-1, PGVECTOR-2, PGVECTOR-3, PGVECTOR-4, DRIZZLE-2 |
| P2 | Webhook ingestion | REG-9, EVO-1, EVO-2, EVO-4, LOG-1 |
| P3 | Media pipeline | REG-7, OAI-1, OAI-2, OAI-3, OAI-6, DOCKER-1, NODE-1 |
| P4 | Embeddings & materializer | REG-1, REG-5, OAI-4, OAI-5, PGVECTOR-2 |
| P5 | Search API | REG-2, REG-9, FASTIFY-2 |
| P6 | Backfill | REG-8, EVO-3, OAI-6 |
| P7 | Observability & retries | REG-3, REG-4, LOG-1, LOG-2 |
| P8 | Deploy / Runtime | DOCKER-1, DOCKER-2, DOCKER-3, NODE-1, NODE-2 |

---

## 1. Critical Regressions from the Previous Implementation

These are real bugs that shipped before. They are blockers — each must have a corresponding test or assertion proving it cannot recur.

### REG-1 [CRITICAL-REGRESSION] — Race condition in materializer (`void tick()`)
- **Phase**: P4 (Embeddings & materializer)
- **Symptom**: Multiple overlapping `tick()` invocations process the same row twice, producing duplicate embeddings, double-charging OpenAI, and corrupting `processed_at` timestamps.
- **Root cause**: `void tick()` fired without `await`; setInterval kept firing while the previous tick was still in-flight.
- **Fix**:
  - Boolean `isRunning` lock guarded at entry of `tick()`.
  - Always `await tick()` from the scheduler.
  - Use `setTimeout` recursion (not `setInterval`) so the next tick is scheduled *after* completion.
  - Optional: add a DB-level advisory lock (`pg_try_advisory_lock`) for multi-instance safety.
- **Verification**: Unit test that calls `tick()` twice concurrently and asserts the second returns immediately. Integration test that runs materializer against 100 messages and asserts each row is processed exactly once.

### REG-2 [CRITICAL-REGRESSION] — `/search` endpoint exposed without auth
- **Phase**: P5 (Search API)
- **Symptom**: Any unauthenticated caller could query all stored messages.
- **Fix**:
  - Bearer token middleware (`Authorization: Bearer <token>`) on `/search` (and any other read endpoints).
  - Token stored in env, compared with `crypto.timingSafeEqual` (see REG-9).
  - Default-deny: a Fastify `preHandler` hook attached at the route level, not relying on a global skip-list.
- **Verification**: Test that hits `/search` without header → 401. With wrong token → 401. With right token → 200.

### REG-3 [CRITICAL-REGRESSION] — Mixed logging (Pino + `console.error`)
- **Phase**: P7 (Observability)
- **Symptom**: Half the logs were JSON-structured (Pino), half were unstructured `console.error` strings. Log aggregator could not correlate request IDs.
- **Fix**:
  - Single Pino instance, exported from `src/logger.ts`.
  - **Forbid** `console.*` via ESLint (`no-console` rule, level `error`).
  - Child loggers per module: `logger.child({ module: 'materializer' })`.
  - Request-scoped logger via `fastify.log` (Fastify wires Pino natively).
- **Verification**: `grep -r "console\." src/` returns nothing. ESLint CI gate.

### REG-4 [CRITICAL-REGRESSION] — Silent message drops in webhook
- **Phase**: P2 (Webhook ingestion) + P7 (Observability)
- **Symptom**: Async errors inside the webhook handler were swallowed (`logger.error` only). No retry, no dead-letter, no alert.
- **Fix**:
  - Webhook responds `200` to Evolution **immediately** (so it doesn't retry), then enqueues work.
  - Failed ingestion writes a row to `failed_messages` table: `{ id, payload jsonb, error text, attempt int, last_attempt_at, next_retry_at }`.
  - Background worker retries with exponential backoff (1m, 5m, 30m, 6h), max 4 attempts, then marked `dead_letter=true`.
  - Structured error log with `messageId`, `errorCode`, `phase` for *every* failure.
- **Verification**: Chaos test — inject error in transcription, confirm row lands in `failed_messages` and is retried.

### REG-5 [CRITICAL-REGRESSION] — Embedding truncation without warning
- **Phase**: P4 (Embeddings)
- **Symptom**: Text > 8000 chars was silently `.slice(0, 8000)`'d before embedding. Long transcripts lost their tails.
- **Fix**:
  - Use the tokenizer (`@dqbd/tiktoken` or `tiktoken`) to count tokens, not chars.
  - `text-embedding-3-small` accepts **8192 tokens**, not chars.
  - When input exceeds limit: emit `logger.warn({ originalLen, truncatedLen, messageId }, 'embedding input truncated')`.
  - Better: chunk the text and store multiple embeddings keyed to the same message (chunk_index column).
- **Verification**: Unit test feeds a 20k-char string; asserts warn log was emitted and chunks > 1.

### REG-6 [CRITICAL-REGRESSION] — No HNSW index on `embedding` column
- **Phase**: P1 (DB schema)
- **Symptom**: `CREATE EXTENSION vector` ran, but no `CREATE INDEX USING hnsw`. Queries went sequential-scan; latency exploded at ~10k rows.
- **Fix**:
  - Migration creates the index explicitly:
    ```sql
    CREATE INDEX messages_embedding_hnsw_idx
      ON messages
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    ```
  - Index builds *after* initial backfill in production (faster), but in dev migrations are fine.
  - Set `SET hnsw.ef_search = 40;` per session/query for tuning.
- **Verification**: `EXPLAIN ANALYZE` on a `<=>` query shows `Index Scan using messages_embedding_hnsw_idx`, not `Seq Scan`.

### REG-7 [CRITICAL-REGRESSION] — Hardcoded 30s media download timeout
- **Phase**: P3 (Media pipeline)
- **Symptom**: Large audio files silently failed; the user saw no error, the row stayed in `pending` forever.
- **Fix**:
  - Timeout configurable via env: `MEDIA_DOWNLOAD_TIMEOUT_MS` (default 120000).
  - On timeout, throw explicit `MediaDownloadTimeoutError` with `{ url, sizeHint, elapsedMs }`.
  - Log warn and mark message `media_status='timeout'` so backfill can retry it later.
  - Use streaming download (`fetch().body` piped to disk) so progress is visible and memory bounded.
- **Verification**: Test that mocks slow server, asserts explicit timeout error is thrown and row updated.

### REG-8 [CRITICAL-REGRESSION] — Slow backfill (50 × 500ms = 10s/page)
- **Phase**: P6 (Backfill)
- **Symptom**: Initial sync of a chat with 50k messages took ~3 hours.
- **Fix**:
  - Increase page size to Evolution max (typically 100–500, verify per endpoint).
  - Drop intra-page sleep to ~50ms or rely on Evolution's own rate-limit headers.
  - Process messages within a page in parallel with `p-limit` (concurrency 5–10).
  - Backoff *only* when Evolution returns 429 (read `Retry-After` header).
- **Verification**: Backfill of 1000 messages completes < 60s in staging.

### REG-9 [CRITICAL-REGRESSION] — Webhook secret compared with `===`
- **Phase**: P2 (Webhook) + P5 (Search auth)
- **Symptom**: Timing-attack surface on the webhook signature/token check.
- **Fix**:
  - Use `crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))`.
  - Both buffers must be the **same length** — pad/reject early to avoid `RangeError`.
  - For HMAC signatures (preferred over shared token): `crypto.createHmac('sha256', secret).update(rawBody).digest()` and compare in constant time.
  - Fastify: add a `preParsing` hook so the raw body is available; default JSON parser will have already serialized otherwise.
- **Verification**: Unit test with a token differing only in the last char still rejects (no early exit).

---

## 2. Evolution API / WhatsApp Pitfalls

### EVO-1 [HIGH] — Duplicate webhook delivery
- **Phase**: P2
- **Cause**: Evolution retries on slow responses; same `messageId` arrives twice within seconds.
- **Fix**:
  - Idempotency key = `messages.evolution_id` with a **UNIQUE constraint**.
  - On insert: `INSERT ... ON CONFLICT (evolution_id) DO NOTHING RETURNING id`. If nothing returned → it's a duplicate, ignore.
  - Respond 200 quickly so Evolution doesn't retry in the first place (see REG-4).
- **Verification**: Replay the same payload twice → exactly one row, second call is a no-op.

### EVO-2 [HIGH] — Payload size for media-heavy messages
- **Phase**: P2
- **Cause**: Evolution can send media inline as base64 in the JSON body. A 10MB audio becomes ~14MB JSON.
- **Fix**:
  - Configure Evolution to send **URL references** when possible (instance setting).
  - Increase Fastify body limit: `app = Fastify({ bodyLimit: 25 * 1024 * 1024 })` — but only on the webhook route, not globally.
  - If base64 arrives: decode to disk *streaming*, never hold full string in memory longer than needed.
  - Reject early on `Content-Length` exceeding budget.
- **Verification**: Load test with 10MB inline payload — process resident memory does not spike > 100MB above baseline.

### EVO-3 [MEDIUM] — Outbound rate limits during backfill
- **Phase**: P6
- **Cause**: Evolution's `/chat/findMessages` is rate-limited; aggressive pagination triggers 429s and IP blocks.
- **Fix**:
  - Respect `Retry-After` header.
  - Token bucket limiter (`bottleneck` or hand-rolled) — start at 5 req/s, adjust based on Evolution's actual quota.
  - Exponential backoff on 5xx with jitter.
- **Verification**: Backfill of 10k messages completes without any 429 in logs.

### EVO-4 [HIGH] — Non-text messages that *look* like text
- **Phase**: P2 (ingestion classifier)
- **Cause**: Reactions, polls, poll updates, view-once messages, button responses, list responses, edited messages, and protocol messages all show up on the same webhook. Some contain a `body` field that's misleading.
- **Fix**:
  - Discriminate on `messageType` / `key.fromMe` / `message.<type>Message` keys.
  - Explicit allow-list of types to ingest: `conversation`, `extendedTextMessage`, `imageMessage`, `audioMessage`, `videoMessage`, `documentMessage`, `stickerMessage` (optionally).
  - Drop with `logger.info({ type }, 'unsupported message type, ignored')` — do NOT crash.
  - Reactions update a separate `reactions` table (or just skip in MVP).
- **Verification**: Fixture set with one of each type; only allow-listed ones create `messages` rows.

---

## 3. OpenAI SDK v5 Pitfalls

### OAI-1 [HIGH] — Whisper 25 MB file-size hard limit
- **Phase**: P3
- **Cause**: Whisper API rejects files > 25 MB with a 400. WhatsApp audio is usually fine, but forwarded recordings can exceed it.
- **Fix**:
  - `fs.stat` the file before upload; if > 25 MB, either:
    - Re-encode to lower bitrate (ffmpeg `-b:a 32k`) — opus or mp3.
    - Split into segments and concatenate transcripts.
  - Surface a clear error if neither works; mark `transcription_status='too_large'`.
- **Verification**: Test with 30MB file — pipeline either downsamples or marks `too_large`, never 400s.

### OAI-2 [MEDIUM] — Whisper supported formats
- **Phase**: P3
- **Cause**: Whisper accepts **mp3, mp4, mpeg, mpga, m4a, wav, webm**. WhatsApp often sends `.ogg` (opus). It *usually* works but isn't officially listed.
- **Fix**:
  - Always transcode to `m4a` (or `mp3`) via ffmpeg before upload — safer and smaller.
  - Keep a sniff (`file-type`) to detect actual container vs. extension.
- **Verification**: `.ogg`, `.opus`, `.amr` (legacy WhatsApp) all transcribe successfully via the transcoding path.

### OAI-3 [HIGH] — Vision: Evolution media URLs may require auth headers
- **Phase**: P3
- **Cause**: `image_url` mode of the Vision API does a public GET; if Evolution's media URL is gated by an `apikey` header, OpenAI fetches a 401/HTML page.
- **Fix**:
  - **Always download media server-side first**, then send as base64 data URL: `data:image/jpeg;base64,...`.
  - This also avoids leaking URLs and works for ephemeral WhatsApp media that expires.
- **Verification**: Disconnect Evolution from the internet during a Vision call (mock) — still works because image is base64.

### OAI-4 [HIGH] — `text-embedding-3-small` returns **1536** dimensions
- **Phase**: P1 (schema) + P4
- **Cause**: Common mistake to declare `vector(384)` (that's `MiniLM`) or `vector(1024)` (that's `large` truncated).
- **Fix**:
  - Schema: `vector(1536)` exactly. Document the choice in a code comment AND in `docs/schema-decisions.md`.
  - If you ever switch to `text-embedding-3-large`, dimension is 3072 (or truncatable down via `dimensions` param) — requires a migration, not just a code change.
  - Pin the model in code: `const EMBEDDING_MODEL = 'text-embedding-3-small'` exported constant.
- **Verification**: Runtime assertion at startup: `assert(result.data[0].embedding.length === 1536)`.

### OAI-5 [MEDIUM] — Whisper + Vision share RPM quota
- **Phase**: P3, P4
- **Cause**: For some accounts, audio/vision endpoints sit on the same RPM bucket. Burst transcription can starve image classification.
- **Fix**:
  - Single client-side limiter across both endpoints (`p-limit` or `bottleneck` shared instance).
  - Read rate-limit headers (`x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`) and self-throttle.
  - Retry with backoff on 429.
- **Verification**: Inject 100 concurrent media items; no 429s reach the failed-messages table.

### OAI-6 [MEDIUM] — Retries and idempotency
- **Phase**: P3, P4
- **Fix**:
  - The OpenAI SDK v5 retries automatically (default 2); make sure your wrapper doesn't double-retry.
  - For embeddings: deterministic input → safe to retry. For transcription: idempotency-key header if you orchestrate multi-step jobs.
  - Treat 5xx as transient; 4xx (except 429) as permanent → goes to dead-letter, not retry queue.

---

## 4. pgvector Pitfalls

### PGVECTOR-1 [CRITICAL-REGRESSION] — Missing HNSW index (see REG-6)

### PGVECTOR-2 [MEDIUM] — HNSW vs IVFFlat choice
- **Phase**: P1
- **Guidance**:
  - **< 1M rows**: HNSW is the right call — better recall, faster queries, no `lists` parameter to tune.
  - **> 10M rows**: revisit — HNSW builds get slow, IVFFlat with `lists ≈ sqrt(N)` may scale better.
  - For brainny's scale (10k–500k messages), HNSW is correct.
- **Trade-off**: HNSW inserts are slower (~2-3x IVFFlat). Acceptable for an ingestion pipeline where reads dominate.

### PGVECTOR-3 [LOW] — HNSW build parameters
- **Phase**: P1
- **Recommended defaults**: `m = 16`, `ef_construction = 64`. Increase `ef_construction` to 200 if recall is critical and one-time build cost is acceptable.
- **Query-time tuning**: `SET hnsw.ef_search = 40;` (default). Raise to 100+ if recall is poor.

### PGVECTOR-4 [HIGH] — Distance operator mismatch
- **Phase**: P4 (materializer) + P5 (search)
- **Cause**: Operators must match the index's ops class.
- **Fix**:
  - Index built with `vector_cosine_ops` → query MUST use `<=>` (cosine distance).
  - `<->` is L2, `<#>` is negative inner product. Using the wrong one bypasses the index.
  - OpenAI embeddings are **already L2-normalized** → cosine and dot-product are equivalent, but stick with `<=>` for consistency with the index.
- **Verification**: `EXPLAIN ANALYZE` shows index scan for both materializer and search code paths.

---

## 5. Fastify 5 Pitfalls

### FASTIFY-1 [MEDIUM] — Breaking changes from Fastify 4
- **Phase**: P0
- **Notes**:
  - `reply.send()` in async handlers: prefer `return value;` — both work but mixing is confusing.
  - `request.routerPath` → `request.routeOptions.url`.
  - Default JSON parser stricter — empty body to a POST throws unless `addContentTypeParser` configured.
  - `@fastify/error` plugin moved.
- **Action**: Read the v5 migration guide before adding plugins; pin plugin versions to Fastify-5-compatible majors.

### FASTIFY-2 [HIGH] — `@fastify/multipart` default file-size limit is too small
- **Phase**: P3 (if you accept direct uploads) / P5
- **Cause**: Default `limits.fileSize` is **1 MB**. Audio uploads silently truncate or fail.
- **Fix**:
  - Configure explicitly: `app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } })`.
  - Set per-route override if you need different limits per endpoint.
  - Handle `MultipartFileSizeLimitError` and respond 413 with a clear message.
- **Verification**: Upload a 10MB file — succeeds. Upload 30MB — 413, not silent truncation.

### FASTIFY-3 [MEDIUM] — Schema validation: TypeBox vs Zod
- **Phase**: P0
- **Notes**:
  - Fastify 5 uses **TypeBox / Ajv** natively. Schemas are JSON Schema.
  - To use Zod, install `@fastify/type-provider-zod` and `fastify-type-provider-zod`.
  - Zod schemas are converted at runtime — small perf cost vs native TypeBox.
- **Recommendation**: Stick with Zod (already common in TS ecosystem) — explicit `setValidatorCompiler(validatorCompiler)` and `setSerializerCompiler(serializerCompiler)` at app init.
- **Pitfall**: Forgetting to set the serializer compiler → responses validate but don't strip extra fields → potential PII leak.

---

## 6. Drizzle ORM Pitfalls

### DRIZZLE-1 [HIGH] — `drizzle-kit push` vs `migrate`
- **Phase**: P0, P1
- **Rule**: `push` mutates the DB without versioned files — fine for prototyping, **never** in production.
- **Fix**:
  - Dev: `drizzle-kit generate` → review SQL → commit migration file → `drizzle-kit migrate`.
  - Prod: only `drizzle-kit migrate` runs (or programmatic `migrate()` at startup).
  - CI gate: fail if `schema.ts` changed without a new migration file.

### DRIZZLE-2 [MEDIUM] — pgvector column type
- **Phase**: P1
- **Notes**:
  - Modern Drizzle has `vector` in `drizzle-orm/pg-core`: `vector('embedding', { dimensions: 1536 })`. Verify your version supports it.
  - If not: use `customType<{ data: number[]; driverData: string }>` with `dataType: () => 'vector(1536)'` and serialize as `'[1,2,3]'`.
  - HNSW index creation goes in the migration SQL — Drizzle won't generate it from schema.
- **Pitfall**: `inArray()` and other helpers don't know about the `<=>` operator → use `sql\`embedding <=> ${vec}::vector\`` for ordering.

### DRIZZLE-3 [LOW] — No auto-migrations
- **Phase**: P0
- **Note**: There is no "auto-detect schema drift and apply" mode. Be explicit: `pnpm db:generate` and `pnpm db:migrate` are separate steps. Document them in README.

---

## 7. Logging & Observability

### LOG-1 [CRITICAL-REGRESSION] — Mixed logging (see REG-3)

### LOG-2 [MEDIUM] — No correlation IDs
- **Phase**: P7
- **Fix**:
  - Generate `requestId` in `onRequest` hook (uuid v7 for ordering).
  - Pass it through to background jobs via job payload.
  - Include in every log line via `logger.child({ requestId })`.
  - Optional: OpenTelemetry traces if observability budget allows.

---

## 8. Production / Docker / Runtime

### DOCKER-1 [HIGH] — Container filesystem is ephemeral
- **Phase**: P8
- **Cause**: Downloaded media in `/app/data/assets/` disappears on every restart. Backfill loses work.
- **Fix**:
  - Mount a volume: `-v brainny-assets:/app/data/assets` (or compose `volumes:` block).
  - Better: object storage (S3 / R2) — declare `ASSETS_BACKEND=s3` env var and abstract behind an interface.
  - Failing that: at least mark the assets dir in `docker-compose.yml` clearly.
- **Verification**: `docker restart brainny` — `/app/data/assets` still has files.

### DOCKER-2 [MEDIUM] — Graceful shutdown
- **Phase**: P8
- **Fix**:
  - SIGTERM handler:
    1. `await fastify.close()` — stop accepting new requests.
    2. Stop materializer scheduler (`clearTimeout`, await in-flight tick).
    3. `await pool.end()` — close DB.
    4. Flush Pino: `logger.flush()`.
  - Set Docker `STOPSIGNAL SIGTERM` and `stop_grace_period: 30s`.
  - Process exit code 0 on clean shutdown, 1 on forced.
- **Verification**: Send SIGTERM during active backfill — no truncated rows, no abandoned jobs.

### DOCKER-3 [LOW] — Multi-stage build hygiene
- **Phase**: P8
- **Notes**:
  - `node:22-bookworm-slim` base. Install `ffmpeg` and `ca-certificates` in runtime stage.
  - Don't run as root: `USER node`.
  - `HEALTHCHECK` against a `/health` endpoint that pings DB.

### NODE-1 [MEDIUM] — Memory spikes from media + embeddings
- **Phase**: P3, P4, P8
- **Cause**: Buffering a 25MB audio + running a Vision call in parallel can blow past Node's default ~1.5GB heap.
- **Fix**:
  - `NODE_OPTIONS=--max-old-space-size=2048` (or sized to container limit minus ~256MB).
  - Stream media to disk — never `await response.arrayBuffer()` for files > a few MB.
  - Cap concurrency: materializer processes N at a time, not the whole batch.
- **Verification**: Resident memory under load stays < container limit; no OOMKilled events.

### NODE-2 [LOW] — Unhandled rejections
- **Phase**: P0, P7
- **Fix**:
  - `process.on('unhandledRejection', (err) => { logger.fatal({ err }, 'unhandled rejection'); process.exit(1); })`.
  - Same for `uncaughtException`.
  - Restart policy in Docker: `restart: unless-stopped`.

---

## 9. Cross-Cutting Reminders

- **Idempotency everywhere**: every external-side-effect handler (webhook ingest, materializer tick, backfill page) should be safely re-runnable.
- **Test the failure paths**: mock OpenAI 429, Evolution 500, DB connection drop. The pipeline must degrade gracefully, not silently lose messages.
- **Secrets**: only via env. Never log full tokens (Pino redact: `redact: ['req.headers.authorization', '*.apiKey']`).
- **Time**: store timestamps as `timestamptz`, log in UTC, render in user TZ only at the edges.
- **Encoding**: WhatsApp message text is UTF-8 with emoji. Make sure DB column is `text` (not `varchar(255)`) and connection encoding is UTF-8.

---

## 10. Anti-Regression Checklist (run before every release)

- [ ] Materializer cannot run two ticks concurrently (REG-1).
- [ ] `/search` returns 401 without bearer token (REG-2).
- [ ] `grep -r "console\." src/` is empty (REG-3).
- [ ] Failed messages land in `failed_messages` table with retry metadata (REG-4).
- [ ] Embedding truncation emits a `warn` log (REG-5).
- [ ] `EXPLAIN ANALYZE` on similarity query shows HNSW index scan (REG-6).
- [ ] Media download honors `MEDIA_DOWNLOAD_TIMEOUT_MS` env (REG-7).
- [ ] Backfill of 1000 messages completes in < 60s (REG-8).
- [ ] Webhook token check uses `crypto.timingSafeEqual` (REG-9).
- [ ] Embedding dim assertion at startup = 1536 (OAI-4).
- [ ] Whisper pre-flight rejects files > 25 MB cleanly (OAI-1).
- [ ] Vision uses base64 data URLs, not Evolution-hosted URLs (OAI-3).
- [ ] Multipart limit ≥ 25 MB on routes that accept audio (FASTIFY-2).
- [ ] Volume mounted for `data/assets/` in compose file (DOCKER-1).
- [ ] SIGTERM cleanly drains and exits 0 (DOCKER-2).
