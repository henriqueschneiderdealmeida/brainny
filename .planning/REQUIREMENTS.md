# Requirements — brainny

## v1 Requirements

### INGEST — Webhook & Message Ingestion
- [ ] **INGEST-01**: System validates X-Webhook-Secret header using timing-safe comparison; returns 401 on mismatch
- [ ] **INGEST-02**: System returns 200 {ok:true} immediately on valid webhook, processes message asynchronously
- [ ] **INGEST-03**: System handles all message types: text, audio, image, video, document, sticker, location, contact, reaction
- [ ] **INGEST-04**: System deduplicates messages using ON CONFLICT DO NOTHING on message id
- [ ] **INGEST-05**: System isolates per-message errors — one failure does not stop processing of other messages
- [ ] **INGEST-06**: System logs structured errors (Pino) for every failed message with message id and error details

### ENRICH — Media & AI Enrichment
- [ ] **ENRICH-01**: System downloads audio files and transcribes via OpenAI Whisper (PT-BR language hint); handles files up to 25MB
- [ ] **ENRICH-02**: System downloads images and generates descriptions via GPT-4o-mini Vision (PT-BR prompt)
- [ ] **ENRICH-03**: System generates text-embedding-3-small embeddings (1536 dims) for all non-empty text content
- [ ] **ENRICH-04**: System warns in logs when message text is truncated before embedding (>8000 chars)
- [ ] **ENRICH-05**: System stores media files locally in date-partitioned directories (data/{YYYY-MM-DD}/assets/)

### STORAGE — PostgreSQL + pgvector
- [ ] **STORE-01**: System creates HNSW index (m=16, ef_construction=64, vector_cosine_ops) on messages.embedding at migration time
- [ ] **STORE-02**: System stores messages with full raw_json payload for re-enrichment capability
- [ ] **STORE-03**: System upserts chat metadata (name, is_group, participants) on every message from that chat

### MATERIALIZE — Obsidian Markdown
- [ ] **MAT-01**: System materializes messages as Markdown files every 5 minutes via node-cron
- [ ] **MAT-02**: Materializer uses in-process mutex lock to prevent overlapping executions
- [ ] **MAT-03**: Materializer groups messages by date (YYYY-MM-DD) and chat, writes to Obsidian vault
- [ ] **MAT-04**: Materializer writes atomically (tmp file + rename) to prevent partial reads by Obsidian

### SEARCH — Semantic Search API
- [ ] **SEARCH-01**: GET /search?q= endpoint validates Authorization: Bearer {SEARCH_TOKEN} header; returns 401 on mismatch
- [ ] **SEARCH-02**: Search embeds query text and returns top-20 results by cosine similarity with score, sender, timestamp, chat

### BACKFILL — Historical Sync
- [ ] **BACKFILL-01**: CLI script (scripts/backfill.ts) fetches historical messages from Evolution API with configurable page size
- [ ] **BACKFILL-02**: Backfill uses sync_state cursor to resume from last synced timestamp

### OPS — Operations
- [ ] **OPS-01**: GET /health returns {ok: true, ts, db: "ok"|"error"} — checks DB connectivity
- [ ] **OPS-02**: System validates all env vars on startup via Zod schema; crashes with clear error if missing
- [ ] **OPS-03**: System handles SIGINT/SIGTERM with graceful shutdown (drain queue, close DB, close server)

## v2 Requirements (Deferred)

- Dead-letter queue / failed_messages table for retry
- Group participant name resolution
- Multi-Evolution-instance support
- Proxy support for WhatsApp connection (needed for IP-blocked servers)

## Out of Scope

- User interface — backend pipeline only
- Sending WhatsApp messages — receive only
- WhatsApp instance management — Evolution API's responsibility
- Multi-tenant — personal system, single instance

## Traceability

| Phase | Requirements Covered |
|-------|----------------------|
| Phase 1: Foundation | STORE-01, STORE-02 (schema), STORE-03 (schema), OPS-01, OPS-02 |
| Phase 2: Webhook Ingest | INGEST-01, INGEST-02, INGEST-03, INGEST-04, INGEST-05, INGEST-06 |
| Phase 3: Media Enrichment | ENRICH-01, ENRICH-02, ENRICH-03, ENRICH-04, ENRICH-05 |
| Phase 4: Storage & Search | STORE-02, STORE-03, SEARCH-01, SEARCH-02 |
| Phase 5: Materialization | MAT-01, MAT-02, MAT-03, MAT-04 |
| Phase 6: Backfill & Ops | BACKFILL-01, BACKFILL-02, OPS-03 |
