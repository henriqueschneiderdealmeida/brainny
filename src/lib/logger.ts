// src/lib/logger.ts
// Pino factory — createLogger(level) returns a configured Pino instance
// T-02-01 mitigation: redact DATABASE_URL and connection strings from logs
// T-02-06 mitigation: redact X-Webhook-Secret from access logs (INGEST-01)
import pino from 'pino';

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    redact: ['*.connectionString', '*.DATABASE_URL', '*.password', "req.headers['x-webhook-secret']"],
  });
}
