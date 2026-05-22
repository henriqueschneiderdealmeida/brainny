# Feature Research

**Domain:** WhatsApp message ingestion & intelligence pipeline
**Researched:** 2026-05-21
**Confidence:** HIGH

## Feature Landscape

### Table Stakes (Required for correct operation)

| Feature | Why Essential | Complexity | Notes |
|---------|---------------|------------|-------|
| Webhook signature validation | Security — reject unauthorized POSTs | LOW | Compare X-Webhook-Secret header |
| All message types handling | text/audio/image/video/document/location/contact/sticker/reaction | MEDIUM | Map each type to enrichment strategy |
| Async webhook processing | Must return 200 immediately, process in background | LOW | p-queue or simple async |
| Deduplication | Evolution may deliver same message twice | LOW | ON CONFLICT DO NOTHING |
| Media download + local storage | Audio/image needed for transcription/description | MEDIUM | Date-based directory |
| Per-message error isolation | One bad message shouldn't stop the queue | LOW | try/catch per message |
| Backfill / historical sync | Catch up messages before webhook was configured | MEDIUM | Pagination over Evolution API |
| Health check endpoint | Liveness probe for Docker | LOW | GET /health → {ok,ts,db} |

### Differentiators (What makes it genuinely useful)

| Feature | Value | Complexity | Notes |
|---------|-------|------------|-------|
| Whisper transcription PT-BR | Audio messages become searchable text | MEDIUM | 25MB limit, detect language |
| GPT-4 Vision image description | Images become searchable | MEDIUM | base64 + vision prompt |
| pgvector semantic search | Find messages by meaning, not keyword | HIGH | HNSW index, cosine similarity |
| Obsidian Markdown materialization | Daily .md files consumable by Claude MCP | MEDIUM | 5-min cron, group by chat |
| Embedding storage | Future AI workflows on message corpus | LOW | Store alongside message |

### Anti-Features (Seem good, are problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Real-time push to external systems | Instant notifications | Tight coupling, webhook fan-out complexity | Polling via /search |
| Store raw media in PostgreSQL | Simpler schema | Disk explosion, poor streaming | Local filesystem + path in DB |
| Synchronous media enrichment in webhook | Simpler code | Blocks 200 response, Evolution retries | Async queue always |
| Full WhatsApp message encryption/decryption | Security | Evolution handles this; re-implementing is error-prone | Trust Evolution |

## MVP Definition

### Launch With (v1)
- [ ] Webhook ingestion with all message types
- [ ] Audio transcription + image description
- [ ] Embedding generation + storage
- [ ] Obsidian materialization
- [ ] Semantic search endpoint (authenticated)
- [ ] Backfill CLI
- [ ] Health check

### Future (v2+)
- [ ] Webhook retry/dead-letter queue
- [ ] Group message participant mapping
- [ ] Multi-instance Evolution support

## Feature Prioritization Matrix

| Feature | User Value | Cost | Priority |
|---------|------------|------|----------|
| Webhook ingest | HIGH | LOW | P1 |
| All message types | HIGH | MEDIUM | P1 |
| Audio transcription | HIGH | MEDIUM | P1 |
| Markdown materialization | HIGH | MEDIUM | P1 |
| Semantic search | HIGH | MEDIUM | P1 |
| Image description | MEDIUM | MEDIUM | P1 |
| Backfill | MEDIUM | MEDIUM | P1 |
| Dead-letter queue | LOW | HIGH | P3 |

---
*Feature research for: WhatsApp message pipeline*
*Researched: 2026-05-21*
