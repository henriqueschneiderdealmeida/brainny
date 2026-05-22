// src/services/materialize.ts
// Materializes WhatsApp messages into per-chat-per-day Markdown files in the Obsidian vault.
// MAT-02: query last 48h window; MAT-03: render Appendix C template; MAT-04: atomic write
import fs from 'node:fs/promises';
import path from 'node:path';
import { gte } from 'drizzle-orm';
import { asc } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import { messages } from '../db/schema.js';
import type { Message } from '../db/schema.js';

export interface MaterializeResult {
  filesWritten: number;
  messagesProcessed: number;
}

/** Returns tz-aware YYYY-MM-DD using fr-CA locale (ISO date format). */
function datePart(ts: Date, tz: string): string {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ts);
}

/** Returns tz-aware HH:MM (24h). */
function timePart(ts: Date, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ts);
}

/**
 * Converts a chatId into a safe filesystem component.
 * Replaces @, ., :, /, \ with underscore; collapses runs; trims edge underscores.
 */
export function safeFilename(chatId: string): string {
  return chatId
    .replace(/[@.:/\\]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Renders the Appendix C Markdown template for one (chat, date) group.
 * Frontmatter: chat_id, chat_name, date, message_count, generated_at
 * Body: ## HH:MM — Name  [type] + text body
 */
export function renderDay(
  chatId: string,
  chatName: string,
  date: string,
  msgs: Message[],
  generatedAt: Date,
  tz: string,
): string {
  const lines: string[] = [
    '---',
    `chat_id: ${chatId}`,
    `chat_name: ${chatName}`,
    `date: ${date}`,
    `message_count: ${msgs.length}`,
    `generated_at: ${generatedAt.toISOString()}`,
    '---',
    '',
    `# ${chatName} — ${date}`,
    '',
  ];

  for (const msg of msgs) {
    const time = timePart(msg.timestamp, tz);
    const name = msg.senderName ?? msg.chatId;
    const typeTag = msg.type !== 'text' ? `  [${msg.type}]` : '';
    lines.push(`## ${time} — ${name}${typeTag}`);
    if (msg.text) lines.push(msg.text);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Writes content atomically: write to {path}.tmp then rename to final path (MAT-04).
 * Creates intermediate directories as needed.
 */
export async function writeAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Main entry point: queries the last 48h of messages from DB, groups by (date, chatId),
 * renders Markdown, and writes atomically to dataDir/{date}/{safeFilename(chatId)}.md.
 *
 * MAT-02: 48h window covers yesterday + today regardless of timezone offset.
 * MAT-03: Markdown template per Appendix C.
 * MAT-04: writeAtomic ensures no partial reads from Obsidian sync.
 */
export async function runMaterialize(
  db: NodePgDatabase<typeof schema>,
  dataDir: string,
  tz: string,
  log: Logger,
): Promise<MaterializeResult> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48h ago

  const rows = await db
    .select()
    .from(messages)
    .where(gte(messages.timestamp, windowStart))
    .orderBy(asc(messages.timestamp));

  if (rows.length === 0) {
    log.debug('materializer: nenhuma mensagem na janela de 48h');
    return { filesWritten: 0, messagesProcessed: 0 };
  }

  // Group by (date, chatId) — Map key keeps insertion order
  const groups = new Map<
    string,
    { chatId: string; chatName: string; date: string; msgs: Message[] }
  >();

  for (const msg of rows) {
    const date = datePart(msg.timestamp, tz);
    const key = `${date}:${msg.chatId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        chatId: msg.chatId,
        chatName: msg.senderName ?? msg.chatId,
        date,
        msgs: [],
      });
    }
    groups.get(key)!.msgs.push(msg);
  }

  let filesWritten = 0;
  for (const { chatId, chatName, date, msgs } of groups.values()) {
    const content = renderDay(chatId, chatName, date, msgs, now, tz);
    const filePath = path.join(dataDir, date, `${safeFilename(chatId)}.md`);
    await writeAtomic(filePath, content);
    filesWritten++;
    log.debug({ filePath, msgCount: msgs.length }, 'materializer: arquivo escrito');
  }

  log.info(
    { filesWritten, messagesProcessed: rows.length },
    'materializer: ciclo concluído',
  );
  return { filesWritten, messagesProcessed: rows.length };
}
