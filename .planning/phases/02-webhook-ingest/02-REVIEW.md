---
phase: 02-webhook-ingest
reviewed: 2026-05-21T00:00:00Z
depth: standard
files_reviewed: 22
files_reviewed_list:
  - src/index.ts
  - src/lib/auth.test.ts
  - src/lib/auth.ts
  - src/lib/logger.ts
  - src/plugins/queue.ts
  - src/routes/webhook.test.ts
  - src/routes/webhook.ts
  - src/services/ingest.test.ts
  - src/services/ingest.ts
  - src/services/persist.test.ts
  - src/services/persist.ts
  - tests/fixtures/audio.json
  - tests/fixtures/contact.json
  - tests/fixtures/document.json
  - tests/fixtures/extended-text.json
  - tests/fixtures/from-me.json
  - tests/fixtures/image.json
  - tests/fixtures/location.json
  - tests/fixtures/reaction.json
  - tests/fixtures/sticker.json
  - tests/fixtures/text.json
  - tests/fixtures/unknown-type.json
  - tests/fixtures/video.json
findings:
  critical: 5
  warning: 5
  info: 3
  total: 13
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-05-21T00:00:00Z
**Depth:** standard
**Files Reviewed:** 22
**Status:** issues_found

## Summary

This phase delivers the webhook ingestion pipeline: auth preHandler, Fastify route, message extraction/normalization, and database persistence. The overall architecture is sound — timing-safe auth, fire-and-forget queue, per-message error isolation, and ON CONFLICT DO NOTHING deduplication are all present. However, five critical correctness and security defects were found, plus five warnings that degrade robustness. The most severe issues are: (1) the `sender` field is always set to `remoteJid` instead of the actual sender for group messages, producing systematically wrong data; (2) `data` can be `null` in the webhook body, causing an unhandled crash in `extractMessages`; (3) the `createLogger` factory in `logger.ts` is completely unused — the app builds its own Pino config inline in `index.ts`, so the redaction rules in `logger.ts` never apply; and (4) the auth handler does not prevent reply-after-reply by returning early after `reply.send`, which in Fastify 5 produces a warning or double-send on certain versions.

---

## Critical Issues

### CR-01: `sender` always equals `chatId` — group message sender identity is lost

**File:** `src/services/ingest.ts:76`
**Issue:** The `base` object sets both `chatId` and `sender` to `data.key.remoteJid`. For group chats, `remoteJid` is the group JID (e.g. `120363xxxxxx@g.us`), not the individual sender. The actual sender in a group message is carried in `data.key.participant` (or `data.participant`), which is never read. Every group message will be stored with `sender === chatId`, making it impossible to distinguish who sent what inside a group — a core use-case of the pipeline ("toda mensagem do WhatsApp deve ser capturada").

**Fix:**
```typescript
// In EvolutionDataItem, add the optional participant field
interface EvolutionDataItem {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
    participant?: string; // present for group messages
  };
  participant?: string; // Evolution also surfaces it here on some versions
  pushName: string;
  messageType: string;
  messageTimestamp: number;
  message: Record<string, unknown>;
}

// In normalizeMessage, use participant when available
const base = {
  id: data.key.id,
  chatId: data.key.remoteJid,
  sender: data.key.participant ?? data.participant ?? data.key.remoteJid,
  senderName: data.pushName ?? null,
  // ...
};
```

---

### CR-02: `data: null` in webhook body causes unhandled crash in `extractMessages`

**File:** `src/services/ingest.ts:40-42`
**Issue:** The Zod body schema declares `data: z.unknown()` and uses `.passthrough()`, meaning `data` can be any value including `null`. In `extractMessages`, the code does:
```typescript
const dataItems: EvolutionDataItem[] = Array.isArray(b.data)
  ? (b.data as EvolutionDataItem[])
  : [b.data as EvolutionDataItem];
```
When `b.data` is `null` or `undefined`, this produces `[null]`. The loop then executes `dataItem.key.fromMe` on `null`, throwing `TypeError: Cannot read properties of null (reading 'key')`. This unhandled exception propagates to `queue.on('error')` and loses the entire webhook payload, but more critically the queue task crashes silently from the caller's perspective. Evolution API occasionally sends `data: null` on `CONNECTION_UPDATE` events that contain a nested `data` field, and similar null-data shapes appear in real deployments.

**Fix:**
```typescript
// Guard null/undefined data before building the array
if (b.data == null) {
  log.debug({ event: b.event }, 'Payload sem data, ignorado');
  return [];
}

const dataItems: EvolutionDataItem[] = Array.isArray(b.data)
  ? (b.data as EvolutionDataItem[])
  : [b.data as EvolutionDataItem];
```

---

### CR-03: `createLogger` is defined but never used — Pino redaction rules in `logger.ts` are dead code

**File:** `src/lib/logger.ts:7` / `src/index.ts:29-33`
**Issue:** `logger.ts` exports `createLogger(level)` which configures Pino with redaction of `x-webhook-secret`, `DATABASE_URL`, and `password`. However, `index.ts` never imports or calls `createLogger`. Instead it passes an inline logger config object directly to `Fastify({ logger: { level, redact: [...] } })`. The `logger.ts` module is completely unused. The consequence is that the redaction paths in the active logger (`index.ts:31`) are subtly different from what `logger.ts` specifies:

- `logger.ts` redacts `"req.headers['x-webhook-secret']"` (the correct Pino path for HTTP access logs)
- `index.ts` redacts `'*.connectionString'`, `'*.DATABASE_URL'`, `'*.password'` — it omits `req.headers['x-webhook-secret']`

This means X-Webhook-Secret will appear unredacted in Pino access logs in production, contradicting T-02-06. The comment on line 4 of `logger.ts` ("T-02-06 mitigation") is misleading — the mitigation is not applied.

**Fix:** Either delete `logger.ts` and add the missing redact path to `index.ts`, or wire `createLogger` into `index.ts`:
```typescript
// Option A — fix index.ts to use createLogger:
import { createLogger } from './lib/logger.js';
// ...
const app = Fastify({
  logger: createLogger(config.LOG_LEVEL),
  bodyLimit: 10 * 1024 * 1024,
});

// Option B — fix index.ts inline (if logger.ts is kept for tests only):
redact: [
  '*.connectionString',
  '*.DATABASE_URL',
  '*.password',
  "req.headers['x-webhook-secret']",  // ADD THIS
],
```

---

### CR-04: Timing-safe auth is bypassable via length-oracle on secrets with differing UTF-8 byte lengths

**File:** `src/lib/auth.ts:35`
**Issue:** The length guard at line 35 compares `providedBuf.byteLength !== expectedBuf.byteLength`. This is correct for preventing `RangeError`, but it leaks the *byte length* of the expected secret via a timing side-channel: an attacker who sends strings of increasing byte length can observe which length gets past the early-return check and into the constant-time comparison. For ASCII-only secrets this is not exploitable (byte length == char length == countable via public knowledge). However, the `WEBHOOK_SECRET` env var is `z.string().min(16)` — there is no constraint to ASCII. If the operator configures a secret with multi-byte UTF-8 characters, the attacker can determine the secret's byte length precisely by observing which lengths trigger the `timingSafeEqual` path (slightly slower due to the function call). This is a timing oracle on secret byte length, which reduces the search space.

**Fix:** While complete mitigation requires HMAC-based verification, the simplest fix is to document that `WEBHOOK_SECRET` must be ASCII-only and enforce it in the Zod schema:
```typescript
// In src/config.ts
WEBHOOK_SECRET: z.string().min(16).regex(/^[\x20-\x7E]+$/, 'WEBHOOK_SECRET must be ASCII printable'),
```
Additionally, to prevent the length oracle entirely, always run `timingSafeEqual` against a constant-length dummy secret when lengths differ:
```typescript
// Always compare — never short-circuit on length alone
const lengthMatch = providedBuf.byteLength === expectedBuf.byteLength;
// Compare against a padded/truncated version to keep timing uniform
const cmpBuf = Buffer.alloc(expectedBuf.byteLength);
providedBuf.copy(cmpBuf, 0, 0, Math.min(providedBuf.byteLength, expectedBuf.byteLength));
const valueMatch = timingSafeEqual(cmpBuf, expectedBuf);
if (!lengthMatch || !valueMatch) {
  await reply.code(401).send({ error: 'Unauthorized' });
  return;
}
```

---

### CR-05: `extractMessages` does not validate that `dataItem.key` exists before property access

**File:** `src/services/ingest.ts:48`
**Issue:** The `EvolutionDataItem` interface declares `key` as required, but the body schema accepts `data: z.unknown()` — no Zod validation enforces the shape of the `data` field before it reaches `extractMessages`. If Evolution sends a malformed payload where a data-array element lacks a `key` field (e.g., `data: [{}]`), `dataItem.key` is `undefined`, and `dataItem.key.fromMe` throws `TypeError: Cannot read properties of undefined (reading 'fromMe')`. This crash is unhandled inside the queue task and propagates to `queue.on('error')`, silently dropping the webhook.

**Fix:** Add a defensive guard before accessing `dataItem.key`:
```typescript
for (const dataItem of dataItems) {
  // Guard malformed items — key is required
  if (!dataItem || typeof dataItem !== 'object' || !dataItem.key) {
    log.warn({ dataItem }, 'Item de dados malformado, ignorado');
    continue;
  }
  // ... rest of loop
}
```

---

## Warnings

### WR-01: `fastify-type-provider-zod` version `4.0.2` is mismatched — should be `6.1.x`

**File:** `package.json:28`
**Issue:** CLAUDE.md specifies `fastify-type-provider-zod: 6.1.x` as the required version. The installed version is `^4.0.2`. Version 4.x is designed for Fastify 4; the project uses Fastify 5 (`^5.8.5`). The v4 type provider has breaking differences in the `FastifyPluginAsyncZod` export and `ZodTypeProvider` generics that are resolved in v6. The code compiles today only because TypeScript's structural typing is lenient enough on the intersection, but the runtime type-provider hooks differ and may fail on edge cases (union schemas, discriminated unions, response serialization). This is a dependency version defect that could cause subtle runtime failures.

**Fix:**
```bash
npm install fastify-type-provider-zod@^6.1.0
```

---

### WR-02: `ingest.test.ts` batch-data test reuses `textFixture.data` and `audioFixture.data` — IDs collide, test is not meaningful

**File:** `src/services/ingest.test.ts:159-168`
**Issue:** The batch test constructs `data: [textFixture.data, audioFixture.data]`. Both fixture data items have `fromMe: false` and distinct `messageType`, so two results are produced. However `textFixture.data` has `id: 'FIXTURE_TEXT_001'` and `audioFixture.data` has `id: 'FIXTURE_AUDIO_003'` — different IDs, so deduplication is not tested here. The real gap is that neither the test nor production code handles the case where the same ID appears twice in a batch (e.g., duplicate items in one webhook delivery). The `persistMessage` call with `onConflictDoNothing` handles this at the DB level, but `extractMessages` would return two `NormalizedMessage` objects with the same `id`, causing two insert attempts. This is a correctness gap: the test passes because the fixture IDs are different, masking the untested duplicate-within-batch case.

**Fix:** Add a test case with two data items sharing the same `id` to verify behavior (currently both would be emitted and the second insert would be silently dropped by the DB — document this is intentional or deduplicate in `extractMessages`).

---

### WR-03: `queue.ts` does not declare a `dependency` on `db` — ordering is enforced only by convention

**File:** `src/plugins/queue.ts:27`
**Issue:** The queue plugin declares `dependencies: ['config']` but not `['config', 'db']`. The queue tasks call `persistMessage(fastify.db, msg)` via the route handler. If `fastify.db` is not ready when a task executes, the DB call fails. In `index.ts` the registration order is `configPlugin → dbPlugin → queuePlugin`, which happens to be correct, but the plugin dependency declaration does not enforce this. A future refactor that reorders registration would fail at runtime with a non-obvious error rather than at boot with a clear "dependency not met" message.

**Fix:**
```typescript
// src/plugins/queue.ts
export default fp(queuePlugin, { name: 'queue', dependencies: ['config', 'db'] });
```

---

### WR-04: `locationMessage` normalizer silently defaults `lat`/`lng` to `0` when fields are missing

**File:** `src/services/ingest.ts:160-161`
**Issue:**
```typescript
const lat = loc?.degreesLatitude ?? 0;
const lng = loc?.degreesLongitude ?? 0;
```
If `degreesLatitude` or `degreesLongitude` is missing from the payload (e.g., Evolution sends a location with only a name and no coordinates), both default to `0`. This produces text `"São Paulo (0, 0)"` — coordinates that point to the Gulf of Guinea. These bogus coordinates are then stored in `text` and indexed/searchable, polluting the data. The consumer has no way to distinguish "actual 0,0 coordinates" from "coordinates were absent".

**Fix:** Use `null` as the sentinel rather than `0`, and omit coordinates from the text when they are absent:
```typescript
const lat = loc?.degreesLatitude ?? null;
const lng = loc?.degreesLongitude ?? null;
const coordStr = lat !== null && lng !== null ? ` (${lat}, ${lng})` : '';
const text = loc?.name ? `${loc.name}${coordStr}` : coordStr.trim() || null;
return { ...base, type: 'location', text: text || null, mediaUrl: null };
```

---

### WR-05: `index.ts` calls `dotenv.config()` AFTER `loadConfig()` call order risk on cold boot

**File:** `src/index.ts:21-25`
**Issue:**
```typescript
if (process.env['NODE_ENV'] !== 'production') {
  const dotenv = await import('dotenv');
  dotenv.config();
}
const config = loadConfig();
```
`loadConfig()` is called on line 25, after `dotenv.config()` on line 21 — the order is correct as written. However, note that the `NODE_ENV` guard on line 19 reads `process.env['NODE_ENV']` before dotenv is loaded. If `.env` sets `NODE_ENV=development` and the shell has no `NODE_ENV` set, `process.env['NODE_ENV']` is `undefined` on line 19, which correctly falls through to the dotenv import. But if a developer explicitly sets `NODE_ENV=production` in their shell to test production behavior locally, dotenv is never loaded and any `.env`-only variables like `DATABASE_URL` or `WEBHOOK_SECRET` will be missing, causing `loadConfig()` to exit with code 1. This is confusing behavior — the intent was "skip dotenv in real production (Docker)", but the guard cannot distinguish shell-set from Docker-injected `NODE_ENV`.

This is a warning-level robustness issue, not a production bug (Docker environments inject all vars). Document it clearly or add a `FORCE_DOTENV=true` escape hatch.

**Fix:** Document this behavior in a code comment, or use a separate env var:
```typescript
// More explicit: skip dotenv only when running inside Docker/Swarm
if (!process.env['SKIP_DOTENV']) {
  const dotenv = await import('dotenv');
  dotenv.config();
}
```

---

## Info

### IN-01: `NormalizedMessage` is a re-export alias with no added type constraints — consider extending it

**File:** `src/services/ingest.ts:9`
**Issue:**
```typescript
export interface NormalizedMessage extends NewMessage {}
```
This is an empty interface extension. TypeScript computes `NormalizedMessage` as identical to `NewMessage` structurally. If the intent is to add ingest-layer invariants (e.g., `embedding` is always `null` at this stage, `rawJson` is always set) in the future, the empty interface is the right pattern. But currently it adds no type safety over `NewMessage` and misleads readers into thinking there are constraints. The interface name is used correctly throughout the codebase — just a quality observation.

**Fix:** Either add at least one invariant (e.g., `readonly embedding: null`) or add a clarifying comment explaining the forward-declaration intent.

---

### IN-02: `webhook.test.ts` fire-and-forget timing test uses a 80ms hard deadline that is fragile on slow CI

**File:** `src/routes/webhook.test.ts:185-188`
**Issue:**
```typescript
expect(elapsed).toBeLessThan(80);
```
The test simulates a 100ms persist delay and expects the HTTP response to arrive in under 80ms. On a loaded CI runner or Windows with a slow event loop, the Fastify inject roundtrip itself can take 30–60ms even without any work, leaving only 20–50ms of headroom. The test may become flaky under load. The 100ms mock delay is a good idea, but the deadline should be relative to the delay (e.g., `< 80` when persist takes `100`) to prevent false failures.

**Fix:** Increase the mock delay or increase the threshold, or assert `persistResolved === false` (which is the meaningful assertion anyway — timing is already asserted indirectly):
```typescript
// Increase mock delay so the margin is obvious:
await new Promise<void>((resolve) => setTimeout(resolve, 500)); // 500ms persist
// Then assert elapsed < 200 — still well under 500ms
expect(elapsed).toBeLessThan(200);
```

---

### IN-03: `openai` and `@fastify/multipart` are listed as required stack but absent from `package.json`

**File:** `package.json`
**Issue:** CLAUDE.md specifies `openai@^5.20.x` and `@fastify/multipart@10.0.x` as required dependencies (for Whisper transcription and media file uploads). Neither appears in `package.json` `dependencies`. Phase 2 plan documents that audio/image enrichment is deferred, but the schema already has `embedding: vector(1536)` and `mediaUrl` columns that depend on these packages in later phases. This is not a bug today, but it means the Phase 3 implementation will require a dependency bump + integration work that has no test coverage yet. Flagged as info so it does not slip through planning.

**Fix:** No action required now. Ensure Phase 3 plan includes these as explicit deliverables.

---

_Reviewed: 2026-05-21T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
