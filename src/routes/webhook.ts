// src/routes/webhook.ts
// Source: RESEARCH.md Pattern 3 — reply-then-enqueue with per-message error isolation
// T-02-06: X-Webhook-Secret redacted in Pino (logger.ts)
// T-02-07: loose Zod body schema with passthrough() — new Evolution fields never cause 400
// T-02-08: route-level bodyLimit 25MB for base64 media payloads (Pitfall 7)
// T-02-09: per-message try/catch prevents queue stall on single job failure
// T-02-10: preHandler: [authHandler] on the route directly (not global hook)
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { z } from 'zod';
import { makeWebhookAuthHandler } from '../lib/auth.js';
import { extractMessages } from '../services/ingest.js';
import { persistMessage } from '../services/persist.js';
import { enrichMessage } from '../services/enrich.js';

// Intentionally loose schema — Evolution body parsing happens in services/ingest.ts.
// passthrough() ensures new top-level Evolution fields never produce a 400 (RESEARCH Pitfall 6).
const webhookBodySchema = z
  .object({
    event: z.string(),
    instance: z.string(),
    data: z.unknown(),
  })
  .passthrough();

// Route plugin — does NOT use fp() (only decorator plugins use fp)
// eslint-disable-next-line @typescript-eslint/require-await
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
      // Route-level bodyLimit: Evolution may send base64 media inline (EVO-2, RESEARCH Pitfall 7)
      // Other routes retain the 10MB Fastify default
      bodyLimit: 25 * 1024 * 1024, // 25 MB
    },
    async (request, reply) => {
      // INGEST-02: respond immediately BEFORE enqueuing work (RESEARCH Pitfall 2 — never await queue.add)
      await reply.send({ ok: true });

      const body = request.body;
      const log = fastify.log.child({
        module: 'webhook',
        event: (body as { event?: string }).event,
      });

      // T-03-07: derive allowedHostname from EVOLUTION_URL once per request
      // EVOLUTION_URL is validated as z.string().url() by Zod at startup — new URL() will not throw
      const allowedHostname = new URL(fastify.config.EVOLUTION_URL).hostname;

      // queue.on('error') in queue plugin handles task failures — no void needed
      // Pitfall 2: do NOT await — that would block until the job completes
      fastify.queue.add(async () => {
        const messages = extractMessages(body, log as unknown as Logger);

        for (const msg of messages) {
          // INGEST-05: each message isolated — one failure does NOT stop siblings
          try {
            await persistMessage(fastify.db, msg);
          } catch (err: unknown) {
            // INGEST-06: structured Pino error log with messageId, errorCode, phase
            log.error(
              {
                messageId: msg.id,
                errorCode: err instanceof Error ? err.constructor.name : 'UnknownError',
                phase: 'persist',
                err,
              },
              'Falha ao persistir mensagem',
            );
            // Do NOT rethrow — sibling messages must continue processing (INGEST-05)
            continue; // skip enrichment if persist failed
          }

          // ENRICH: enrich the persisted message — isolated from persist and sibling messages
          try {
            await enrichMessage(
              fastify.db,
              fastify.openai,
              msg,
              log as unknown as Logger, // FastifyBaseLogger is structurally compatible with pino.Logger at runtime
              fastify.config.DATA_DIR,
              allowedHostname,
            );
          } catch (err: unknown) {
            log.error(
              {
                messageId: msg.id,
                errorCode: err instanceof Error ? err.constructor.name : 'UnknownError',
                phase: 'enrich',
                err,
              },
              'Falha ao enriquecer mensagem',
            );
            // Do NOT rethrow — message is persisted; partial enrichment is acceptable
          }
        }
      });
    },
  );
};

export default webhookRoutes;
