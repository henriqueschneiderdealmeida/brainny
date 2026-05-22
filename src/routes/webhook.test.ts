// src/routes/webhook.test.ts
// Integration tests for POST /webhook/evolution
// Covers: INGEST-02 (200 immediately), INGEST-05 (error isolation), INGEST-06 (structured error log)
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
import type { NormalizedMessage } from '../services/ingest.js';

// ── Module mocks (must be before imports of the modules being mocked) ──────
vi.mock('../services/ingest.js', () => ({
  extractMessages: vi.fn(),
}));

vi.mock('../services/persist.js', () => ({
  persistMessage: vi.fn(),
}));

vi.mock('../services/enrich.js', () => ({
  enrichMessage: vi.fn().mockResolvedValue(undefined),
}));

// Dynamic imports AFTER vi.mock() to get the mocked versions
const { extractMessages } = await import('../services/ingest.js');
const { persistMessage } = await import('../services/persist.js');
const { enrichMessage } = await import('../services/enrich.js');

import webhookRoutes from './webhook.js';

// ── Constants ──────────────────────────────────────────────────────────────
const TEST_SECRET = 'testsecretvalue12345'; // min 16 chars

// ── Helpers ───────────────────────────────────────────────────────────────
function makeMockDb(): NodePgDatabase<typeof schema> {
  const onConflictDoNothingFn = vi.fn().mockResolvedValue([]);
  const valuesFn = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingFn });
  const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
  return { insert: insertFn } as unknown as NodePgDatabase<typeof schema>;
}

// Mock queue plugin: provides a real PQueue instance as fastify.queue
const mockQueuePlugin: FastifyPluginAsync = async (fastify) => {
  const queue = new PQueue({ concurrency: 1 });
  fastify.decorate('queue', queue);
};

// Build a test Fastify app with all required decorators registered
async function buildApp() {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Provide fastify.config
  app.decorate('config', {
    NODE_ENV: 'test' as const,
    PORT: 3000,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
    EVOLUTION_URL: 'https://evolution.yowa.com.br',
    OPENAI_API_KEY: 'test-openai-key',
    WEBHOOK_SECRET: TEST_SECRET,
    SEARCH_TOKEN: 'testsearchtoken123456',
    DATA_DIR: '/tmp/test',
    INGEST_CONCURRENCY: 1,
    MATERIALIZER_CRON: '*/5 * * * *',
    TZ: 'America/Sao_Paulo',
    LOG_LEVEL: 'silent' as const,
  });

  // Provide fastify.db
  app.decorate('db', makeMockDb());

  // Provide fastify.openai stub — enrichMessage is mocked so this object is never actually called
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.decorate('openai', {} as any);

  // Provide fastify.queue via the mock plugin (fp so it's visible to sub-plugins)
  await app.register(fp(mockQueuePlugin, { name: 'queue' }));

  // Register the route under test
  await app.register(webhookRoutes);

  return app;
}

// Sample valid MESSAGES_UPSERT body
const validBody = {
  event: 'MESSAGES_UPSERT',
  instance: 'brainny',
  data: {
    key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'MSG001' },
    pushName: 'Test',
    messageType: 'conversation',
    messageTimestamp: 1716307200,
    message: { conversation: 'Olá' },
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────
describe('POST /webhook/evolution', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Restore default enrichMessage implementation after clearAllMocks wipes call records
    vi.mocked(enrichMessage).mockResolvedValue(undefined);
    app = await buildApp();
  });

  afterEach(async () => {
    // Drain pending queue jobs before closing so they don't bleed into the next test
    await app.queue.onIdle();
    await app.close();
  });

  // INGEST-01: Auth guard — missing header
  it('returns 401 when X-Webhook-Secret header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      payload: validBody,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
  });

  // INGEST-01: Auth guard — wrong secret
  it('returns 401 when X-Webhook-Secret header is wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      headers: { 'x-webhook-secret': 'wrongsecretvalue123' },
      payload: validBody,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
  });

  // INGEST-02: Correct secret returns 200 {ok: true}
  it('returns 200 {ok: true} with correct X-Webhook-Secret', async () => {
    // Return empty array so no persistMessage calls
    vi.mocked(extractMessages).mockReturnValue([]);

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      headers: { 'x-webhook-secret': TEST_SECRET },
      payload: validBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  // INGEST-02: Fire-and-forget — 200 arrives BEFORE queue job completes
  it('returns 200 before queue job resolves (fire-and-forget timing)', async () => {
    let persistResolved = false;

    const normalizedMsg: NormalizedMessage = {
      id: 'MSG001',
      chatId: '5511999999999@s.whatsapp.net',
      sender: '5511999999999@s.whatsapp.net',
      senderName: 'Test',
      timestamp: new Date(1716307200 * 1000),
      type: 'text',
      text: 'Olá',
      mediaUrl: null,
      rawJson: {},
      embedding: null,
    };

    vi.mocked(extractMessages).mockReturnValue([normalizedMsg]);
    vi.mocked(persistMessage).mockImplementation(async () => {
      // Simulate slow persist (100ms delay)
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      persistResolved = true;
    });

    const start = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      headers: { 'x-webhook-secret': TEST_SECRET },
      payload: validBody,
    });
    const elapsed = Date.now() - start;

    // Response must arrive quickly (before 80ms — well before the 100ms persist delay)
    expect(res.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(80);
    // At the time the HTTP response was received, persist had NOT yet resolved
    expect(persistResolved).toBe(false);
  });

  // INGEST-06: Failed persistMessage logs error with {messageId, phase: 'persist'}
  it('calls fastify.log.error with {messageId, phase: "persist"} when persistMessage throws', async () => {
    const logErrorSpy = vi.fn();
    // Replace the logger on the app instance
    Object.defineProperty(app, 'log', {
      value: { ...app.log, error: logErrorSpy, child: vi.fn().mockReturnValue({ error: logErrorSpy, debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) },
      writable: true,
    });

    const badMsg: NormalizedMessage = {
      id: 'bad-id',
      chatId: '5511999999999@s.whatsapp.net',
      sender: '5511999999999@s.whatsapp.net',
      senderName: 'Test',
      timestamp: new Date(1716307200 * 1000),
      type: 'text',
      text: 'Bad message',
      mediaUrl: null,
      rawJson: {},
      embedding: null,
    };

    vi.mocked(extractMessages).mockReturnValue([badMsg]);
    vi.mocked(persistMessage).mockRejectedValue(new Error('DB write failed'));

    await app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      headers: { 'x-webhook-secret': TEST_SECRET },
      payload: validBody,
    });

    // Wait for queue job to finish
    await app.queue.onIdle();

    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'bad-id',
        phase: 'persist',
      }),
      expect.any(String),
    );
  });

  // INGEST-05: Error isolation — sibling messages still processed when one fails
  it('continues processing sibling messages when one persistMessage throws', async () => {
    const badMsg: NormalizedMessage = {
      id: 'bad-id',
      chatId: '5511@s.whatsapp.net',
      sender: '5511@s.whatsapp.net',
      senderName: 'Bad',
      timestamp: new Date(1716307200 * 1000),
      type: 'text',
      text: 'bad',
      mediaUrl: null,
      rawJson: {},
      embedding: null,
    };

    const goodMsg: NormalizedMessage = {
      id: 'good-id',
      chatId: '5511@s.whatsapp.net',
      sender: '5511@s.whatsapp.net',
      senderName: 'Good',
      timestamp: new Date(1716307200 * 1000),
      type: 'text',
      text: 'good',
      mediaUrl: null,
      rawJson: {},
      embedding: null,
    };

    vi.mocked(extractMessages).mockReturnValue([badMsg, goodMsg]);
    vi.mocked(persistMessage).mockImplementation(async (_db, msg) => {
      if (msg.id === 'bad-id') {
        throw new Error('DB write failed');
      }
      // good-id: resolves normally
    });

    await app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      headers: { 'x-webhook-secret': TEST_SECRET },
      payload: validBody,
    });

    // Wait for queue to drain
    await app.queue.onIdle();

    // persistMessage must have been called for both messages
    expect(vi.mocked(persistMessage)).toHaveBeenCalledTimes(2);
    // good-id call must have resolved without rethrowing
    const calls = vi.mocked(persistMessage).mock.calls;
    const goodCall = calls.find(([, msg]) => msg.id === 'good-id');
    expect(goodCall).toBeDefined();
  });

  // ENRICH wiring: enrichMessage is called after persist for audio messages
  it('calls enrichMessage after persistMessage for audio message', async () => {
    const audioMsg: NormalizedMessage = {
      id: 'FIXTURE_AUDIO_003',
      chatId: '5511999999003@s.whatsapp.net',
      sender: '5511999999003@s.whatsapp.net',
      senderName: 'Remetente Audio',
      timestamp: new Date(1716307320 * 1000),
      type: 'audio',
      text: null,
      mediaUrl: 'https://evolution.yowa.com.br/audio.ogg',
      rawJson: {},
      embedding: null,
    };

    vi.mocked(extractMessages).mockReturnValue([audioMsg]);
    vi.mocked(persistMessage).mockResolvedValue(undefined);
    vi.mocked(enrichMessage).mockResolvedValue(undefined);

    await app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      headers: { 'x-webhook-secret': TEST_SECRET },
      payload: validBody,
    });

    await app.queue.onIdle();

    expect(vi.mocked(enrichMessage)).toHaveBeenCalledOnce();
    expect(vi.mocked(enrichMessage)).toHaveBeenCalledWith(
      expect.anything(), // fastify.db
      expect.anything(), // fastify.openai
      expect.objectContaining({ id: 'FIXTURE_AUDIO_003', type: 'audio' }),
      expect.anything(), // log
      '/tmp/test',       // DATA_DIR
      'evolution.yowa.com.br', // allowedHostname derived from EVOLUTION_URL
    );
  });

  // ENRICH wiring: enrichMessage failure does not surface to HTTP layer (returns 200)
  it('enrichMessage failure does not break 200 response', async () => {
    const audioMsg: NormalizedMessage = {
      id: 'enrich-fail-id',
      chatId: '5511999999003@s.whatsapp.net',
      sender: '5511999999003@s.whatsapp.net',
      senderName: 'Test',
      timestamp: new Date(1716307320 * 1000),
      type: 'audio',
      text: null,
      mediaUrl: 'https://evolution.yowa.com.br/audio.ogg',
      rawJson: {},
      embedding: null,
    };

    vi.mocked(extractMessages).mockReturnValue([audioMsg]);
    vi.mocked(persistMessage).mockResolvedValue(undefined);
    vi.mocked(enrichMessage).mockRejectedValue(new Error('OpenAI API error'));

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      headers: { 'x-webhook-secret': TEST_SECRET },
      payload: validBody,
    });

    // HTTP response must still be 200 regardless of enrichment failure
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await app.queue.onIdle();
    // enrichMessage was called but threw — no rethrow propagated
    expect(vi.mocked(enrichMessage)).toHaveBeenCalledOnce();
  });

  // ENRICH wiring: enrichMessage failure is isolated per message — sibling still attempted
  it('enrichMessage failure is isolated per message — sibling messages still processed', async () => {
    const msg1: NormalizedMessage = {
      id: 'msg-1',
      chatId: '5511@s.whatsapp.net',
      sender: '5511@s.whatsapp.net',
      senderName: 'First',
      timestamp: new Date(1716307320 * 1000),
      type: 'audio',
      text: null,
      mediaUrl: 'https://evolution.yowa.com.br/audio1.ogg',
      rawJson: {},
      embedding: null,
    };
    const msg2: NormalizedMessage = {
      id: 'msg-2',
      chatId: '5511@s.whatsapp.net',
      sender: '5511@s.whatsapp.net',
      senderName: 'Second',
      timestamp: new Date(1716307320 * 1000),
      type: 'text',
      text: 'hello',
      mediaUrl: null,
      rawJson: {},
      embedding: null,
    };

    vi.mocked(extractMessages).mockReturnValue([msg1, msg2]);
    vi.mocked(persistMessage).mockResolvedValue(undefined);
    // enrichMessage throws only for first call, succeeds for second
    vi.mocked(enrichMessage)
      .mockRejectedValueOnce(new Error('Enrich error for msg-1'))
      .mockResolvedValueOnce(undefined);

    await app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      headers: { 'x-webhook-secret': TEST_SECRET },
      payload: validBody,
    });

    await app.queue.onIdle();

    // Both messages must have had enrichMessage attempted
    expect(vi.mocked(enrichMessage)).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(enrichMessage).mock.calls;
    expect(calls[0]?.[2]).toMatchObject({ id: 'msg-1' });
    expect(calls[1]?.[2]).toMatchObject({ id: 'msg-2' });
  });

  // Non-MESSAGES_UPSERT events: return 200, extractMessages returns [], nothing persisted
  it('returns 200 for non-MESSAGES_UPSERT event — extractMessages returns [], nothing persisted', async () => {
    vi.mocked(extractMessages).mockReturnValue([]);

    const connectionStatusBody = {
      event: 'CONNECTION_UPDATE',
      instance: 'brainny',
      data: { state: 'open' },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/evolution',
      headers: { 'x-webhook-secret': TEST_SECRET },
      payload: connectionStatusBody,
    });

    // Wait for queue to drain
    await app.queue.onIdle();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(vi.mocked(persistMessage)).not.toHaveBeenCalled();
  });
});
