<!-- GSD:project-start source:PROJECT.md -->
## Project

**brainny**

brainny é um pipeline de ingestão e inteligência de mensagens do WhatsApp. Recebe webhooks da Evolution API (gateway WhatsApp), processa mensagens de qualquer tipo (texto, áudio via Whisper, imagens via GPT-4 Vision), armazena no PostgreSQL com embeddings pgvector, materializa arquivos Markdown diários no vault Obsidian e expõe um endpoint de busca semântica.

**Core Value:** Toda mensagem do WhatsApp deve ser capturada, enriquecida e pesquisável — independente do tipo de mídia.

### Constraints

- **Tech Stack**: Node.js 22, TypeScript, Fastify, Drizzle ORM, PostgreSQL + pgvector, OpenAI SDK, Zod, Pino — decisão final
- **Runtime**: Node.js 22 (não Bun) — compatibilidade com ambiente Docker existente
- **Banco**: Usar banco `whatsapp_brain` já existente no PostgreSQL compartilhado (stack ID 8 no Portainer)
- **Rede**: Container deve estar na overlay network `yowanet` para alcançar postgres e evolution por nome de serviço
- **Idioma**: PT-BR em prompts e mensagens de log voltados ao usuário
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

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
# Core runtime
# Dev / tooling
## Key Integration Notes
### Fastify 5 + TypeScript + Zod
- Register the Zod type provider **once** at the root app, then call `app.withTypeProvider<ZodTypeProvider>()` to get a typed instance. Use that instance for every route so `request.body` / `request.query` / `request.params` are inferred from the Zod schema.
- Fastify 5 requires plugins to be `async` or use the `done` callback consistently — mixing styles breaks lifecycle.
- Use `fastify.register()` for every plugin (multipart, cors, helmet, db connection). Plugin encapsulation is now stricter in v5.
- Built-in logger is Pino — set it via `Fastify({ logger: pinoInstance })`. Don't double-register `pino-http`.
### Drizzle + pgvector
- `drizzle-kit generate` writes SQL with `CREATE EXTENSION IF NOT EXISTS vector;` — confirm it's present in the generated migration; if not, prepend it manually to the first migration.
- HNSW index build is slow on large tables — create AFTER bulk backfill, not before.
- `cosineDistance(a, b)` compiles to `a <=> b` (pgvector operator). `1 - distance` = similarity in [0, 1] for normalized vectors (OpenAI embeddings are L2-normalized).
### OpenAI SDK v5
- v5 SDK uses Node's global `fetch` — works on Node 22 with no extra deps.
- Errors are typed: `import { APIError, RateLimitError } from 'openai'` — match on those in `p-retry` decisions.
- `detail: 'low'` for vision keeps cost predictable (~85 tokens/image vs hundreds for `high`).
### p-queue for OpenAI rate limiting
### @fastify/multipart config
### node-cron vs setInterval for the materializer tick
- Cron expressions are explicit (`*/5 * * * *` = every 5 min) — readable in code review and matches ops expectations.
- Survives clock drift better than `setInterval` (which can drift on event-loop pressure).
- Supports timezones natively: `cron.schedule('0 3 * * *', task, { timezone: 'America/Sao_Paulo' })` — important since Markdown files are date-partitioned per local day.
- `node-cron` 4.x has named tasks, `start()`/`stop()`/`destroy()`, and overlap protection (`noOverlap: true`).
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
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
