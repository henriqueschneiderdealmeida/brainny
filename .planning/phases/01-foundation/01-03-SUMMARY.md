---
plan: 01-03
phase: 01-foundation
status: complete
completed: "2026-05-21"
requirements_covered:
  - STORE-01
  - STORE-02
  - STORE-03
self_check: PASSED
---

# Plan 01-03 Summary — Migration Generate + Apply + HNSW Verification

## What Was Built

Two Drizzle ORM migration files generated and applied to the `whatsapp_brain` PostgreSQL database:

- `src/db/migrations/0000_enable-vector.sql` — enables pgvector extension (`CREATE EXTENSION IF NOT EXISTS vector`)
- `src/db/migrations/0001_dazzling_kitty_pryde.sql` — creates all three tables + HNSW index

## Key Files Created

| File | Purpose |
|------|---------|
| `src/db/migrations/0000_enable-vector.sql` | Enable pgvector extension before table creation |
| `src/db/migrations/0001_dazzling_kitty_pryde.sql` | messages, chats, sync_state tables + HNSW index |
| `src/db/migrations/meta/_journal.json` | drizzle-kit migration journal |
| `src/db/migrations/meta/0000_snapshot.json` | Schema snapshot after migration 0 |
| `src/db/migrations/meta/0001_snapshot.json` | Schema snapshot after migration 1 |

## Verification Results (Human-Approved)

All 6 checks from Task 2 passed:

1. **`npm run db:migrate`** — Applied 2 migrations successfully
2. **Tables exist** — `chats`, `messages`, `sync_state`, `__drizzle_migrations` confirmed in `information_schema`
3. **HNSW index present** — `messages_embedding_hnsw` exists with `USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64')`
4. **EXPLAIN confirms Index Scan** — `SET enable_seqscan = off; EXPLAIN ...` shows "Index Scan using messages_embedding_hnsw"
5. **Dev server boots** — `npm run dev` starts successfully, validates env, connects to DB
6. **Health endpoint responds** — `GET /health` → `{"ok":true,"ts":"...","db":"ok"}`

## Requirements Coverage

- **STORE-01** — HNSW index `messages_embedding_hnsw` with `vector_cosine_ops`, m=16, ef_construction=64 ✓
- **STORE-02** — `raw_json` (jsonb NOT NULL) column in messages table ✓
- **STORE-03** — `is_group` (boolean) and `participants_json` (jsonb) in chats table ✓

## Notable Details

- HNSW `WITH` clause was present in generated SQL — no manual fix needed (pitfall from RESEARCH.md Assumption A1 did not manifest)
- `IF NOT EXISTS` guard on extension migration ensures idempotency if pgvector was already installed
- Migration files committed before human verification checkpoint to allow inspection
