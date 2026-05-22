// src/routes/search.test.ts
// Integration tests for GET /search
// Covers: SEARCH-01 (Bearer token auth), SEARCH-02 (pgvector cosine similarity)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import fp from 'fastify-plugin';
import PQueue from 'p-queue';
import type { FastifyPluginAsync } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';

import searchRoutes from './search.js';

// ── Constants ──────────────────────────────────────────────────────────────
const TEST_TOKEN = 'testsearchtoken123456'; // min 16 chars

// ── Helpers ───────────────────────────────────────────────────────────────
const MOCK_EMBEDDING = Array.from({ length: 1536 }, (_, i) => i / 1536);

const SAMPLE_DB_RESULTS = [
  {
    id: 'MSG001',
    chatId: '5511999@s.whatsapp.net',
    senderName: 'Alice',
    timestamp: new Date('2024-05-21T12:00:00Z'),
    text: 'Olá mundo',
    score: 0.92,
  },
  {
    id: 'MSG002',
    chatId: '5511888@s.whatsapp.net',
    senderName: 'Bob',
    timestamp: new Date('2024-05-21T11:00:00Z'),
    text: 'Bom dia',
    score: 0.85,
  },
];

function makeMockDb(results = SAMPLE_DB_RESULTS): NodePgDatabase<typeof schema> {
  const limitFn = vi.fn().mockResolvedValue(results);
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn } as unknown as NodePgDatabase<typeof schema>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockOpenAI(embedding = MOCK_EMBEDDING): any {
  return {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding }],
      }),
    },
  };
}

const mockQueuePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate('queue', new PQueue({ concurrency: 1 }));
};

async function buildApp(dbResults = SAMPLE_DB_RESULTS) {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('config', {
    NODE_ENV: 'test' as const,
    PORT: 3000,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
    EVOLUTION_URL: 'https://evolution.yowa.com.br',
    OPENAI_API_KEY: 'test-key',
    WEBHOOK_SECRET: 'testsecretvalue12345',
    SEARCH_TOKEN: TEST_TOKEN,
    DATA_DIR: '/tmp/test',
    INGEST_CONCURRENCY: 1,
    MATERIALIZER_CRON: '*/5 * * * *',
    TZ: 'America/Sao_Paulo',
    LOG_LEVEL: 'silent' as const,
  });

  app.decorate('db', makeMockDb(dbResults));
  app.decorate('openai', makeMockOpenAI());

  await app.register(fp(mockQueuePlugin, { name: 'queue' }));
  await app.register(searchRoutes);

  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe('GET /search', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // SEARCH-01: Auth — missing header
  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=test',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
  });

  // SEARCH-01: Auth — wrong token
  it('returns 401 when Bearer token is wrong', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=test',
      headers: { authorization: 'Bearer wrongtoken1234567' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
  });

  // SEARCH-01: Auth — non-Bearer scheme
  it('returns 401 when Authorization header is not Bearer scheme', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=test',
      headers: { authorization: `Basic ${TEST_TOKEN}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
  });

  // SEARCH-02: Success — correct token returns results
  it('returns 200 with results when token is correct', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=Olá',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: unknown[] };
    expect(body).toHaveProperty('results');
    expect(Array.isArray(body.results)).toBe(true);
  });

  // SEARCH-02: Embedding call uses text-embedding-3-small model
  it('calls openai.embeddings.create with text-embedding-3-small and the query', async () => {
    const mockOpenAI = makeMockOpenAI();
    // Override openai on the app instance before register (rebuild app with custom openai)
    const customApp = Fastify({ logger: false });
    customApp.setValidatorCompiler(validatorCompiler);
    customApp.setSerializerCompiler(serializerCompiler);
    customApp.decorate('config', {
      NODE_ENV: 'test' as const,
      PORT: 3000,
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
      EVOLUTION_URL: 'https://evolution.yowa.com.br',
      OPENAI_API_KEY: 'test-key',
      WEBHOOK_SECRET: 'testsecretvalue12345',
      SEARCH_TOKEN: TEST_TOKEN,
      DATA_DIR: '/tmp/test',
      INGEST_CONCURRENCY: 1,
      MATERIALIZER_CRON: '*/5 * * * *',
      TZ: 'America/Sao_Paulo',
      LOG_LEVEL: 'silent' as const,
    });
    customApp.decorate('db', makeMockDb());
    customApp.decorate('openai', mockOpenAI);
    await customApp.register(fp(mockQueuePlugin, { name: 'queue' }));
    await customApp.register(searchRoutes);

    await customApp.inject({
      method: 'GET',
      url: '/search?q=mensagem+de+texto',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(mockOpenAI.embeddings.create).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: 'mensagem de texto',
    });

    await customApp.close();
  });

  // SEARCH-02: Returns empty results when DB returns []
  it('returns empty results array when no embeddings match', async () => {
    const emptyApp = Fastify({ logger: false });
    emptyApp.setValidatorCompiler(validatorCompiler);
    emptyApp.setSerializerCompiler(serializerCompiler);
    emptyApp.decorate('config', {
      NODE_ENV: 'test' as const,
      PORT: 3000,
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
      EVOLUTION_URL: 'https://evolution.yowa.com.br',
      OPENAI_API_KEY: 'test-key',
      WEBHOOK_SECRET: 'testsecretvalue12345',
      SEARCH_TOKEN: TEST_TOKEN,
      DATA_DIR: '/tmp/test',
      INGEST_CONCURRENCY: 1,
      MATERIALIZER_CRON: '*/5 * * * *',
      TZ: 'America/Sao_Paulo',
      LOG_LEVEL: 'silent' as const,
    });
    emptyApp.decorate('db', makeMockDb([]));
    emptyApp.decorate('openai', makeMockOpenAI());
    await emptyApp.register(fp(mockQueuePlugin, { name: 'queue' }));
    await emptyApp.register(searchRoutes);

    const res = await emptyApp.inject({
      method: 'GET',
      url: '/search?q=test',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [] });

    await emptyApp.close();
  });

  // SEARCH-01: Missing q param returns 400
  it('returns 400 when query param q is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.statusCode).toBe(400);
  });

  // SEARCH-02: Results have correct shape
  it('results have expected fields: id, chatId, senderName, timestamp, text, score', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=test',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Record<string, unknown>[] };
    const first = body.results[0];
    expect(first).toBeDefined();
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('chatId');
    expect(first).toHaveProperty('senderName');
    expect(first).toHaveProperty('timestamp');
    expect(first).toHaveProperty('text');
    expect(first).toHaveProperty('score');
  });
});
