# Roadmap — brainny

**Granularity:** Standard (6 phases)
**Mode:** mvp throughout — ship the pipeline end-to-end before iterating on quality.

This roadmap sequences v1 by dependencies: persistence schema first (everything writes to it), then the ingest entry point, then enrichment that depends on raw rows, then the read side (search) once data exists, then materialization (consumes stable storage), and finally backfill + operational hardening.

---

### Phase 1: Foundation
**Goal:** Stand up the project scaffold, configuration, HTTP server, database schema with pgvector + HNSW, and a live health endpoint — the skeleton every later phase plugs into.
**Mode:** mvp
**Requirements:** STORE-01, STORE-02 (schema), STORE-03 (schema), OPS-01, OPS-02
**Status:** Complete (3/3 plans)

**Wave 1** — Toolchain + Zod env config
- `01-01` Toolchain scaffold, package.json, tsconfig, ESLint, vitest config, src/config.ts, config tests

**Wave 2** *(blocked on Wave 1 completion)*
- `01-02` DB schema (Drizzle), Fastify app, plugins, GET /health, health tests

**Wave 3** *(blocked on Wave 2 completion)*
- `01-03` [BLOCKING, manual] Migration generate + SQL verify + drizzle-kit migrate + HNSW checkpoint

**Cross-cutting constraints:**
- `"type": "module"` in package.json — all imports must use `.js` extensions
- All automated verify commands use `node --input-type=module` (ESM-safe)
- `drizzle-kit push` is FORBIDDEN — always `generate → review → migrate`

**Success Criteria:**
1. `npm run dev` boots Fastify, validates env via Zod, fails fast on missing vars, and binds to the configured port.
2. `drizzle-kit migrate` applies the initial migration creating `messages`, `chats`, `sync_state` tables plus the `CREATE EXTENSION vector` and `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)` statements.
3. `GET /health` returns `{ok: true, ts, db: "ok"}` when Postgres is reachable and `{..., db: "error"}` (with non-200) when it is not.
4. `EXPLAIN ANALYZE` of a sample cosine query (`embedding <=> $1::vector`) shows `Index Scan using messages_embedding_hnsw`, not Seq Scan.

Plans:
- [x] 01-01-PLAN.md — Toolchain scaffold (package.json, tsconfig, eslint, vitest) + src/config.ts with Zod env validation
- [x] 01-02-PLAN.md — DB schema (Drizzle: messages/chats/sync_state + HNSW) + Fastify app + GET /health route + tests
- [x] 01-03-PLAN.md — [BLOCKING] Migration: generate, verify HNSW SQL, apply to whatsapp_brain + human verification checkpoint

---

### Phase 2: Webhook Ingest
**Goal:** Accept Evolution API webhooks safely and asynchronously — validate the secret, ack fast, queue work, parse every WhatsApp message type, deduplicate, and isolate per-message errors with structured logs.
**Mode:** mvp
**Requirements:** INGEST-01, INGEST-02, INGEST-03, INGEST-04, INGEST-05, INGEST-06
**Status:** Planned (2/2 plans)

**Wave 1** — Services layer (auth, ingest, persist, queue plugin, unit tests)
- `02-01` Install p-queue/p-retry/fastify-type-provider-zod@^6.1 + queue plugin + auth handler + ingest/persist services + unit tests + 12 fixtures

**Wave 2** *(blocked on Wave 1 completion)*
- `02-02` POST /webhook/evolution route + Pino redact + wire into index.ts + full suite gate

**Cross-cutting constraints:**
- `crypto.timingSafeEqual` requires byteLength check BEFORE call — no exceptions
- `await reply.send({ ok: true })` MUST precede `void fastify.queue.add(...)` in route handler
- Per-message try/catch inside queue job — never wrap entire batch in one catch
- Route-level `bodyLimit: 25 * 1024 * 1024` — global limit stays 10MB

**Success Criteria:**
1. `POST /webhook/evolution` with a wrong `X-Webhook-Secret` returns 401 (compared via `crypto.timingSafeEqual`); with the right secret returns 200 `{ok:true}` in under 50ms p99 even when the queue is busy.
2. A fixture suite of every message type (text, extended text, audio, image, video, document, sticker, location, contact, reaction) flows through `services/ingest.ts` → `services/persist.ts` and results in exactly one row per id; replaying the same payload twice produces zero duplicates.
3. Injecting an error inside one message handler does not interrupt sibling jobs in the `p-queue`; the failed message produces a Pino `error` log with `{messageId, errorCode, phase}` and the queue continues to drain.

Plans:
- [x] 02-01-PLAN.md — Install deps (p-queue, p-retry, fastify-type-provider-zod ^6.1) + queue plugin + auth handler + ingest/persist services + unit tests + fixtures
- [x] 02-02-PLAN.md — POST /webhook/evolution route + Pino redact update + wire queue+webhook into index.ts + full suite gate

---

### Phase 3: Media Enrichment
**Goal:** Turn audio, images, and documents into searchable text via OpenAI — download safely, transcribe with Whisper (PT-BR), describe images with GPT-4o-mini Vision, generate embeddings, and store assets to disk.
**Mode:** mvp
**Requirements:** ENRICH-01, ENRICH-02, ENRICH-03, ENRICH-04, ENRICH-05
**Status:** Complete (2/2 plans)

**Wave 1** — OpenAI service layer (install, config, plugin, enrich service, unit tests)
- `03-01` npm install openai@^5.23 + EVOLUTION_URL in config + openai.ts plugin + enrich.ts service (downloadMedia, Whisper, Vision, embed, storeAsset) + enrich.test.ts unit tests

**Wave 2** *(blocked on Wave 1 completion)*
- `03-02` Wire enrichMessage into webhook.ts queue job + register openaiPlugin in index.ts + integration tests + full suite gate

**Cross-cutting constraints:**
- `maxRetries: 0` on OpenAI client — p-retry owns all retries (no double backoff storm)
- `await toFile(buffer, ...)` — toFile returns a Promise; must be awaited before transcriptions.create
- Three module-level PQueue instances in enrich.ts (whisper/vision/embedding) — not per-call
- `EVOLUTION_URL` env var drives SSRF allowlist — never hardcode Evolution hostname
- `msg.timestamp` (not `new Date()`) for asset directory date derivation
- video and sticker: skip enrichment with log.info, no OpenAI call, no storeAsset
- p-retry v6: use `randomize: true` (NOT `jitter: 'full'` which is v5 syntax)

**Success Criteria:**
1. An audio message (≤25MB) ends up persisted with `text` containing the Whisper transcript in PT-BR, the original media file written under `data/YYYY-MM-DD/assets/`, and `embedding` populated to length 1536.
2. An image message ends up persisted with `text` containing a PT-BR description from GPT-4o-mini Vision (passed as base64 data URL, not Evolution URL), and a non-null embedding.
3. Submitting a text body longer than 8000 chars triggers a Pino `warn` log identifying the message id and truncated length before embedding; the embedding call still succeeds.
4. Rate limits and transient failures (429 / 5xx) from OpenAI are absorbed by `p-queue` + exponential backoff; sustained 100-message bursts complete without any message landing in a permanently failed state.

Plans:
- [x] 03-01-PLAN.md — Install openai@^5.23 + EVOLUTION_URL config + openai.ts Fastify plugin + enrich.ts service (all enrichment logic) + enrich.test.ts unit tests covering ENRICH-01 through ENRICH-05
- [x] 03-02-PLAN.md — Wire enrichMessage into webhook.ts queue job + openaiPlugin registration in index.ts + webhook integration tests + full suite gate

**Verified:** 2026-05-22 — 13/13 must-haves verified, 65/65 tests passing, 0 tsc errors.

---

### Phase 4: Storage & Search
**Goal:** Make the corpus queryable — finalize Drizzle upserts for messages/chats and expose an authenticated semantic search endpoint over pgvector.
**Mode:** mvp
**Requirements:** STORE-02, STORE-03, SEARCH-01, SEARCH-02
**Status:** Complete (2/2 plans)

**Verified:** 2026-05-22 — 78/78 tests passing, 0 tsc errors.

Plans:
- [x] 04-01-PLAN.md — Chat upsert + persist tests (STORE-02, STORE-03)
- [x] 04-02-PLAN.md — GET /search endpoint (SEARCH-01, SEARCH-02)

**Success Criteria:**
1. Every persisted message row carries the full original Evolution payload in `raw_json`, enabling re-enrichment without refetching from Evolution; every message also triggers an upsert into `chats` (name, is_group, participants_json, last_seen_at).
2. `GET /search?q=...` without `Authorization: Bearer <SEARCH_TOKEN>` (or with the wrong token, compared via `timingSafeEqual`) returns 401; with the correct token it returns 200.
3. A correctly-authenticated search returns up to 20 results ordered by cosine similarity (descending), each containing `{id, chat_id, sender_name, timestamp, text, score}` where `score = 1 - (embedding <=> query)`.
4. `EXPLAIN ANALYZE` on the production search query confirms the HNSW index is used (no Seq Scan) at corpus sizes up to 100k rows in staging.

---

### Phase 5: Materialization
**Goal:** Render the corpus into the Obsidian vault as date-partitioned Markdown files every 5 minutes, safely and atomically, so notes are always consistent for Obsidian and Claude MCP to consume.
**Mode:** mvp
**Requirements:** MAT-01, MAT-02, MAT-03, MAT-04
**Status:** Complete (2/2 plans)

**Verified (05-01):** 2026-05-22 — 20 new tests (98 total), 0 tsc errors. MAT-02, MAT-03, MAT-04 satisfied.
**Verified (05-02):** 2026-05-22 — 98 tests pass, 0 tsc errors. MAT-01 satisfied (cron scheduler + overlap guard + graceful shutdown).

Plans:
- [x] 05-01-PLAN.md — Materialize service + tests (runMaterialize, renderDay, writeAtomic, safeFilename, node-cron install)
- [x] 05-02-PLAN.md — Wire node-cron into index.ts + MAT-01 overlap guard + full suite gate

**Success Criteria:**
1. `node-cron` runs the materializer on `*/5 * * * *` (timezone `America/Sao_Paulo`); each tick logs start, message count, and duration.
2. Two overlapping ticks cannot run concurrently — the in-process `running` boolean (or PG advisory lock) makes the second tick log "skipped" and return immediately; verified by a unit test that invokes the tick twice in parallel.
3. After a tick, the vault contains one `.md` file per `(date, chat)` pair within the re-render window (yesterday + today), grouped and ordered chronologically, matching the template in Appendix C of ARCHITECTURE.md.
4. File writes go through a tmp-file + `rename` sequence; killing the process mid-write never leaves a half-written `.md` file in the vault.

---

### Phase 6: Backfill & Ops
**Goal:** Catch up history from Evolution and harden the deployment — CLI backfill with resumable cursors, graceful shutdown, Dockerfile, and the Docker Swarm stack on `yowanet`.
**Mode:** mvp
**Requirements:** BACKFILL-01, BACKFILL-02, OPS-03
**Success Criteria:**
1. `tsx scripts/backfill.ts` (or built equivalent) paginates Evolution's `/chat/findMessages` with a configurable page size, respects 429 `Retry-After`, and reuses the same `services/*` code paths as the live webhook ingest.
2. Backfill writes its progress into `sync_state` (e.g. `backfill.cursor.<chatId>`); rerunning the script after an interruption resumes from the last persisted cursor without reprocessing rows already in `messages`.
3. Sending `SIGTERM` to the container stops accepting HTTP requests, stops cron, drains the p-queue via `onIdle()`, closes the pg pool, flushes Pino, and exits with code 0 within `stop_grace_period` (≤30s).
4. The container deploys to the Docker Swarm stack on the `yowanet` overlay network and reaches `postgres` and `evolution` by service name; `docker stack ps` shows the service `Running` and `/health` returns 200 from another container on the same network.

---

*Last updated: 2026-05-21 after Phase 3 planning.*
