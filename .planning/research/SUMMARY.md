# Research Summary — brainny

**Synthesized:** 2026-05-21
**Research files:** STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md

## Recommended Stack

- **Runtime:** Node.js 22.x LTS + TypeScript 5.9.x (strict)
- **HTTP:** Fastify 5.8.x + `fastify-type-provider-zod` 6.1.x + Zod 3.25.x
- **DB:** PostgreSQL 17 + pgvector 0.8.x, driver `pg` 8.21.x
- **ORM:** Drizzle ORM 0.45.x + drizzle-kit 0.31.x (native `vector(1536)`)
- **AI:** `openai` SDK 5.20.x — Whisper-1, GPT-4o-mini Vision, text-embedding-3-small (1536 dims)
- **Logging:** Pino 9.14.x
- **Concurrency:** `p-queue` 9.3.x + `p-retry` 6.x (per-endpoint queues)
- **Scheduling:** `node-cron` 4.2.x (`noOverlap: true`, timezone `America/Sao_Paulo`)
- **Fastify extras:** `@fastify/multipart` 10, `@fastify/helmet` 13, `@fastify/cors` 11
- **Dev:** `tsx` 4.22, `vitest` 2, ESLint 9 flat config + `no-console: error`

**Forbidden:** `axios`, `node-fetch`, `ts-node`, `nodemon`, Prisma, LangChain, Winston, `console.*` in src, `zod@^4`, `openai@^6`.

## Table Stakes Features (v1)

1. Webhook ingestion — timing-safe secret check, always returns 200 (401 only on bad secret)
2. All message types — text, audio, image, video, document, sticker, location, contact (reactions/polls drop silently)
3. Async processing — p-queue concurrency=3, webhook never blocks
4. Deduplication — `ON CONFLICT DO NOTHING` on `messages.id`
5. Audio transcription — Whisper PT-BR, 25MB pre-flight, `.ogg`→`.m4a` transcode
6. Image description — GPT-4o-mini Vision, base64 data URLs only
7. Embedding — text-embedding-3-small 1536 dims, token-counted truncation with warn
8. Obsidian materialization — 5-min cron, atomic tmp+rename, per-chat-per-day
9. Semantic search — Bearer-token auth, cosine `<=>` against HNSW index
10. Backfill CLI — paginated Evolution sync with cursor
11. Health check — `/health` pings DB

## Architecture at a Glance

Single-process Fastify 5 app. Webhook → validate → p-queue → normalize → enrich (Whisper/Vision) → embed → Drizzle upsert. node-cron materializer fires every 5 min with in-process mutex, renders per-chat-per-day Markdown atomically to Obsidian vault. Search endpoint embeds query → HNSW cosine similarity.

```
src/
├── plugins/     db, openai, queue, auth        (decorate fastify)
├── routes/      webhook, search, health         (thin: Zod + delegate)
├── services/    ingest, enrich, embed, persist, materialize, search
├── db/          schema.ts, client.ts, migrations/
├── queue/       processor.ts
├── scheduler/   materializer.ts
├── templates/   day.md.ts
├── lib/         logger, errors
└── config.ts    Zod env schema — fail-fast on boot
```

## Critical Watch-Outs

**9 regressions from old codebase — all must be fixed in Phase 1-2:**

1. **REG-1** Materializer `void tick()` overlap → boolean `isRunning` mutex + `await`
2. **REG-2** `/search` unauthenticated → Bearer token preHandler, `crypto.timingSafeEqual`
3. **REG-3** Mixed Pino + `console.error` → single Pino instance, ESLint `no-console: error`
4. **REG-4** Silent webhook drops → `failed_messages` table + exponential retry worker
5. **REG-5** Char-truncated embeddings → token-counted (tiktoken), warn log
6. **REG-6** Missing HNSW index → explicit migration `CREATE INDEX USING hnsw ... WITH (m=16, ef_construction=64)`
7. **REG-7** Hardcoded 30s timeout → `MEDIA_DOWNLOAD_TIMEOUT_MS` env, streaming fetch + AbortController
8. **REG-8** Slow backfill → parallel page processing with `p-limit`, backoff only on 429
9. **REG-9** Webhook secret `===` → `crypto.timingSafeEqual` with padded buffers

**Other high-impact:**
- Vision: always download media first, send base64 data URLs — Evolution URLs are ephemeral/gated
- Embedding dim: runtime assertion `embedding.length === 1536` on first call
- HNSW operator: index uses `vector_cosine_ops` → query MUST use `<=>` or index is skipped
- Fastify bodyLimit: bump to 25-30 MB for base64 media payloads (default 1 MB rejects silently)
- Volume mounts: `/app/data/assets` + Obsidian vault must be Docker volumes (ephemeral FS loses files on restart)
- `drizzle-kit push` never in prod — always `generate` → review → commit → `migrate`

## Phase Build Order

| Phase | Name | Addresses |
|-------|------|-----------|
| 1 | Foundation | Scaffold, config, Fastify, Drizzle schema, HNSW index, health |
| 2 | Webhook Ingest | timingSafeEqual, p-queue, all types, dedup, Pino everywhere |
| 3 | Media Enrichment | Whisper, Vision, embeddings, rate limits, streaming download |
| 4 | Storage & Search | Drizzle upserts, `/search` with auth |
| 5 | Materialization | node-cron, mutex, atomic Markdown, Obsidian |
| 6 | Backfill & Ops | CLI, graceful shutdown, Dockerfile, Swarm stack |

## Sources

- STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md
