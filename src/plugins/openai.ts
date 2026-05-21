// src/plugins/openai.ts
// Source: RESEARCH.md Pattern 9 — OpenAI client Fastify plugin
// T-03-05: maxRetries: 0 — p-retry owns all retry logic; SDK built-in retry disabled to avoid double backoff
import fp from 'fastify-plugin';
import OpenAI from 'openai';
import type { FastifyPluginAsync } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    openai: OpenAI;
  }
}

const openaiPlugin: FastifyPluginAsync = async (fastify) => {
  const client = new OpenAI({
    apiKey: fastify.config.OPENAI_API_KEY,
    maxRetries: 0, // p-retry handles retries; disable SDK built-in retry to avoid double backoff (T-03-05)
  });
  fastify.decorate('openai', client);
};

export default fp(openaiPlugin, { name: 'openai', dependencies: ['config'] });
