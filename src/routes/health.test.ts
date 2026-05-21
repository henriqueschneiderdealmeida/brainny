// src/routes/health.test.ts
// Integration tests for OPS-01: GET /health endpoint
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import healthRoutes from './health.js';

describe('GET /health', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with {ok: true, db: "ok"} when DB is reachable', async () => {
    // Mock pgPool with a query that resolves
    app.decorate('pgPool', {
      query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    });

    await app.register(healthRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; ts: string; db: string }>();
    expect(body.ok).toBe(true);
    expect(body.db).toBe('ok');
  });

  it('returns 503 with {ok: false, db: "error"} when DB query fails', async () => {
    // Mock pgPool with a query that throws
    app.decorate('pgPool', {
      query: vi.fn().mockRejectedValue(new Error('DB down')),
    });

    await app.register(healthRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(503);
    const body = response.json<{ ok: boolean; ts: string; db: string }>();
    expect(body.ok).toBe(false);
    expect(body.db).toBe('error');
  });

  it('response ts field is a valid ISO 8601 date string', async () => {
    // Mock pgPool with a working query
    app.decorate('pgPool', {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    });

    await app.register(healthRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    const body = response.json<{ ok: boolean; ts: string; db: string }>();
    expect(typeof body.ts).toBe('string');
    // ISO 8601 date: e.g. "2026-05-21T16:51:37.123Z"
    expect(() => new Date(body.ts)).not.toThrow();
    expect(new Date(body.ts).toISOString()).toBe(body.ts);
  });
});
