// src/lib/auth.test.ts
// Unit tests for INGEST-01: timing-safe webhook auth handler
// Covers: factory return type, 401 cases (missing, wrong, shorter, longer, array), pass-through
import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { makeWebhookAuthHandler } from './auth.js';

const SECRET = 'mysecretvalue16'; // 16 chars — meets min(16) constraint

function makeMockRequest(headerValue?: string | string[]): FastifyRequest {
  return {
    headers: {
      'x-webhook-secret': headerValue,
    },
  } as unknown as FastifyRequest;
}

function makeMockReply() {
  const sendFn = vi.fn();
  const codeFn = vi.fn().mockReturnValue({ send: sendFn });
  return {
    code: codeFn,
    send: sendFn,
    _codeFn: codeFn,
    _sendFn: sendFn,
  } as unknown as FastifyReply & { _codeFn: typeof codeFn; _sendFn: typeof sendFn };
}

describe('makeWebhookAuthHandler', () => {
  it('returns a function', () => {
    const handler = makeWebhookAuthHandler(SECRET);
    expect(typeof handler).toBe('function');
  });

  it('sends 401 when x-webhook-secret header is missing entirely', async () => {
    const handler = makeWebhookAuthHandler(SECRET);
    const request = makeMockRequest(undefined);
    const reply = makeMockReply();

    await handler(request, reply as unknown as FastifyReply);

    expect((reply as any)._codeFn).toHaveBeenCalledWith(401);
  });

  it('sends 401 when x-webhook-secret is wrong (same length)', async () => {
    const handler = makeWebhookAuthHandler(SECRET);
    const request = makeMockRequest('wrongsecretval1'); // same length: 16 chars
    const reply = makeMockReply();

    await handler(request, reply as unknown as FastifyReply);

    expect((reply as any)._codeFn).toHaveBeenCalledWith(401);
  });

  it('sends 401 when x-webhook-secret differs only in last character', async () => {
    const handler = makeWebhookAuthHandler(SECRET);
    const request = makeMockRequest('mysecretvalue1X'); // last char differs
    const reply = makeMockReply();

    await handler(request, reply as unknown as FastifyReply);

    expect((reply as any)._codeFn).toHaveBeenCalledWith(401);
  });

  it('sends 401 when x-webhook-secret is shorter (no RangeError thrown)', async () => {
    const handler = makeWebhookAuthHandler(SECRET);
    const request = makeMockRequest('short'); // shorter than expected
    const reply = makeMockReply();

    // Must NOT throw RangeError — length guard prevents timingSafeEqual call
    await expect(handler(request, reply as unknown as FastifyReply)).resolves.toBeUndefined();
    expect((reply as any)._codeFn).toHaveBeenCalledWith(401);
  });

  it('sends 401 when x-webhook-secret is longer (no RangeError thrown)', async () => {
    const handler = makeWebhookAuthHandler(SECRET);
    const request = makeMockRequest('mysecretvalue16extra'); // longer than expected
    const reply = makeMockReply();

    // Must NOT throw RangeError
    await expect(handler(request, reply as unknown as FastifyReply)).resolves.toBeUndefined();
    expect((reply as any)._codeFn).toHaveBeenCalledWith(401);
  });

  it('does NOT send reply when x-webhook-secret matches exactly', async () => {
    const handler = makeWebhookAuthHandler(SECRET);
    const request = makeMockRequest(SECRET); // exact match
    const reply = makeMockReply();

    await handler(request, reply as unknown as FastifyReply);

    // code() should NOT be called — Fastify continues to the route handler
    expect((reply as any)._codeFn).not.toHaveBeenCalled();
  });

  it('sends 401 when x-webhook-secret is an array (not a string)', async () => {
    const handler = makeWebhookAuthHandler(SECRET);
    const request = makeMockRequest([SECRET, SECRET] as unknown as string); // array value
    const reply = makeMockReply();

    await handler(request, reply as unknown as FastifyReply);

    expect((reply as any)._codeFn).toHaveBeenCalledWith(401);
  });
});
