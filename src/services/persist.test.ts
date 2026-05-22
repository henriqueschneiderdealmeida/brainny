// src/services/persist.test.ts
// Unit tests for persistMessage — INGEST-04 (dedup) + STORE-02 (rawJson) + STORE-03 (chat upsert)
import { describe, it, expect, vi } from 'vitest';
import { persistMessage } from './persist.js';
import type { NormalizedMessage } from './ingest.js';
import { messages, chats } from '../db/schema.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';

// Build a mock db that handles two insert chains:
//   1st insert: messages → .values().onConflictDoNothing()
//   2nd insert: chats   → .values().onConflictDoUpdate(...)
function makeMockDb() {
  const onConflictDoNothingFn = vi.fn().mockResolvedValue([]);
  const onConflictDoUpdateFn = vi.fn().mockResolvedValue([]);

  let callCount = 0;
  const valuesFn = vi.fn().mockImplementation(() => {
    callCount++;
    // Odd calls = messages (onConflictDoNothing), even = chats (onConflictDoUpdate)
    return callCount % 2 === 1
      ? { onConflictDoNothing: onConflictDoNothingFn }
      : { onConflictDoUpdate: onConflictDoUpdateFn };
  });

  const insertFn = vi.fn().mockReturnValue({ values: valuesFn });

  const mockDb = { insert: insertFn } as unknown as NodePgDatabase<typeof schema>;

  return { mockDb, insertFn, valuesFn, onConflictDoNothingFn, onConflictDoUpdateFn };
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
  // ── INGEST-04: dedup ──────────────────────────────────────────────────

  it('calls db.insert(messages).values(msg).onConflictDoNothing()', async () => {
    const { mockDb, insertFn, valuesFn, onConflictDoNothingFn } = makeMockDb();

    await persistMessage(mockDb, sampleMsg);

    expect(insertFn).toHaveBeenCalledWith(messages);
    expect(valuesFn).toHaveBeenCalledWith(sampleMsg);
    expect(onConflictDoNothingFn).toHaveBeenCalledTimes(1);
  });

  it('calling twice with the same msg does NOT throw (dedup is a no-op)', async () => {
    const { mockDb } = makeMockDb();
    await expect(persistMessage(mockDb, sampleMsg)).resolves.toBeUndefined();
    await expect(persistMessage(mockDb, sampleMsg)).resolves.toBeUndefined();
  });

  it('returns Promise<void> (no return value)', async () => {
    const { mockDb } = makeMockDb();
    const result = await persistMessage(mockDb, sampleMsg);
    expect(result).toBeUndefined();
  });

  // ── STORE-03: chat upsert ─────────────────────────────────────────────

  it('calls insert twice — messages then chats', async () => {
    const { mockDb, insertFn } = makeMockDb();

    await persistMessage(mockDb, sampleMsg);

    expect(insertFn).toHaveBeenCalledTimes(2);
    expect(insertFn).toHaveBeenNthCalledWith(1, messages);
    expect(insertFn).toHaveBeenNthCalledWith(2, chats);
  });

  it('upserts chat with isGroup=false for DM chatId (@s.whatsapp.net)', async () => {
    const { mockDb, valuesFn } = makeMockDb();
    const msg: NormalizedMessage = { ...sampleMsg, chatId: '5511999@s.whatsapp.net', senderName: 'Alice' };

    await persistMessage(mockDb, msg);

    const chatInsertArg = valuesFn.mock.calls[1]![0] as { id: string; isGroup: boolean; name: string };
    expect(chatInsertArg.id).toBe('5511999@s.whatsapp.net');
    expect(chatInsertArg.isGroup).toBe(false);
    expect(chatInsertArg.name).toBe('Alice');
  });

  it('upserts chat with isGroup=true for group chatId (@g.us)', async () => {
    const { mockDb, valuesFn } = makeMockDb();
    const msg: NormalizedMessage = { ...sampleMsg, chatId: '5511GROUP@g.us', senderName: 'Grupo Família' };

    await persistMessage(mockDb, msg);

    const chatInsertArg = valuesFn.mock.calls[1]![0] as { isGroup: boolean };
    expect(chatInsertArg.isGroup).toBe(true);
  });

  it('falls back to chatId as name when senderName is null', async () => {
    const { mockDb, valuesFn } = makeMockDb();
    const msg: NormalizedMessage = { ...sampleMsg, chatId: '5511999@s.whatsapp.net', senderName: null };

    await persistMessage(mockDb, msg);

    const chatInsertArg = valuesFn.mock.calls[1]![0] as { name: string };
    expect(chatInsertArg.name).toBe('5511999@s.whatsapp.net');
  });

  it('onConflictDoUpdate sets name and lastSeenAt', async () => {
    const { mockDb, onConflictDoUpdateFn } = makeMockDb();

    await persistMessage(mockDb, sampleMsg);

    expect(onConflictDoUpdateFn).toHaveBeenCalledOnce();
    const updateArg = onConflictDoUpdateFn.mock.calls[0]![0] as {
      target: unknown;
      set: { name: string; lastSeenAt: Date };
    };
    expect(updateArg.set.name).toBe(sampleMsg.senderName);
    expect(updateArg.set.lastSeenAt).toEqual(sampleMsg.timestamp);
  });
});
