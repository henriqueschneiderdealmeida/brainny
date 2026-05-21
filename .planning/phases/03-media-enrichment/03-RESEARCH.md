# Phase 3: Media Enrichment - Research

**Researched:** 2026-05-21
**Domain:** OpenAI SDK v5 (Whisper, GPT-4o-mini Vision, Embeddings), Node 22 native fetch, p-queue/p-retry, Drizzle UPDATE, fs/promises atomic write
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ENRICH-01 | Download audio files and transcribe via OpenAI Whisper (PT-BR language hint); handle files ≤25MB | §Standard Stack (openai SDK v5 `toFile` + `audio.transcriptions.create`), §Pattern 1 |
| ENRICH-02 | Download images and generate descriptions via GPT-4o-mini Vision (PT-BR prompt) | §Standard Stack, §Pattern 2 — base64 data URL, not Evolution URL |
| ENRICH-03 | Generate text-embedding-3-small embeddings (1536 dims) for all non-empty text content | §Standard Stack, §Pattern 3 |
| ENRICH-04 | Warn in logs when message text is truncated before embedding (>8000 chars) | §Pattern 4 — truncation before embed |
| ENRICH-05 | Store media files locally in date-partitioned dirs (`data/{YYYY-MM-DD}/assets/`) | §Pattern 5 — atomic tmp→rename write |
</phase_requirements>

---

## Summary

Phase 3 builds the enrichment layer that transforms raw media rows (audio, image, video, document) into searchable text with embeddings. The pipeline is: download media from Evolution URL → process via OpenAI (Whisper/Vision) → generate embedding for resulting text → store file to disk → UPDATE the already-persisted database row with text + embedding.

Enrichment runs **inside the existing `fastify.queue.add()` job in `webhook.ts`**, immediately after `persistMessage`. This keeps the ingest and enrichment phases sequential per message without introducing a second queue or event bus. The existing `p-queue` instance (from `queuePlugin`) provides the concurrency cap. Three separate in-module `PQueue` instances (one each for Whisper, Vision, and Embeddings calls) sub-limit OpenAI API calls within each job.

The only new external dependency is the `openai` npm package (v5.x). All other capabilities — `p-queue`, `p-retry`, `fs/promises`, Node 22 native `fetch`, `AbortController` — are already present or part of Node 22 stdlib. The Drizzle UPDATE pattern (`.update().set().where(eq(...))`) is standard and requires no new schema changes.

**Primary recommendation:** Create `src/services/enrich.ts` that exports `enrichMessage(db, openai, msg, log): Promise<void>`. Call it from `webhook.ts` queue job after `persistMessage`. Use three child `PQueue` instances (whisper: concurrency 1, vision: concurrency 2, embedding: concurrency 3) with `p-retry` wrapping each OpenAI call.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Media URL validation (SSRF) | API / Backend | — | Domain allowlist check before any network call; must happen server-side |
| Media download | API / Backend | — | Node 22 `fetch` + `AbortController`; runs inside p-queue job |
| Audio transcription (Whisper) | API / Backend | — | OpenAI API call; must happen after download; result stored to DB |
| Image description (Vision) | API / Backend | — | OpenAI API call with base64 payload; result stored to DB |
| Embedding generation | API / Backend | — | OpenAI API call; runs after text is available (transcription or caption) |
| File storage (assets) | API / Backend | — | `fs/promises` write with tmp→rename atomic pattern; disk, not object store |
| DB UPDATE (text + embedding) | API / Backend | Database | Drizzle `.update().set().where()` on messages table |
| Rate-limit / retry logic | API / Backend | — | p-queue + p-retry; entirely in-process |

---

## Standard Stack

### Core (Phase 3 new addition)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| openai | 5.23.2 (latest 5.x) | Whisper, GPT-4o-mini Vision, Embeddings | Constraint-pinned v5; v6 exists but project locks v5; `toFile` helper + typed errors |

**Version verification:**
```
npm view openai@"5.x" version → latest 5.x is 5.23.2 (2026-05-21)
```
[VERIFIED: npm registry]

### Already Installed (used in Phase 3)

| Library | Version | Purpose |
|---------|---------|---------|
| p-queue | 9.3.0 | Sub-queues per OpenAI endpoint (whisper/vision/embedding) |
| p-retry | 6.2.1 | Exponential backoff on 429/5xx |
| drizzle-orm | 0.45.2 | `.update().set().where(eq(...))` for adding text+embedding to existing row |
| Node 22 `fetch` | built-in | Media download from Evolution URL |
| Node 22 `fs/promises` | built-in | Atomic file write (tmp → rename) |
| Node 22 `crypto` | built-in | URL hostname validation (SSRF guard) |

### Installation

```bash
npm install openai@"^5.23"
```

Note: CLAUDE.md says `openai@^5.20` — pin to `^5.23` (latest 5.x) — fully compatible, same major.

---

## Package Legitimacy Audit

| Package | Registry | Age | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-------------|-----------|-------------|
| openai | npm | 6 yrs (2020-07-09) | github.com/openai/openai-node | [OK] | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none

**Packages flagged as suspicious [SUS]:** none

**Postinstall check:** `npm view openai@5.23.2 scripts` — no `postinstall` key. [VERIFIED: npm registry]

---

## Architecture Patterns

### System Architecture Diagram

```
POST /webhook/evolution
        │
        ▼
  [authHandler preHandler]
        │
        ▼
  reply.send({ok: true})   ← 200 returned immediately (INGEST-02)
        │
        ▼
  fastify.queue.add(async () => {
    │
    ├─ extractMessages(body, log)       ← existing: ingest.ts
    │
    └─ for each msg:
         ├─ persistMessage(db, msg)     ← existing: persist.ts (INSERT, dedup)
         │
         └─ enrichMessage(db, openai, msg, log)   ← NEW: enrich.ts
              │
              ├─ if msg.type === 'audio':
              │     downloadMedia(msg.mediaUrl) → Buffer (≤25MB)
              │     whisperQueue.add(() => pRetry(() =>
              │       openai.audio.transcriptions.create(toFile(buf, ...))))
              │     → text = transcript
              │     storeAsset(text, buf, msg)
              │
              ├─ if msg.type === 'image':
              │     downloadMedia(msg.mediaUrl) → Buffer
              │     base64 = buf.toString('base64')
              │     visionQueue.add(() => pRetry(() =>
              │       openai.chat.completions.create({model:'gpt-4o-mini', ...})))
              │     → text = description
              │     storeAsset(text, buf, msg)
              │
              ├─ if msg.type === 'text'/'location'/'contact'/'reaction':
              │     text = msg.text (already in row)
              │
              └─ if text is non-null/non-empty:
                    truncatedText = truncate(text, 8000)  ← warn if truncated (ENRICH-04)
                    embeddingQueue.add(() => pRetry(() =>
                      openai.embeddings.create({input: truncatedText, model: 'text-embedding-3-small'})))
                    → embedding = response.data[0].embedding
                    db.update(messages).set({text, embedding}).where(eq(messages.id, msg.id))
  })
```

### Recommended Project Structure

```
src/
├── services/
│   ├── ingest.ts          # existing — extractMessages, NormalizedMessage
│   ├── persist.ts         # existing — persistMessage (INSERT ON CONFLICT DO NOTHING)
│   └── enrich.ts          # NEW — enrichMessage, downloadMedia, storeAsset, truncateText
├── plugins/
│   └── openai.ts          # NEW — OpenAI client Fastify plugin (fastify.openai decorator)
└── routes/
    └── webhook.ts          # MODIFIED — add enrichMessage call after persistMessage
```

### Pattern 1: Whisper Transcription with toFile

**What:** Convert a downloaded audio `Buffer` to a file object for the OpenAI Whisper API without writing to disk.
**When to use:** `msg.type === 'audio'`, `mediaUrl` is non-null, buffer ≤ 25MB.

```typescript
// Source: [VERIFIED: github.com/openai/openai-node README + dev.to article (verified via WebFetch)]
// Import toFile from openai package (available in v5)
import OpenAI, { toFile } from 'openai';

// After downloading buffer:
const transcript = await openai.audio.transcriptions.create({
  file: await toFile(audioBuffer, `${msg.id}.ogg`, { contentType: 'audio/ogg' }),
  model: 'whisper-1',
  language: 'pt',          // PT-BR language hint → ENRICH-01
  response_format: 'text', // plain string, no timestamps needed
});
// transcript is a string (with response_format: 'text')
```

**Content-type mapping by Evolution messageType:**
- `audioMessage`: `audio/ogg` (WhatsApp voice notes are OGG/Opus)
- `videoMessage`: `video/mp4`
- `documentMessage`: derive from fileName extension (mp3 → `audio/mpeg`, m4a → `audio/mp4`)

**Supported Whisper audio formats (ASSUMED — from training data):** flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm. Max 25MB file size.

### Pattern 2: GPT-4o-mini Vision with Base64 Data URL

**What:** Encode downloaded image buffer as base64 data URL and pass to Vision API. Never pass Evolution URLs directly — they expire.
**When to use:** `msg.type === 'image'` (and optionally `video` thumbnail, `sticker`).

```typescript
// Source: [VERIFIED: OpenAI API docs — image_url type with data: URL]
const base64 = imageBuffer.toString('base64');
const mimeType = 'image/jpeg'; // WhatsApp images are JPEG

const response = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  max_tokens: 300,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${base64}`,
            detail: 'low', // ~85 tokens/image; CLAUDE.md recommends 'low' for cost
          },
        },
        {
          type: 'text',
          text: 'Descreva esta imagem de forma concisa em português do Brasil.',
        },
      ],
    },
  ],
});

const description = response.choices[0]?.message?.content ?? null;
```

**Caption passthrough:** If `msg.text` (the caption from ingest.ts) is already non-null, prepend it to description or use it directly, optionally skipping Vision to save cost. MVP: always call Vision for images regardless of caption, combine as `${caption}\n${description}`.

### Pattern 3: text-embedding-3-small Embeddings

**What:** Generate 1536-dim embedding vector for text content.
**When to use:** After text is determined (transcript, description, or plain text). Skip if text is null or empty string.

```typescript
// Source: [VERIFIED: OpenAI API docs — embeddings.create]
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: truncatedText,
  // dimensions not specified → defaults to 1536 (matches schema vector(1536))
});

const embedding: number[] = response.data[0]!.embedding;
// embedding.length === 1536
```

### Pattern 4: Text Truncation Before Embedding

**What:** Guard against embeddings API input limit. ROADMAP specifies 8000 chars as the project truncation threshold.
**When to use:** Before every `embeddings.create` call.

```typescript
// Source: [ASSUMED — project-defined threshold from ROADMAP.md success criteria]
const MAX_EMBED_CHARS = 8000;

function truncateForEmbedding(text: string, messageId: string, log: Logger): string {
  if (text.length <= MAX_EMBED_CHARS) return text;
  // ENRICH-04: warn log with messageId and original length
  log.warn(
    { messageId, originalLength: text.length, truncatedLength: MAX_EMBED_CHARS },
    'Texto truncado antes de gerar embedding',
  );
  return text.slice(0, MAX_EMBED_CHARS);
}
```

Note: OpenAI's actual token limit for `text-embedding-3-small` is 8191 tokens, not chars. 8000 chars is a safe conservative char proxy since average English token ≈ 4 chars, Portuguese ≈ similar. [ASSUMED — approximation; actual limit is in tokens not chars]

### Pattern 5: Atomic Asset Storage

**What:** Write downloaded media to `data/YYYY-MM-DD/assets/<messageId>.<ext>` atomically.
**Why atomic:** tmp file + `fs.rename()` is atomic on Linux (same filesystem); prevents Obsidian or materializer reading a partial file.

```typescript
// Source: [VERIFIED: Node.js fs/promises official docs — rename is atomic on same-fs]
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

async function storeAsset(
  buffer: Buffer,
  messageId: string,
  ext: string,
  dateStr: string, // 'YYYY-MM-DD'
  dataDir: string,
): Promise<string> {
  const dir = join(dataDir, dateStr, 'assets');
  await mkdir(dir, { recursive: true });

  const filename = `${messageId}.${ext}`;
  const finalPath = join(dir, filename);
  const tmpPath = `${finalPath}.tmp`;

  await writeFile(tmpPath, buffer);
  await rename(tmpPath, finalPath); // atomic on same filesystem

  return finalPath;
}
```

**Date string derivation:** `msg.timestamp.toISOString().slice(0, 10)` — uses message timestamp, not `new Date()`, so backfilled messages land in the correct date directory.

**Extension mapping (ASSUMED — from WhatsApp media types):**
| msg.type | default ext |
|----------|------------|
| audio | ogg |
| image | jpg |
| video | mp4 |
| document | derive from `fileName` field in rawJson, fallback `bin` |
| sticker | webp |

### Pattern 6: Media Download with SSRF Guard

**What:** Download media from Evolution URL using Node 22 native `fetch` with timeout and domain allowlist.
**SSRF risk:** The `mediaUrl` field comes from the Evolution webhook payload, which is untrusted. An attacker could craft a webhook pointing to internal services (e.g., `http://postgres:5432`).

```typescript
// Source: [VERIFIED: Node.js docs — AbortSignal.timeout() available Node 17.3+]
const ALLOWED_EVOLUTION_HOSTNAMES = new Set([
  'evolution.yowa.com.br',         // production Evolution host
  // Add more if Evolution CDN hostnames differ
]);

async function downloadMedia(url: string): Promise<Buffer> {
  // SSRF guard: validate hostname before any fetch
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL de mídia inválida: ${url}`);
  }

  if (!ALLOWED_EVOLUTION_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(`Hostname não permitido para download de mídia: ${parsed.hostname}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Apenas HTTPS é permitido para download de mídia`);
  }

  // 30-second timeout for media downloads
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Download falhou: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // 25MB cap (Whisper limit; also protect heap)
  if (buffer.byteLength > 25 * 1024 * 1024) {
    throw new Error(`Arquivo muito grande: ${buffer.byteLength} bytes (limite: 25MB)`);
  }

  return buffer;
}
```

**`ALLOWED_EVOLUTION_HOSTNAMES`** should be populated from config (`EVOLUTION_URL` env var already planned), not hardcoded — parse hostname from `process.env.EVOLUTION_URL` at startup.

### Pattern 7: p-queue + p-retry for OpenAI Calls

**What:** Three separate PQueue instances to rate-limit OpenAI calls independently per endpoint. p-retry wraps each call with exponential backoff.
**Why separate queues:** Whisper, Vision, and Embedding have different rate limits (RPM and TPM). Mixing them in one queue under-utilizes the embedding endpoint while Whisper is backlogged.

```typescript
// Source: [ASSUMED — pattern derived from CLAUDE.md recommendation + p-queue/p-retry docs]
import PQueue from 'p-queue';
import pRetry, { AbortError } from 'p-retry';
import { APIError } from 'openai';

// Module-level queues — singleton per process
const whisperQueue = new PQueue({ concurrency: 1, intervalCap: 3, interval: 60_000 });
const visionQueue = new PQueue({ concurrency: 2, intervalCap: 10, interval: 60_000 });
const embeddingQueue = new PQueue({ concurrency: 3, intervalCap: 20, interval: 60_000 });

// Retry wrapper
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(fn, {
    retries: 4,
    minTimeout: 1000,
    maxTimeout: 30_000,
    factor: 2,
    jitter: 'full', // Note: p-retry 6.x uses randomize: true not jitter
    onFailedAttempt: (error) => {
      // Abort retries on 4xx client errors that are not 429
      if (error instanceof APIError && error.status !== undefined) {
        if (error.status >= 400 && error.status < 500 && error.status !== 429) {
          throw new AbortError(error);
        }
      }
    },
  });
}
```

**Note on p-retry v6 options:** `randomize: true` is the correct jitter option in p-retry 6.x (not `jitter: 'full'` which is p-retry 5.x syntax). [ASSUMED — verify in p-retry 6.x changelog before coding]

### Pattern 8: Drizzle UPDATE for text + embedding

**What:** After enrichment, update the already-persisted row with the computed `text` and `embedding`.
**When:** `persistMessage` runs first (INSERT with ON CONFLICT DO NOTHING); enrichMessage runs second (UPDATE).

```typescript
// Source: [VERIFIED: orm.drizzle.team/docs/update]
import { eq } from 'drizzle-orm';
import { messages } from '../db/schema.js';

await db
  .update(messages)
  .set({ text, embedding })
  .where(eq(messages.id, messageId));
```

**Null safety:** If enrichment fails for any reason, the row retains `text: null, embedding: null`. The message is not lost — `rawJson` always has the original payload for re-enrichment. Failure is logged with Pino; no rethrow (same isolation pattern as persist).

### Pattern 9: OpenAI Client Plugin

**What:** Fastify plugin that decorates `fastify.openai` with a single `OpenAI` instance.
**Why plugin:** Keeps the API key out of service modules; mirrors the `dbPlugin` pattern already in the project.

```typescript
// src/plugins/openai.ts
import fp from 'fastify-plugin';
import OpenAI from 'openai';
import type { FastifyPluginAsync } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    openai: OpenAI;
  }
}

const openaiPlugin: FastifyPluginAsync = async (fastify) => {
  const client = new OpenAI({
    apiKey: fastify.config.OPENAI_API_KEY,
    maxRetries: 0, // p-retry handles retries; disable SDK's built-in retry to avoid double backoff
  });
  fastify.decorate('openai', client);
};

export default fp(openaiPlugin, { name: 'openai', dependencies: ['config'] });
```

**`maxRetries: 0` is critical** — the OpenAI SDK v5 has built-in retry logic (default 2 retries). If both SDK retries and p-retry are active, you get multiplicative retry storms. Set `maxRetries: 0` and let p-retry own all retry logic.

### Integration Point in webhook.ts

The queue job in `webhook.ts` becomes:

```typescript
void fastify.queue.add(async () => {
  const msgs = extractMessages(body, log);

  for (const msg of msgs) {
    try {
      await persistMessage(fastify.db, msg);
    } catch (err: unknown) {
      log.error({ messageId: msg.id, phase: 'persist', err }, 'Falha ao persistir mensagem');
      continue; // Skip enrichment if persist failed
    }

    try {
      await enrichMessage(fastify.db, fastify.openai, msg, log, fastify.config.DATA_DIR);
    } catch (err: unknown) {
      log.error({ messageId: msg.id, phase: 'enrich', err }, 'Falha ao enriquecer mensagem');
      // Do NOT rethrow — message is persisted, partial enrichment is acceptable
    }
  }
});
```

### Anti-Patterns to Avoid

- **Passing Evolution URL directly to Vision API:** Evolution CDN URLs expire (signed URLs with TTL). Always download first, base64-encode, pass as data URL.
- **Writing audio buffer to temp file then `fs.createReadStream`:** Use `toFile(buffer, ...)` directly — avoids disk I/O and temp file cleanup.
- **Wrapping `toFile` result without `await`:** `toFile` returns a Promise — always `await toFile(...)` before passing to `transcriptions.create`.
- **Single PQueue for all OpenAI calls:** Different endpoints have different rate limits — separate queues per endpoint.
- **SDK built-in retry + p-retry active simultaneously:** Results in exponential retry storm. Set `maxRetries: 0` on the OpenAI client.
- **Using `new Date()` for asset directory date:** Use `msg.timestamp` so backfilled messages land in the correct historical date bucket.
- **Synchronous `fs` calls:** Always use `fs/promises` (never `fs.writeFileSync`).
- **Calling `downloadMedia` without hostname validation:** SSRF risk — validate against allowlist before `fetch`.
- **Hardcoding Evolution hostname:** Read from `EVOLUTION_URL` env var parsed at startup.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File-to-API upload without disk | Custom FormData buffer handling | `toFile(buffer, name, {contentType})` from `openai` | SDK handles multipart encoding correctly, including boundary and content-type |
| Exponential backoff | Custom setTimeout retry loop | `p-retry` with `onFailedAttempt` | Handles jitter, AbortError early exit, typed errors |
| Embedding API token truncation | Custom tokenizer | 8000-char conservative proxy | token-exact truncation requires `tiktoken` which adds 10MB WASM dep; char proxy is good enough for PT-BR |
| Atomic file write | Manual rename-after-write logic | Pattern 5 (already simple) | One call: `writeFile(tmp) → rename(tmp, final)` — simple enough to do directly |
| SSRF protection at network layer | iptables / egress proxy | URL.hostname allowlist in code | Single-instance personal deployment; hostname check is sufficient and auditable |

---

## Common Pitfalls

### Pitfall 1: `toFile` Not Awaited
**What goes wrong:** `transcriptions.create({ file: toFile(buf, ...) })` — `toFile` returns a Promise, not a File object. Passing the unawaited Promise causes a runtime error or silent wrong type.
**Why it happens:** `toFile` is async because it may need to read stream internals.
**How to avoid:** Always `await toFile(...)`: `file: await toFile(buf, name, {contentType})`.
**Warning signs:** TypeScript error "Promise is not assignable to Uploadable" — catch at compile time with strict types.

### Pitfall 2: Evolution URLs Expire
**What goes wrong:** Storing Evolution URL and later passing it to GPT-4o-mini vision — URL returns 403/404 by the time the queue processes it.
**Why it happens:** Evolution serves media via signed CDN URLs with short TTL (minutes to hours).
**How to avoid:** Download immediately on first enrichment run; pass base64 to Vision, not the URL. Store buffer to disk (ENRICH-05) for future re-enrichment.
**Warning signs:** Vision API returning error about inaccessible image URL.

### Pitfall 3: SDK Built-in Retry + p-retry Double Storm
**What goes wrong:** OpenAI SDK v5 defaults to `maxRetries: 2`. Combined with p-retry's 4 retries, a single failing call can retry up to 12 times (3 × 4), with exponentially increasing delays.
**Why it happens:** SDK retries are transparent — easy to forget they're active.
**How to avoid:** Set `maxRetries: 0` on the `OpenAI` client constructor. p-retry owns all retry logic.
**Warning signs:** Logs showing many more retry attempts than `p-retry`'s configured `retries` count.

### Pitfall 4: Missing Null Check Before `enrichMessage`
**What goes wrong:** Calling `downloadMedia(null)` when `msg.mediaUrl` is null (text, location, contact, reaction types have `mediaUrl: null`).
**Why it happens:** `NormalizedMessage.mediaUrl` is `string | null`.
**How to avoid:** Guard at the top of `enrichMessage`: `if (!msg.mediaUrl && msg.type !== 'text') return;`. Text-type messages skip download and go directly to embedding.

### Pitfall 5: `embedding` Column Receives `number[]` but Schema Expects `vector`
**What goes wrong:** Drizzle's `vector` column type is special — passing a plain `number[]` may serialize incorrectly depending on the pg adapter version.
**Why it happens:** pgvector JS bindings require specific wire format.
**How to avoid:** The `drizzle-orm/pg-core` `vector()` column helper handles serialization automatically when using Drizzle's query builder. Using `db.update(messages).set({ embedding: array })` is correct — Drizzle handles `number[]` → pgvector wire format. Do NOT use raw `db.execute(sql`UPDATE ...`)` for embedding unless you serialize manually.
**Warning signs:** pgvector error "invalid input syntax for type vector" in Postgres logs.

### Pitfall 6: `p-retry` v6 Option Name Change
**What goes wrong:** Using `jitter: 'full'` (p-retry 5.x) in p-retry 6.x — option is silently ignored, no jitter applied.
**Why it happens:** API changed between major versions.
**How to avoid:** In p-retry 6.x, use `randomize: true` for jitter. [ASSUMED — verify against p-retry 6.x changelog: `github.com/sindresorhus/p-retry`]
**Warning signs:** Retry delays are exactly `minTimeout × factor^attempt` with no randomization.

### Pitfall 7: Asset Write Crossing Filesystem Boundaries
**What goes wrong:** `fs.rename()` throws `EXDEV` (cross-device link) if `dataDir` and the system temp dir are on different filesystems.
**Why it happens:** `rename` is only atomic on the same filesystem; if tmp file is on `/tmp` and final is on a mounted volume, they may differ.
**How to avoid:** Write tmp file to the same directory as the final file (same `dir` as target), not to `/tmp`. Pattern 5 uses `finalPath + '.tmp'` in the same dir — this is correct.

### Pitfall 8: Whisper 25MB Limit Checked After Full Download
**What goes wrong:** Downloading a 100MB video then rejecting it wastes bandwidth and time.
**Why it happens:** HTTP response body is streamed but `response.arrayBuffer()` buffers everything.
**How to avoid:** Check `Content-Length` response header before buffering:
```typescript
const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
if (contentLength > 25 * 1024 * 1024) throw new Error('Arquivo excede 25MB');
```
Fall back to post-download check when `Content-Length` is absent.

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `fs.createReadStream(path)` for Whisper | `toFile(buffer, name, {contentType})` in-memory | No temp file needed; works in serverless/Docker |
| Passing hosted URL to Vision | Base64 data URL `data:image/jpeg;base64,...` | Eliminates URL expiry problem for Evolution CDN |
| `AbortController` + `setTimeout` + `clearTimeout` pattern | `AbortSignal.timeout(ms)` (Node 17.3+, Node 22 stable) | One-liner timeout, no manual cleanup needed |
| Single retry queue for all AI calls | Separate `PQueue` per endpoint | Respects per-endpoint RPM limits independently |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | WhatsApp voice notes from Evolution use OGG/Opus container | Pattern 1 — content-type mapping | Wrong content-type may cause Whisper rejection; fix: detect from buffer magic bytes or use `audio/ogg` as default (Whisper is tolerant) |
| A2 | `randomize: true` is the p-retry v6 jitter option (not `jitter: 'full'`) | Pattern 7 | No jitter → retry storm under load; verify in p-retry 6.x changelog before coding |
| A3 | 8000 chars is a safe proxy for the 8191-token embedding limit for PT-BR text | Pattern 4 | Short texts never truncated; extremely long texts may still exceed token limit; acceptable for MVP |
| A4 | Evolution CDN URLs expire (signed TTL) | Anti-patterns, Pitfall 2 | If URLs are permanent, downloading is still correct (defensive) — no risk from this assumption being wrong |
| A5 | `openai` SDK v5 `maxRetries` defaults to 2 (not 0) | Pattern 9 | If default is 0, setting `maxRetries: 0` is a no-op — harmless |
| A6 | Vision `detail: 'low'` is sufficient for WhatsApp images | Pattern 2 | Low detail may miss text in images; upgrade to `auto` if quality is insufficient |
| A7 | Whisper `language: 'pt'` (not 'pt-BR') is the correct ISO code | Pattern 1 | Wrong code → Whisper may default to auto-detect (still works, slightly slower) |

---

## Open Questions

1. **Should `video` and `sticker` types be enriched?**
   - What we know: `videoMessage` has `mediaUrl`; `stickerMessage` has `mediaUrl`. Whisper can handle video audio tracks if extracted. Stickers are WebP images — Vision could describe them.
   - What's unclear: Phase 3 requirements only specify audio (ENRICH-01) and image (ENRICH-02). Video/sticker are not mentioned.
   - Recommendation: Treat video as audio-only enrichment (Whisper on the audio track — but Evolution gives the full video, not extracted audio). MVP: skip video and sticker enrichment; add placeholder `log.info` that they are not enriched. Phase 6 backfill can add later.

2. **Should image captions from ingest.ts be combined with Vision description?**
   - What we know: `msg.text` for `imageMessage` is already set to `img?.caption` by `ingest.ts`. Vision adds a description. Both are useful.
   - Recommendation: Combine as `[caption]\n[description]` when caption is non-null; use description alone otherwise. This gives richer embedding signal.

3. **Should `EVOLUTION_URL` env var be added to `config.ts` for SSRF hostname derivation?**
   - What we know: `config.ts` already validates `OPENAI_API_KEY`, `DATABASE_URL`, `WEBHOOK_SECRET`, etc. An Evolution URL for media download validation is needed.
   - Recommendation: Add `EVOLUTION_URL: z.string().url()` to `envSchema`. Parse hostname once at plugin startup and pass to `downloadMedia`.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 22 | `AbortSignal.timeout()`, `fs/promises` | Yes | v24.14.1 | — |
| openai npm package | Whisper, Vision, Embeddings | Not yet installed | 5.23.2 available | — |
| PostgreSQL + pgvector | Drizzle UPDATE with embedding | Assumed running | — | — |
| Evolution API | Media download URL | External service | — | Log error, skip enrich |

**Missing dependencies with no fallback:** `openai` package must be installed before Phase 3 begins. Run `npm install openai@"^5.23"`.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 2.1.9 |
| Config file | vitest.config.ts (or package.json `test` script) |
| Quick run command | `npx vitest run src/services/enrich.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ENRICH-01 | Whisper transcription called with correct params (model, language, toFile) | unit (mocked openai) | `npx vitest run src/services/enrich.test.ts` | ❌ Wave 0 |
| ENRICH-01 | Audio > 25MB is rejected before OpenAI call | unit | `npx vitest run src/services/enrich.test.ts` | ❌ Wave 0 |
| ENRICH-02 | Vision called with base64 data URL (not raw URL) | unit (mocked openai) | `npx vitest run src/services/enrich.test.ts` | ❌ Wave 0 |
| ENRICH-03 | Embedding generated and saved to DB for text message | unit (mocked openai + db) | `npx vitest run src/services/enrich.test.ts` | ❌ Wave 0 |
| ENRICH-04 | Pino warn logged when text > 8000 chars; embedding still succeeds | unit | `npx vitest run src/services/enrich.test.ts` | ❌ Wave 0 |
| ENRICH-05 | Asset written to correct date-partitioned path; tmp→rename sequence used | unit (real fs/tmp dir) | `npx vitest run src/services/enrich.test.ts` | ❌ Wave 0 |
| ENRICH-03 | embedding column = number[] of length 1536 after update | unit (mocked) | `npx vitest run src/services/enrich.test.ts` | ❌ Wave 0 |
| ENRICH-01/02 | Download from non-Evolution hostname throws before fetch | unit | `npx vitest run src/services/enrich.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npx vitest run src/services/enrich.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/services/enrich.test.ts` — covers all ENRICH-01 through ENRICH-05
- [ ] `src/plugins/openai.ts` — OpenAI client Fastify plugin
- [ ] Install `openai@"^5.23"`: `npm install openai@"^5.23"`

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes | URL hostname allowlist (SSRF); Content-Length check before buffer |
| V6 Cryptography | no | — |
| V7 Error Handling | yes | Pino structured error logs; no stack traces in API responses |
| V9 Communication | yes | HTTPS-only for media download; reject `http:` URLs |

### Known Threat Patterns for Media Download

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SSRF via crafted `mediaUrl` in webhook payload | Elevation of Privilege | Hostname allowlist derived from `EVOLUTION_URL` env var; reject non-HTTPS |
| Large file exhausting heap | Denial of Service | `Content-Length` header check before `arrayBuffer()`; 25MB hard cap after download |
| Malformed audio crashing Whisper | Tampering | Let OpenAI API reject it; catch APIError and log; never crash the process |
| Base64 memory amplification (image × 1.37) | Denial of Service | 25MB download cap → max ~34MB base64 string; acceptable for Node 22 heap |

---

## Sources

### Primary (HIGH confidence)
- `github.com/openai/openai-node` README — `toFile` helper import and signature [VERIFIED via WebFetch]
- `orm.drizzle.team/docs/update` — `.update().set().where(eq(...))` pattern [VERIFIED via WebFetch]
- npm registry: `npm view openai@5.23.2` — version exists, no postinstall, repo is `github.com/openai/openai-node` [VERIFIED: npm registry]
- Node.js docs: `AbortSignal.timeout()` available since Node 17.3 (stable in Node 22) [VERIFIED: training knowledge + MDN]
- slopcheck: `openai` → [OK] [VERIFIED: slopcheck 0.6.1]

### Secondary (MEDIUM confidence)
- OpenAI API docs (verified via WebSearch): `embeddings.create({ model: 'text-embedding-3-small', input })` → 1536-dim default
- OpenAI API docs (verified via WebSearch): vision `image_url` type with `data:mime;base64,...` format
- OpenAI API docs (verified via WebSearch): Whisper `language: 'pt'` for Portuguese; `response_format: 'text'` for plain string
- dev.to article (verified via WebFetch): `toFile(buffer, filename, {contentType})` from `openai` package

### Tertiary (LOW confidence)
- WhatsApp OGG/Opus container format for voice notes — ASSUMED from general knowledge [A1]
- p-retry v6 `randomize: true` option name — ASSUMED, needs verification [A2]
- Evolution CDN URL expiry — ASSUMED from common CDN patterns [A4]

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — openai v5.23.2 confirmed on npm registry, slopcheck OK
- Architecture: HIGH — integration point in webhook.ts is clear from Phase 2 code
- OpenAI API patterns: MEDIUM-HIGH — confirmed via official docs (WebSearch) + SDK README (WebFetch)
- Pitfalls: HIGH — most confirmed by direct code inspection of Phase 2 patterns + SDK behavior
- p-retry v6 options: LOW — A2 assumption, needs verification before coding

**Research date:** 2026-05-21
**Valid until:** 2026-06-20 (30 days — openai SDK moves fast; check for 5.x point releases)
