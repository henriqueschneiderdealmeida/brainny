// src/services/persist.ts
// Source: RESEARCH.md Pattern 5 — Drizzle insert with ON CONFLICT DO NOTHING
// T-02-04: onConflictDoNothing on messages.id PK — replayed webhooks are no-ops
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import { messages } from '../db/schema.js';
import type { NormalizedMessage } from './ingest.js';

/**
 * Persists a single normalized message to the database.
 * ON CONFLICT DO NOTHING on messages.id (PK) — duplicate webhook deliveries are no-ops.
 * No logging inside this function — logging belongs in the caller (route handler).
 */
export async function persistMessage(
  db: NodePgDatabase<typeof schema>,
  msg: NormalizedMessage,
): Promise<void> {
  await db.insert(messages).values(msg).onConflictDoNothing();
}
