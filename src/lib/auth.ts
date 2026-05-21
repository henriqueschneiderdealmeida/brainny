// src/lib/auth.ts
// Source: RESEARCH.md Pattern 2 — timing-safe webhook auth preHandler factory
// T-02-01: crypto.timingSafeEqual with pre-request length guard; secret never logged
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Creates a Fastify preHandler that validates the X-Webhook-Secret header
 * using constant-time comparison (crypto.timingSafeEqual).
 *
 * Security notes:
 *   - expectedBuf is computed once in the closure, not per-request.
 *   - Length is checked before timingSafeEqual to avoid RangeError (RESEARCH Pitfall 1).
 *   - The secret value is NEVER logged anywhere in this handler.
 */
export function makeWebhookAuthHandler(secret: string) {
  // Compute once — avoids per-request Buffer allocation for the expected value
  const expectedBuf = Buffer.from(secret, 'utf8');

  return async function validateWebhookSecret(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const provided = request.headers['x-webhook-secret'];

    // Reject non-string values (missing header, array, etc.)
    if (typeof provided !== 'string') {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const providedBuf = Buffer.from(provided, 'utf8');

    // Guard length mismatch BEFORE timingSafeEqual to avoid RangeError (Pitfall 1)
    if (providedBuf.byteLength !== expectedBuf.byteLength) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    // Constant-time comparison — prevents timing attacks (T-02-01)
    if (!timingSafeEqual(providedBuf, expectedBuf)) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    // All checks passed — do NOT call reply.send(); Fastify continues to route handler
  };
}
