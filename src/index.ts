// src/index.ts
// Source: RESEARCH.md Pattern 1 — Fastify 5 + ZodTypeProvider app bootstrap
// T-02-03 mitigation: BOTH validatorCompiler AND serializerCompiler registered
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { loadConfig } from './config.js';
import configPlugin from './plugins/config.js';
import dbPlugin from './plugins/db.js';
import queuePlugin from './plugins/queue.js';
import healthRoutes from './routes/health.js';
import webhookRoutes from './routes/webhook.js';

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

  // Register plugins in order: configPlugin MUST come before dbPlugin, queuePlugin after dbPlugin
  await app.register(configPlugin, { config });
  await app.register(dbPlugin);
  await app.register(queuePlugin);

  // Routes use the ZodTypeProvider typed instance
  const api = app.withTypeProvider<ZodTypeProvider>();
  await api.register(healthRoutes);
  await api.register(webhookRoutes);

  // Start listening
  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
