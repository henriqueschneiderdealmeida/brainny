---
phase: 01-foundation
reviewed: 2026-05-21T00:00:00Z
depth: standard
files_reviewed: 15
files_reviewed_list:
  - drizzle.config.ts
  - eslint.config.ts
  - package.json
  - src/config.test.ts
  - src/config.ts
  - src/db/client.ts
  - src/db/schema.ts
  - src/index.ts
  - src/lib/logger.ts
  - src/plugins/config.ts
  - src/plugins/db.ts
  - src/routes/health.test.ts
  - src/routes/health.ts
  - tsconfig.json
  - vitest.config.ts
findings:
  critical: 1
  warning: 5
  info: 1
  total: 7
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-05-21T00:00:00Z
**Depth:** standard
**Files Reviewed:** 15
**Status:** issues_found

## Summary

Reviewed the complete Phase 1 foundation: Fastify 5 app bootstrap, Zod env validation, Drizzle schema, pg pool factory, config/db plugins, health route, tests, and tooling config. The skeleton is structurally sound — Fastify 5 + ZodTypeProvider wiring is correct, env validation exits cleanly, HNSW index and schema types are well-formed, and the test suite isolates dependencies correctly.

One critical defect: the installed `fastify-type-provider-zod` is two major versions behind the project specification. Five warnings follow, ranging from an operational hang risk on startup to dead code. One info-level test coverage gap rounds out the findings.

## Critical Issues

### CR-01: `fastify-type-provider-zod` version is two major versions behind spec

**File:** `package.json:28`
**Issue:** `package.json` pins `fastify-type-provider-zod` at `^4.0.2`. `CLAUDE.md` (the authoritative stack specification) mandates `6.1.x`. This is a two-major-version divergence. v4 and v6 have different internal APIs, different peer-dependency requirements, and potentially different type-provider behaviours. The code currently imports `FastifyPluginAsyncZod` which exists in v4 — but any future v6 migration may hit breaking changes in route schema typing, `jsonSchemaTransform`, and Zod coercion handling that are invisible at v4. Running a version that does not match the spec means the implementation has not been validated against the required dependency.

**Fix:**
```bash
npm install fastify-type-provider-zod@^6.1.0
```
Then verify `FastifyPluginAsyncZod`, `serializerCompiler`, `validatorCompiler` imports still resolve (these are stable exports, but confirm against v6 changelog for any renamed options).

---

## Warnings

### WR-01: `pg.Pool` has no `connectionTimeoutMillis` — startup hangs indefinitely when DB is unreachable

**File:** `src/db/client.ts:6-11`
**Issue:** The pool is created with `max` and `idleTimeoutMillis` but no `connectionTimeoutMillis`. The `node-postgres` default for this field is `0`, meaning wait forever. `dbPlugin` calls `await pool.query('SELECT 1')` as a "fast-fail" boot check (comment: `T-02-04: intentional`). If the PostgreSQL service is temporarily unreachable (e.g., Docker startup ordering), this query will block the event loop indefinitely — the app will never start and the container will not register as unhealthy. The fast-fail intent is correct but the implementation does not enforce a deadline.

**Fix:**
```typescript
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000, // fail fast if DB is unreachable at boot
  });
}
```

---

### WR-02: `createLogger()` in `src/lib/logger.ts` is a dead export — never imported

**File:** `src/lib/logger.ts:6`
**Issue:** `createLogger(level)` is exported but is not imported anywhere in the codebase. `src/index.ts` configures Fastify's built-in logger directly with inline options, bypassing this factory entirely. The redact configuration in `logger.ts` (`*.connectionString`, `*.DATABASE_URL`, `*.password`) is therefore also unused. Shipping a dead export creates confusion about which logging path is active and invites the `createLogger` path to drift out of sync.

**Fix:** Either use `createLogger` in `index.ts` by passing the resulting instance to `Fastify({ logger: createLogger(config.LOG_LEVEL) })`, or delete `src/lib/logger.ts` entirely and keep the inline logger options. Using `createLogger` is preferred because it consolidates the redact list in one place (see WR-04).

---

### WR-03: No `SIGTERM`/`SIGINT` signal handlers — graceful shutdown does not work in Docker Swarm

**File:** `src/index.ts:50-54`
**Issue:** The `main()` function starts the server but registers no `process.on('SIGTERM', ...)` or `process.on('SIGINT', ...)` handler. Fastify 5 does not handle these signals automatically. When Docker Swarm sends `SIGTERM` during a rolling update or scale-down, Node.js receives the signal and exits immediately (default behaviour), killing the process before `app.close()` fires. The `onClose` hook in `dbPlugin` — which calls `pool.end()` — is therefore never invoked, leaving database connections open. Over multiple rolling updates this can exhaust the `max: 10` connection limit in the shared PostgreSQL instance.

**Fix:**
```typescript
// After await app.listen(...)
const shutdown = async (signal: string) => {
  app.log.info(`${signal} received — closing server`);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
```

---

### WR-04: Redact configuration duplicated across `logger.ts` and `index.ts`

**File:** `src/lib/logger.ts:9`, `src/index.ts:29`
**Issue:** The Pino redact array `['*.connectionString', '*.DATABASE_URL', '*.password']` is defined identically in two places. `logger.ts` defines it for the exported `createLogger` factory; `index.ts` defines it inline for the Fastify logger options. Since `createLogger` is never called (see WR-02), only the `index.ts` copy is active, but a future developer reading `logger.ts` would reasonably assume it is the canonical source. If a new sensitive field is added (e.g., `*.OPENAI_API_KEY`), it needs to be added in two places or the active copy is missed.

**Fix:** Resolve this by consolidating to a single source. Export the redact list as a constant from `logger.ts` (or a dedicated `src/lib/redact.ts`) and import it in `index.ts`:
```typescript
// src/lib/logger.ts
export const LOG_REDACT = ['*.connectionString', '*.DATABASE_URL', '*.password'] as const;
```
```typescript
// src/index.ts
import { LOG_REDACT } from './lib/logger.js';
// ...
const app = Fastify({ logger: { level: config.LOG_LEVEL, redact: LOG_REDACT } });
```

---

### WR-05: `drizzle.config.ts` uses a TypeScript non-null assertion on an unvalidated env var

**File:** `drizzle.config.ts:10`
**Issue:** `process.env['DATABASE_URL']!` suppresses the TypeScript `undefined` warning but does not validate the value at runtime. If `DATABASE_URL` is not set when running `drizzle-kit generate` or `drizzle-kit migrate`, the `!` assertion causes the string `"undefined"` to be passed to `drizzle-kit`'s PostgreSQL driver. The resulting error message (e.g., `invalid input syntax for type integer: "NaN"` from a failed port parse) is opaque and hard to diagnose in CI.

**Fix:**
```typescript
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('DATABASE_URL is required for drizzle-kit commands');
  process.exit(1);
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: { url: databaseUrl },
  migrations: { table: '__drizzle_migrations', schema: 'public' },
});
```

---

## Info

### IN-01: `health.test.ts` ISO-8601 test does not assert HTTP status code

**File:** `src/routes/health.test.ts:62-80`
**Issue:** The third test ("response ts field is a valid ISO 8601 date string") mocks `pgPool.query` to return `{ rows: [] }` (no error), registers the health route, and then reads `body.ts` — but never asserts `response.statusCode`. If the route were changed to always return 503, this test would still pass because it only checks the shape of `ts`. The test's stated intent is narrowly about the `ts` field format, but omitting the status code assertion means a regression in HTTP semantics goes undetected by this case.

**Fix:**
```typescript
// Add after line 77 (before the ts assertions):
expect(response.statusCode).toBe(200);
```

---

_Reviewed: 2026-05-21T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
