---
phase: 1
phase_slug: foundation
date: 2026-05-21
source: RESEARCH.md §Validation Architecture
---

# Phase 1: Foundation — Validation Strategy

## Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 2.x |
| Config file | `vitest.config.ts` |
| Quick run | `npx vitest run src/` |
| Full suite | `npx vitest run` |

## Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Command | File |
|--------|----------|-----------|---------|------|
| OPS-01 | GET /health returns `{ok, ts, db}` with 200 when DB is reachable | integration | `npx vitest run src/routes/health.test.ts` | Wave 0 gap |
| OPS-01 | GET /health returns `db:"error"` + non-200 when DB is down | integration | `npx vitest run src/routes/health.test.ts` | Wave 0 gap |
| OPS-02 | `loadConfig()` exits with code 1 on missing `DATABASE_URL` | unit | `npx vitest run src/config.test.ts` | Wave 0 gap |
| OPS-02 | `loadConfig()` returns typed `Env` on valid env vars | unit | `npx vitest run src/config.test.ts` | Wave 0 gap |
| STORE-01 | HNSW index exists after migration | manual SQL | `EXPLAIN ANALYZE SELECT ... ORDER BY embedding <=> $1 LIMIT 1` confirms Index Scan | manual |
| STORE-01 | Migration applies idempotently (`CREATE IF NOT EXISTS`) | manual SQL | Verified by human checkpoint in 01-03 Task 2: re-running `npm run db:migrate` against an already-migrated DB reports 0 new migrations applied; `IF NOT EXISTS` guards in SQL prevent errors | manual |

## Sampling Schedule

- **Per task commit:** `npx vitest run src/config.test.ts src/routes/health.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green + `EXPLAIN ANALYZE` confirms HNSW index scan (not Seq Scan)

## Wave 0 Gaps — Must Create

- [ ] `src/config.test.ts` — covers OPS-02 (env validation, fail-fast on missing `DATABASE_URL`)
- [ ] `src/routes/health.test.ts` — covers OPS-01 (health endpoint: DB ok + DB error branches)
- [ ] `vitest.config.ts` — shared config (`testEnvironment: 'node'`)

## Manual Verification Steps (Phase Gate)

```sql
-- After drizzle-kit migrate, verify HNSW index is used
EXPLAIN ANALYZE
SELECT id FROM messages
ORDER BY embedding <=> '[0,0,...,0]'::vector(1536)
LIMIT 1;
-- Expected: "Index Scan using messages_embedding_hnsw"
-- Failure: "Seq Scan on messages" → index missing or wrong operator class
```

## Security Checks

| Pattern | Mitigation | Verified By |
|---------|------------|-------------|
| Missing env vars at boot | Zod fail-fast (OPS-02) | `config.test.ts` |
| DB connection string in logs | Pino redact config | Code review |
| `console.log` leaking secrets | ESLint `no-console: error` | `npm run lint` exits 0 |
