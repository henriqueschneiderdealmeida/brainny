// src/index.ts
// Source: RESEARCH.md Pattern 1 — Fastify 5 + ZodTypeProvider app bootstrap
// T-02-03 mitigation: BOTH validatorCompiler AND serializerCompiler registered
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import cron from 'node-cron';
import type { Logger } from 'pino';
import { loadConfig } from './config.js';
import configPlugin from './plugins/config.js';
import dbPlugin from './plugins/db.js';
import openaiPlugin from './plugins/openai.js';
import queuePlugin from './plugins/queue.js';
import healthRoutes from './routes/health.js';
import webhookRoutes from './routes/webhook.js';
import searchRoutes from './routes/search.js';
import { runMaterialize } from './services/materialize.js';

async function main() {
  // Load dotenv in non-production only
  if (process.env['NODE_ENV'] !== 'production') {
    const dotenv = await import('dotenv');
    dotenv.config();
  }

  // Zod parse — exits with code 1 on failure (OPS-02)
  const config = loadConfig();

  const app = Fastify({
    // T-02-01: redact DATABASE_URL from logs
    logger: {
      level: config.LOG_LEVEL,
      redact: ['*.connectionString', '*.DATABASE_URL', '*.password', "req.headers['x-webhook-secret']"],
    },
    bodyLimit: 10 * 1024 * 1024, // 10 MB default; override per-route for media
  });

  // Must be set BEFORE any route registration (T-02-03: prevents PII leak via extra fields)
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register plugins in order: configPlugin MUST come before dbPlugin and openaiPlugin
  // openaiPlugin depends on configPlugin (fp dependency: ['config'])
  await app.register(configPlugin, { config });
  await app.register(dbPlugin);
  await app.register(openaiPlugin);
  await app.register(queuePlugin);

  // Routes use the ZodTypeProvider typed instance
  const api = app.withTypeProvider<ZodTypeProvider>();
  await api.register(healthRoutes);
  await api.register(webhookRoutes);
  await api.register(searchRoutes);

  // Start listening
  await app.listen({ port: config.PORT, host: config.HOST });

  // MAT-01: Schedule materializer with overlap guard
  let materializerRunning = false;

  const materializerTask = cron.schedule(
    config.MATERIALIZER_CRON,
    async () => {
      if (materializerRunning) {
        app.log.info('materializer: tick skipped (already running)');
        return;
      }
      materializerRunning = true;
      const tickStart = Date.now();
      app.log.info('materializer: tick started');
      try {
        const result = await runMaterialize(
          app.db,
          config.DATA_DIR,
          config.TIMEZONE,
          app.log as unknown as Logger,
        );
        const duration = Date.now() - tickStart;
        app.log.info(
          {
            filesWritten: result.filesWritten,
            messagesProcessed: result.messagesProcessed,
            durationMs: duration,
          },
          'materializer: tick complete',
        );
      } catch (err) {
        app.log.error({ err }, 'materializer: tick failed');
      } finally {
        materializerRunning = false;
      }
    },
    { timezone: config.TIMEZONE, noOverlap: true },
  );

  // Graceful shutdown: stop cron, drain queue, close Fastify (OPS-03 partial)
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    materializerTask.stop();
    await app.queue.onIdle();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
