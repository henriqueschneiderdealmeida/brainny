// src/db/schema.ts
// Source: RESEARCH.md Pattern 5 + orm.drizzle.team/docs/guides/vector-similarity-search
import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    sender: text('sender').notNull(),
    senderName: text('sender_name'),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    type: text('type').notNull(),
    text: text('text'),
    mediaUrl: text('media_url'),
    rawJson: jsonb('raw_json').notNull(), // STORE-02: full raw payload for re-enrichment
    embedding: vector('embedding', { dimensions: 1536 }), // OAI-4: must be exactly 1536
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('messages_embedding_hnsw')
      .using('hnsw', t.embedding.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }), // REG-6: explicit params
    index('messages_chat_ts_idx').on(t.chatId, t.timestamp),
    index('messages_ts_idx').on(t.timestamp),
  ],
);

export const chats = pgTable('chats', {
  id: text('id').primaryKey(),
  name: text('name'),
  isGroup: boolean('is_group').notNull().default(false), // STORE-03
  participantsJson: jsonb('participants_json'), // STORE-03
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});

export const syncState = pgTable('sync_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type SyncState = typeof syncState.$inferSelect;
