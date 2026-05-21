# Roadmap — brainny

**Granularity:** Standard (6 phases)
**Mode:** mvp throughout — ship the pipeline end-to-end before iterating on quality.

This roadmap sequences v1 by dependencies: persistence schema first (everything writes to it), then the ingest entry point, then enrichment that depends on raw rows, then the read side (search) once data exists, then materialization (consumes stable storage), and finally backfill + operational hardening.

---

### Phase 1: Foundation
**Goal:** Stand up the project scaffold, configuration, HTTP server, database schema with pgvector + HNSW, and a live health endpoint — the skeleton every later phase plugs into.
**Mode:** mvp
**Requirements:** STORE-01, STORE-02 (schema), STORE-03 (schema), OPS-01, OPS-02
**Success Criteria:**
1. `npm run dev` boots Fastify, validates env via Zod, fails fast on missing vars, and binds to the configured port.
2. `drizzle-kit migrate` applies the initial migration creating `messages`, `chats`, `sync_state` tables plus the `CREATE EXTENSION vector` and `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)` statements.
3. `GET /health` returns `{ok: true, ts, db: "ok"}` when Postgres is reachable and `{..., db: "error"}` (with non-200) when it is not.
4. `EXPLAIN ANALYZE` of a sample cosine query (`embedding <=> $1::vector`) shows `Index Scan using messages_embedding_hnsw`, not Seq Scan.

---

### Phase 2: Webhook Ingest
**Goal:** Accept Evolution API webhooks safely and asynchronously — validate the secret, ack fast, queue work, parse every WhatsApp message type, deduplicate, and isolate per-message errors with structured logs.
**Mode:** mvp
**Requirements:** INGEST-01, INGEST-02, INGEST-03, INGEST-04, INGEST-05, INGEST-06
**Success Criteria:**
1. `POST /webhook/evolution` with a wrong `X-Webhook-Secret` returns 401 (compared via `crypto.timingSafeEqual`); with the right secret returns 200 `{ok:true}` in under 50ms p99 even when the queue is busy.
2. A fixture suite of every message type (text, extended text, audio, image, video, document, sticker, location, contact, reaction) flows through `services/ingest.ts` → `services/persist.ts` and results in exactly one row per id; replaying the same payload twice produces zero duplicates.
3. Injecting an error inside one message handler does not interrupt sibling jobs in the `p-queue`; the failed message produces a Pino `error` log with `{messageId, errorCode, phase}` and the queue continues to drain.

---

### Phase 3: Media Enrichment
**Goal:** Turn audio, images, and documents into searchable text via OpenAI — download safely, transcribe with Whisper (PT-BR), describe images with GPT-4o-mini Vision, generate embeddings, and store assets to disk.
**Mode:** mvp
**Requirements:** ENRICH-01, ENRICH-02, ENRICH-03, ENRICH-04, ENRICH-05
**Success Criteria:**
1. An audio message (≤25MB) ends up persisted with `text` containing the Whisper transcript in PT-BR, the original media file written under `data/YYYY-MM-DD/assets/`, and `embedding` populated to length 1536.
2. An image message ends up persisted with `text` containing a PT-BR description from GPT-4o-mini Vision (passed as base64 data URL, not Evolution URL), and a non-null embedding.
3. Submitting a text body longer than 8000 chars triggers a Pino `warn` log identifying the message id and truncated length before embedding; the embedding call still succeeds.
4. Rate limits and transient failures (429 / 5xx) from OpenAI are absorbed by `p-queue` + exponential backoff; sustained 100-message bursts complete without any message landing in a permanently failed state.

---

### Phase 4: Storage & Search
**Goal:** Make the corpus queryable — finalize Drizzle upserts for messages/chats and expose an authenticated semantic search endpoint over pgvector.
**Mode:** mvp
**Requirements:** STORE-02, STORE-03, SEARCH-01, SEARCH-02
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

*Last updated: 2026-05-21 after initialization.*
