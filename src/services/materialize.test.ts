// src/services/materialize.test.ts
// Unit tests for materialize.ts — MAT-02, MAT-03, MAT-04
// Covers: safeFilename, empty-window short-circuit, writeAtomic atomic pattern,
// multi-chat grouping, multi-date grouping, Markdown rendering, and tmp→final rename.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import type { Message } from '../db/schema.js';

// ─── Mock node:fs/promises ────────────────────────────────────────────────────
// vi.mock is hoisted to the top of the file by vitest. Variables referenced inside the
// factory must also be hoisted via vi.hoisted() so they are initialized before the mock
// factory runs. See: https://vitest.dev/api/vi.html#vi-hoisted
const { mockMkdir, mockWriteFile, mockRename } = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockRename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    rename: mockRename,
  },
}));

// Import after mocks are set up
import { safeFilename, renderDay, runMaterialize } from './materialize.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TZ = 'America/Sao_Paulo';
const DATA_DIR = '/vault/WhatsApp';
const GENERATED_AT = new Date('2026-05-22T12:00:00Z');

const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} satisfies Partial<Logger> as unknown as Logger;

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'MSG_001',
    chatId: '5511999999001@s.whatsapp.net',
    sender: '5511999999001@s.whatsapp.net',
    senderName: 'Alice',
    timestamp: new Date('2026-05-22T14:00:00Z'), // 11:00 in America/Sao_Paulo (UTC-3)
    type: 'text',
    text: 'Olá mundo',
    mediaUrl: null,
    rawJson: {},
    embedding: null,
    createdAt: new Date('2026-05-22T14:00:00Z'),
    ...overrides,
  };
}

/** Build a mock DB whose select().from().where().orderBy() chain resolves to `rows`. */
function makeMockDb(rows: Message[]): NodePgDatabase<typeof schema> {
  const orderByFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn } as unknown as NodePgDatabase<typeof schema>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('safeFilename', () => {
  it('replaces @ with underscore', () => {
    expect(safeFilename('5511999@s.whatsapp.net')).not.toContain('@');
  });

  it('replaces . with underscore', () => {
    expect(safeFilename('5511999@s.whatsapp.net')).not.toContain('.');
  });

  it('replaces : with underscore', () => {
    expect(safeFilename('chat:123')).not.toContain(':');
  });

  it('collapses multiple underscores into one', () => {
    const result = safeFilename('5511999@s.whatsapp.net');
    expect(result).not.toMatch(/__+/);
  });

  it('does not start or end with underscore', () => {
    const result = safeFilename('5511999@s.whatsapp.net');
    expect(result).not.toMatch(/^_|_$/);
  });
});

describe('runMaterialize — empty window (MAT-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns {filesWritten:0, messagesProcessed:0} when DB returns no messages', async () => {
    const db = makeMockDb([]);
    const result = await runMaterialize(db, DATA_DIR, TZ, mockLog);
    expect(result).toEqual({ filesWritten: 0, messagesProcessed: 0 });
  });

  it('does not call writeFile when there are no messages', async () => {
    const db = makeMockDb([]);
    await runMaterialize(db, DATA_DIR, TZ, mockLog);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe('runMaterialize — atomic write pattern (MAT-04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls writeFile with a .tmp path before rename', async () => {
    const db = makeMockDb([makeMessage()]);
    await runMaterialize(db, DATA_DIR, TZ, mockLog);

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const tmpPath = mockWriteFile.mock.calls[0]![0] as string;
    expect(tmpPath).toMatch(/\.tmp$/);
  });

  it('calls rename after writeFile, moving .tmp to final path', async () => {
    const db = makeMockDb([makeMessage()]);
    await runMaterialize(db, DATA_DIR, TZ, mockLog);

    expect(mockRename).toHaveBeenCalledOnce();
    const [tmpPath, finalPath] = mockRename.mock.calls[0] as [string, string];
    expect(tmpPath).toMatch(/\.tmp$/);
    expect(finalPath).not.toMatch(/\.tmp$/);
    // tmp path is final path + .tmp
    expect(tmpPath).toBe(finalPath + '.tmp');
  });

  it('creates the directory before writing', async () => {
    const db = makeMockDb([makeMessage()]);
    await runMaterialize(db, DATA_DIR, TZ, mockLog);

    expect(mockMkdir).toHaveBeenCalledOnce();
    const [dir, opts] = mockMkdir.mock.calls[0] as [string, { recursive: boolean }];
    expect(opts.recursive).toBe(true);
    expect(typeof dir).toBe('string');
  });
});

describe('runMaterialize — multi-chat grouping (MAT-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('two messages from different chats on the same date → 2 files written', async () => {
    const sameDay = new Date('2026-05-22T14:00:00Z');
    const msgA = makeMessage({ id: 'A', chatId: 'chatA@s.whatsapp.net', timestamp: sameDay });
    const msgB = makeMessage({ id: 'B', chatId: 'chatB@s.whatsapp.net', timestamp: sameDay });

    const db = makeMockDb([msgA, msgB]);
    const result = await runMaterialize(db, DATA_DIR, TZ, mockLog);

    expect(result.filesWritten).toBe(2);
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
  });
});

describe('runMaterialize — multi-date grouping (MAT-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('two messages from same chat on different dates → 2 files written', async () => {
    // Use timestamps that are on different calendar days in America/Sao_Paulo (UTC-3)
    // 2026-05-21T05:00:00Z = 2026-05-21 02:00 local
    // 2026-05-22T14:00:00Z = 2026-05-22 11:00 local
    const msgDay1 = makeMessage({
      id: 'D1',
      chatId: 'chat@s.whatsapp.net',
      timestamp: new Date('2026-05-21T05:00:00Z'),
    });
    const msgDay2 = makeMessage({
      id: 'D2',
      chatId: 'chat@s.whatsapp.net',
      timestamp: new Date('2026-05-22T14:00:00Z'),
    });

    const db = makeMockDb([msgDay1, msgDay2]);
    const result = await runMaterialize(db, DATA_DIR, TZ, mockLog);

    expect(result.filesWritten).toBe(2);
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
  });
});

describe('renderDay — Markdown output (MAT-03)', () => {
  const chatId = '5511999999001@s.whatsapp.net';
  const chatName = 'Alice';
  const date = '2026-05-22';
  const msgs: Message[] = [makeMessage()];

  it('output contains YAML frontmatter with chat_id field', () => {
    const md = renderDay(chatId, chatName, date, msgs, GENERATED_AT, TZ);
    expect(md).toContain(`chat_id: ${chatId}`);
  });

  it('output contains YAML frontmatter with date field', () => {
    const md = renderDay(chatId, chatName, date, msgs, GENERATED_AT, TZ);
    expect(md).toContain(`date: ${date}`);
  });

  it('output contains YAML frontmatter with message_count field', () => {
    const md = renderDay(chatId, chatName, date, msgs, GENERATED_AT, TZ);
    expect(md).toContain(`message_count: ${msgs.length}`);
  });

  it('output contains message section header ## HH:MM — Name', () => {
    const md = renderDay(chatId, chatName, date, msgs, GENERATED_AT, TZ);
    // timestamp 2026-05-22T14:00:00Z = 11:00 in America/Sao_Paulo (UTC-3)
    expect(md).toMatch(/## \d{2}:\d{2} — Alice/);
  });

  it('output contains the message text body', () => {
    const md = renderDay(chatId, chatName, date, msgs, GENERATED_AT, TZ);
    expect(md).toContain('Olá mundo');
  });

  it('non-text type appends [type] tag to section header', () => {
    const audioMsg = makeMessage({ type: 'audio', text: null });
    const md = renderDay(chatId, chatName, date, [audioMsg], GENERATED_AT, TZ);
    expect(md).toContain('[audio]');
  });

  it('text type does NOT append [type] tag', () => {
    const md = renderDay(chatId, chatName, date, msgs, GENERATED_AT, TZ);
    expect(md).not.toContain('[text]');
  });

  it('output starts with YAML front-matter fence (---)', () => {
    const md = renderDay(chatId, chatName, date, msgs, GENERATED_AT, TZ);
    expect(md.trimStart()).toMatch(/^---\n/);
  });
});
