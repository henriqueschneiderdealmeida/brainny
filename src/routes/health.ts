// src/routes/health.ts
// Source: RESEARCH.md Pattern 7 — GET /health endpoint
// OPS-01: returns {ok, ts, db} — 200 when DB reachable, 503 when not
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const healthResponseSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  db: z.enum(['ok', 'error']),
});

// eslint-disable-next-line @typescript-eslint/require-await
const healthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema, 503: healthResponseSchema } } },
    async (_req, reply) => {
      let dbStatus: 'ok' | 'error' = 'ok';
      try {
        await fastify.pgPool.query('SELECT 1');
      } catch {
        dbStatus = 'error';
        // Log but don't propagate — health endpoint must always respond
        fastify.log.warn('health check: DB unreachable');
      }
      return reply.code(dbStatus === 'ok' ? 200 : 503).send({
        ok: dbStatus === 'ok',
        ts: new Date().toISOString(),
        db: dbStatus,
      });
    },
  );
};

export default healthRoutes;
