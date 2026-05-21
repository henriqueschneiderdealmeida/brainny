# Walking Skeleton — brainny Phase 1: Foundation

**Phase:** 01-foundation
**Mode:** Walking Skeleton (MVP Phase 1)
**Date:** 2026-05-21

---

## What Is This Skeleton?

The thinnest possible end-to-end stack for brainny: a running Fastify 5 server that validates environment variables at boot, connects to the `whatsapp_brain` PostgreSQL database via Drizzle ORM, and exposes `GET /health`. The database has the full production schema (`messages`, `chats`, `sync_state`) including the `vector(1536)` column and HNSW index for pgvector — the exact schema that every later phase writes to and reads from.

This skeleton is not a prototype. Every decision made here (TypeScript config, module system, plugin patterns, migration discipline) is permanent and load-bearing. Later phases add features without renegotiating any of these foundations.

---

## Architectural Decisions

### Runtime & Module System

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js 22 | Constraint — Docker environment, LTS, native `fetch`, `node:test`, top-level await |
| Module system | ESM (`"type": "module"`) | Aligns with TypeScript `"module": "node20"`; all imports use `.js` extension; tsx handles natively |
| TypeScript | 5.9.x, `"module": "node20"`, `"moduleResolution": "node20"`, `strict: true`, `noUncheckedIndexedAccess: true` | Constraint — strictest safe config; `node20` enables top-level await without workarounds |
| Dev runner | `tsx watch src/index.ts` | Constraint — no ts-node, no nodemon; tsx is faster and handles ESM without config |

### HTTP Framework

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | Fastify 5.8.x | Constraint — schema-first, Pino built-in, ZodTypeProvider, async hooks |
| Request validation | `fastify-type-provider-zod@^6.1` | Zod schemas → fully inferred request/response types; both `setValidatorCompiler` AND `setSerializerCompiler` required |
| Plugin pattern | `fastify-plugin` (`fp()`) | Required for cross-plugin decorator visibility (`fastify.config`, `fastify.db`, `fastify.pgPool`) |

### Database

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Database | PostgreSQL 17 + pgvector 0.8.x, DB: `whatsapp_brain` | Constraint — existing shared Postgres, Portainer stack ID 8 |
| ORM | Drizzle ORM 0.45.x | Constraint — type-safe, first-class `vector(1536)` column, no engine binary |
| Driver | `pg` (node-postgres) 8.21.x | Constraint — Drizzle `node-postgres` adapter |
| Vector index | HNSW, `m=16, ef_construction=64`, `vector_cosine_ops` | HNSW is better recall than IVFFlat for <1M rows; parameters explicit in migration SQL |
| Migration discipline | `generate → review → migrate` | NEVER `drizzle-kit push` — versioned migrations only |

### Validation & Logging

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Env validation | Zod 3.25.x `envSchema` + `loadConfig()` | Constraint — `safeParse(process.env)` exits with code 1 on first boot failure; Zod 4.x forbidden |
| Logging | Pino 9.14.x (Fastify built-in) | Constraint — `fastify.log.*` everywhere; `console.*` forbidden (`no-console: error` ESLint rule) |

### Directory Layout

```
brainny/
├── src/
│   ├── config.ts               # Zod env schema + loadConfig() — boots before Fastify
│   ├── index.ts                # main(): build app → register plugins/routes → listen
│   ├── lib/
│   │   └── logger.ts           # createLogger(config) factory — returns Pino instance
│   ├── plugins/
│   │   ├── config.ts           # fp() plugin: decorates fastify.config
│   │   └── db.ts               # fp() plugin: decorates fastify.db + fastify.pgPool
│   ├── routes/
│   │   └── health.ts           # GET /health — DB probe, always 200/503
│   └── db/
│       ├── schema.ts           # Drizzle pgTable: messages, chats, sync_state + HNSW index
│       ├── client.ts           # createPool(url): pg.Pool factory
│       └── migrations/         # drizzle-kit output — committed to git
│           ├── 0000_enable_vector.sql
│           └── 0001_initial_schema.sql
├── drizzle.config.ts           # Drizzle-kit config: schema path, out dir, DB URL
├── tsconfig.json               # TypeScript 5.9, node20 module, strict
├── eslint.config.ts            # ESLint 9 flat config + no-console: error
├── .prettierrc                 # Formatter config
├── vitest.config.ts            # Test config, testEnvironment: node
├── .env.example                # All required env vars with placeholder values
└── package.json                # "type": "module", all scripts, all deps
```

Phase 1 creates ONLY the files above. Services, queue, scheduler, templates, scripts directories are created in Phases 2–6.

---

## Plugin Registration Order (Invariant)

```
main()
  └── loadConfig()                    ← exits before Fastify if env invalid
       └── Fastify({ logger: pino })
            └── setValidatorCompiler + setSerializerCompiler
                 ├── register configPlugin  ← exposes fastify.config
                 ├── register dbPlugin      ← reads fastify.config.DATABASE_URL
                 └── register healthRoutes  ← reads fastify.pgPool
```

The registration order above is PERMANENT and MUST NOT be changed. `dbPlugin` has `dependencies: ['config']` enforced via `fp()`.

---

## What Each Phase Adds to the Skeleton

| Phase | Adds to Skeleton |
|-------|-----------------|
| 2 | POST /webhook/evolution route, services/ingest.ts, services/persist.ts, p-queue, WEBHOOK_SECRET validation |
| 3 | services/enrich.ts (Whisper + GPT-4 Vision), OpenAI SDK client, p-retry, media download |
| 4 | GET /search endpoint, SEARCH_TOKEN auth, semantic search query via cosine distance |
| 5 | scheduler/materializer.ts, node-cron, vault Markdown writes |
| 6 | scripts/backfill.ts, SIGTERM graceful shutdown, Dockerfile, Docker Swarm stack |

---

## Skeleton Invariants (Never Break These)

- `fastify.config` is always available to `fastify.db` and routes (plugin order enforced)
- `fastify.db` is a `NodePgDatabase<typeof schema>` — every DB query goes through Drizzle, never raw `pg`
- `fastify.pgPool` exists alongside `fastify.db` for the health check's raw `SELECT 1`
- `console.*` is forbidden at ESLint level — all logging is `fastify.log.*` or `app.log.*`
- All source files are ESM (`import/export`) — no `require()` anywhere
- All imports from local files use `.js` extension (e.g., `./config.js` → resolves to `config.ts` via tsx)
- `dotenv` is loaded only in `NODE_ENV !== 'production'`
- `drizzle-kit push` is forbidden — run `generate → verify SQL → migrate`
