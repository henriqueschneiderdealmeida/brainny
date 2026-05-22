# brainny — Architecture

> WhatsApp message pipeline: Evolution API webhook → enrich (Whisper / Vision) → embed → PostgreSQL+pgvector → materialize to Obsidian Markdown → semantic search.

Stack: Node.js 22 · TypeScript (strict) · Fastify 5 · Drizzle ORM · PostgreSQL 16 + pgvector · OpenAI SDK v5 · Zod · Pino · node-cron · p-queue.

---

## 1. Recommended Project Structure

```
brainny/
├── src/
│   ├── plugins/                 # Fastify plugins (encapsulated, registered once)
│   │   ├── db.ts                # Drizzle pool + decorator (fastify.db)
│   │   ├── openai.ts            # OpenAI client decorator (fastify.openai)
│   │   ├── auth.ts              # Webhook + bearer auth preHandlers
│   │   └── queue.ts             # p-queue instance decorator (fastify.queue)
│   ├── routes/                  # HTTP surface (thin, validation only)
│   │   ├── webhook.ts           # POST /webhook/evolution
│   │   ├── search.ts            # GET /search
│   │   └── health.ts            # GET /health, /ready
│   ├── services/                # Business logic — pure, testable, no Fastify
│   │   ├── ingest.ts            # parse Evolution payload → normalized Message
│   │   ├── enrich/
│   │   │   ├── audio.ts         # download + Whisper transcription
│   │   │   ├── image.ts         # download + GPT-4o Vision description
│   │   │   ├── document.ts      # filename + mime extraction
│   │   │   └── index.ts         # dispatcher by message type
│   │   ├── embed.ts             # text-embedding-3-small wrapper
│   │   ├── persist.ts           # Drizzle upsert (conflict: id)
│   │   ├── materialize.ts       # group → render Markdown → write vault
│   │   ├── search.ts            # vector query (<=> cosine)
│   │   └── media.ts             # downloader with AbortController timeout
│   ├── db/
│   │   ├── schema.ts            # Drizzle pgTable definitions
│   │   ├── client.ts            # pool + drizzle() factory
│   │   └── migrations/          # drizzle-kit output (committed)
│   ├── queue/
│   │   ├── processor.ts         # message processing job (enrich + persist)
│   │   └── index.ts             # p-queue factory (concurrency=3)
│   ├── scheduler/
│   │   └── materializer.ts      # node-cron tick with mutex
│   ├── templates/
│   │   └── day.md.ts            # Markdown template (per-chat day file)
│   ├── lib/
│   │   ├── logger.ts            # Pino factory
│   │   ├── errors.ts            # typed error classes
│   │   └── obsidian.ts          # safe path/filename for vault writes
│   ├── config.ts                # Zod env schema + parse on boot
│   └── index.ts                 # Fastify build + listen + graceful shutdown
├── scripts/
│   ├── backfill.ts              # historical Evolution sync CLI
│   └── rematerialize.ts         # force re-render of date range
├── drizzle.config.ts
├── tsconfig.json                # "strict": true, "noUncheckedIndexedAccess": true
├── Dockerfile                   # node:22-alpine, multi-stage
├── docker-compose.yml           # postgres+pgvector for local dev
├── .env.example
└── package.json
```

### Folder rationale

| Folder | Why it exists |
|---|---|
| `plugins/` | Fastify encapsulation contract. Anything that decorates the instance or owns a long-lived resource (DB pool, OpenAI client, queue) goes here so it can be initialized once, closed on shutdown, and accessed via `fastify.<name>` in routes. |
| `routes/` | Thin HTTP layer. Only does Zod validation + auth check + delegates to `services/`. Keeps handlers fast and testable. |
| `services/` | Pure business logic. No Fastify dependency — can be invoked from routes, queue workers, cron, or CLI scripts. Unit-testable without booting an HTTP server. |
| `db/` | Single source of truth for schema. `schema.ts` is imported by services for typed queries and by drizzle-kit for migrations. |
| `queue/` | Async boundary. Webhook returns 200 immediately; heavy work (Whisper, Vision, embedding) lives here behind bounded concurrency. |
| `scheduler/` | Cron jobs isolated so they can be disabled per-env (e.g. only one replica runs the materializer). |
| `templates/` | Markdown rendering kept apart from persistence; lets the Obsidian output format evolve without touching DB code. |
| `lib/` | Cross-cutting utilities (logger, errors, path safety). |
| `config.ts` | Fail-fast Zod validation on boot. If `DATABASE_URL` is missing, the process exits before Fastify binds. |
| `scripts/` | Operational tools that import services directly — same code paths as production. |

---

## 2. Data Flow Diagrams

### 2.1 Webhook Ingest Flow

```
┌─────────────────────────┐
│ Evolution API           │
│ POST /webhook/evolution │
│ X-Webhook-Secret: ***   │
└────────────┬────────────┘
             ▼
┌──────────────────────────────────────────────────┐
│ Fastify route: routes/webhook.ts                 │
│  1. preHandler: validate X-Webhook-Secret         │
│       └─ mismatch → 401 (no body parsed)          │
│  2. Zod parse body (loose; unknown fields kept)   │
│  3. fastify.queue.add(() => process(payload))     │
│  4. reply.code(200).send({ ok: true })            │  ◄── returns FAST (<50ms)
└────────────┬─────────────────────────────────────┘
             ▼ (async, off the request lifecycle)
┌──────────────────────────────────────────────────┐
│ queue/processor.ts (p-queue, concurrency=3)      │
│                                                  │
│  ┌─ services/ingest.ts                           │
│  │   normalize Evolution payload → Message DTO   │
│  │   (id, chatId, sender, type, timestamp, raw)  │
│  │                                               │
│  ├─ services/enrich/index.ts                     │
│  │   switch (type) {                             │
│  │     audio    → media.download() → Whisper     │
│  │     image    → media.download() → Vision      │
│  │     video    → caption (if any) + filename    │
│  │     document → filename + mime                │
│  │     text     → passthrough                    │
│  │   }                                           │
│  │   30s AbortController on every download       │
│  │                                               │
│  ├─ services/embed.ts                            │
│  │   text-embedding-3-small (1536 dims)          │
│  │   skip if final text is empty                 │
│  │                                               │
│  └─ services/persist.ts                          │
│      INSERT ... ON CONFLICT (id) DO UPDATE       │
│      (idempotent — webhook retries are safe)     │
│                                                  │
│  Errors per-message: log + skip, never throw     │
└──────────────────────────────────────────────────┘
```

Key invariants:
- **Webhook ALWAYS returns 200** unless the secret is wrong (401). Internal failures are logged and never bubble to Evolution — they would just trigger pointless retries.
- **Idempotency is in the DB layer**, not the queue. Same message id arriving twice (Evolution retries, backfill overlap) just upserts.
- **Concurrency = 3** balances OpenAI throughput vs rate limits. Tunable via `INGEST_CONCURRENCY` env.

### 2.2 Materialization Flow (every 5 min)

```
node-cron("*/5 * * * *")
       │
       ▼
┌────────────────────────────────────────────┐
│ scheduler/materializer.ts                  │
│  if (running) { log "skip"; return }       │  ◄── boolean mutex
│  running = true                            │
│  try {                                     │
│    const cursor = await getSyncState(      │
│        'materializer.lastRun')             │
│                                            │
│    // Re-render yesterday + today so       │
│    // late-arriving messages still show.   │
│    const range = [startOfYesterday,        │
│                   endOfToday]              │
│                                            │
│    rows = SELECT ... FROM messages         │
│           WHERE timestamp BETWEEN $1 $2    │
│           ORDER BY timestamp ASC           │
│                                            │
│    grouped = groupBy(rows,                 │
│              row => [date(row), chat])     │
│                                            │
│    for each (date, chatId) in grouped:     │
│       md  = renderDay(template, msgs)      │
│       dir = `${DATA_DIR}/${date}`          │
│       path = `${dir}/${slug(chat)}.md`     │
│       writeFileAtomic(path, md)            │  ◄── tmp + rename
│                                            │
│    await setSyncState(                     │
│      'materializer.lastRun', now)          │
│  } finally {                               │
│    running = false                         │
│  }                                         │
└────────────────────────────────────────────┘
```

Notes:
- **Mutex is in-process** — fine for single-instance deployments. For multi-replica, swap for a PG advisory lock (`pg_try_advisory_lock`).
- **Re-render window = yesterday + today** so messages that arrive after the day rolled over (timezone edges, backfill) appear in the right day file.
- **Atomic writes** (`write → fsync → rename`) prevent Obsidian from indexing half-written files.

### 2.3 Search Flow

```
GET /search?q=texto&limit=20
Authorization: Bearer ${SEARCH_TOKEN}
       │
       ▼
┌────────────────────────────────────────────┐
│ routes/search.ts                           │
│  preHandler: bearer token check (401)      │
│  Zod query: { q: string, limit?: 1..50 }   │
│                                            │
│  vec = await openai.embeddings.create({    │
│    model: 'text-embedding-3-small',        │
│    input: q                                │
│  })                                        │
│                                            │
│  SELECT id, chat_id, sender_name,          │
│         timestamp, text,                   │
│         1 - (embedding <=> $1) AS score    │
│  FROM messages                             │
│  WHERE embedding IS NOT NULL               │
│  ORDER BY embedding <=> $1                 │
│  LIMIT $2                                  │
│                                            │
│  → 200 [{ id, chat_id, sender_name,        │
│           timestamp, text, score }]        │
└────────────────────────────────────────────┘
```

`<=>` is pgvector's cosine distance. Returned `score = 1 - distance` so higher = better.

---

## 3. Drizzle Schema Design

`src/db/schema.ts`:

```ts
import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * messages — one row per WhatsApp message.
 * id = Evolution message id (globally unique). Upsert on conflict.
 */
export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    sender: text('sender').notNull(),                  // jid (e.g. 5511...@s.whatsapp.net)
    senderName: text('sender_name'),                   // pushName / contact name
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    type: text('type', {
      enum: ['text', 'audio', 'image', 'video', 'document', 'sticker', 'other'],
    }).notNull(),
    text: text('text'),                                // final enriched text (transcription/caption/body)
    mediaUrl: text('media_url'),                       // Evolution media URL (or local path after download)
    rawJson: jsonb('raw_json').notNull(),              // full Evolution payload for re-processing
    embedding: vector('embedding', { dimensions: 1536 }), // nullable — empty msgs skip embed
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    chatTsIdx: index('messages_chat_ts_idx').on(t.chatId, t.timestamp),
    tsIdx: index('messages_ts_idx').on(t.timestamp),
    // HNSW for vector search (created via raw SQL migration; Drizzle has no first-class HNSW yet)
    // CREATE INDEX messages_embedding_hnsw ON messages
    //   USING hnsw (embedding vector_cosine_ops);
  }),
);

/**
 * chats — denormalized chat metadata for fast rendering.
 */
export const chats = pgTable('chats', {
  id: text('id').primaryKey(),                         // chat jid
  name: text('name'),                                  // group subject or contact name
  isGroup: boolean('is_group').notNull().default(false),
  participantsJson: jsonb('participants_json'),        // array of { jid, name } for groups
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});

/**
 * sync_state — generic key/value cursor store.
 *   key examples:
 *     'materializer.lastRun'          → ISO timestamp
 *     'backfill.cursor.<chatId>'      → last processed msg id
 */
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
```

Initial migration (`drizzle/0000_init.sql`) must include:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
-- (drizzle-kit handles tables)
CREATE INDEX messages_embedding_hnsw
  ON messages USING hnsw (embedding vector_cosine_ops);
```

---

## 4. Fastify Plugin Pattern

`src/plugins/db.ts`:

```ts
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

  // Probe connection so boot fails fast on bad creds.
  await pool.query('SELECT 1');

  const db = drizzle(pool, { schema, logger: false });

  fastify.decorate('db', db);
  fastify.decorate('pgPool', pool);

  fastify.addHook('onClose', async () => {
    await pool.end();
  });
};

// fp() lifts encapsulation so `fastify.db` is visible to sibling plugins/routes.
export default fp(dbPlugin, { name: 'db' });
```

Registered in `src/index.ts`:

```ts
const app = Fastify({ logger });
await app.register(configPlugin);   // exposes fastify.config
await app.register(dbPlugin);
await app.register(openaiPlugin);
await app.register(queuePlugin);
await app.register(authPlugin);
await app.register(routes, { prefix: '/' });
```

Other plugins follow the same shape: `openai.ts` decorates `fastify.openai`, `queue.ts` decorates `fastify.queue`, `auth.ts` registers reusable `preHandler` hooks (`fastify.webhookAuth`, `fastify.searchAuth`).

---

## 5. Async Queue Pattern (p-queue)

`src/queue/index.ts`:

```ts
import PQueue from 'p-queue';
import type { Logger } from 'pino';

export interface QueueOptions {
  concurrency: number;
  logger: Logger;
}

export function createIngestQueue({ concurrency, logger }: QueueOptions) {
  const queue = new PQueue({
    concurrency,
    autoStart: true,
    // soft rate limit guard against OpenAI bursts:
    intervalCap: 30,
    interval: 1_000,
    carryoverConcurrencyCount: true,
  });

  queue.on('error', (err) => {
    // p-queue swallows job errors by default; surface them.
    logger.error({ err }, 'queue job error');
  });

  queue.on('idle', () => {
    logger.debug('queue idle');
  });

  return queue;
}
```

`src/plugins/queue.ts`:

```ts
import fp from 'fastify-plugin';
import { createIngestQueue } from '../queue/index.js';
import type PQueue from 'p-queue';

declare module 'fastify' {
  interface FastifyInstance {
    queue: PQueue;
  }
}

export default fp(async (fastify) => {
  const queue = createIngestQueue({
    concurrency: fastify.config.INGEST_CONCURRENCY ?? 3,
    logger: fastify.log,
  });
  fastify.decorate('queue', queue);

  fastify.addHook('onClose', async () => {
    queue.pause();
    await queue.onIdle();   // drain before shutdown
  });
}, { name: 'queue', dependencies: ['config'] });
```

Webhook usage:

```ts
fastify.post('/webhook/evolution', {
  preHandler: fastify.webhookAuth,
}, async (req, reply) => {
  const payload = req.body;  // already Zod-validated by schema option
  // Fire-and-forget; do NOT await.
  fastify.queue.add(() => processMessage(fastify, payload))
    .catch((err) => fastify.log.error({ err }, 'enqueue failed'));
  return reply.code(200).send({ ok: true });
});
```

---

## 6. Materializer Mutex Pattern

`src/scheduler/materializer.ts`:

```ts
import cron from 'node-cron';
import type { FastifyInstance } from 'fastify';
import { runMaterialize } from '../services/materialize.js';

export function startMaterializer(app: FastifyInstance) {
  let running = false;

  const task = cron.schedule(
    app.config.MATERIALIZER_CRON ?? '*/5 * * * *',
    async () => {
      if (running) {
        app.log.warn('materializer tick skipped — previous run still active');
        return;
      }
      running = true;
      const startedAt = Date.now();
      try {
        const result = await runMaterialize(app);
        app.log.info(
          { ms: Date.now() - startedAt, ...result },
          'materializer tick complete',
        );
      } catch (err) {
        app.log.error({ err }, 'materializer tick failed');
      } finally {
        running = false;
      }
    },
    { scheduled: true, timezone: app.config.TZ ?? 'America/Sao_Paulo' },
  );

  app.addHook('onClose', async () => {
    task.stop();
    // Wait for any in-flight tick to finish.
    while (running) await new Promise((r) => setTimeout(r, 100));
  });
}
```

For multi-replica deployments, replace the `running` boolean with a PG advisory lock at the top of `runMaterialize`:

```ts
const [{ locked }] = await db.execute(
  sql`SELECT pg_try_advisory_lock(${MATERIALIZER_LOCK_ID}) AS locked`,
);
if (!locked) return { skipped: true };
try { /* work */ } finally {
  await db.execute(sql`SELECT pg_advisory_unlock(${MATERIALIZER_LOCK_ID})`);
}
```

---

## 7. Error Handling Strategy

### 7.1 Per-message isolation
The queue processor wraps every message in `try/catch`. One bad payload never blocks the queue.

```ts
export async function processMessage(app: FastifyInstance, payload: unknown) {
  const log = app.log.child({ component: 'processor' });
  try {
    const msg = ingest.normalize(payload);
    log.debug({ id: msg.id, type: msg.type }, 'processing');
    const enriched = await enrich.run(app, msg);
    const embedding = enriched.text ? await embed.text(app, enriched.text) : null;
    await persist.upsert(app.db, { ...enriched, embedding });
  } catch (err) {
    log.error({ err, payload: safePayloadSummary(payload) }, 'message dropped');
    // Swallow — do not rethrow. Queue continues.
  }
}
```

### 7.2 Media download timeout
`services/media.ts` uses `AbortController` with a hard 30s ceiling and a typed error on timeout.

```ts
export async function downloadMedia(url: string, log: Logger): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new MediaDownloadError(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) {
      throw new MediaTooLargeError(`media exceeds 25MB: ${buf.length}`);
    }
    return buf;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new MediaDownloadError(`timeout after 30s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

### 7.3 OpenAI rate limits
Two-layer defense:

1. **Soft cap** at the queue level: `intervalCap: 30, interval: 1_000` (max 30 jobs/sec) in `p-queue`.
2. **Per-call retry** with exponential backoff for `429` / `5xx`:

```ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 4, baseMs = 500, log }: { retries?: number; baseMs?: number; log: Logger },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const retriable = status === 429 || (status !== undefined && status >= 500);
      if (!retriable || attempt >= retries) throw err;
      const delay = baseMs * 2 ** attempt + Math.random() * 200;
      log.warn({ err, attempt, delay }, 'openai retriable error');
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }
}
```

The OpenAI SDK v5 also has built-in `maxRetries` — we set `maxRetries: 2` on the client and let `withRetry` handle the longer outer loop for queue jobs.

### 7.4 Webhook always returns 200
```
401 — wrong/missing X-Webhook-Secret (the ONLY non-200)
200 — everything else, including:
       - malformed body  (logged, dropped)
       - queue full      (logged, dropped — backpressure absorbed)
       - unknown type    (logged, dropped)
```
Rationale: Evolution retries on non-2xx. Retries amplify our own bugs; better to ack and absorb.

### 7.5 Graceful shutdown
`SIGTERM`/`SIGINT` triggers `app.close()`, which:
1. Stops accepting new HTTP requests.
2. Stops cron tasks; waits for in-flight tick.
3. Pauses queue, awaits `onIdle()`.
4. Closes PG pool.

This keeps in-flight Whisper calls from being orphaned mid-write.

### 7.6 Error taxonomy (`src/lib/errors.ts`)

| Class | Recoverable? | Action |
|---|---|---|
| `MediaDownloadError` | yes | log, persist message with `text=null` |
| `MediaTooLargeError` | no | log, persist with `text="[media too large]"` |
| `EnrichmentError` (Whisper/Vision failure) | partial | log, persist with raw caption/filename fallback |
| `EmbeddingError` | yes | log, persist message with `embedding=null` (searchable later via re-embed job) |
| `PersistError` | no | log, drop — DB issue, alert via Pino error level |

---

## Appendix A — Environment (`src/config.ts`)

```ts
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_EMBED_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_WHISPER_MODEL: z.string().default('whisper-1'),
  OPENAI_VISION_MODEL: z.string().default('gpt-4o-mini'),

  WEBHOOK_SECRET: z.string().min(16),
  SEARCH_TOKEN: z.string().min(16),

  DATA_DIR: z.string(),                  // Obsidian vault path
  INGEST_CONCURRENCY: z.coerce.number().int().positive().default(3),
  MATERIALIZER_CRON: z.string().default('*/5 * * * *'),
  TZ: z.string().default('America/Sao_Paulo'),

  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function loadConfig(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
```

## Appendix B — Boot sequence (`src/index.ts`)

```ts
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import configPlugin from './plugins/config.js';
import dbPlugin from './plugins/db.js';
import openaiPlugin from './plugins/openai.js';
import queuePlugin from './plugins/queue.js';
import authPlugin from './plugins/auth.js';
import routes from './routes/index.js';
import { startMaterializer } from './scheduler/materializer.js';

async function main() {
  const config = loadConfig();
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(configPlugin, { config });
  await app.register(dbPlugin);
  await app.register(openaiPlugin);
  await app.register(queuePlugin);
  await app.register(authPlugin);
  await app.register(routes);

  startMaterializer(app);

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

---

## Appendix C — Day Markdown template (per chat)

`{DATA_DIR}/2026-05-21/familia-grupo.md`:

```md
---
chat_id: 5511999999999-1234567890@g.us
chat_name: Família
date: 2026-05-21
message_count: 42
generated_at: 2026-05-21T14:05:00-03:00
---

# Família — 2026-05-21

## 08:14 — Maria
Bom dia gente!

## 08:15 — João  [audio]
> Boa! Hoje tem reunião às 10h, lembrem.

## 09:02 — Maria  [image]
> Foto: Bolo de chocolate sobre mesa de madeira, vista de cima.

...
```

This is the schema the materializer renders into. Obsidian indexes it natively for backlinks and full-text; pgvector handles semantic search on the raw rows.
