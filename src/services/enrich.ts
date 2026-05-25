// src/services/enrich.ts
// Source: RESEARCH.md Patterns 1-9 — enrichment pipeline for audio, image, text messages
// T-03-01: SSRF guard in downloadMedia — hostname allowlist before any fetch()
// T-03-02: Content-Length check before arrayBuffer(); 25MB hard cap after download
// T-03-04: truncateForEmbedding caps at 8000 chars before embeddings.create
import OpenAI, { toFile, APIError } from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions.js';
import PQueue from 'p-queue';
import pRetry, { AbortError } from 'p-retry';
import { eq } from 'drizzle-orm';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { messages } from '../db/schema.js';
import type { NormalizedMessage } from './ingest.js';
import * as schema from '../db/schema.js';

// Module-level constants
const MAX_EMBED_CHARS = 8000;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25MB

// Module-level PQueue singletons — one per OpenAI endpoint (different RPM limits)
// Source: RESEARCH.md Pattern 7
export const whisperQueue = new PQueue({ concurrency: 1, intervalCap: 3, interval: 60_000 });
export const visionQueue = new PQueue({ concurrency: 2, intervalCap: 10, interval: 60_000 });
export const embeddingQueue = new PQueue({ concurrency: 3, intervalCap: 20, interval: 60_000 });

/**
 * Retry wrapper for OpenAI calls.
 * Aborts on 4xx client errors (except 429 Too Many Requests).
 * Note: randomize: true is the p-retry v6 jitter option (not jitter: 'full' which is v5 syntax — RESEARCH Pitfall 6)
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(fn, {
    retries: 4,
    minTimeout: 1000,
    maxTimeout: 30_000,
    factor: 2,
    randomize: true, // p-retry v6 jitter option (NOT jitter: 'full' — that is v5 syntax)
    onFailedAttempt: (error) => {
      if (
        error instanceof APIError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      ) {
        throw new AbortError(error);
      }
    },
  });
}

/**
 * Truncates text to MAX_EMBED_CHARS and warns via Pino if truncation occurred.
 * ENRICH-04: warn log includes messageId, originalLength, truncatedLength.
 */
export function truncateForEmbedding(text: string, messageId: string, log: Logger): string {
  if (text.length <= MAX_EMBED_CHARS) return text;
  log.warn(
    { messageId, originalLength: text.length, truncatedLength: MAX_EMBED_CHARS },
    'Texto truncado antes de gerar embedding',
  );
  return text.slice(0, MAX_EMBED_CHARS);
}

/**
 * Downloads media from a URL with SSRF guard and size limits.
 * T-03-01: Validates protocol (HTTPS only) and hostname against allowedHostname.
 * T-03-02: Checks Content-Length before buffering; hard cap after download.
 * Source: RESEARCH.md Pattern 6
 */
export async function downloadMedia(url: string, allowedHostnames: string[]): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL de mídia inválida: ${url}`);
  }

  // T-03-01: HTTPS only
  if (parsed.protocol !== 'https:') {
    throw new Error('Apenas HTTPS é permitido para download de mídia');
  }

  // T-03-01: Hostname allowlist — Evolution API host + WhatsApp CDN (mmg.whatsapp.net)
  if (!allowedHostnames.includes(parsed.hostname)) {
    throw new Error(`Hostname não permitido para download de mídia: ${parsed.hostname}`);
  }

  // 30-second timeout via AbortSignal.timeout (Node 17.3+, stable on Node 22)
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  if (!response.ok) {
    throw new Error(`Download falhou: ${response.status} ${response.statusText}`);
  }

  // T-03-02: Check Content-Length before buffering (Pitfall 8 guard)
  const cl = parseInt(response.headers.get('content-length') ?? '0', 10);
  if (cl > MAX_MEDIA_BYTES) {
    throw new Error(`Arquivo excede 25MB pelo Content-Length: ${cl} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();

  // T-03-02: Hard cap after download (Content-Length may be missing or spoofed)
  if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
    throw new Error(`Arquivo excede 25MB após download: ${arrayBuffer.byteLength} bytes`);
  }

  return Buffer.from(arrayBuffer);
}

/**
 * Stores a media buffer to disk atomically (tmp → rename).
 * ENRICH-05: date-partitioned path data/YYYY-MM-DD/assets/<id>.<ext>
 * Uses msg.timestamp (not new Date()) for date derivation — correct for backfill.
 * Pitfall 7 guard: tmpPath is in the same directory as finalPath (same filesystem).
 * Source: RESEARCH.md Pattern 5
 */
export async function storeAsset(
  buffer: Buffer,
  messageId: string,
  ext: string,
  timestamp: Date,
  dataDir: string,
): Promise<string> {
  const dateStr = timestamp.toISOString().slice(0, 10); // YYYY-MM-DD from message timestamp
  const dir = join(dataDir, dateStr, 'assets');
  await mkdir(dir, { recursive: true });

  const finalPath = join(dir, `${messageId}.${ext}`);
  const tmpPath = `${finalPath}.tmp`; // same dir — atomic rename on same filesystem (Pitfall 7)

  await writeFile(tmpPath, buffer);
  await rename(tmpPath, finalPath);

  return finalPath;
}

/**
 * Enriches a persisted message with text (via Whisper/Vision) and embedding.
 * Runs after persistMessage in the ingest queue job.
 * Accepts allowedHostname to keep service testable without Fastify config.
 * Source: RESEARCH.md Architecture Diagram
 */
export async function enrichMessage(
  db: NodePgDatabase<typeof schema>,
  openai: OpenAI,
  msg: NormalizedMessage,
  log: Logger,
  dataDir: string,
  allowedHostnames: string[],
): Promise<void> {
  let text: string | null = msg.text ?? null;

  switch (msg.type) {
    case 'audio': {
      if (!msg.mediaUrl) {
        log.info({ messageId: msg.id }, 'Áudio sem URL, ignorado');
        break;
      }
      const audioBuf = await downloadMedia(msg.mediaUrl, allowedHostnames);
      // ENRICH-01: Whisper with toFile — must be awaited (Pitfall 1 guard: toFile returns Promise)
      const audioFile = await toFile(audioBuf, `${msg.id}.ogg`, { type: 'audio/ogg' });
      text = (await whisperQueue.add(() =>
        withRetry(() =>
          openai.audio.transcriptions.create({
            file: audioFile,
            model: 'whisper-1',
            language: 'pt',
            response_format: 'text',
          }),
        ),
      )) as string;
      await storeAsset(audioBuf, msg.id, 'ogg', msg.timestamp as Date, dataDir);
      break;
    }

    case 'image': {
      if (!msg.mediaUrl) {
        log.info({ messageId: msg.id }, 'Imagem sem URL, ignorada');
        break;
      }
      const imageBuf = await downloadMedia(msg.mediaUrl, allowedHostnames);
      const base64 = imageBuf.toString('base64');
      const caption = msg.text ?? null;
      // ENRICH-02: Vision with base64 data URL (never Evolution URL — Pitfall 2)
      const visionResult = (await visionQueue.add(() =>
        withRetry(() =>
          openai.chat.completions.create({
            model: 'gpt-4o-mini',
            max_tokens: 300,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/jpeg;base64,${base64}`,
                      detail: 'low', // ~85 tokens/image (CLAUDE.md recommendation)
                    },
                  },
                  {
                    type: 'text',
                    text: 'Descreva esta imagem de forma concisa em português do Brasil.',
                  },
                ],
              },
            ],
          }),
        ),
      )) as ChatCompletion;
      const description = visionResult.choices[0]?.message?.content ?? null;
      text = caption ? `${caption}\n${description}` : description ?? null;
      await storeAsset(imageBuf, msg.id, 'jpg', msg.timestamp as Date, dataDir);
      break;
    }

    case 'document': {
      if (!msg.mediaUrl) break;
      const docBuf = await downloadMedia(msg.mediaUrl, allowedHostnames);
      const rawDoc = msg.rawJson as { documentMessage?: { fileName?: string } };
      const ext = rawDoc.documentMessage?.fileName?.split('.').pop() ?? 'bin';
      await storeAsset(docBuf, msg.id, ext, msg.timestamp as Date, dataDir);
      text = msg.text ?? null; // fileName set by ingest.ts — no OpenAI call for documents
      break;
    }

    case 'video': {
      log.info(
        { messageId: msg.id, type: 'video' },
        'Vídeo ignorado — enriquecimento não implementado nesta fase',
      );
      return; // skip all enrichment including embedding
    }

    case 'sticker': {
      log.info(
        { messageId: msg.id, type: 'sticker' },
        'Sticker ignorado — enriquecimento não implementado nesta fase',
      );
      return; // skip all enrichment including embedding
    }

    default: {
      // text, location, contact, reaction — text already set from msg.text above
      break;
    }
  }

  // Skip embedding if no text produced
  if (text === null || text.trim() === '') return;

  const embeddableText = truncateForEmbedding(text, msg.id, log);

  // ENRICH-03: Generate embedding via text-embedding-3-small (1536 dims)
  const embeddingResult = (await embeddingQueue.add(() =>
    withRetry(() =>
      openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: embeddableText,
      }),
    ),
  )) as Awaited<ReturnType<typeof openai.embeddings.create>>;

  const embedding = embeddingResult.data[0]!.embedding as number[];

  // ENRICH-03: UPDATE the already-persisted row with text + embedding (Drizzle Pattern 8)
  await db.update(messages).set({ text, embedding }).where(eq(messages.id, msg.id));
}
