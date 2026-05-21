// src/services/persist.test.ts
// Unit tests for INGEST-04: persistMessage uses onConflictDoNothing for deduplication
import { describe, it, expect, vi } from 'vitest';
import { persistMessage } from './persist.js';
import type { NormalizedMessage } from './ingest.js';
import { messages } from '../db/schema.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';

// Build a mock db that supports the chained insert().values().onConflictDoNothing() pattern
function makeMockDb() {
  const onConflictDoNothingFn = vi.fn().mockResolvedValue([]);
  const valuesFn = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingFn });
  const insertFn = vi.fn().mockReturnValue({ values: valuesFn });

  const mockDb = {
    insert: insertFn,
  } as unknown as NodePgDatabase<typeof schema>;

  return { mockDb, insertFn, valuesFn, onConflictDoNothingFn };
}

const sampleMsg: NormalizedMessage = {
  id: 'TEST_MSG_001',
  chatId: '5511999999001@s.whatsapp.net',
  sender: '5511999999001@s.whatsapp.net',
  senderName: 'Remetente Teste',
  timestamp: new Date(1716307200 * 1000),
  type: 'text',
  text: 'Olá mundo',
  mediaUrl: null,
  rawJson: { key: { id: 'TEST_MSG_001' } },
  embedding: null,
};

describe('persistMessage', () => {
  it('calls db.insert(messages).values(msg).onConflictDoNothing()', async () => {
    const { mockDb, insertFn, valuesFn, onConflictDoNothingFn } = makeMockDb();

    await persistMessage(mockDb, sampleMsg);

    expect(insertFn).toHaveBeenCalledWith(messages);
    expect(valuesFn).toHaveBeenCalledWith(sampleMsg);
    expect(onConflictDoNothingFn).toHaveBeenCalledTimes(1);
  });

  it('calling twice with the same msg does NOT throw (dedup is a no-op)', async () => {
    const { mockDb } = makeMockDb();

    // First call
    await expect(persistMessage(mockDb, sampleMsg)).resolves.toBeUndefined();
    // Second call (same id — simulates duplicate webhook delivery)
    await expect(persistMessage(mockDb, sampleMsg)).resolves.toBeUndefined();
  });

  it('returns Promise<void> (no return value)', async () => {
    const { mockDb } = makeMockDb();

    const result = await persistMessage(mockDb, sampleMsg);
    expect(result).toBeUndefined();
  });
});
