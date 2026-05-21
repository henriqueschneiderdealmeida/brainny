# Phase 2: Webhook Ingest — Research

**Researched:** 2026-05-21
**Domain:** Fastify 5 webhook route, timing-safe auth, p-queue async processing, Evolution API payload parsing, Drizzle ON CONFLICT deduplication, Pino structured error isolation
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INGEST-01 | System validates X-Webhook-Secret header using timing-safe comparison; returns 401 on mismatch | Covered by §Security Domain and §Architecture Patterns: `crypto.timingSafeEqual` preHandler hook pattern |
| INGEST-02 | System returns 200 {ok:true} immediately on valid webhook, processes message asynchronously | Covered by §Architecture Patterns: reply-then-enqueue pattern with `p-queue` |
| INGEST-03 | System handles all message types: text, audio, image, video, document, sticker, location, contact, reaction | Covered by §Architecture Patterns: Evolution API payload shape and message type discriminator |
| INGEST-04 | System deduplicates messages using ON CONFLICT DO NOTHING on message id | Covered by §Architecture Patterns: Drizzle `onConflictDoNothing()` on `messages.id` PK |
| INGEST-05 | System isolates per-message errors — one failure does not stop processing of other messages | Covered by §Architecture Patterns: p-queue job isolation with per-job try/catch |
| INGEST-06 | System logs structured errors (Pino) for every failed message with message id and error details | Covered by §Architecture Patterns: Pino child logger pattern for failed jobs |
</phase_requirements>

---

## Summary

Phase 2 installs the ingest entry point for every WhatsApp message brainny will ever store. The work divides cleanly into three layers: (1) the HTTP boundary — a Fastify route that validates `X-Webhook-Secret` via `crypto.timingSafeEqual`, responds `200 {ok:true}` in under 50ms, then hands off to the queue; (2) the queue layer — a `p-queue` instance (concurrency driven by `INGEST_CONCURRENCY` env var) that runs each message job in isolation so a single failure cannot block siblings; (3) the persistence layer — a thin `services/persist.ts` that maps Evolution payload fields to the Drizzle `messages` schema and uses `onConflictDoNothing()` for idempotent upserts.

The most critical implementation detail is the timing-safe comparison. Node's `crypto.timingSafeEqual` requires both buffers to have **identical byte lengths** before calling the function; a length mismatch throws a `RangeError` at runtime. The safe pattern is: return 401 immediately when `provided.length !== expected.length`, then call `timingSafeEqual` only when lengths match. This avoids the `RangeError` while still not leaking timing on length.

Evolution API does not include a built-in `X-Webhook-Secret` header when sending webhooks — it has no native secret-signing mechanism in its outgoing webhook requests. The `X-Webhook-Secret` header that INGEST-01 requires must be added via Evolution's per-instance webhook header configuration (if available in the deployed version) or via a proxy/middleware layer. The brainny app validates whatever value appears in the header against `process.env.WEBHOOK_SECRET`. This is a project-level design decision already encoded in the REQUIREMENTS.md and env schema.

The second most critical detail is that `p-queue@9.3.x` is a pure ESM package. With `"type": "module"` already set in `package.json`, the import is `import PQueue from 'p-queue'` (default import, no named exports for the class). The `onIdle()` method is how Phase 6 graceful shutdown drains the queue before exiting.

**Primary recommendation:** Wire the webhook as a Fastify `preHandler` for auth, return immediately, enqueue via `fastify.queue.add(async () => { ... })`, and isolate each job in its own try/catch that logs to a Pino child logger. Never `await` the queue.add() from the route handler.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Webhook HTTP endpoint | API / Backend | — | Fastify route, validated by Zod body schema + preHandler auth |
| Timing-safe secret validation | API / Backend | — | `crypto.timingSafeEqual` in a `preHandler` hook on the route |
| Fast ack (200 before processing) | API / Backend | — | Route returns immediately; work is handed to the queue |
| Async job queue | API / Backend | — | `p-queue` instance decorated on Fastify; in-process |
| Message type parsing | API / Backend | — | `services/ingest.ts` discriminator on `messageType` field |
| Deduplication | Database / Storage | API / Backend | `ON CONFLICT DO NOTHING` at DB insert; no application-level lock needed |
| Structured error logging | API / Backend | — | Pino child logger per job; errors do not propagate to sibling jobs |
| Chat metadata upsert | Database / Storage | — | Phase 4 concern; Phase 2 persists raw message rows only |

---

## Project Constraints (from CLAUDE.md)

All directives are locked — the planner MUST NOT deviate:

- **Runtime:** Node.js 22 — `crypto.timingSafeEqual` is available natively (no package needed)
- **HTTP framework:** Fastify 5.8.x — `preHandler` hook is the correct lifecycle point for auth
- **Validation:** Zod 3.25.x — webhook body validated via `FastifyPluginAsyncZod` route schema
- **Logging:** Pino 9.14.x — `fastify.log.error({ messageId, errorCode, phase }, 'msg')` only; `console.*` FORBIDDEN
- **Queue:** p-queue 9.3.x — pure ESM, `import PQueue from 'p-queue'`; already listed in CLAUDE.md stack
- **Retry:** p-retry 6.x — CLAUDE.md pins `p-retry@^6` (latest is 8.0.0; pin explicitly to `p-retry@^6.2`)
- **ESM:** `"type": "module"` in package.json — all imports use `.js` extensions
- **No console.log:** ESLint `no-console: error` will fail the CI gate
- **PT-BR:** User-facing log messages in PT-BR
- **WEBHOOK_SECRET:** Already in `config.ts` env schema — no schema changes needed
- **INGEST_CONCURRENCY:** Already in `config.ts` env schema (default 3) — used as `p-queue` concurrency

---

## Standard Stack

### New Packages for Phase 2

| Library | Version | Purpose | Provenance |
|---------|---------|---------|------------|
| p-queue | 9.3.0 | In-process async job queue with concurrency control | [VERIFIED: npm registry] |
| p-retry | 6.2.1 (pin `^6.2`) | Exponential backoff for failed jobs | [VERIFIED: npm registry] |

> **p-retry version note:** npm `latest` is 8.0.0. CLAUDE.md pins `p-retry@^6`. Last 6.x release is `6.2.1`. Use `p-retry@^6.2` explicitly — do NOT use `@latest`.

> **`crypto` note:** `timingSafeEqual` is part of Node.js built-in `node:crypto` module. No npm package needed. `@types/node@^22` already covers the types. [VERIFIED: Node.js 22 docs]

### Already Available (from Phase 1)

| Library | Purpose | Status |
|---------|---------|--------|
| fastify@^5.8 | HTTP server + route registration | Installed |
| fastify-plugin | fp() for plugin encapsulation | Installed |
| fastify-type-provider-zod@^4.0.2 | Zod-typed routes | Installed (note: package.json shows 4.0.2, not 6.1.x) |
| drizzle-orm@^0.45.2 | `onConflictDoNothing()` for deduplication | Installed |
| zod@^3.25 | Webhook body schema validation | Installed |
| pino@^9.14 | Structured logging | Installed |

> **fastify-type-provider-zod version alert:** `package.json` currently has `fastify-type-provider-zod@^4.0.2`, but Phase 1 research recommended `^6.1`. The installed version should be confirmed before Phase 2 starts. The `FastifyPluginAsyncZod` type export was introduced in later versions — verify it exists in the installed version. [ASSUMED — not re-verified in this session]

### Installation Commands for Phase 2

```bash
npm install p-queue@^9.3 p-retry@^6.2
```

No additional Fastify plugins needed for Phase 2. Evolution API sends JSON bodies (not multipart), so `@fastify/multipart` is not needed here.

---

## Package Legitimacy Audit

> slopcheck run: `python -m slopcheck install p-queue p-retry` — both packages returned `[OK]`.

| Package | Registry | Source Repo | slopcheck | Disposition |
|---------|----------|-------------|-----------|-------------|
| p-queue | npm | github.com/sindresorhus/p-queue | [OK] | Approved |
| p-retry | npm | github.com/sindresorhus/p-retry | [OK] | Approved |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged [SUS]:** none

Both packages are from Sindre Sorhus — prolific maintainer of hundreds of well-established Node.js utilities. Established packages with years of npm history.

---

## Architecture Patterns

### System Architecture Diagram

```
POST /webhook/evolution
         │
         ├─ [preHandler] validateWebhookSecret()
         │       ├─ header missing → 401 immediately
         │       ├─ Buffer.byteLength mismatch → 401 immediately
         │       └─ crypto.timingSafeEqual fails → 401 immediately
         │
         ├─ [handler] parse body (already validated by Zod schema)
         │       └─ return reply.send({ ok: true })    ← 200 in < 50ms
         │
         └─ [fire-and-forget] fastify.queue.add(async () => {
                   try {
                     messages = extractMessages(body)
                     for (msg of messages) {
                       normalized = normalizeMessage(msg)
                       await persistMessage(fastify.db, normalized)  // ON CONFLICT DO NOTHING
                     }
                   } catch (err) {
                     fastify.log.error({ messageId, errorCode, phase: 'ingest' }, 'Falha ao processar mensagem')
                     // does NOT rethrow — sibling jobs continue
                   }
                 })

services/ingest.ts (message type discriminator)
         │
         ├─ body.event !== 'MESSAGES_UPSERT' → skip (log info, return)
         ├─ body.data.key.fromMe === true → skip (log debug, return)
         │
         └─ body.data.messageType switch:
               'conversation'          → { type: 'text', text: msg.conversation }
               'extendedTextMessage'   → { type: 'text', text: msg.extendedTextMessage.text }
               'audioMessage'          → { type: 'audio', mediaUrl: msg.audioMessage.url }
               'imageMessage'          → { type: 'image', mediaUrl: msg.imageMessage.url }
               'videoMessage'          → { type: 'video', mediaUrl: msg.videoMessage.url }
               'documentMessage'       → { type: 'document', mediaUrl: msg.documentMessage.url }
               'stickerMessage'        → { type: 'sticker', mediaUrl: msg.stickerMessage.url }
               'locationMessage'       → { type: 'location', text: formatLocation(msg.locationMessage) }
               'contactMessage'        → { type: 'contact', text: formatContact(msg.contactsArrayMessage) }
               'reactionMessage'       → { type: 'reaction', text: msg.reactionMessage.text }
               default                 → log info 'tipo de mensagem não suportado', skip row

services/persist.ts (Drizzle insert)
         │
         └─ db.insert(messages).values(row).onConflictDoNothing()
                   └─ returns [] on duplicate → no-op, no error thrown
```

### Recommended Project Structure (Phase 2 additions)

```
src/
├── plugins/
│   ├── config.ts        # existing — fastify.config
│   ├── db.ts            # existing — fastify.db, fastify.pgPool
│   └── queue.ts         # NEW — fastify.queue (PQueue instance)
├── routes/
│   ├── health.ts        # existing
│   └── webhook.ts       # NEW — POST /webhook/evolution
├── services/
│   ├── ingest.ts        # NEW — payload parsing + message type normalization
│   └── persist.ts       # NEW — Drizzle insert with onConflictDoNothing
├── lib/
│   ├── logger.ts        # existing
│   └── auth.ts          # NEW — validateWebhookSecret() preHandler factory
├── db/
│   └── schema.ts        # existing — messages table (id is PK, used for dedup)
└── index.ts             # existing — register queue plugin + webhook routes
```

### Pattern 1: queue plugin (fastify.queue decorator)

**What:** Creates a single `PQueue` instance shared across all routes, decorated on Fastify with `fp()`.

**When to use:** Register in `index.ts` after `dbPlugin`. All routes access `fastify.queue`.

```typescript
// src/plugins/queue.ts
// Source: github.com/sindresorhus/p-queue [CITED]
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import PQueue from 'p-queue';

declare module 'fastify' {
  interface FastifyInstance {
    queue: PQueue;
  }
}

const queuePlugin: FastifyPluginAsync = async (fastify) => {
  const queue = new PQueue({
    concurrency: fastify.config.INGEST_CONCURRENCY,  // default 3 from env
  });

  // Emit queue errors via Pino — never swallow silently
  queue.on('error', (err: unknown) => {
    fastify.log.error({ err }, 'Erro inesperado na fila de ingestão');
  });

  fastify.decorate('queue', queue);
};

export default fp(queuePlugin, { name: 'queue', dependencies: ['config'] });
```

### Pattern 2: timing-safe webhook auth preHandler

**What:** Validates `X-Webhook-Secret` header using `crypto.timingSafeEqual`. Returns 401 with no body on mismatch.

**Critical details:**
- `timingSafeEqual` throws `RangeError` if buffers differ in byte length. Guard with length check first.
- The length check itself leaks timing info about length — this is acceptable; a fixed-length secret (enforced by `z.string().min(16)` in env schema) already fixes the useful attack surface.
- Use `Buffer.from(value, 'utf8')` not `Buffer.from(value)` — explicit encoding.

```typescript
// src/lib/auth.ts
// Source: Node.js 22 crypto docs + PITFALLS.md REG-9 [CITED]
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export function makeWebhookAuthHandler(secret: string) {
  const expectedBuf = Buffer.from(secret, 'utf8');

  return async function validateWebhookSecret(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const provided = request.headers['x-webhook-secret'];

    if (typeof provided !== 'string') {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const providedBuf = Buffer.from(provided, 'utf8');

    // Guard length mismatch BEFORE timingSafeEqual (avoids RangeError)
    if (providedBuf.byteLength !== expectedBuf.byteLength) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    if (!timingSafeEqual(providedBuf, expectedBuf)) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
  };
}
```

### Pattern 3: webhook route — reply fast, enqueue async

**What:** Route returns 200 immediately. Work is added to `fastify.queue` with `void fastify.queue.add(...)`. The queue job has its own try/catch so errors are isolated.

**Critical:** Do NOT `await fastify.queue.add(...)` in the route handler — that defeats the purpose of async processing. Use `void` to explicitly fire-and-forget.

```typescript
// src/routes/webhook.ts
// Source: REQUIREMENTS.md INGEST-02 + p-queue docs [CITED]
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { makeWebhookAuthHandler } from '../lib/auth.js';
import { extractMessages } from '../services/ingest.js';
import { persistMessage } from '../services/persist.js';

// Loose body schema — rawJson captures everything; messageType discriminates
const webhookBodySchema = z.object({
  event: z.string(),
  instance: z.string(),
  data: z.unknown(),  // typed loosely; ingest.ts does the detailed parsing
}).passthrough();

const webhookRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const authHandler = makeWebhookAuthHandler(fastify.config.WEBHOOK_SECRET);

  fastify.post(
    '/webhook/evolution',
    {
      schema: {
        body: webhookBodySchema,
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
      preHandler: [authHandler],
      // bodyLimit override: EVO-2 — Evolution may send base64-encoded media inline
      bodyLimit: 25 * 1024 * 1024,  // 25 MB
    },
    async (request, reply) => {
      // Respond immediately — INGEST-02
      await reply.send({ ok: true });

      const body = request.body;
      const log = fastify.log.child({ module: 'webhook', event: body.event });

      // Fire-and-forget: never await this
      void fastify.queue.add(async () => {
        const messages = extractMessages(body, log);

        for (const msg of messages) {
          // Each message gets its own try/catch — INGEST-05
          try {
            await persistMessage(fastify.db, msg);
          } catch (err: unknown) {
            // INGEST-06: structured error log with messageId, errorCode, phase
            log.error(
              {
                messageId: msg.id,
                errorCode: (err instanceof Error ? err.constructor.name : 'UnknownError'),
                phase: 'persist',
                err,
              },
              'Falha ao persistir mensagem',
            );
            // Do NOT rethrow — continue processing siblings
          }
        }
      });
    },
  );
};

export default webhookRoutes;
```

### Pattern 4: ingest service — Evolution payload shape and type discriminator

**What:** `extractMessages` accepts the raw webhook body, filters non-message events and outbound messages, then maps each message type to a normalized internal shape.

**Evolution API MESSAGES_UPSERT payload shape** [MEDIUM confidence — verified from SDK types and community examples]:

```typescript
// Evolution API v2 MESSAGES_UPSERT webhook body shape
// Source: gusnips/evolution-api-sdk TypeScript types + community examples [CITED]
interface EvolutionWebhookBody {
  event: 'MESSAGES_UPSERT' | string;   // can be other events too
  instance: string;                      // instance name
  data: {
    key: {
      remoteJid: string;   // "5511999999999@s.whatsapp.net" or "group@g.us"
      fromMe: boolean;     // true = sent by us; skip unless archiving sent msgs
      id: string;          // unique message ID — used as messages.id PK
    };
    pushName: string;            // sender's display name
    status: string;              // e.g. "DELIVERY_ACK"
    messageType: string;         // discriminator field
    messageTimestamp: number;    // Unix epoch seconds
    instanceId: string;
    source: string;              // "android" | "web" | "ios"
    message: {
      // Exactly one of these will be present (matches messageType):
      conversation?: string;                         // plain text
      extendedTextMessage?: { text: string; };       // long/formatted text
      audioMessage?: { url: string; mimetype: string; seconds: number; };
      imageMessage?: { url: string; mimetype: string; caption?: string; };
      videoMessage?: { url: string; mimetype: string; caption?: string; };
      documentMessage?: { url: string; mimetype: string; fileName?: string; };
      stickerMessage?: { url: string; mimetype: string; };
      locationMessage?: { degreesLatitude: number; degreesLongitude: number; name?: string; };
      contactsArrayMessage?: { contacts: Array<{ fullName: string; phones: string[]; }>; };
      reactionMessage?: { key: { id: string; }; text: string; };
    };
  };
}
```

```typescript
// src/services/ingest.ts
// Source: REQUIREMENTS.md INGEST-03 + PITFALLS.md EVO-1, EVO-4 [CITED]
import type { Logger } from 'pino';
import type { NewMessage } from '../db/schema.js';

export interface NormalizedMessage extends NewMessage {}

export function extractMessages(
  body: unknown,
  log: Logger,
): NormalizedMessage[] {
  const b = body as { event?: string; data?: Record<string, unknown> };

  // Only process MESSAGES_UPSERT events
  if (b.event !== 'MESSAGES_UPSERT') {
    log.debug({ event: b.event }, 'Evento não é MESSAGES_UPSERT, ignorado');
    return [];
  }

  const data = b.data as {
    key: { remoteJid: string; fromMe: boolean; id: string };
    pushName: string;
    messageType: string;
    messageTimestamp: number;
    message: Record<string, unknown>;
  };

  // Skip outbound messages (fromMe) — only ingest received messages
  if (data.key.fromMe) {
    log.debug({ messageId: data.key.id }, 'Mensagem própria ignorada');
    return [];
  }

  const normalized = normalizeMessage(data);
  if (!normalized) {
    log.info(
      { messageId: data.key.id, messageType: data.messageType },
      'Tipo de mensagem não suportado, ignorado',
    );
    return [];
  }

  return [normalized];
}

function normalizeMessage(data: {
  key: { remoteJid: string; fromMe: boolean; id: string };
  pushName: string;
  messageType: string;
  messageTimestamp: number;
  message: Record<string, unknown>;
}): NormalizedMessage | null {
  const base = {
    id: data.key.id,
    chatId: data.key.remoteJid,
    sender: data.key.remoteJid,
    senderName: data.pushName ?? null,
    timestamp: new Date(data.messageTimestamp * 1000),
    rawJson: data as unknown as Record<string, unknown>,
  };

  const msg = data.message;
  const mt = data.messageType;

  if (mt === 'conversation' && typeof msg['conversation'] === 'string') {
    return { ...base, type: 'text', text: msg['conversation'], mediaUrl: null, embedding: null };
  }
  if (mt === 'extendedTextMessage' && msg['extendedTextMessage']) {
    const ext = msg['extendedTextMessage'] as { text?: string };
    return { ...base, type: 'text', text: ext.text ?? null, mediaUrl: null, embedding: null };
  }
  if (mt === 'audioMessage' && msg['audioMessage']) {
    const audio = msg['audioMessage'] as { url?: string };
    return { ...base, type: 'audio', text: null, mediaUrl: audio.url ?? null, embedding: null };
  }
  if (mt === 'imageMessage' && msg['imageMessage']) {
    const img = msg['imageMessage'] as { url?: string; caption?: string };
    return { ...base, type: 'image', text: img.caption ?? null, mediaUrl: img.url ?? null, embedding: null };
  }
  if (mt === 'videoMessage' && msg['videoMessage']) {
    const vid = msg['videoMessage'] as { url?: string; caption?: string };
    return { ...base, type: 'video', text: vid.caption ?? null, mediaUrl: vid.url ?? null, embedding: null };
  }
  if (mt === 'documentMessage' && msg['documentMessage']) {
    const doc = msg['documentMessage'] as { url?: string; fileName?: string };
    return { ...base, type: 'document', text: doc.fileName ?? null, mediaUrl: doc.url ?? null, embedding: null };
  }
  if (mt === 'stickerMessage' && msg['stickerMessage']) {
    const sticker = msg['stickerMessage'] as { url?: string };
    return { ...base, type: 'sticker', text: null, mediaUrl: sticker.url ?? null, embedding: null };
  }
  if (mt === 'locationMessage' && msg['locationMessage']) {
    const loc = msg['locationMessage'] as { degreesLatitude?: number; degreesLongitude?: number; name?: string };
    const text = loc.name
      ? `${loc.name} (${loc.degreesLatitude ?? 0}, ${loc.degreesLongitude ?? 0})`
      : `${loc.degreesLatitude ?? 0}, ${loc.degreesLongitude ?? 0}`;
    return { ...base, type: 'location', text, mediaUrl: null, embedding: null };
  }
  if (mt === 'contactsArrayMessage' && msg['contactsArrayMessage']) {
    const c = msg['contactsArrayMessage'] as { contacts?: Array<{ fullName?: string }> };
    const text = (c.contacts ?? []).map((ct) => ct.fullName ?? '').join(', ');
    return { ...base, type: 'contact', text, mediaUrl: null, embedding: null };
  }
  if (mt === 'reactionMessage' && msg['reactionMessage']) {
    const reaction = msg['reactionMessage'] as { text?: string };
    return { ...base, type: 'reaction', text: reaction.text ?? null, mediaUrl: null, embedding: null };
  }

  return null; // unsupported type
}
```

### Pattern 5: persist service — Drizzle ON CONFLICT DO NOTHING

**What:** Insert a single `NormalizedMessage` row. If `messages.id` already exists (duplicate webhook delivery), `onConflictDoNothing()` silently no-ops. [VERIFIED: orm.drizzle.team]

```typescript
// src/services/persist.ts
// Source: orm.drizzle.team/docs/insert [CITED]
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { messages } from '../db/schema.js';
import type { NormalizedMessage } from './ingest.js';

export async function persistMessage(
  db: NodePgDatabase<typeof schema>,
  msg: NormalizedMessage,
): Promise<void> {
  // ON CONFLICT DO NOTHING on messages.id (PK) — INGEST-04 deduplication
  await db
    .insert(messages)
    .values(msg)
    .onConflictDoNothing();
  // Returns [] on duplicate — no error thrown, no logging needed here
}
```

### Pattern 6: index.ts additions — register queue plugin and webhook routes

**What:** Add `queuePlugin` and `webhookRoutes` to the existing `main()` in `src/index.ts`.

```typescript
// src/index.ts additions (merge with existing)
import queuePlugin from './plugins/queue.js';
import webhookRoutes from './routes/webhook.js';

// In main(), after dbPlugin:
await app.register(queuePlugin);

// After existing healthRoutes:
await api.register(webhookRoutes);
```

### Anti-Patterns to Avoid

- **`await fastify.queue.add(...)` in route handler:** Defeats async processing — the route blocks until the job completes. Use `void fastify.queue.add(...)`.
- **`===` for secret comparison:** Leaks timing info. Always `crypto.timingSafeEqual`. (REG-9)
- **`timingSafeEqual` without length check:** Throws `RangeError` if buffers differ in byte length. Always check lengths first. (REG-9)
- **Missing `preHandler` on the route:** Registering auth as a global hook and then conditionally skipping is fragile. Attach `preHandler: [authHandler]` directly to the route.
- **Throwing inside `queue.add()` job body:** An unhandled throw will cause the PQueue `'error'` event but will not stop other queued jobs. However, it is better to catch explicitly per message so the error log includes `messageId`.
- **Parsing `messageType` without an allow-list:** "Protocol messages", polls, and ephemeral messages all appear on `MESSAGES_UPSERT`. Return `null` for any unrecognized type, log it, and continue. (EVO-4)
- **Trusting Evolution URL fields without null-check:** `audioMessage.url` can be undefined if Evolution is configured to strip URLs. Always optional-chain or guard. (ASSUMED)
- **Letting `fromMe: true` messages through:** Unless explicitly archiving sent messages, skip them at extraction time. Otherwise the chat search will be polluted with outbound messages. (EVO-4)
- **Global body limit of 25MB:** Evolution can send base64-encoded media inline (EVO-2). Set the 25MB limit at route level only (`bodyLimit` on the route options), not globally — other routes can keep the 10MB Fastify default.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Concurrency control | Custom semaphore with a counter | `p-queue` with `concurrency` option | p-queue handles backpressure, ordering, `onIdle()` for graceful drain, and error events correctly |
| Exponential backoff | Manual `setTimeout` with jitter | `p-retry@^6.2` | Handles jitter, `retries`, `minTimeout`, `maxTimeout`, `onFailedAttempt` — correct by default |
| Timing-safe string comparison | `secret === provided` | `crypto.timingSafeEqual` | `===` on strings leaks timing; built-in crypto handles it with no deps |
| Message type dispatch | Long `if/else if` chain without guard | Switch-style with explicit allow-list + null return for unknown | An explicit allow-list prevents "protocol" and "poll" messages from silently corrupting the schema |
| Webhook deduplication | In-memory `Set<string>` of seen IDs | `INSERT ... ON CONFLICT DO NOTHING` on `messages.id` (PK) | In-memory set is lost on restart; DB constraint survives restarts and is the source of truth |

**Key insight:** In-process queuing with `p-queue` is sufficient for this scale. Do not add Redis/BullMQ — they require an extra dependency and the queue is not required to persist across restarts for Phase 2.

---

## Common Pitfalls

### Pitfall 1: `crypto.timingSafeEqual` RangeError on length mismatch (REG-9)

**What goes wrong:** `timingSafeEqual(Buffer.from('abc'), Buffer.from('abcd'))` throws `RangeError: Input buffers must have the same byte length`. The route crashes with a 500.

**Why it happens:** `timingSafeEqual` has no tolerance for different-length inputs. The documentation requires buffers to be the same length.

**How to avoid:**
```typescript
if (providedBuf.byteLength !== expectedBuf.byteLength) {
  return reply.code(401).send({ error: 'Unauthorized' });
}
// Only call timingSafeEqual after length check passes
```

**Warning signs:** `RangeError: Input buffers must have the same byte length` in production logs.

---

### Pitfall 2: `await fastify.queue.add()` blocks the response

**What goes wrong:** The route handler awaits the queue job. The 200 response is not sent until all message processing (including future Whisper calls in Phase 3) completes. Evolution's webhook timeout triggers a retry, causing duplicate delivery.

**Why it happens:** `queue.add()` returns a Promise that resolves when the job finishes.

**How to avoid:** Use `void fastify.queue.add(...)` to fire-and-forget. Send the reply before enqueuing:
```typescript
await reply.send({ ok: true });  // first
void fastify.queue.add(async () => { ... });  // after
```

**Warning signs:** Response times > 5s in webhook metrics; duplicate rows in `messages` table.

---

### Pitfall 3: Evolution sends multiple message objects in one webhook (EVO-1)

**What goes wrong:** Some Evolution versions batch multiple messages into a single `MESSAGES_UPSERT` event. Processing only `body.data` as a single object misses the others.

**Why it happens:** Evolution API design — bulk delivery for efficiency.

**How to avoid:** Check if `data` is an array or object. The body schema should handle both:
```typescript
// body.data may be an array of messages in some Evolution versions [ASSUMED]
const dataItems = Array.isArray(body.data) ? body.data : [body.data];
```
Flag this as [ASSUMED] — exact batching behavior depends on Evolution version deployed.

**Warning signs:** Message count in DB significantly lower than Evolution's sent-message count.

---

### Pitfall 4: `fromMe: true` messages stored as received messages (EVO-4)

**What goes wrong:** Evolution fires `MESSAGES_UPSERT` for both received AND sent messages. Without filtering `fromMe: true`, outbound messages pollute the corpus.

**How to avoid:** Filter in `extractMessages`:
```typescript
if (data.key.fromMe) {
  log.debug({ messageId: data.key.id }, 'Mensagem própria ignorada');
  return [];
}
```

---

### Pitfall 5: p-queue not registered before webhook route

**What goes wrong:** `fastify.queue` is undefined when the webhook route handler executes. Calling `fastify.queue.add()` throws `TypeError: Cannot read properties of undefined (reading 'add')`.

**Why it happens:** Plugin registration order in Fastify 5 is sequential. `queuePlugin` must be registered before the webhook route plugin.

**How to avoid:** Register in order: `configPlugin` → `dbPlugin` → `queuePlugin` → routes. Use `dependencies: ['config']` in `queuePlugin`'s `fp()` call to enforce the dependency.

---

### Pitfall 6: Zod `passthrough()` vs strict body validation

**What goes wrong:** Defining a strict Zod body schema for the Evolution webhook body (all optional fields enumerated) causes valid payloads to fail validation when Evolution adds new fields in a future version. The webhook returns 400 and Evolution retries forever.

**How to avoid:** Use a loose top-level schema with `z.unknown()` for the `data` field and `passthrough()` on the wrapper. Parse the inner structure in `ingest.ts` with defensive casts, not Zod schemas. The `rawJson` column stores the full payload for future re-parsing.

---

### Pitfall 7: Body limit for media-inline payloads (EVO-2)

**What goes wrong:** Evolution configured with `webhookBase64: true` will include full media as base64 in the webhook body. A 10MB audio becomes ~14MB of JSON. Fastify's default `bodyLimit: 10485760` (10MB) rejects it with a 413.

**How to avoid:** Set `bodyLimit: 25 * 1024 * 1024` as a **route-level override** on the `POST /webhook/evolution` route. Do not raise the global body limit — other routes (health, future search) don't need it.

---

## Evolution API Webhook Specifics

### Authentication model [MEDIUM confidence]

Evolution API does NOT sign outgoing webhook requests with a built-in secret. The `X-Webhook-Secret` header validated by INGEST-01 is a **project-level convention** — the header value must be configured as a custom header in Evolution's webhook setup (if the deployed version supports custom headers) or via a reverse proxy that injects it.

Current Evolution API (v2.x): custom header support was requested (issue #1933) and closed as "not planned." This means the `X-Webhook-Secret` header must be injected by a reverse proxy (e.g., nginx `proxy_set_header`) sitting between Evolution and brainny, OR the WEBHOOK_SECRET validation logic must accept the Evolution API's authentication mechanism (sending the `apikey` header value in `X-Webhook-Secret`). [ASSUMED — needs confirmation from the actual Evolution instance configuration before Phase 2 executes]

**Practical recommendation for Phase 2:** Implement the `X-Webhook-Secret` preHandler exactly as INGEST-01 specifies. Document in `.env.example` that the Evolution instance must be configured to send this header (or a proxy must inject it). The code is correct per the requirement — the ops configuration is a deployment concern.

### MESSAGES_UPSERT payload structure [MEDIUM confidence]

Verified from multiple sources (SDK types, community code examples, GitHub issues):

```
Top level:
  event:     "MESSAGES_UPSERT"
  instance:  <instance-name-string>
  data:      <object or array — version-dependent>

data fields:
  key.remoteJid:     "55119999999@s.whatsapp.net" (DM) or "123456789@g.us" (group)
  key.fromMe:        boolean
  key.id:            string (unique message ID — maps to messages.id)
  pushName:          string (sender display name — maps to senderName)
  messageType:       string discriminator
  messageTimestamp:  number (Unix epoch seconds)
  message:           object (one sub-key matches messageType)
```

Known `messageType` values (allow-list for INGEST-03):
- `conversation` — plain text, content in `message.conversation`
- `extendedTextMessage` — formatted/long text, content in `message.extendedTextMessage.text`
- `audioMessage` — voice note/audio, URL in `message.audioMessage.url`
- `imageMessage` — image, URL in `message.imageMessage.url`, caption optional
- `videoMessage` — video, URL in `message.videoMessage.url`
- `documentMessage` — file, URL in `message.documentMessage.url`
- `stickerMessage` — sticker, URL in `message.stickerMessage.url`
- `locationMessage` — lat/lng in `message.locationMessage.degreesLatitude/degreesLongitude`
- `contactsArrayMessage` — contacts array in `message.contactsArrayMessage.contacts[]`
- `reactionMessage` — emoji reaction in `message.reactionMessage.text`

Types to drop (log info, no row inserted): `protocolMessage`, `pollCreationMessage`, `pollUpdateMessage`, `senderKeyDistributionMessage`, `messageContextInfo`, and any other unrecognized `messageType`.

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Simple token `===` comparison | `crypto.timingSafeEqual` | Eliminates timing attack surface (REG-9) |
| `try/catch` wrapping the entire batch | Per-message try/catch inside queue job | One failure doesn't drop entire batch (INGEST-05) |
| Synchronous dedup in memory | `INSERT ... ON CONFLICT DO NOTHING` at DB | Survives restarts, no memory overhead |
| Global body limit | Route-level `bodyLimit` override | Other routes unaffected; webhook handles large media payloads |
| In-process set for dedup | DB primary key constraint | Source of truth; concurrent replays handled correctly |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Evolution API v2 sends `data` as a single object (not array) per webhook call | Architecture Patterns, Pitfall 3 | If Evolution batches, the `extractMessages` function misses all but the first message. The Pattern 3 code shows the array-guard — keep it |
| A2 | `message.audioMessage.url` etc. are direct media URLs accessible without auth headers | Architecture Patterns (ingest.ts) | Media download in Phase 3 would fail silently (OAI-3 in PITFALLS.md covers this — always download server-side first) |
| A3 | Evolution sends the `apikey` header (or no secret) on outgoing webhooks; `X-Webhook-Secret` must be injected by proxy or Evolution custom header config | Security Domain, Evolution API Webhook Specifics | brainny endpoint would reject all real Evolution webhooks with 401 until the header is configured. Needs ops verification before go-live |
| A4 | `fastify-type-provider-zod@^4.0.2` (currently installed) exports `FastifyPluginAsyncZod` and supports the route-level `schema` pattern | Standard Stack | Compile error at route definition; upgrade to `^6.1` may be needed before Phase 2 executes |
| A5 | `body.data.messageTimestamp` is a Unix epoch in seconds (not milliseconds) | Architecture Patterns (ingest.ts) | Timestamps off by 1000x. Detection: a stored message timestamp in year ~55000 AD is a clear sign |

---

## Open Questions

1. **Evolution custom header support on the deployed instance**
   - What we know: Evolution v2 closed the custom headers feature request as "not planned" at v2.3.7
   - What's unclear: Which Evolution version is running in Portainer (stack ID 8); whether that version supports per-instance custom headers in the webhook config UI
   - Recommendation: Before Phase 2 executes, check the Evolution Manager UI for the deployed instance. If no custom header option exists, add an nginx proxy rule that injects `X-Webhook-Secret: <value>`. Document in the deployment runbook.

2. **fastify-type-provider-zod version discrepancy**
   - What we know: `package.json` has `^4.0.2` but Phase 1 research recommended `^6.1`. The `FastifyPluginAsyncZod` type and the `serializerCompiler` are critical for Phase 2 route typing.
   - What's unclear: Whether `4.0.2` exports `FastifyPluginAsyncZod` and behaves correctly with Fastify 5.8.x
   - Recommendation: Upgrade to `fastify-type-provider-zod@^6.1` as Phase 2 Wave 0 task, before writing any routes. The existing tests use the 4.x API — check for breaking changes.

3. **Whether `body.data` can be an array**
   - What we know: Most documented examples show a single object; some community reports suggest batching
   - What's unclear: The deployed Evolution version's batching behavior
   - Recommendation: Implement the array-guard defensively (as shown in Pitfall 3 pattern). Zero cost if it never batches; prevents silent drops if it does.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node:crypto | timingSafeEqual | ✓ | Built into Node 22 | — |
| p-queue | Job queue | Not yet installed | — | — |
| p-retry | Retry logic | Not yet installed | — | — |
| fastify.db | Drizzle insert | ✓ (Phase 1) | 0.45.x | — |
| messages table | Persistence | ✓ (Phase 1 migration) | — | — |

**Missing dependencies needing installation:**
- `p-queue@^9.3` and `p-retry@^6.2` must be installed as Phase 2 Wave 0 task.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 2.x |
| Config file | `vitest.config.ts` (from Phase 1) |
| Quick run command | `npx vitest run src/lib/auth.test.ts src/services/ingest.test.ts src/services/persist.test.ts src/routes/webhook.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INGEST-01 | Missing `X-Webhook-Secret` header → 401 | unit | `npx vitest run src/lib/auth.test.ts` | ❌ Wave 0 |
| INGEST-01 | Wrong `X-Webhook-Secret` value → 401 | unit | `npx vitest run src/lib/auth.test.ts` | ❌ Wave 0 |
| INGEST-01 | Wrong secret differing only in last char → 401 (timing safe) | unit | `npx vitest run src/lib/auth.test.ts` | ❌ Wave 0 |
| INGEST-01 | Correct `X-Webhook-Secret` → passes preHandler | unit | `npx vitest run src/lib/auth.test.ts` | ❌ Wave 0 |
| INGEST-01 | Different-length secret → 401, no RangeError | unit | `npx vitest run src/lib/auth.test.ts` | ❌ Wave 0 |
| INGEST-02 | POST with valid secret → 200 `{ok:true}` immediately | integration | `npx vitest run src/routes/webhook.test.ts` | ❌ Wave 0 |
| INGEST-03 | Fixture: text message → row with type='text' | unit | `npx vitest run src/services/ingest.test.ts` | ❌ Wave 0 |
| INGEST-03 | Fixture: audio message → row with type='audio' | unit | `npx vitest run src/services/ingest.test.ts` | ❌ Wave 0 |
| INGEST-03 | Fixture: image message → row with type='image' | unit | `npx vitest run src/services/ingest.test.ts` | ❌ Wave 0 |
| INGEST-03 | Fixture: video, document, sticker, location, contact, reaction | unit | `npx vitest run src/services/ingest.test.ts` | ❌ Wave 0 |
| INGEST-03 | Unknown messageType → returns [] (no row, logs info) | unit | `npx vitest run src/services/ingest.test.ts` | ❌ Wave 0 |
| INGEST-04 | Replaying same payload twice → exactly one DB row | integration | `npx vitest run src/services/persist.test.ts` | ❌ Wave 0 |
| INGEST-05 | Error in one message job → sibling jobs continue | unit | `npx vitest run src/routes/webhook.test.ts` | ❌ Wave 0 |
| INGEST-06 | Failed job → Pino error log with `{messageId, errorCode, phase}` | unit | `npx vitest run src/routes/webhook.test.ts` | ❌ Wave 0 |

### Test strategy for INGEST-04 (dedup)

Persist tests should use a real DB (test DB) or a mock Drizzle instance that returns `[]` on the second insert. The cleanest approach for unit tests is to spy on `db.insert()` and verify it is called with `onConflictDoNothing()`.

### Test strategy for INGEST-05 (error isolation)

Inject a mock `persistMessage` that throws on message `id === 'bad'` and resolves for others. Assert that the other messages are processed and `fastify.log.error` is called exactly once with the bad message's ID.

### Sampling Rate

- **Per task commit:** `npx vitest run src/lib/auth.test.ts src/services/ingest.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/lib/auth.test.ts` — covers INGEST-01 (timing-safe comparison, 401 paths, RangeError guard)
- [ ] `src/services/ingest.test.ts` — covers INGEST-03 (all 9 message types + unknown type handling)
- [ ] `src/services/persist.test.ts` — covers INGEST-04 (dedup: same id twice → one row)
- [ ] `src/routes/webhook.test.ts` — covers INGEST-02, INGEST-05, INGEST-06 (route integration)
- [ ] Test fixtures: JSON files in `tests/fixtures/` for each Evolution message type

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | `crypto.timingSafeEqual` on `X-Webhook-Secret`; bearer token on future `/search` |
| V3 Session Management | No | Stateless webhook; no sessions |
| V4 Access Control | Yes | `preHandler` on POST /webhook/evolution; default-deny |
| V5 Input Validation | Yes | Zod body schema (loose passthrough); defensive casts in ingest.ts |
| V6 Cryptography | Yes | `crypto.timingSafeEqual` — do not hand-roll constant-time comparison |

### Known Threat Patterns for this Phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Timing attack on secret comparison | Information Disclosure | `crypto.timingSafeEqual` with length guard (REG-9) |
| Replay attack / duplicate webhook | Tampering | `ON CONFLICT DO NOTHING` on `messages.id` (INGEST-04) |
| Oversized payload (base64 media) | Denial of Service | Route-level `bodyLimit: 25MB`; reject early on `Content-Length` (EVO-2) |
| Malformed/unexpected messageType | Tampering | Explicit allow-list; unknown types logged and skipped (EVO-4) |
| `fromMe` messages poisoning corpus | Tampering | Filter `data.key.fromMe === true` in `extractMessages` |
| Secret leaked in logs | Information Disclosure | Pino `redact` already includes `*.password`; add `req.headers['x-webhook-secret']` to redact list |
| Single job error crashing queue | Denial of Service | Per-job try/catch; queue continues (INGEST-05) |

> **Pino redact addition needed:** Add `'req.headers[\'x-webhook-secret\']'` to the Pino redact list in `src/lib/logger.ts` or the Fastify logger options. Without this, the secret appears in access logs.

---

## Sources

### Primary (HIGH confidence)

- Node.js 22 docs: `node:crypto timingSafeEqual` — built-in, no package needed
- [orm.drizzle.team/docs/insert](https://orm.drizzle.team/docs/insert) — `onConflictDoNothing()` API
- [github.com/sindresorhus/p-queue](https://github.com/sindresorhus/p-queue) — PQueue constructor, `add()`, `onIdle()`, `concurrency`, ESM import
- PITFALLS.md (project prior research) — REG-9 (timingSafeEqual), EVO-1 (dedup), EVO-2 (payload size), EVO-4 (message type allow-list)
- `src/db/schema.ts` (codebase) — `messages.id` is PK, confirmed dedup target
- `src/config.ts` (codebase) — `WEBHOOK_SECRET` and `INGEST_CONCURRENCY` already in env schema

### Secondary (MEDIUM confidence)

- [github.com/gusnips/evolution-api-sdk](https://github.com/gusnips/evolution-api-sdk) — TypeScript types for webhook payload shape: `key.remoteJid`, `key.fromMe`, `key.id`, `pushName`, `messageType`, `messageTimestamp`, `message` sub-types
- [github.com/EvolutionAPI/evolution-api/.env.example](https://github.com/EvolutionAPI/evolution-api/blob/main/.env.example) — no native webhook secret; relies on `AUTHENTICATION_API_KEY`
- [github.com/EvolutionAPI/evolution-api/issues/1933](https://github.com/EvolutionAPI/evolution-api/issues/1933) — custom header feature request closed as "not planned" (v2.3.7)
- Community code examples (Medium article, GitHub issues) — confirmed `data.message.conversation`, `data.message.extendedTextMessage.text` field paths
- npm registry: `p-queue@9.3.0` (latest), `p-retry@6.2.1` (last v6.x) — version confirmed via `npm view`

### Tertiary (LOW confidence)

- None identified.

---

## Metadata

**Confidence breakdown:**
- Standard stack (p-queue, p-retry, node:crypto): HIGH — npm versions verified, slopcheck passed, APIs confirmed via official GitHub READMEs
- Webhook route pattern (Fastify preHandler, reply-then-enqueue): HIGH — established pattern in Phase 1 codebase
- Evolution API payload shape: MEDIUM — verified from SDK types and community examples, not from official payload documentation (official docs don't include payload schemas)
- Evolution authentication model: MEDIUM — confirmed no built-in webhook secret; custom header status [ASSUMED] for deployed version

**Research date:** 2026-05-21
**Valid until:** 2026-06-21 (stable packages; Evolution API payload shape may shift on major version bumps)
