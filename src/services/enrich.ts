// src/services/enrich.ts
// Source: RESEARCH.md Patterns 1-9 — enrichment pipeline for audio, image, text messages
// T-03-01: SSRF guard in downloadMedia — hostname allowlist before any fetch()
// T-03-02: Content-Length check before arrayBuffer(); 25MB hard cap after download
// T-03-04: truncateForEmbedding caps at 8000 chars before embeddings.create
// WhatsApp media is end-to-end encrypted. downloadMediaViaEvolution() calls Evolution API's
// getBase64FromMediaMessage endpoint which uses the stored mediaKey (in rawJson) to decrypt.
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

export interface EvolutionConfig {
  url: string;
  apiKey: string;
  instance: string;
}

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
 * Detects the real image format from buffer magic bytes.
 * Supports WebP, PNG, JPEG, GIF — falls back to image/jpeg for unknown formats.
 */
export function detectImageFormat(buf: Buffer): { mime: string; ext: string } {
  // WebP: bytes 0-3 = RIFF (52 49 46 46) AND bytes 8-11 = WEBP (57 45 42 50)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  // PNG: bytes 0-3 = 89 50 4E 47
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  // JPEG: bytes 0-1 = FF D8
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  // GIF: bytes 0-2 = 47 49 46
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  // Default fallback
  return { mime: 'image/jpeg', ext: 'jpg' };
}

/**
 * Detects the real audio format from buffer magic bytes.
 * Supports OGG, M4A/MP4, MP3, WebM, WAV, FLAC — falls back to audio/ogg for unknown formats.
 */
export function detectAudioFormat(buf: Buffer): { mime: string; ext: string } {
  // OGG: bytes 0-3 = "OggS" (4F 67 67 53)
  if (buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return { mime: 'audio/ogg', ext: 'ogg' };
  }
  // M4A/MP4: bytes 4-7 = "ftyp" (66 74 79 70)
  if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return { mime: 'audio/mp4', ext: 'm4a' };
  }
  // MP3 with ID3 header: bytes 0-2 = "ID3" (49 44 33)
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }
  // MP3 sync word: FF FB, FF F3, FF F2
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) {
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }
  // WebM: bytes 0-3 = 1A 45 DF A3 (EBML)
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { mime: 'audio/webm', ext: 'webm' };
  }
  // WAV: bytes 0-3 = "RIFF" (52 49 46 46) AND bytes 8-11 = "WAVE" (57 41 56 45)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) {
    return { mime: 'audio/wav', ext: 'wav' };
  }
  // FLAC: bytes 0-3 = "fLaC" (66 4C 61 43)
  if (buf.length >= 4 && buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) {
    return { mime: 'audio/flac', ext: 'flac' };
  }
  // Default fallback
  return { mime: 'audio/ogg', ext: 'ogg' };
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
 * Downloads decrypted media via Evolution API's getBase64FromMediaMessage endpoint.
 * WhatsApp media is E2E encrypted — mmg.whatsapp.net serves encrypted bytes that cannot
 * be used directly. Evolution API uses the stored mediaKey (in rawJson) to decrypt and
 * returns a clean base64-encoded buffer.
 */
export async function downloadMediaViaEvolution(
  rawJson: Record<string, unknown>,
  config: EvolutionConfig,
): Promise<Buffer> {
  const endpoint = `${config.url}/chat/getBase64FromMediaMessage/${config.instance}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': config.apiKey,
    },
    body: JSON.stringify({ message: rawJson, convertToMp4: false }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Evolution media download failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as { base64: string; mediaType: string };
  if (!data.base64) {
    throw new Error('Evolution API returned empty base64 for media');
  }
  const buf = Buffer.from(data.base64, 'base64');
  if (buf.byteLength > MAX_MEDIA_BYTES) {
    throw new Error(`Arquivo excede 25MB após download via Evolution: ${buf.byteLength} bytes`);
  }
  return buf;
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
  evolutionConfig: EvolutionConfig,
): Promise<void> {
  let text: string | null = msg.text ?? null;

  switch (msg.type) {
    case 'audio': {
      if (!msg.mediaUrl) {
        log.info({ messageId: msg.id }, 'Áudio sem URL, ignorado');
        break;
      }
      const audioBuf = await downloadMediaViaEvolution(msg.rawJson as Record<string, unknown>, evolutionConfig);
      const { mime: audioMime, ext: audioExt } = detectAudioFormat(audioBuf);
      // ENRICH-01: Whisper with toFile — must be awaited (Pitfall 1 guard: toFile returns Promise)
      // Use detected mime/ext so WhatsApp M4A/OGG/WebM are sent with the correct Content-Type
      const audioFile = await toFile(audioBuf, `${msg.id}.${audioExt}`, { type: audioMime });
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
      await storeAsset(audioBuf, msg.id, audioExt, msg.timestamp as Date, dataDir);
      break;
    }

    case 'image': {
      if (!msg.mediaUrl) {
        log.info({ messageId: msg.id }, 'Imagem sem URL, ignorada');
        break;
      }
      const imageBuf = await downloadMediaViaEvolution(msg.rawJson as Record<string, unknown>, evolutionConfig);
      const { mime, ext: imgExt } = detectImageFormat(imageBuf);
      const base64 = imageBuf.toString('base64');
      const caption = msg.text ?? null;
      // ENRICH-02: Vision with base64 data URL (never Evolution URL — Pitfall 2)
      // Uses detected mime type so WebP/PNG buffers are sent with correct Content-Type
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
                      url: `data:${mime};base64,${base64}`,
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
      await storeAsset(imageBuf, msg.id, imgExt, msg.timestamp as Date, dataDir);
      break;
    }

    case 'document': {
      if (!msg.mediaUrl) break;
      const docBuf = await downloadMediaViaEvolution(msg.rawJson as Record<string, unknown>, evolutionConfig);
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
