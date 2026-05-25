// src/services/enrich.test.ts
// Unit tests for enrich.ts — covers ENRICH-01 through ENRICH-05
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// Mock openai before importing enrich.ts so the module uses mocked version
vi.mock('openai', async () => {
  const toFile = vi.fn(async (_buf: unknown, name: string, opts?: { type?: string }) => ({
    name,
    type: opts?.type ?? 'application/octet-stream',
  }));

  const mockTranscriptionsCreate = vi.fn().mockResolvedValue('transcrição de áudio');
  const mockCompletionsCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'descrição da imagem' } }],
  });
  const mockEmbeddingsCreate = vi.fn().mockResolvedValue({
    data: [{ embedding: new Array(1536).fill(0.1) }],
  });

  const MockOpenAI = vi.fn().mockImplementation(() => ({
    audio: { transcriptions: { create: mockTranscriptionsCreate } },
    chat: { completions: { create: mockCompletionsCreate } },
    embeddings: { create: mockEmbeddingsCreate },
  }));

  class MockAPIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'APIError';
    }
  }

  class MockAbortError extends Error {
    constructor(message: string | Error) {
      super(typeof message === 'string' ? message : message.message);
      this.name = 'AbortError';
    }
  }

  return {
    default: MockOpenAI,
    toFile,
    APIError: MockAPIError,
    AbortError: MockAbortError,
  };
});

// Mock p-retry to run the function directly (no actual delays in tests)
vi.mock('p-retry', () => ({
  default: vi.fn(async (fn: () => unknown) => fn()),
  AbortError: class AbortError extends Error {
    constructor(msg: string | Error) {
      super(typeof msg === 'string' ? msg : msg.message);
    }
  },
}));

import {
  downloadMedia,
  truncateForEmbedding,
  storeAsset,
  enrichMessage,
  detectImageFormat,
  detectAudioFormat,
} from './enrich.js';

// Clear all mock call counts between tests so they don't bleed across describe blocks
beforeEach(() => {
  vi.clearAllMocks();
});

// Helper: build a minimal mock NormalizedMessage
function makeMsg(
  overrides: Partial<{
    id: string;
    type: string;
    text: string | null;
    mediaUrl: string | null;
    timestamp: Date;
    rawJson: Record<string, unknown>;
  }> = {},
) {
  return {
    id: 'msg-001',
    chatId: 'chat-001',
    sender: 'sender@s.whatsapp.net',
    senderName: 'Tester',
    timestamp: new Date('2024-01-15T12:00:00Z'),
    type: 'text',
    text: 'olá',
    mediaUrl: null,
    rawJson: {},
    embedding: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// Helper: build a chainable mock db (update().set().where())
function makeMockDb() {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  const updateMock = vi.fn().mockReturnValue({ set: setMock });
  return {
    db: { update: updateMock },
    updateMock,
    setMock,
    whereMock,
  };
}

// Helper: mock logger
function makeMockLog() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// Helper: mock openai instance from mocked class
async function makeMockOpenAI() {
  const { default: MockOpenAI } = await import('openai');
  return new (MockOpenAI as unknown as new () => {
    audio: { transcriptions: { create: ReturnType<typeof vi.fn> } };
    chat: { completions: { create: ReturnType<typeof vi.fn> } };
    embeddings: { create: ReturnType<typeof vi.fn> };
  })();
}

// ─── describe: downloadMedia ──────────────────────────────────────────────────

describe('downloadMedia', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects non-HTTPS URL with descriptive error', async () => {
    await expect(
      downloadMedia('http://evolution.yowa.com.br/media/audio.ogg', ['evolution.yowa.com.br']),
    ).rejects.toThrow('Apenas HTTPS é permitido para download de mídia');
  });

  it('rejects hostname not in allowedHostnames', async () => {
    await expect(
      downloadMedia('https://evil.example.com/media/audio.ogg', ['evolution.yowa.com.br']),
    ).rejects.toThrow('Hostname não permitido para download de mídia: evil.example.com');
  });

  it('accepts mmg.whatsapp.net when it is in the allowedHostnames list', async () => {
    const sampleData = new Uint8Array([1, 2, 3]).buffer;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: vi.fn().mockResolvedValue(sampleData),
    }));

    const buf = await downloadMedia(
      'https://mmg.whatsapp.net/media/audio.ogg',
      ['evolution.yowa.com.br', 'mmg.whatsapp.net'],
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it('rejects mmg.whatsapp.net when it is NOT in the allowedHostnames list', async () => {
    await expect(
      downloadMedia('https://mmg.whatsapp.net/media/audio.ogg', ['evolution.yowa.com.br']),
    ).rejects.toThrow('Hostname não permitido para download de mídia: mmg.whatsapp.net');
  });

  it('throws for invalid URL before any fetch', async () => {
    await expect(downloadMedia('not-a-url', ['evolution.yowa.com.br'])).rejects.toThrow(
      'URL de mídia inválida',
    );
  });

  it('checks Content-Length header before buffering and throws if > 25MB', async () => {
    const oversizedCl = (25 * 1024 * 1024 + 1).toString();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => (h === 'content-length' ? oversizedCl : null) },
      arrayBuffer: vi.fn(),
    }));

    await expect(
      downloadMedia('https://evolution.yowa.com.br/media/big.ogg', ['evolution.yowa.com.br']),
    ).rejects.toThrow('Content-Length');
  });

  it('returns Buffer for valid HTTPS URL matching allowedHostnames', async () => {
    const sampleData = new Uint8Array([1, 2, 3, 4]).buffer;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: vi.fn().mockResolvedValue(sampleData),
    }));

    const buf = await downloadMedia(
      'https://evolution.yowa.com.br/media/audio.ogg',
      ['evolution.yowa.com.br'],
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.byteLength).toBe(4);
  });

  it('throws after download if buffer exceeds 25MB', async () => {
    const oversized = new ArrayBuffer(25 * 1024 * 1024 + 1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: vi.fn().mockResolvedValue(oversized),
    }));

    await expect(
      downloadMedia('https://evolution.yowa.com.br/media/big.ogg', ['evolution.yowa.com.br']),
    ).rejects.toThrow('25MB após download');
  });
});

// ─── describe: truncateForEmbedding ──────────────────────────────────────────

describe('truncateForEmbedding', () => {
  it('returns text unchanged when text.length <= 8000', () => {
    const log = makeMockLog();
    const text = 'a'.repeat(8000);
    const result = truncateForEmbedding(text, 'msg-1', log as never);
    expect(result).toBe(text);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns sliced text when text.length > 8000', () => {
    const log = makeMockLog();
    const text = 'b'.repeat(9000);
    const result = truncateForEmbedding(text, 'msg-2', log as never);
    expect(result).toHaveLength(8000);
    expect(result).toBe(text.slice(0, 8000));
  });

  it('calls log.warn with messageId, originalLength, truncatedLength when truncated', () => {
    const log = makeMockLog();
    truncateForEmbedding('c'.repeat(9500), 'msg-3', log as never);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      { messageId: 'msg-3', originalLength: 9500, truncatedLength: 8000 },
      'Texto truncado antes de gerar embedding',
    );
  });
});

// ─── describe: detectImageFormat ─────────────────────────────────────────────

describe('detectImageFormat', () => {
  it('detects WebP from RIFF+WEBP magic bytes', () => {
    // Construct a minimal buffer with RIFF at 0-3 and WEBP at 8-11
    const buf = Buffer.alloc(12);
    buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46; // RIFF
    buf[8] = 0x57; buf[9] = 0x45; buf[10] = 0x42; buf[11] = 0x50; // WEBP
    expect(detectImageFormat(buf)).toEqual({ mime: 'image/webp', ext: 'webp' });
  });

  it('detects PNG from magic bytes 89 50 4E 47', () => {
    const buf = Buffer.alloc(8);
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
    expect(detectImageFormat(buf)).toEqual({ mime: 'image/png', ext: 'png' });
  });

  it('detects JPEG from magic bytes FF D8', () => {
    const buf = Buffer.alloc(4);
    buf[0] = 0xff; buf[1] = 0xd8;
    expect(detectImageFormat(buf)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  });

  it('returns fallback image/jpeg for empty/unknown buffer', () => {
    expect(detectImageFormat(Buffer.alloc(10))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(detectImageFormat(Buffer.alloc(0))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  });
});

// ─── describe: detectAudioFormat ─────────────────────────────────────────────

describe('detectAudioFormat', () => {
  it('detects OGG from OggS magic bytes', () => {
    const buf = Buffer.alloc(8);
    buf[0] = 0x4f; buf[1] = 0x67; buf[2] = 0x67; buf[3] = 0x53; // OggS
    expect(detectAudioFormat(buf)).toEqual({ mime: 'audio/ogg', ext: 'ogg' });
  });

  it('detects M4A from ftyp magic bytes at offset 4', () => {
    const buf = Buffer.alloc(12);
    buf[4] = 0x66; buf[5] = 0x74; buf[6] = 0x79; buf[7] = 0x70; // ftyp
    expect(detectAudioFormat(buf)).toEqual({ mime: 'audio/mp4', ext: 'm4a' });
  });

  it('detects MP3 from ID3 header', () => {
    const buf = Buffer.alloc(8);
    buf[0] = 0x49; buf[1] = 0x44; buf[2] = 0x33; // ID3
    expect(detectAudioFormat(buf)).toEqual({ mime: 'audio/mpeg', ext: 'mp3' });
  });

  it('detects MP3 from sync word FF FB', () => {
    const buf = Buffer.alloc(4);
    buf[0] = 0xff; buf[1] = 0xfb;
    expect(detectAudioFormat(buf)).toEqual({ mime: 'audio/mpeg', ext: 'mp3' });
  });

  it('detects WebM from EBML magic bytes', () => {
    const buf = Buffer.alloc(8);
    buf[0] = 0x1a; buf[1] = 0x45; buf[2] = 0xdf; buf[3] = 0xa3;
    expect(detectAudioFormat(buf)).toEqual({ mime: 'audio/webm', ext: 'webm' });
  });

  it('detects WAV from RIFF+WAVE magic bytes', () => {
    const buf = Buffer.alloc(12);
    buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46; // RIFF
    buf[8] = 0x57; buf[9] = 0x41; buf[10] = 0x56; buf[11] = 0x45; // WAVE
    expect(detectAudioFormat(buf)).toEqual({ mime: 'audio/wav', ext: 'wav' });
  });

  it('detects FLAC from fLaC magic bytes', () => {
    const buf = Buffer.alloc(8);
    buf[0] = 0x66; buf[1] = 0x4c; buf[2] = 0x61; buf[3] = 0x43; // fLaC
    expect(detectAudioFormat(buf)).toEqual({ mime: 'audio/flac', ext: 'flac' });
  });

  it('returns fallback audio/ogg for empty/unknown buffer', () => {
    expect(detectAudioFormat(Buffer.alloc(0))).toEqual({ mime: 'audio/ogg', ext: 'ogg' });
    expect(detectAudioFormat(Buffer.alloc(10))).toEqual({ mime: 'audio/ogg', ext: 'ogg' });
  });
});

// ─── describe: storeAsset ────────────────────────────────────────────────────

describe('storeAsset', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enrich-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes file to correct date-partitioned path: data/YYYY-MM-DD/assets/id.ext', async () => {
    const buf = Buffer.from('audio-data');
    const timestamp = new Date('2024-01-15T12:00:00Z');

    const result = await storeAsset(buf, 'msg-id-001', 'ogg', timestamp, tmpDir);

    const expected = path.join(tmpDir, '2024-01-15', 'assets', 'msg-id-001.ogg');
    expect(result).toBe(expected);
    const written = await fs.readFile(expected);
    expect(written).toEqual(buf);
  });

  it('uses message timestamp for date (not current date)', async () => {
    const buf = Buffer.from('data');
    const pastTimestamp = new Date('2023-06-20T08:00:00Z');

    const result = await storeAsset(buf, 'msg-past', 'jpg', pastTimestamp, tmpDir);

    expect(result).toContain('2023-06-20');
    expect(result).not.toContain(new Date().toISOString().slice(0, 10));
  });

  it('uses tmp file then rename (tmp file not present after write)', async () => {
    const buf = Buffer.from('test-bytes');
    const timestamp = new Date('2024-01-15T00:00:00Z');

    await storeAsset(buf, 'msg-rename-test', 'ogg', timestamp, tmpDir);

    const dir = path.join(tmpDir, '2024-01-15', 'assets');
    const tmpFile = path.join(dir, 'msg-rename-test.ogg.tmp');
    const finalFile = path.join(dir, 'msg-rename-test.ogg');

    // Final file exists
    await expect(fs.access(finalFile)).resolves.not.toThrow();
    // Tmp file was renamed away
    await expect(fs.access(tmpFile)).rejects.toThrow();
  });
});

// ─── describe: enrichMessage — audio ─────────────────────────────────────────

describe('enrichMessage — audio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls downloadMedia and transcriptions.create when type=audio and mediaUrl is set', async () => {
    const sampleBuf = new ArrayBuffer(100);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: vi.fn().mockResolvedValue(sampleBuf),
    }));

    const { db, whereMock } = makeMockDb();
    const log = makeMockLog();
    const openai = await makeMockOpenAI();
    const msg = makeMsg({ type: 'audio', mediaUrl: 'https://evolution.yowa.com.br/audio.ogg', text: null });

    await enrichMessage(db as never, openai as never, msg as never, log as never, os.tmpdir(), ['evolution.yowa.com.br']);

    expect(openai.audio.transcriptions.create).toHaveBeenCalledOnce();
    const callArg = (openai.audio.transcriptions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.model).toBe('whisper-1');
    expect(callArg.language).toBe('pt');
    expect(callArg.response_format).toBe('text');
    // db.update was called with the transcript text
    expect(whereMock).toHaveBeenCalled();
  });

  it('passes audio/mp4 mime and m4a ext to toFile when buffer has ftyp magic bytes (WhatsApp M4A)', async () => {
    // Build an ArrayBuffer that looks like M4A: bytes 4-7 = "ftyp"
    const m4aBuf = new Uint8Array(12);
    m4aBuf[4] = 0x66; m4aBuf[5] = 0x74; m4aBuf[6] = 0x79; m4aBuf[7] = 0x70; // ftyp
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: vi.fn().mockResolvedValue(m4aBuf.buffer),
    }));

    const { db } = makeMockDb();
    const log = makeMockLog();
    const openai = await makeMockOpenAI();
    const msg = makeMsg({ type: 'audio', mediaUrl: 'https://evolution.yowa.com.br/audio.enc', text: null });

    await enrichMessage(db as never, openai as never, msg as never, log as never, os.tmpdir(), ['evolution.yowa.com.br']);

    const { toFile } = await import('openai');
    const toFileMock = toFile as ReturnType<typeof vi.fn>;
    expect(toFileMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/\.m4a$/),
      { type: 'audio/mp4' },
    );
  });

  it('does not download or call OpenAI when type=audio and mediaUrl is null', async () => {
    const { db, whereMock } = makeMockDb();
    const log = makeMockLog();
    const openai = await makeMockOpenAI();
    const msg = makeMsg({ type: 'audio', mediaUrl: null, text: null });

    await enrichMessage(db as never, openai as never, msg as never, log as never, os.tmpdir(), ['evolution.yowa.com.br']);

    expect(openai.audio.transcriptions.create).not.toHaveBeenCalled();
    expect(whereMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ messageId: 'msg-001' }, 'Áudio sem URL, ignorado');
  });
});

// ─── describe: enrichMessage — image ─────────────────────────────────────────

describe('enrichMessage — image', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls vision create with base64 data URL starting data:image/jpeg;base64,', async () => {
    const sampleBuf = new ArrayBuffer(10);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: vi.fn().mockResolvedValue(sampleBuf),
    }));

    const { db } = makeMockDb();
    const log = makeMockLog();
    const openai = await makeMockOpenAI();
    const msg = makeMsg({ type: 'image', mediaUrl: 'https://evolution.yowa.com.br/img.jpg', text: null });

    await enrichMessage(db as never, openai as never, msg as never, log as never, os.tmpdir(), ['evolution.yowa.com.br']);

    expect(openai.chat.completions.create).toHaveBeenCalledOnce();
    const callArg = (openai.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      model: string;
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string; detail: string } }> }>;
    };
    expect(callArg.model).toBe('gpt-4o-mini');
    const imageContent = callArg.messages[0]!.content.find((c) => c.type === 'image_url');
    expect(imageContent?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(imageContent?.image_url?.detail).toBe('low');
  });

  it('combines caption with vision description when msg.text is non-null', async () => {
    const sampleBuf = new ArrayBuffer(10);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: vi.fn().mockResolvedValue(sampleBuf),
    }));

    const { db, setMock } = makeMockDb();
    const log = makeMockLog();
    const openai = await makeMockOpenAI();
    const msg = makeMsg({
      type: 'image',
      mediaUrl: 'https://evolution.yowa.com.br/img.jpg',
      text: 'caption do usuário',
    });

    await enrichMessage(db as never, openai as never, msg as never, log as never, os.tmpdir(), ['evolution.yowa.com.br']);

    const setCallArgs = (setMock as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { text: string };
    expect(setCallArgs.text).toBe('caption do usuário\ndescrição da imagem');
  });
});

// ─── describe: enrichMessage — text/embed ────────────────────────────────────

describe('enrichMessage — text/embed', () => {
  it('calls embeddings.create and db.update when type=text and text is non-empty', async () => {
    const { db, setMock, whereMock } = makeMockDb();
    const log = makeMockLog();
    const openai = await makeMockOpenAI();
    const msg = makeMsg({ type: 'text', text: 'Olá, tudo bem?' });

    await enrichMessage(db as never, openai as never, msg as never, log as never, os.tmpdir(), ['evolution.yowa.com.br']);

    expect(openai.embeddings.create).toHaveBeenCalledOnce();
    const embedCallArg = (openai.embeddings.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      model: string;
      input: string;
    };
    expect(embedCallArg.model).toBe('text-embedding-3-small');

    expect(whereMock).toHaveBeenCalled();
    const setCallArgs = (setMock as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      text: string;
      embedding: number[];
    };
    expect(Array.isArray(setCallArgs.embedding)).toBe(true);
    expect(setCallArgs.embedding).toHaveLength(1536);
    expect(setCallArgs.text).toBe('Olá, tudo bem?');
  });

  it('does NOT call embeddings.create or db.update when type=text and text is null', async () => {
    const { db, whereMock } = makeMockDb();
    const log = makeMockLog();
    const openai = await makeMockOpenAI();
    const msg = makeMsg({ type: 'text', text: null });

    await enrichMessage(db as never, openai as never, msg as never, log as never, os.tmpdir(), ['evolution.yowa.com.br']);

    expect(openai.embeddings.create).not.toHaveBeenCalled();
    expect(whereMock).not.toHaveBeenCalled();
  });

  it('calls log.warn before embeddings.create when text > 8000 chars', async () => {
    const { db } = makeMockDb();
    const log = makeMockLog();
    const openai = await makeMockOpenAI();
    const longText = 'x'.repeat(9000);
    const msg = makeMsg({ type: 'text', text: longText });

    await enrichMessage(db as never, openai as never, msg as never, log as never, os.tmpdir(), ['evolution.yowa.com.br']);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-001', originalLength: 9000, truncatedLength: 8000 }),
      'Texto truncado antes de gerar embedding',
    );
    expect(openai.embeddings.create).toHaveBeenCalled();
  });
});

// ─── describe: enrichMessage — skip types ────────────────────────────────────

describe('enrichMessage — skip types', () => {
  it('skips enrichment for type=video: no OpenAI call, log.info called', async () => {
    const { db, whereMock } = makeMockDb();
    const log = makeMockLog();
    const openai = await makeMockOpenAI();
    const msg = makeMsg({ type: 'video', mediaUrl: 'https://evolution.yowa.com.br/v.mp4', text: 'caption' });

    await enrichMessage(db as never, openai as never, msg as never, log as never, os.tmpdir(), ['evolution.yowa.com.br']);

    expect(openai.audio.transcriptions.create).not.toHaveBeenCalled();
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(openai.embeddings.create).not.toHaveBeenCalled();
    expect(whereMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { messageId: 'msg-001', type: 'video' },
      'Vídeo ignorado — enriquecimento não implementado nesta fase',
    );
  });

  it('skips enrichment for type=sticker: no OpenAI call, log.info called', async () => {
    const { db, whereMock } = makeMockDb();
    const log = makeMockLog();
    const openai = await makeMockOpenAI();
    const msg = makeMsg({ type: 'sticker', mediaUrl: 'https://evolution.yowa.com.br/s.webp', text: null });

    await enrichMessage(db as never, openai as never, msg as never, log as never, os.tmpdir(), ['evolution.yowa.com.br']);

    expect(openai.audio.transcriptions.create).not.toHaveBeenCalled();
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(openai.embeddings.create).not.toHaveBeenCalled();
    expect(whereMock).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { messageId: 'msg-001', type: 'sticker' },
      'Sticker ignorado — enriquecimento não implementado nesta fase',
    );
  });
});
