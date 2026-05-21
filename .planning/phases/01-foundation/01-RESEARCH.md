# Phase 1: Foundation — Research

**Researched:** 2026-05-21
**Domain:** Node.js 22 / TypeScript / Fastify 5 / Drizzle ORM / PostgreSQL + pgvector project scaffold
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| STORE-01 | System creates HNSW index (m=16, ef_construction=64, vector_cosine_ops) on messages.embedding at migration time | Covered by §Standard Stack and §Architecture Patterns: Drizzle schema index syntax + raw SQL migration placement |
| STORE-02 (schema) | System stores messages with full raw_json payload for re-enrichment capability | Covered by §Architecture Patterns: Drizzle schema definition with `jsonb` rawJson column |
| STORE-03 (schema) | System upserts chat metadata (name, is_group, participants) on every message from that chat | Covered by §Architecture Patterns: `chats` table schema definition |
| OPS-01 | GET /health returns {ok: true, ts, db: "ok"\|"error"} — checks DB connectivity | Covered by §Architecture Patterns: health endpoint pattern |
| OPS-02 | System validates all env vars on startup via Zod schema; crashes with clear error if missing | Covered by §Architecture Patterns: Zod env schema + fail-fast boot pattern |
</phase_requirements>

---

## Summary

Phase 1 establishes the full project skeleton that every later phase builds on. The work has three distinct pillars: (1) project toolchain — TypeScript 5.9 strict config, package.json scripts, ESLint 9 flat config with `no-console: error`; (2) runtime — Fastify 5 app with Pino logger, ZodTypeProvider, env-validation plugin, DB plugin, and a `/health` endpoint; (3) persistence — Drizzle ORM schema for `messages`, `chats`, and `sync_state` with the `vector(1536)` column and the HNSW index created in the first migration.

The single biggest sequencing risk is the migration strategy for `CREATE EXTENSION IF NOT EXISTS vector`. Drizzle-kit does NOT emit `CREATE EXTENSION` in auto-generated SQL; the extension must be created either via a custom pre-migration or manually in the first migration file. The HNSW index parameters (`m=16, ef_construction=64`) can be passed via Drizzle schema with `.with()`, but the generated SQL must be verified manually — the safest path is to write them explicitly into the migration file.

The existing `package.json` uses `"type": "commonjs"`, which must be changed to `"type": "module"` to match the TypeScript ESM output (`"module": "node20"` in tsconfig). Alternatively keep CommonJS and set `"module": "commonjs"` — but the constraint stack (tsx, Fastify 5, Drizzle) works with either; ESM is the cleaner long-term choice.

**Primary recommendation:** Write the `CREATE EXTENSION IF NOT EXISTS vector` manually at the top of the first Drizzle-generated migration file. Use Drizzle schema `.using('hnsw', ...).with({ m: 16, ef_construction: 64 })` for the HNSW index so it appears correctly in generated SQL — then verify before running.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Env validation (fail-fast) | API / Backend | — | Process-level concern, runs before Fastify binds |
| HTTP server lifecycle | API / Backend | — | Fastify owns listen/close; not a browser or CDN concern |
| Database schema + migrations | Database / Storage | — | Drizzle schema is the schema; drizzle-kit generates SQL |
| HNSW index | Database / Storage | — | pgvector index is a DB-level artifact |
| Health check endpoint | API / Backend | — | Liveness probe — pings DB from server |
| Structured logging | API / Backend | — | Pino runs in-process; logs emitted by server |
| Project toolchain (lint/build) | — (build-time) | — | Not a runtime tier; CI/dev concern |

---

## Project Constraints (from CLAUDE.md)

All directives from CLAUDE.md are locked. The planner MUST NOT deviate from these:

- **Runtime:** Node.js 22 (Docker), NOT Bun
- **TypeScript:** 5.9.x strict — `"strict": true`, `"noUncheckedIndexedAccess": true`
- **HTTP framework:** Fastify 5.8.x — no Express, no Hono
- **ORM:** Drizzle ORM 0.45.x + drizzle-kit 0.31.x — no Prisma, no Kysely
- **DB driver:** `pg` (node-postgres) 8.21.x — Drizzle's `node-postgres` adapter
- **Database:** `whatsapp_brain` on existing shared PostgreSQL (stack ID 8 in Portainer); `pgvector/pgvector:pg17` image
- **Validation:** Zod 3.25.x (NOT Zod 4.x) — `fastify-type-provider-zod` 6.1.x
- **Logging:** Pino 9.14.x — `app.log.info(...)` only; `console.*` FORBIDDEN (ESLint `no-console: error`)
- **Dev runner:** `tsx` 4.22.x — NOT ts-node, NOT nodemon, NOT bun --watch
- **Migration discipline:** NEVER use `drizzle-kit push` — always `generate → review → migrate`
- **Forbidden patterns:** `node-fetch`, `axios`, `ts-node`, `nodemon`, `body-parser`, `console.log` in prod, `zod@^4`, `openai@^6`, synchronous `fs` calls, raw `pg` queries in business logic
- **Network:** Container on `yowanet` overlay network; reaches `postgres` and `evolution` by service name
- **dotenv:** Dev-only (`NODE_ENV !== 'production'`)

---

## Standard Stack

### Core (Phase 1 only)

| Library | Verified Version | Purpose | Provenance |
|---------|-----------------|---------|------------|
| fastify | 5.8.5 | HTTP server | [VERIFIED: npm registry] |
| fastify-plugin | 5.1.0 | fp() lift for plugin encapsulation | [VERIFIED: npm registry] |
| fastify-type-provider-zod | 6.1.0 | Zod schemas → typed routes | [VERIFIED: npm registry] |
| drizzle-orm | 0.45.2 | Type-safe SQL builder + vector column | [VERIFIED: npm registry] |
| drizzle-kit | 0.31.10 | Migration CLI | [VERIFIED: npm registry] |
| pg | 8.21.0 | node-postgres driver (Drizzle adapter) | [VERIFIED: npm registry] |
| zod | 4.4.3 (3.25.x pinned by CLAUDE.md) | Env + request validation | [VERIFIED: npm registry] — use `zod@^3.25` |
| pino | 10.3.1 (9.14.x pinned by CLAUDE.md) | Structured logger | [VERIFIED: npm registry] — use `pino@^9.14` |
| dotenv | 17.4.2 | Dev env loading | [VERIFIED: npm registry] |

> **IMPORTANT version note:** npm `latest` for `zod` is 4.4.3 and for `pino` is 10.3.1. CLAUDE.md pins `zod@^3.25` and `pino@^9.14`. The planner MUST use explicit version ranges in install commands, not `@latest`.

> **TypeScript version note:** npm `latest` is 6.0.3 (breaking release). CLAUDE.md pins 5.9.x. Latest 5.x is `5.9.3`. Use `typescript@^5.9`.

### Dev Tools (Phase 1)

| Library | Verified Version | Purpose | Provenance |
|---------|-----------------|---------|------------|
| typescript | 5.9.3 (5.x latest) | Compiler | [VERIFIED: npm registry] |
| tsx | 4.22.3 | Dev runner / watch mode | [VERIFIED: npm registry] |
| @types/node | 25.9.1 (pin to `^22` per CLAUDE.md) | Node 22 types | [VERIFIED: npm registry] |
| @types/pg | 8.20.0 | pg type definitions | [VERIFIED: npm registry] |
| pino-pretty | 13.1.3 | Dev-time log formatting | [VERIFIED: npm registry] |
| eslint | 10.4.0 (9.x required for flat config) | Linter | [VERIFIED: npm registry] — use `eslint@^9` |
| @eslint/js | 10.0.1 | ESLint recommended rules | [VERIFIED: npm registry] |
| typescript-eslint | 8.59.4 | TypeScript rules + parser (unified pkg) | [VERIFIED: npm registry] |
| prettier | 3.8.3 | Formatter | [VERIFIED: npm registry] |
| vitest | 4.1.7 (2.x pinned by CLAUDE.md) | Unit test runner | [VERIFIED: npm registry] — use `vitest@^2` |

> **eslint version note:** npm `latest` is 10.4.0 but ESLint 9 flat config is the target. Use `eslint@^9` to stay on v9.x. ESLint 10 is an unreleased major — verify before upgrading.

> **@types/node pinning:** npm `latest` is `^25`. Pin to `@types/node@^22` to match Node 22 runtime and avoid type drift.

> **vitest note:** slopcheck flagged vitest as [SUS] (name close to `vite`). Manual verification confirms it is legitimate: homepage https://vitest.dev, GitHub https://github.com/vitest-dev/vitest, 467 published versions. Classification: **APPROVED — false positive from slopcheck**.

### Installation Commands

```bash
# Production dependencies
npm install \
  fastify@^5.8 \
  fastify-plugin@^5 \
  fastify-type-provider-zod@^6.1 \
  drizzle-orm@^0.45 \
  pg@^8.21 \
  zod@^3.25 \
  pino@^9.14 \
  dotenv@^17

# Dev dependencies
npm install -D \
  typescript@^5.9 \
  tsx@^4.22 \
  drizzle-kit@^0.31 \
  @types/node@^22 \
  @types/pg@^8.20 \
  pino-pretty@^13 \
  eslint@^9 \
  @eslint/js@^9 \
  typescript-eslint@^8 \
  prettier@^3 \
  vitest@^2
```

---

## Package Legitimacy Audit

| Package | Registry | slopcheck | Disposition |
|---------|----------|-----------|-------------|
| fastify | npm | [OK] | Approved |
| fastify-plugin | npm | [OK] | Approved |
| fastify-type-provider-zod | npm | [OK] | Approved |
| drizzle-orm | npm | [OK] | Approved |
| drizzle-kit | npm | [OK] | Approved |
| pg | npm | [OK] | Approved |
| zod | npm | [OK] | Approved |
| pino | npm | [OK] | Approved |
| tsx | npm | [OK] | Approved |
| typescript | npm | [OK] | Approved |
| pino-pretty | npm | [OK] | Approved |
| dotenv | npm | [OK] | Approved |
| eslint | npm | [OK] | Approved |
| @eslint/js | npm | [OK] | Approved |
| typescript-eslint | npm | [OK] | Approved (via `@typescript-eslint/eslint-plugin`) |
| prettier | npm | [OK] | Approved |
| vitest | npm | [SUS] | **Approved — false positive.** vitest.dev is the official Vite ecosystem test runner. 467 versions on npm. Confirmed legitimate via homepage and GitHub. |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged [SUS]:** vitest — approved after manual verification

---

## Architecture Patterns

### System Architecture Diagram

```
Startup sequence
      │
      ├── 1. loadConfig() — Zod parse process.env
      │        └── fail-fast: process.exit(1) if invalid
      │
      ├── 2. Fastify({ logger: pinoInstance })
      │        └── setValidatorCompiler + setSerializerCompiler (Zod)
      │
      ├── 3. register plugins (ordered, await each)
      │        ├── configPlugin  (decorates fastify.config)
      │        ├── dbPlugin      (pg pool → drizzle → decorates fastify.db + fastify.pgPool)
      │        │       └── pool.query('SELECT 1') on boot — fast-fail on bad creds
      │        └── (openai, queue, auth — Phase 2+)
      │
      ├── 4. register routes
      │        └── GET /health   ← Phase 1 only
      │
      └── 5. app.listen({ port, host })

GET /health data flow
      │
      ├── Fastify route handler
      ├── try: await fastify.pgPool.query('SELECT 1')
      │       → 200 { ok: true, ts: ISO, db: "ok" }
      └── catch:
              → 200 { ok: false, ts: ISO, db: "error" }
              (never 5xx — health is always reachable)

drizzle-kit migration workflow
      │
      ├── (once) drizzle-kit generate --custom --name=enable-vector
      │       → write: CREATE EXTENSION IF NOT EXISTS vector;
      │
      ├── drizzle-kit generate
      │       → generates CREATE TABLE messages, chats, sync_state
      │       → generates CREATE INDEX ... USING hnsw ...
      │       → VERIFY: m=16, ef_construction=64 present; if not, edit file
      │
      └── drizzle-kit migrate
              → applies to whatsapp_brain database
              → idempotent: IF NOT EXISTS guards
```

### Recommended Project Structure

```
brainny/
├── src/
│   ├── plugins/
│   │   ├── config.ts       # Zod env → fastify.config decorator
│   │   └── db.ts           # pg Pool + drizzle → fastify.db + fastify.pgPool decorators
│   ├── routes/
│   │   └── health.ts       # GET /health
│   ├── db/
│   │   ├── schema.ts       # Drizzle pgTable definitions (messages, chats, sync_state)
│   │   ├── client.ts       # Pool factory (used by dbPlugin)
│   │   └── migrations/     # drizzle-kit output — committed to git
│   ├── lib/
│   │   └── logger.ts       # Pino factory (createLogger)
│   ├── config.ts           # Zod env schema + loadConfig()
│   └── index.ts            # main(): build app → listen → SIGTERM handler
├── drizzle.config.ts
├── tsconfig.json
├── eslint.config.ts
├── .prettierrc
├── .env.example
└── package.json
```

Phase 1 creates only the files above. The remaining folders (`services/`, `queue/`, `scheduler/`, `templates/`, `scripts/`) are stubs or created in later phases.

### Pattern 1: Fastify 5 + ZodTypeProvider Setup

**What:** Register Zod as both validator AND serializer compiler at app root, then use `.withTypeProvider<ZodTypeProvider>()` on routes for full inference.

**When to use:** Once at root `index.ts`; all route files receive the typed instance.

```typescript
// src/index.ts
// Source: https://github.com/turkerdev/fastify-type-provider-zod + STACK.md
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig(); // Zod parse — exits on failure

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 10 * 1024 * 1024, // 10 MB default; override per-route for media
  });

  // Must be set BEFORE any route registration
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(configPlugin, { config });
  await app.register(dbPlugin);
  // Phase 2+: openai, queue, auth plugins

  // Routes use the typed instance
  const api = app.withTypeProvider<ZodTypeProvider>();
  await api.register(healthRoutes);

  // ...
}
```

**Critical:** `setValidatorCompiler` and `setSerializerCompiler` MUST be called before any `.register()` that adds routes. Missing the serializer compiler causes responses to not strip extra fields, which is a PII risk (FASTIFY-3).

### Pattern 2: Config Plugin (fastify.config decorator)

**What:** Expose typed env config via `fastify.config` using `fastify-plugin` + TypeScript module augmentation.

```typescript
// src/plugins/config.ts
// Source: ARCHITECTURE.md Appendix B + STACK.md
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Env;
  }
}

const configPlugin: FastifyPluginAsync<{ config: Env }> = async (fastify, opts) => {
  fastify.decorate('config', opts.config);
};

export default fp(configPlugin, { name: 'config' });
```

`fp()` lifts the encapsulation boundary so `fastify.config` is visible to sibling plugins (e.g., `dbPlugin` reads `fastify.config.DATABASE_URL`).

### Pattern 3: DB Plugin

**What:** Create `pg.Pool`, probe connection, expose `fastify.db` (Drizzle) and `fastify.pgPool` (raw pool for health check).

```typescript
// src/plugins/db.ts
// Source: ARCHITECTURE.md §4
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../db/schema.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: NodePgDatabase<typeof schema>;
    pgPool: pg.Pool;
  }
}

const dbPlugin: FastifyPluginAsync = async (fastify) => {
  const pool = new pg.Pool({
    connectionString: fastify.config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  // Fast-fail: if DB is unreachable at boot, exit now
  await pool.query('SELECT 1');

  fastify.decorate('db', drizzle(pool, { schema }));
  fastify.decorate('pgPool', pool);

  fastify.addHook('onClose', async () => pool.end());
};

export default fp(dbPlugin, { name: 'db', dependencies: ['config'] });
```

### Pattern 4: Zod Env Schema + loadConfig()

**What:** Validate all required env vars before Fastify binds. Exit(1) with clear error on failure.

```typescript
// src/config.ts
// Source: ARCHITECTURE.md Appendix A
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),   // postgresql://user:pass@postgres:5432/whatsapp_brain

  // Phase 2+ — included now so app boots in full later without schema changes:
  OPENAI_API_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(16),
  SEARCH_TOKEN: z.string().min(16),

  DATA_DIR: z.string(),             // Obsidian vault path
  INGEST_CONCURRENCY: z.coerce.number().int().positive().default(3),
  MATERIALIZER_CRON: z.string().default('*/5 * * * *'),
  TZ: z.string().default('America/Sao_Paulo'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Use console.error here ONLY — this is the one pre-logger boot path
    // eslint-disable-next-line no-console
    console.error('ENV validation failed:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}
```

> **Deliberate `no-console` disable:** The `loadConfig()` function runs before Pino is initialized; the one `console.error` call here is necessary and should be annotated with `eslint-disable-line no-console`.

### Pattern 5: Drizzle Schema (messages, chats, sync_state)

**What:** Full schema for Phase 1. HNSW index is declared in Drizzle schema via `.using().with()` — generated SQL must be verified.

```typescript
// src/db/schema.ts
// Source: ARCHITECTURE.md §3 + orm.drizzle.team/docs/guides/vector-similarity-search
import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    sender: text('sender').notNull(),
    senderName: text('sender_name'),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    type: text('type').notNull(),
    text: text('text'),
    mediaUrl: text('media_url'),
    rawJson: jsonb('raw_json').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),   // OAI-4: must be exactly 1536
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('messages_embedding_hnsw')
      .using('hnsw', t.embedding.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),   // REG-6 fix: explicit params
    index('messages_chat_ts_idx').on(t.chatId, t.timestamp),
    index('messages_ts_idx').on(t.timestamp),
  ],
);

export const chats = pgTable('chats', {
  id: text('id').primaryKey(),
  name: text('name'),
  isGroup: boolean('is_group').notNull().default(false),
  participantsJson: jsonb('participants_json'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});

export const syncState = pgTable('sync_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type SyncState = typeof syncState.$inferSelect;
```

**vector import path:** `vector` is exported from `drizzle-orm/pg-core` directly — no separate extension package needed for the schema type. [VERIFIED: orm.drizzle.team/docs/extensions/pg]

### Pattern 6: Migration Workflow

**Step-by-step (never deviate):**

```bash
# Step 1: Create custom migration for vector extension (do this FIRST, once)
npx drizzle-kit generate --custom --name=enable-vector
# Edit the generated file — add:
# CREATE EXTENSION IF NOT EXISTS vector;

# Step 2: Generate schema migration from schema.ts
npx drizzle-kit generate
# Generates: src/db/migrations/NNNN_initial_schema.sql

# Step 3: MANUALLY VERIFY the generated SQL contains:
# - CREATE TABLE messages (..., embedding vector(1536), ...)
# - CREATE INDEX messages_embedding_hnsw ON messages
#     USING hnsw (embedding vector_cosine_ops)
#     WITH (m = 16, ef_construction = 64);
# If the WITH clause is missing, ADD IT MANUALLY before running migrate.

# Step 4: Apply migrations
npx drizzle-kit migrate
```

**Drizzle config (`drizzle.config.ts`):**

```typescript
// Source: orm.drizzle.team/docs/drizzle-config-file [CITED]
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  migrations: {
    table: '__drizzle_migrations',
    schema: 'public',
  },
});
```

### Pattern 7: GET /health Endpoint

**What:** Probes DB, always returns 200 (health checks should be reachable even under DB failure).

```typescript
// src/routes/health.ts
// Source: REQUIREMENTS.md OPS-01 + ARCHITECTURE.md
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const healthResponseSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  db: z.enum(['ok', 'error']),
});

const healthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema } } },
    async (_req, reply) => {
      let dbStatus: 'ok' | 'error' = 'ok';
      try {
        await fastify.pgPool.query('SELECT 1');
      } catch {
        dbStatus = 'error';
        // Log but don't propagate — health endpoint must always respond
        fastify.log.warn('health check: DB unreachable');
      }
      return reply.code(dbStatus === 'ok' ? 200 : 503).send({
        ok: dbStatus === 'ok',
        ts: new Date().toISOString(),
        db: dbStatus,
      });
    },
  );
};

export default healthRoutes;
```

> **Note on status codes:** REQUIREMENTS.md says "returns `{..., db: 'error'}` with non-200 when it is not reachable." The ROADMAP.md success criterion just says non-200. Using 503 for DB failure + 200 for success is the correct interpretation.

### Pattern 8: ESLint 9 Flat Config

**What:** `eslint.config.ts` using the unified `typescript-eslint` package with `strictTypeChecked` preset + `no-console: error`.

```typescript
// eslint.config.ts
// Source: typescript-eslint.io/packages/typescript-eslint [CITED]
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      'no-console': 'error',    // REG-3: enforce Pino-only logging
    },
  },
  {
    // Allow console in scripts and config files
    files: ['scripts/**', 'drizzle.config.ts', 'eslint.config.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'src/db/migrations/**'],
  },
);
```

### Pattern 9: package.json Scripts

The existing `package.json` has `"type": "commonjs"`. Phase 1 must change this to `"type": "module"` to align with TypeScript `"module": "node20"` ESM output. The entry point must also change from `"main": "index.js"` to appropriate ESM conventions.

```json
{
  "name": "brainny",
  "version": "1.0.0",
  "description": "WhatsApp message ingestion and intelligence pipeline",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "db:generate:custom": "drizzle-kit generate --custom",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src --max-warnings 0",
    "format": "prettier --write src"
  }
}
```

> **ESM + tsx:** `tsx` handles `.ts` files natively in both CJS and ESM mode. With `"type": "module"` and `"module": "node20"` in tsconfig, all internal imports must use `.js` extensions (e.g., `import { loadConfig } from './config.js'` — the `.js` resolves to the `.ts` source file when running via tsx).

### Pattern 10: tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "node20",
    "moduleResolution": "node20",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Anti-Patterns to Avoid

- **`drizzle-kit push` in production:** Schema drift without versioned migration files. Always `generate → review → migrate`.
- **Missing `serializerCompiler`:** Fastify won't strip extra fields from responses. PII leak risk (FASTIFY-3).
- **`fp()` omitted from plugin:** Fastify v5 encapsulates plugins by default. Without `fp()`, decorators set in `dbPlugin` are invisible to sibling plugins/routes.
- **Plugin registration order violation:** `configPlugin` MUST come before `dbPlugin` (since db reads `fastify.config.DATABASE_URL`). Use `dependencies: ['config']` in `fp()` call.
- **`"type": "commonjs"` with ESM tsconfig:** Causes Node to reject `.js` files as ESM. Must be consistent.
- **`console.log` in `src/`:** ESLint will fail the CI gate. Use `fastify.log` or a Pino child logger everywhere.
- **`vector` column declaration with wrong dimensions:** `vector(384)` is MiniLM, `vector(1536)` is text-embedding-3-small. Wrong value requires a migration. (OAI-4)
- **HNSW index without `WITH` parameters:** Drizzle may generate the index without `m=16, ef_construction=64` explicitly. Always verify migration SQL (PGVECTOR-3, REG-6).
- **Importing `zod` without checking version:** `npm install zod` will install v4.4.3. Explicitly pin `zod@^3.25`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Env validation | Custom `process.env` checks | `zod.object().safeParse(process.env)` | Type inference, default values, clear error messages |
| Plugin encapsulation lifting | Manual `fastify.decorate` coordination | `fastify-plugin` (`fp()`) | Fastify v5 scopes decorators by default; fp() is the idiomatic solution |
| DB pool management | Raw `pg` Pool in app code | `dbPlugin` with `onClose` hook | Pool lifecycle must be tied to Fastify's shutdown sequence |
| Zod route typing | Manual type assertions | `fastify-type-provider-zod` + `withTypeProvider` | Types are inferred from schema, no manual casting |
| Structured logging | `console.log` or custom formatter | Fastify's built-in Pino | Pino is already wired; child loggers, redaction, request correlation built-in |
| Migration tracking | Custom migration table | drizzle-kit's `__drizzle_migrations` table | Handles ordering, timestamps, idempotency |

**Key insight:** Every item above has a footgun version that looks simple but breaks under concurrent requests, shutdowns, or schema drift. Fastify + Drizzle solve these at the framework level.

---

## Common Pitfalls

### Pitfall 1: HNSW `WITH` parameters silently dropped in migration (REG-6, PGVECTOR-3)

**What goes wrong:** Drizzle's `index().using('hnsw', ...).with({ m: 16, ef_construction: 64 })` in schema.ts generates the HNSW index, but the WITH clause may be absent or formatted differently in the generated SQL. Running `drizzle-kit migrate` without verifying creates the index with default parameters (m=16 is default, but ef_construction may default to 64 — not guaranteed). More critically, the index is created but EXPLAIN ANALYZE shows `Seq Scan` if pgvector wasn't found or if ef_search is not set per-session.

**Why it happens:** Drizzle's index builder `.with()` is a generic `Record<string, any>` passthrough. The generated SQL must be inspected; there is no type-level guarantee the SQL is correct.

**How to avoid:** After `drizzle-kit generate`, open the generated `.sql` file and confirm:
```sql
CREATE INDEX messages_embedding_hnsw ON messages
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```
If `WITH (...)` is missing, add it manually before running `drizzle-kit migrate`.

**Warning signs:** `EXPLAIN ANALYZE SELECT ... ORDER BY embedding <=> $1 LIMIT 20` shows `Seq Scan on messages`.

---

### Pitfall 2: `CREATE EXTENSION vector` runs after `CREATE TABLE` (DRIZZLE-2)

**What goes wrong:** If the table migration runs before the extension migration, PostgreSQL throws `ERROR: type "vector" does not exist`. Migration fails mid-run, leaving the schema partially applied.

**Why it happens:** Drizzle-kit orders migrations by timestamp prefix. If `0001_initial_tables.sql` has an earlier timestamp than `0000_enable_vector.sql`, Postgres fails on the `vector(1536)` column type.

**How to avoid:** Create the custom extension migration FIRST:
```bash
npx drizzle-kit generate --custom --name=enable-vector
```
This generates a timestamped file with the earliest timestamp. Edit it to contain only:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```
Then run the normal schema generation. The custom migration's timestamp will be earlier, so it runs first.

**Warning signs:** `ERROR: type "vector" does not exist` during `drizzle-kit migrate`.

---

### Pitfall 3: Plugin registration without `fp()` — decorator not visible (FASTIFY-1)

**What goes wrong:** A plugin that calls `fastify.decorate('db', ...)` without wrapping with `fp()` creates the decorator only within that plugin's scope. Sibling plugins and routes cannot access `fastify.db`.

**Why it happens:** Fastify v5 encapsulates plugins by default. This is intentional — it prevents accidental global state. `fp()` is the explicit opt-out.

**How to avoid:** Every plugin that decorates the Fastify instance MUST be wrapped with `fp()`:
```typescript
export default fp(dbPlugin, { name: 'db', dependencies: ['config'] });
```

**Warning signs:** `TypeError: fastify.db is not a function` in route handlers.

---

### Pitfall 4: ZodTypeProvider routes compiled without type-provider context

**What goes wrong:** Route declared with a Zod schema on an `app` instance that hasn't called `.withTypeProvider<ZodTypeProvider>()` compiles, but `request.body` types are not inferred — they're `unknown`. Silently breaks type safety.

**Why it happens:** `withTypeProvider` returns a new typed instance. The original `app` is untyped for route schemas.

**How to avoid:** Use `const api = app.withTypeProvider<ZodTypeProvider>()` and register ALL routes on `api`, not on `app`. Or type the plugin arg:
```typescript
const routes: FastifyPluginAsyncZod = async (fastify) => { ... }
```
`FastifyPluginAsyncZod` is the pre-typed plugin type exported from `fastify-type-provider-zod`.

---

### Pitfall 5: `"type": "commonjs"` left in package.json

**What goes wrong:** TypeScript compiles to ESM (`.js` files with `import/export`) but Node tries to load them as CommonJS and throws `SyntaxError: Cannot use import statement in a module`.

**Why it happens:** The existing `package.json` was initialized with `"type": "commonjs"`. This must change before adding TypeScript with `"module": "node20"`.

**How to avoid:** Set `"type": "module"` in `package.json` as one of the first tasks. All internal imports must use `.js` extension even when importing `.ts` files (Node resolution for ESM).

---

### Pitfall 6: `@types/node` version drift (MEDIUM)

**What goes wrong:** `npm install @types/node` installs the latest (v25.x). Node 22 APIs typed in v25 may be missing from the actual Node 22 runtime. Build succeeds but runtime throws `TypeError`.

**How to avoid:** Pin `@types/node@^22` explicitly. The major version should match the Node runtime major.

---

## Code Examples

### Verified pattern: vector cosine search (Phase 4 preview — schema needed in Phase 1)

```typescript
// Source: orm.drizzle.team/docs/guides/vector-similarity-search [CITED]
import { cosineDistance, desc, sql } from 'drizzle-orm';

const similarity = sql<number>`1 - (${cosineDistance(messages.embedding, queryVec)})`;

const hits = await db
  .select({
    id: messages.id,
    chatId: messages.chatId,
    senderName: messages.senderName,
    timestamp: messages.timestamp,
    text: messages.text,
    score: similarity,
  })
  .from(messages)
  .where(sql`${messages.embedding} IS NOT NULL`)
  .orderBy(desc(similarity))
  .limit(20);
```

### Verified pattern: Drizzle HNSW index in schema

```typescript
// Source: orm.drizzle.team/docs/guides/vector-similarity-search [CITED]
(t) => [
  index('messages_embedding_hnsw')
    .using('hnsw', t.embedding.op('vector_cosine_ops'))
    .with({ m: 16, ef_construction: 64 }),
]
```

### Verified pattern: Pino logger usage (never console)

```typescript
// Source: PITFALLS.md REG-3 + STACK.md
// In route handlers:
fastify.log.info({ messageId: msg.id }, 'processing message');

// In services (no Fastify access):
const log = app.log.child({ module: 'health' });
log.warn('DB unreachable during health check');
```

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `ts-node` + `nodemon` | `tsx watch` | Faster startup, no ESM config dance |
| ESLint `.eslintrc.json` (eslintrc config) | `eslint.config.ts` (flat config, ESLint 9) | One config file, no `.eslintignore`, typed |
| `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` separately | `typescript-eslint` unified package | One import replaces two; flat-config-first |
| IVFFlat vector index | HNSW index | Better recall, no lists parameter to tune, standard for < 1M rows |
| `drizzle-kit push` | `drizzle-kit generate` + `drizzle-kit migrate` | Versioned migrations, production-safe |
| Pino passed as `logger: true` (Fastify v4 pattern) | `Fastify({ logger: pinoInstance })` | Direct Pino instance control over redaction, level |

**Deprecated/outdated:**
- `eslintrc` format: Deprecated in ESLint 8, removed in ESLint 9. Use flat config only.
- `setValidatorCompiler` without `setSerializerCompiler`: Missing the serializer was a v4 oversight; both are required in v5 for correct behavior.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Drizzle `.with({ m: 16, ef_construction: 64 })` emits the `WITH (m = 16, ef_construction = 64)` clause in generated SQL | Standard Stack / Common Pitfalls | HNSW index created with default params; EXPLAIN ANALYZE check (success criterion 4) will catch this |
| A2 | `eslint.config.ts` (TypeScript config file) is supported by ESLint 9.x | Architecture Patterns (ESLint) | May need to use `eslint.config.js` instead; low risk, easy to change |
| A3 | `FastifyPluginAsyncZod` is the correct named export from `fastify-type-provider-zod@6.1` | Architecture Patterns | Type error at import; fallback: use generic `FastifyPluginAsync` with manual `.withTypeProvider()` |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed.
(Table has 3 entries — low risk, all easily caught during implementation.)

---

## Open Questions

1. **`CREATE EXTENSION vector` already exists in `whatsapp_brain`?**
   - What we know: The database `whatsapp_brain` is a shared existing PostgreSQL instance. pgvector may already be installed.
   - What's unclear: Whether `CREATE EXTENSION IF NOT EXISTS vector` has already been run.
   - Recommendation: Use `CREATE EXTENSION IF NOT EXISTS vector` (idempotent). The `IF NOT EXISTS` guard makes this safe whether or not it's already installed. Do NOT skip this step — if it's missing and we omit it, the migration fails.

2. **`"type": "commonjs"` → `"type": "module"` migration impact**
   - What we know: The existing `package.json` has `"type": "commonjs"` and no other source files exist yet.
   - What's unclear: Whether any tooling in the Docker environment expects CJS.
   - Recommendation: Switch to `"type": "module"` now while there's no source code to migrate. Much harder to do later.

3. **ESLint 10 vs ESLint 9**
   - What we know: `npm view eslint version` returns `10.4.0` as latest. CLAUDE.md says ESLint 9 flat config.
   - What's unclear: Whether ESLint 10 has breaking changes for this setup.
   - Recommendation: Pin `eslint@^9` explicitly. ESLint 10 was recently released and the flat config ecosystem is still catching up.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ (local: v24.14.1, target: v22 in Docker) | v24.14.1 local | — |
| npm | Package install | ✓ | bundled with Node | — |
| PostgreSQL (whatsapp_brain) | DB schema, health check | Not probed (Portainer stack ID 8) | 17.x target | — |
| pgvector extension | HNSW index | Unknown | 0.8.x target | — |
| Docker / Docker Swarm | Phase 6 only | Not checked in Phase 1 | — | — |

**Missing dependencies with no fallback:**
- PostgreSQL `whatsapp_brain` database — must be reachable with a valid `DATABASE_URL` in `.env` before running `drizzle-kit migrate` or `npm run dev`. If unreachable, `dbPlugin` will fail fast at boot (this is intentional per success criterion 1).

**Missing dependencies with fallback:**
- pgvector extension unknown state — mitigated by `CREATE EXTENSION IF NOT EXISTS vector` (idempotent).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 2.x |
| Config file | `vitest.config.ts` — Wave 0 gap |
| Quick run command | `npx vitest run src/` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OPS-01 | GET /health returns {ok, ts, db} with correct status codes | integration | `npx vitest run src/routes/health.test.ts` | Wave 0 gap |
| OPS-01 | GET /health returns db:"error" + non-200 when DB is down | integration | `npx vitest run src/routes/health.test.ts` | Wave 0 gap |
| OPS-02 | loadConfig() exits with code 1 on missing DATABASE_URL | unit | `npx vitest run src/config.test.ts` | Wave 0 gap |
| OPS-02 | loadConfig() returns typed Env on valid env vars | unit | `npx vitest run src/config.test.ts` | Wave 0 gap |
| STORE-01 | HNSW index exists after migration (EXPLAIN ANALYZE check) | manual / SQL | `EXPLAIN ANALYZE SELECT ...` — see success criterion 4 | manual |
| STORE-01 | Migration applies idempotently (CREATE IF NOT EXISTS) | integration | `npx vitest run src/db/migration.test.ts` | Wave 0 gap |

### Sampling Rate

- **Per task commit:** `npx vitest run src/config.test.ts src/routes/health.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green + EXPLAIN ANALYZE confirms HNSW index scan

### Wave 0 Gaps

- [ ] `src/config.test.ts` — covers OPS-02 (env validation, fail-fast)
- [ ] `src/routes/health.test.ts` — covers OPS-01 (health endpoint, DB probe)
- [ ] `vitest.config.ts` — shared config (define `testEnvironment: 'node'`)
- [ ] Framework install: already in devDependencies as `vitest@^2`

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No (Phase 1 has no auth endpoints) | — |
| V3 Session Management | No | — |
| V4 Access Control | No (Phase 1: /health only, no protected routes) | — |
| V5 Input Validation | Yes | Zod env schema + ZodTypeProvider on /health |
| V6 Cryptography | No (Phase 1 does not handle secrets or tokens) | — |

### Known Threat Patterns for this Phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Missing env vars at boot | Denial of Service | Zod fail-fast (OPS-02) — blocks invalid starts |
| DB connection string in logs | Information Disclosure | Pino redact: `['*.connectionString', '*.DATABASE_URL']` |
| Health endpoint reveals DB state | Information Disclosure | Acceptable — internal network only; liveness probe semantics |
| `console.log` leaking secrets | Information Disclosure | ESLint `no-console: error` (REG-3) |

---

## Sources

### Primary (HIGH confidence)

- [orm.drizzle.team/docs/guides/vector-similarity-search](https://orm.drizzle.team/docs/guides/vector-similarity-search) — pgvector schema, HNSW index syntax, vector column
- [orm.drizzle.team/docs/extensions/pg](https://orm.drizzle.team/docs/extensions/pg) — vector import from drizzle-orm/pg-core
- [orm.drizzle.team/docs/drizzle-config-file](https://orm.drizzle.team/docs/drizzle-config-file) — drizzle.config.ts format
- [orm.drizzle.team/docs/kit-custom-migrations](https://orm.drizzle.team/docs/kit-custom-migrations) — custom migration generation for CREATE EXTENSION
- [typescript-eslint.io/packages/typescript-eslint](https://typescript-eslint.io/packages/typescript-eslint) — ESLint 9 flat config setup
- npm registry: drizzle-orm@0.45.2, drizzle-kit@0.31.10, fastify@5.8.5, fastify-type-provider-zod@6.1.0, pg@8.21.0, tsx@4.22.3, typescript@5.9.3, pino@10.3.1 (latest), zod@4.4.3 (latest)

### Secondary (MEDIUM confidence)

- ARCHITECTURE.md (project research) — plugin patterns, schema design, boot sequence
- STACK.md (project research) — verified stack choices, integration notes
- PITFALLS.md (project research) — REG-1 through REG-9, DRIZZLE-1, FASTIFY-1, FASTIFY-3, PGVECTOR-1 through PGVECTOR-4
- github.com/turkerdev/fastify-type-provider-zod — validatorCompiler/serializerCompiler setup pattern
- github.com/drizzle-team/drizzle-orm blob/main/drizzle-orm/src/pg-core/indexes.ts — `.with()` method confirmed in IndexBuilder

### Tertiary (LOW confidence)

- None identified.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified via `npm view`, slopcheck run, constraints from CLAUDE.md confirmed
- Architecture: HIGH — patterns verified against official Drizzle and Fastify docs, cross-checked with project research files
- Pitfalls: HIGH — sourced from PITFALLS.md (domain-specific prior research) + ARCHITECTURE.md + official docs

**Research date:** 2026-05-21
**Valid until:** 2026-06-21 (stable ecosystem, 30-day window)
