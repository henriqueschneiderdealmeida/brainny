#!/usr/bin/env tsx
/**
 * Backfill CLI — fetches historical WhatsApp messages from Evolution API
 * Usage: tsx scripts/backfill.ts [--chat <chatId>] [--page-size <n>]
 * Resumes from sync_state cursor on re-run (BACKFILL-02)
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import type OpenAI from 'openai';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { syncState } from '../src/db/schema.js';
import { extractMessages } from '../src/services/ingest.js';
import { persistMessage } from '../src/services/persist.js';
import { enrichMessage } from '../src/services/enrich.js';

// CLI arg parsing
const args = process.argv.slice(2);
const pageSizeArg = args[args.indexOf('--page-size') + 1];
const pageSize = pageSizeArg ? parseInt(pageSizeArg, 10) : 50;
const chatFilter = args.includes('--chat') ? args[args.indexOf('--chat') + 1] : null;

// Fetch with Retry-After support (BACKFILL-01)
async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  log: pino.Logger,
  maxRetries = 5,
): Promise<Response> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    const res = await fetch(url, { headers });
    if (res.status !== 429) return res;
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
    log.warn({ retryAfter, attempt }, 'backfill: 429 rate limit — aguardando');
    await new Promise<void>((r) => setTimeout(r, retryAfter * 1000));
    attempt++;
  }
  throw new Error(`Máximo de tentativas (${maxRetries}) excedido — rate limiting persistente`);
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] !== 'production') {
    const dotenv = await import('dotenv');
    dotenv.config();
  }

  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });
  const pool = createPool(config.DATABASE_URL);
  const db = drizzle(pool, { schema });

  const { default: OpenAIClass } = await import('openai') as { default: typeof OpenAI & (new (...args: unknown[]) => OpenAI) };
  const openai = new OpenAIClass({ apiKey: config.OPENAI_API_KEY, maxRetries: 0 });

  const evolutionHostname = new URL(config.EVOLUTION_URL).hostname;
  const headers = { apikey: config.EVOLUTION_API_KEY };

  // Determine chats to backfill
  let chatIds: string[];
  if (chatFilter) {
    chatIds = [chatFilter];
  } else {
    const chatsUrl = `${config.EVOLUTION_URL}/chat/findChats/${config.EVOLUTION_INSTANCE}`;
    const res = await fetchWithRetry(chatsUrl, headers, log);
    if (!res.ok) throw new Error(`Falha ao buscar lista de chats: ${res.status} ${res.statusText}`);
    const chatsData = (await res.json()) as Array<{ id: string }>;
    chatIds = chatsData.map((c) => c.id);
  }

  log.info({ chatCount: chatIds.length, pageSize }, 'backfill: iniciando');

  let totalProcessed = 0;
  let totalSkipped = 0;

  for (const chatId of chatIds) {
    const cursorKey = `backfill.cursor.${chatId}`;

    // Load saved cursor (BACKFILL-02)
    const [cursorRow] = await db
      .select()
      .from(syncState)
      .where(eq(syncState.key, cursorKey));

    let cursor: string | undefined = cursorRow
      ? (cursorRow.value as { messageId?: string }).messageId
      : undefined;

    log.info({ chatId, cursor: cursor ?? 'none' }, 'backfill: processando chat');

    let chatProcessed = 0;
    let pagesFetched = 0;

    for (;;) {
      const params = new URLSearchParams({ count: String(pageSize) });
      if (cursor) params.set('messageId', cursor);

      const url = `${config.EVOLUTION_URL}/chat/findMessages/${config.EVOLUTION_INSTANCE}?remoteJid=${encodeURIComponent(chatId)}&${params.toString()}`;
      const res = await fetchWithRetry(url, headers, log);

      if (!res.ok) {
        log.error({ chatId, status: res.status }, 'backfill: falha ao buscar página — pulando chat');
        break;
      }

      type FindMessagesResponse = { messages?: { records?: unknown[] } };
      const data = (await res.json()) as FindMessagesResponse;
      const records: unknown[] = data.messages?.records ?? [];

      if (records.length === 0) {
        log.info({ chatId, pagesFetched }, 'backfill: chat concluído (sem mais registros)');
        break;
      }

      // Wrap records as fake MESSAGES_UPSERT body to reuse extractMessages (BACKFILL-01)
      const fakeBody = { event: 'MESSAGES_UPSERT', data: records };
      const msgs = extractMessages(fakeBody, log);

      for (const msg of msgs) {
        try {
          await persistMessage(db, msg);
          await enrichMessage(db, openai, msg, log, config.DATA_DIR, evolutionHostname);
          chatProcessed++;
          totalProcessed++;
        } catch (err) {
          log.error({ err, msgId: msg.id }, 'backfill: erro ao processar mensagem — pulando');
          totalSkipped++;
        }
      }

      // Persist cursor to last record id (BACKFILL-02)
      const lastRecord = records[records.length - 1] as { key?: { id?: string } } | undefined;
      const lastId = lastRecord?.key?.id;
      if (lastId) {
        cursor = lastId;
        await db
          .insert(syncState)
          .values({ key: cursorKey, value: { messageId: cursor } })
          .onConflictDoUpdate({
            target: syncState.key,
            set: { value: { messageId: cursor }, updatedAt: new Date() },
          });
      }

      pagesFetched++;
      log.debug({ chatId, pagesFetched, pageRecords: records.length, chatProcessed }, 'backfill: página concluída');

      if (records.length < pageSize) {
        log.info({ chatId, pagesFetched }, 'backfill: chat concluído (última página)');
        break;
      }
    }
  }

  log.info({ totalProcessed, totalSkipped }, 'backfill: todos os chats concluídos');
  await pool.end();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Erro fatal no backfill:', err);
  process.exit(1);
});
