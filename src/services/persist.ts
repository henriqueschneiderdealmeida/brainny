// src/services/persist.ts
// Source: RESEARCH.md Pattern 5 — Drizzle insert with ON CONFLICT DO NOTHING
// T-02-04: onConflictDoNothing on messages.id PK — replayed webhooks are no-ops
// STORE-03: chat upsert on every message — keeps chats.lastSeenAt current
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import { messages, chats } from '../db/schema.js';
import type { NormalizedMessage } from './ingest.js';

/**
 * Persists a single normalized message and upserts its chat metadata.
 * ON CONFLICT DO NOTHING on messages.id — duplicate deliveries are no-ops.
 * ON CONFLICT DO UPDATE on chats.id — keeps name and lastSeenAt fresh (STORE-03).
 */
export async function persistMessage(
  db: NodePgDatabase<typeof schema>,
  msg: NormalizedMessage,
): Promise<void> {
  await db.insert(messages).values(msg).onConflictDoNothing();

  // STORE-03: upsert chat metadata — isGroup inferred from chatId suffix
  const isGroup = msg.chatId.endsWith('@g.us');
  await db
    .insert(chats)
    .values({
      id: msg.chatId,
      name: msg.senderName ?? msg.chatId,
      isGroup,
      participantsJson: null,
      lastSeenAt: msg.timestamp,
    })
    .onConflictDoUpdate({
      target: chats.id,
      set: {
        name: msg.senderName ?? msg.chatId,
        lastSeenAt: msg.timestamp,
      },
    });
}
