# Stack Research

**Domain:** WhatsApp message ingestion pipeline
**Researched:** 2026-05-21
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|---|---|---|---|
| Node.js | 22.x LTS (>=22.11) | JavaScript runtime | Constraint — LTS, native `fetch`, stable `node:test`, top-level await, matches Docker base image already in use |
| TypeScript | 5.9.x (5.9.3 latest stable) | Static typing | Constraint pins 5.x strict; 5.9 brings `--module node20`, deferred imports, leaner `tsc --init` output |
| Fastify | 5.8.x | HTTP framework | Constraint — schema-first, native AJV, async hook system, ~2x faster than Express; v5 drops Node <20, requires explicit plugin async patterns |
| Drizzle ORM | 0.45.x (0.45.2) | Type-safe SQL builder | Constraint — declarative TS schema, first-class `vector` column type via `drizzle-orm/pg-core`, no runtime reflection (no Prisma engine binary) |
| drizzle-kit | 0.31.x (0.31.10) | Schema migrations / introspection | Pairs with drizzle-orm; generates and applies SQL migrations from TS schema |
| PostgreSQL | 17.x + pgvector 0.8.x | Data + vector store | Constraint — `pgvector/pgvector:pg17` image, HNSW index with `vector_cosine_ops` for 1536-dim embeddings |
| pg (node-postgres) | 8.21.x | PG driver for Drizzle | Drizzle's `node-postgres` adapter (`drizzle-orm/node-postgres`) — battle-tested, supports pooling and `pgvector` JS bindings |
| openai | 5.20.x (last 5.x line; 6.x exists but constraint pins v5) | OpenAI API SDK | Constraint — Whisper transcription, GPT-4o-mini vision, `text-embedding-3-small`. v5 introduced new `client.audio.transcriptions.create({ file })` with `toFile` helper, native `fetch`, no `node-fetch` dep |
| Zod | 3.25.x (last stable 3.x; 4.x exists but constraint pins v3) | Runtime validation | Constraint — Fastify schema via `fastify-type-provider-zod`, env parsing, Evolution webhook body validation. 3.25 is the frozen 3.x endpoint before v4 |
| Pino | 9.14.x (constraint pins v9; 10.x exists) | Structured logging | Constraint — fastest JSON logger, child loggers per request via `pino-http`, integrates natively as `app.log` in Fastify |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---|---|---|---|
| @fastify/multipart | 10.0.x | File upload parsing | Receiving audio/image media from Evolution webhook payloads when files are streamed rather than base64-inlined; configure `limits.fileSize` ~25MB for Whisper cap |
| @fastify/cors | 11.2.x | CORS for `/search` endpoint | If a future Obsidian plugin or browser client hits `/search`; safe default `origin: false` (Evolution webhooks don't need CORS) |
| @fastify/helmet | 13.x | Security headers | Production hardening of `/search` and `/health` endpoints |
| @fastify/rate-limit | 10.x | Throttle public endpoints | Protect `/search` and `/webhook` from abuse; in-memory bucket is fine for single-instance |
| fastify-type-provider-zod | 6.1.x | Zod-typed routes | Bind Zod schemas to Fastify routes so `request.body` / `request.query` are inferred and validated in one shot |
| pino-http | 11.0.x | HTTP request logging | Fastify uses Pino natively, but `pino-http` is useful if any raw `http` server or worker exposes endpoints outside Fastify |
| pino-pretty | 13.1.x | Dev-time log formatter | `NODE_ENV=development` only — pipe `pino` output through `pino-pretty` for human-readable logs |
| pgvector | 0.2.x | JS helpers for pgvector | Provides `toSql()` for serializing `number[]` to pgvector wire format when not using Drizzle's `vector` column helper directly |
| p-queue | 9.3.x | Concurrency control | Rate-limit OpenAI calls (Whisper, Vision, Embeddings) — separate queues per endpoint with `concurrency: 5` and `intervalCap` for tier limits |
| p-retry | 6.x | Exponential backoff | Wrap OpenAI calls — retry on 429 / 5xx with jitter; complements p-queue |
| node-cron | 4.2.x | Cron scheduler | Materializer tick (e.g., every 5 min flush of pending messages → Markdown), nightly backfill jobs |
| dotenv | 17.4.x | Env loading in dev | Load `.env` in dev; in Docker, env vars come from compose/swarm — keep dotenv dev-only |
| undici | bundled with Node 22 | HTTP client | Already available as global `fetch`; use directly for Evolution media downloads (no axios needed) |

### Development Tools

| Tool | Purpose | Notes |
|---|---|---|
| tsx | TS dev runner / watch mode | 4.22.x — `tsx watch src/server.ts` for hot-reload; no `ts-node` registration dance, native ESM |
| @types/node | Node 22 type defs | 22.x line (e.g. 22.10.x) — pin to the Node major in use, not latest 25.x, to avoid drift |
| @types/pg | pg type defs | 8.20.x |
| @types/node-cron | node-cron types | If node-cron 4.x ships types embedded, omit; otherwise pin to matching major |
| drizzle-kit | Migration CLI | Already core — `drizzle-kit generate`, `drizzle-kit migrate`, `drizzle-kit studio` |
| vitest | Unit test runner | 2.x — TS-native, jest-compatible API, faster than jest; pairs well with tsx |
| @fastify/swagger + @fastify/swagger-ui | OpenAPI docs (optional) | Auto-generates docs from Zod schemas via `fastify-type-provider-zod`'s OpenAPI bridge |
| eslint + @typescript-eslint | Linting | ESLint 9 flat config, `strict-type-checked` ruleset |
| prettier | Formatting | 3.x |

## Installation

```bash
# Core runtime
npm install \
  fastify@^5.8 \
  @fastify/multipart@^10 \
  @fastify/cors@^11 \
  @fastify/helmet@^13 \
  @fastify/rate-limit@^10 \
  fastify-type-provider-zod@^6 \
  drizzle-orm@^0.45 \
  pg@^8.21 \
  pgvector@^0.2 \
  openai@^5.20 \
  zod@^3.25 \
  pino@^9.14 \
  pino-http@^11 \
  p-queue@^9 \
  p-retry@^6 \
  node-cron@^4 \
  dotenv@^17

# Dev / tooling
npm install -D \
  typescript@^5.9 \
  drizzle-kit@^0.31 \
  @types/node@^22 \
  @types/pg@^8.20 \
  tsx@^4.22 \
  pino-pretty@^13 \
  vitest@^2 \
  eslint@^9 \
  @typescript-eslint/parser@^8 \
  @typescript-eslint/eslint-plugin@^8 \
  prettier@^3
```

Recommended `package.json` scripts:

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "test": "vitest run",
    "lint": "eslint src --max-warnings 0"
  }
}
```

`tsconfig.json` key options for strict mode:

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
  }
}
```

## Key Integration Notes

### Fastify 5 + TypeScript + Zod

- Register the Zod type provider **once** at the root app, then call `app.withTypeProvider<ZodTypeProvider>()` to get a typed instance. Use that instance for every route so `request.body` / `request.query` / `request.params` are inferred from the Zod schema.

```typescript
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

const app = Fastify({ logger: { level: 'info' } })
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)

const api = app.withTypeProvider<ZodTypeProvider>()

api.post('/webhook', {
  schema: {
    body: z.object({
      event: z.string(),
      instance: z.string(),
      data: z.object({ key: z.object({ id: z.string() }) }).passthrough(),
    }),
    response: { 200: z.object({ ok: z.literal(true) }) },
  },
  handler: async (req) => {
    // req.body is fully typed
    return { ok: true as const }
  },
})
```

- Fastify 5 requires plugins to be `async` or use the `done` callback consistently — mixing styles breaks lifecycle.
- Use `fastify.register()` for every plugin (multipart, cors, helmet, db connection). Plugin encapsulation is now stricter in v5.
- Built-in logger is Pino — set it via `Fastify({ logger: pinoInstance })`. Don't double-register `pino-http`.

### Drizzle + pgvector

Schema definition (1536-dim for `text-embedding-3-small`):

```typescript
import { pgTable, uuid, text, timestamp, vector, index } from 'drizzle-orm/pg-core'

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    sender: text('sender').notNull(),
    type: text('type').notNull(), // text | audio | image | video | document
    content: text('content').notNull(), // transcript / description / body
    embedding: vector('embedding', { dimensions: 1536 }),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('messages_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('messages_chat_ts_idx').on(t.chatId, t.timestamp),
  ],
)
```

Cosine similarity query:

```typescript
import { cosineDistance, desc, gt, sql } from 'drizzle-orm'

const similarity = sql<number>`1 - (${cosineDistance(messages.embedding, queryEmbedding)})`

const hits = await db
  .select({
    id: messages.id,
    content: messages.content,
    chatId: messages.chatId,
    timestamp: messages.timestamp,
    similarity,
  })
  .from(messages)
  .where(gt(similarity, 0.3))
  .orderBy((t) => desc(t.similarity))
  .limit(20)
```

- `drizzle-kit generate` writes SQL with `CREATE EXTENSION IF NOT EXISTS vector;` — confirm it's present in the generated migration; if not, prepend it manually to the first migration.
- HNSW index build is slow on large tables — create AFTER bulk backfill, not before.
- `cosineDistance(a, b)` compiles to `a <=> b` (pgvector operator). `1 - distance` = similarity in [0, 1] for normalized vectors (OpenAI embeddings are L2-normalized).

### OpenAI SDK v5

Whisper (audio transcription) — use the `toFile` helper for buffers/streams:

```typescript
import OpenAI, { toFile } from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const audioBuffer: Buffer = await downloadFromEvolution(mediaUrl)

const transcript = await openai.audio.transcriptions.create({
  file: await toFile(audioBuffer, 'audio.ogg', { type: 'audio/ogg' }),
  model: 'whisper-1',
  language: 'pt',
  response_format: 'verbose_json', // includes segments + duration
})
```

Vision (GPT-4o-mini) — pass image as base64 data URL:

```typescript
const b64 = imageBuffer.toString('base64')
const description = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Descreva esta imagem em PT-BR em até 2 frases.' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' } },
      ],
    },
  ],
  max_tokens: 200,
})
const text = description.choices[0].message.content
```

Embeddings — `text-embedding-3-small` returns 1536-dim by default; can be shortened via `dimensions` param:

```typescript
const emb = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: textChunk, // string or string[] (batch up to ~2048 inputs)
})
const vector: number[] = emb.data[0].embedding // length === 1536
```

- v5 SDK uses Node's global `fetch` — works on Node 22 with no extra deps.
- Errors are typed: `import { APIError, RateLimitError } from 'openai'` — match on those in `p-retry` decisions.
- `detail: 'low'` for vision keeps cost predictable (~85 tokens/image vs hundreds for `high`).

### p-queue for OpenAI rate limiting

Maintain one queue per endpoint family — tier-1 limits differ across Whisper, Chat, Embeddings:

```typescript
import PQueue from 'p-queue'
import pRetry from 'p-retry'

export const whisperQueue = new PQueue({ concurrency: 3, intervalCap: 50, interval: 60_000 })
export const visionQueue = new PQueue({ concurrency: 5, intervalCap: 500, interval: 60_000 })
export const embedQueue = new PQueue({ concurrency: 10, intervalCap: 3000, interval: 60_000 })

export async function transcribe(buf: Buffer) {
  return whisperQueue.add(() =>
    pRetry(() => openai.audio.transcriptions.create({ /* ... */ }), {
      retries: 3,
      minTimeout: 1000,
      factor: 2,
      onFailedAttempt: (err) => app.log.warn({ err: err.message, attempt: err.attemptNumber }, 'whisper retry'),
    }),
  )
}
```

### @fastify/multipart config

For Evolution webhooks that POST audio inline (or for any future media upload endpoint):

```typescript
await app.register(import('@fastify/multipart'), {
  limits: {
    fieldNameSize: 100,
    fieldSize: 1024 * 1024,        // 1 MB per non-file field
    fields: 20,
    fileSize: 26 * 1024 * 1024,    // 26 MB — Whisper's hard cap is 25 MB
    files: 4,
    headerPairs: 2000,
  },
  attachFieldsToBody: false,        // stream files; don't buffer into req.body
})
```

In practice Evolution sends media as **base64 strings inside JSON**, not multipart — so multipart is only needed if you add a manual upload endpoint. Default Fastify `bodyLimit` (1 MB) is too low for base64 audio; bump it at app construction:

```typescript
const app = Fastify({ bodyLimit: 30 * 1024 * 1024 }) // 30 MB JSON body for base64 media
```

### node-cron vs setInterval for the materializer tick

**Use `node-cron`** for the materializer for these reasons:

- Cron expressions are explicit (`*/5 * * * *` = every 5 min) — readable in code review and matches ops expectations.
- Survives clock drift better than `setInterval` (which can drift on event-loop pressure).
- Supports timezones natively: `cron.schedule('0 3 * * *', task, { timezone: 'America/Sao_Paulo' })` — important since Markdown files are date-partitioned per local day.
- `node-cron` 4.x has named tasks, `start()`/`stop()`/`destroy()`, and overlap protection (`noOverlap: true`).

Skeleton:

```typescript
import cron from 'node-cron'

const tick = cron.schedule(
  '*/5 * * * *',
  async () => {
    try {
      await materializeRecentMessages()
    } catch (err) {
      app.log.error({ err }, 'materializer tick failed')
    }
  },
  { timezone: 'America/Sao_Paulo', noOverlap: true },
)

app.addHook('onClose', async () => tick.stop())
```

Use `setInterval` only for sub-minute intervals (cron min granularity is 1s in v4 but 1m in many examples) or trivial in-process heartbeats.

## Alternatives Considered

| Recommended | Alternative | Why Not |
|---|---|---|
| Fastify 5 | Express 5 / Hono / Elysia | Constraint locks Fastify. Even without constraint: Express lacks schema validation; Hono is edge-first (suboptimal for long-running Whisper calls); Elysia is Bun-first |
| Drizzle ORM | Prisma / Kysely / raw pg | Constraint locks Drizzle. Prisma adds a ~70MB engine binary and slower cold start; Kysely lacks first-class pgvector typing; raw pg loses type safety (the original whatsapp-brain pain point) |
| pg (node-postgres) | postgres.js | postgres.js is faster but Drizzle's `node-postgres` adapter is more mature and pgvector serialization is better documented with `pg` |
| openai SDK v5 | Vercel `ai` SDK / langchain.js | Constraint locks openai SDK. Vercel `ai` adds abstraction tax for non-streaming back-end use; langchain.js is overkill for 3 endpoint calls and brings dep bloat |
| Zod 3.25 | Valibot / ArkType / Zod 4 | Constraint locks Zod v3. Valibot is smaller but lacks Fastify type-provider parity; Zod 4 has breaking schema API changes |
| Pino 9 | Winston / Bunyan / Console | Constraint locks Pino v9. Pino is 5–10x faster than Winston and is Fastify's native logger anyway |
| pgvector + PG | Qdrant / Pinecone / Weaviate | Constraint locks PG. Single-instance personal scale (~hundreds of thousands of messages max) fits comfortably in pgvector HNSW; no need for a separate vector DB and the operational cost it brings |
| p-queue + p-retry | Bull / BullMQ | BullMQ requires Redis. p-queue is in-process and sufficient since the only contended resource is the OpenAI API; if/when persistent retry/dead-letter is needed, revisit |
| node-cron | Agenda / BullMQ schedulers / `setInterval` | Agenda/BullMQ need MongoDB/Redis. `setInterval` drifts and lacks timezone handling |
| @fastify/multipart | busboy direct / formidable | Fastify multipart wraps busboy with Fastify's lifecycle hooks and is the idiomatic choice |
| tsx | ts-node / swc-node / bun --watch | ts-node is slower and has ESM friction; bun is excluded by Node 22 constraint; tsx is the simplest path |

## What NOT to Use

| Avoid | Why | Use Instead |
|---|---|---|
| `node-fetch` | Node 22 has global `fetch` (undici); extra dep is dead weight | global `fetch` |
| `axios` | Same reason — `fetch` covers all Evolution media-download needs | global `fetch` with `AbortController` |
| `ts-node` / `ts-node-dev` | Slow startup, ESM/CJS hassles | `tsx` |
| `body-parser` / `cookie-parser` (Express idioms) | Fastify has these built in or as `@fastify/*` plugins | `@fastify/cookie`, native JSON parsing |
| `nodemon` | Doesn't understand TS natively; needs ts-node | `tsx watch` |
| Raw `pg` queries in business logic | Loses type safety — the exact pain point of whatsapp-brain | Drizzle query builder; reach for `db.execute(sql\`...\`)` only for raw SQL escape hatches |
| Prisma | Constraint forbids; also: 70MB engine, slower migrations, less direct pgvector support | Drizzle ORM |
| LangChain / LlamaIndex | Heavy abstraction over 3 OpenAI calls; lock-in risk | Direct `openai` SDK calls wrapped in `p-queue` |
| `winston` / `bunyan` | Slower; Fastify already ships Pino | `pino` (Fastify built-in) |
| Storing embeddings as `jsonb` arrays | No index → O(n) scans; pgvector exists for a reason | `vector(1536)` column + HNSW index |
| `console.log` in production paths | Unstructured, blocks event loop on heavy output | `app.log.info({ ... }, 'msg')` |
| Synchronous `fs` calls in materializer | Blocks event loop while writing to OneDrive-synced folder | `fs/promises` + per-file writes (consider `proper-lockfile` if concurrent ticks possible) |
| `dotenv` in production | Env vars come from Docker Swarm / Portainer secrets | Use `dotenv` only in `NODE_ENV !== 'production'` |
| `node-cron` < 4.x | Older versions used `cron.schedule(...)` with no `destroy()`, leak risk | `node-cron@^4` |
| `zod@^4` for this project | Constraint pins v3; v4 has breaking schema API and v4-only ecosystem packages | `zod@^3.25` |
| `openai@^6` for this project | Constraint pins v5 | `openai@^5.20` (last 5.x line) |

---
*Stack research for: WhatsApp message pipeline*
*Researched: 2026-05-21*
