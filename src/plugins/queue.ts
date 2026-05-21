// src/plugins/queue.ts
// Source: RESEARCH.md Pattern 1 — p-queue Fastify plugin (fastify.queue decorator)
// T-02-05: queue.on('error') prevents unhandled rejections from crashing the process
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import PQueue from 'p-queue';

declare module 'fastify' {
  interface FastifyInstance {
    queue: PQueue;
  }
}

const queuePlugin: FastifyPluginAsync = async (fastify) => {
  const queue = new PQueue({
    concurrency: fastify.config.INGEST_CONCURRENCY,
  });

  // Emit queue errors via Pino — never swallow silently (T-02-05)
  queue.on('error', (err: unknown) => {
    fastify.log.error({ err }, 'Erro inesperado na fila de ingestão');
  });

  fastify.decorate('queue', queue);
};

export default fp(queuePlugin, { name: 'queue', dependencies: ['config'] });
