import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(), // postgresql://user:pass@postgres:5432/whatsapp_brain
  EVOLUTION_URL: z.string().url(), // https://evolution.yowa.com.br — used for SSRF allowlist derivation
  EVOLUTION_API_KEY: z.string().min(1), // API key for Evolution instance
  EVOLUTION_INSTANCE: z.string().min(1).default('brainny'), // Evolution instance name

  // Phase 2+ — included now so app boots in full later without schema changes:
  OPENAI_API_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(16),
  SEARCH_TOKEN: z.string().min(16),

  DATA_DIR: z.string().default('./data'), // Obsidian vault path
  TIMEZONE: z.string().default('America/Sao_Paulo'),
  INGEST_CONCURRENCY: z.coerce.number().int().positive().default(3),
  MATERIALIZER_CRON: z.string().default('*/5 * * * *'),
  TZ: z.string().default('America/Sao_Paulo'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Use console.error here ONLY — this is the one pre-logger boot path
    // eslint-disable-next-line no-console
    console.error('ENV validation failed:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}
