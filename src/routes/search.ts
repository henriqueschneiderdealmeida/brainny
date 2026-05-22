// src/routes/search.ts
// SEARCH-01: Bearer token auth via timingSafeEqual (same pattern as webhook auth)
// SEARCH-02: pgvector cosine similarity — top-20 results ordered by embedding <=> query
import { z } from 'zod';
import { sql, isNotNull, gte, lte, and } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { makeSearchAuthHandler } from '../lib/auth.js';
import { messages } from '../db/schema.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const parseFrom = (s: string) => new Date(ISO_DATE_RE.test(s) ? `${s}T00:00:00.000Z` : s);
const parseTo = (s: string) => new Date(ISO_DATE_RE.test(s) ? `${s}T23:59:59.999Z` : s);

const searchResultSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  senderName: z.string().nullable(),
  timestamp: z.date(),
  text: z.string().nullable(),
  score: z.number(),
});

const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(2000),
  from: z.string().optional(),
  to: z.string().optional(),
});

const searchRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const authHandler = makeSearchAuthHandler(fastify.config.SEARCH_TOKEN);

  fastify.get(
    '/search',
    {
      schema: {
        querystring: searchQuerySchema,
        response: {
          200: searchResponseSchema,
          401: z.object({ error: z.string() }),
        },
      },
      preHandler: [authHandler],
    },
    async (request) => {
      const { q, from, to } = request.query;

      const embeddingResult = await fastify.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: q,
      });
      const queryEmbedding = embeddingResult.data[0]!.embedding;
      const embeddingLiteral = `[${queryEmbedding.join(',')}]`;

      const conditions = [
        isNotNull(messages.embedding),
        ...(from ? [gte(messages.timestamp, parseFrom(from))] : []),
        ...(to ? [lte(messages.timestamp, parseTo(to))] : []),
      ];

      const results = await fastify.db
        .select({
          id: messages.id,
          chatId: messages.chatId,
          senderName: messages.senderName,
          timestamp: messages.timestamp,
          text: messages.text,
          score: sql<number>`1 - (embedding <=> ${embeddingLiteral}::vector)`,
        })
        .from(messages)
        .where(and(...conditions))
        .orderBy(sql`embedding <=> ${embeddingLiteral}::vector`)
        .limit(20);

      return { results };
    },
  );
};

export default searchRoutes;
