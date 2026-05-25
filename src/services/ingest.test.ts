// src/services/ingest.test.ts
// Unit tests for INGEST-03: extractMessages normalizes all 10 message types
// Also covers: non-messages.upsert filter, fromMe filter, unknown type returns []
import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { extractMessages } from './ingest.js';

// Minimal mock logger — only the methods called by extractMessages
const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} satisfies Partial<Logger> as unknown as Logger;

// JSON fixtures (Node 22 + "type": "module" — JSON imports with { type: 'json' } assertion)
import textFixture from '../../tests/fixtures/text.json' with { type: 'json' };
import extendedTextFixture from '../../tests/fixtures/extended-text.json' with { type: 'json' };
import audioFixture from '../../tests/fixtures/audio.json' with { type: 'json' };
import imageFixture from '../../tests/fixtures/image.json' with { type: 'json' };
import videoFixture from '../../tests/fixtures/video.json' with { type: 'json' };
import documentFixture from '../../tests/fixtures/document.json' with { type: 'json' };
import stickerFixture from '../../tests/fixtures/sticker.json' with { type: 'json' };
import locationFixture from '../../tests/fixtures/location.json' with { type: 'json' };
import contactFixture from '../../tests/fixtures/contact.json' with { type: 'json' };
import reactionFixture from '../../tests/fixtures/reaction.json' with { type: 'json' };
import unknownTypeFixture from '../../tests/fixtures/unknown-type.json' with { type: 'json' };
import fromMeFixture from '../../tests/fixtures/from-me.json' with { type: 'json' };

describe('extractMessages', () => {
  it('returns [] for non-messages.upsert events', () => {
    const body = { event: 'CONNECTION_UPDATE', data: {} };
    const result = extractMessages(body, mockLog);
    expect(result).toEqual([]);
  });

  it('processes fromMe=true messages (own instance messages are stored)', () => {
    const result = extractMessages(fromMeFixture, mockLog);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe('Eu enviei isso');
  });

  it('returns [] for unknown messageType (protocolMessage)', () => {
    const result = extractMessages(unknownTypeFixture, mockLog);
    expect(result).toEqual([]);
  });

  it('normalizes conversation (text) message correctly', () => {
    const result = extractMessages(textFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('Olá mundo');
    expect(msg.mediaUrl).toBeNull();
  });

  it('normalizes extendedTextMessage correctly', () => {
    const result = extractMessages(extendedTextFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('Texto longo formatado');
    expect(msg.mediaUrl).toBeNull();
  });

  it('normalizes audioMessage correctly', () => {
    const result = extractMessages(audioFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe('audio');
    expect(msg.text).toBeNull();
    expect(msg.mediaUrl).toBe('https://example.com/audio.ogg');
  });

  it('normalizes imageMessage correctly', () => {
    const result = extractMessages(imageFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe('image');
    expect(msg.text).toBe('Uma foto');
    expect(msg.mediaUrl).toBe('https://example.com/photo.jpg');
  });

  it('normalizes videoMessage correctly', () => {
    const result = extractMessages(videoFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe('video');
    expect(msg.text).toBe('Um vídeo');
    expect(msg.mediaUrl).toBe('https://example.com/video.mp4');
  });

  it('normalizes documentMessage correctly', () => {
    const result = extractMessages(documentFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe('document');
    expect(msg.text).toBe('relatorio.pdf');
    expect(msg.mediaUrl).toBe('https://example.com/file.pdf');
  });

  it('normalizes stickerMessage correctly', () => {
    const result = extractMessages(stickerFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe('sticker');
    expect(msg.text).toBeNull();
    expect(msg.mediaUrl).toBe('https://example.com/sticker.webp');
  });

  it('normalizes locationMessage correctly (text contains name and coordinates)', () => {
    const result = extractMessages(locationFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe('location');
    expect(msg.text).toContain('São Paulo');
    expect(msg.text).toContain('-23.5505');
    expect(msg.text).toContain('-46.6333');
    expect(msg.mediaUrl).toBeNull();
  });

  it('normalizes contactsArrayMessage correctly', () => {
    const result = extractMessages(contactFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe('contact');
    expect(msg.text).toBe('João Silva');
    expect(msg.mediaUrl).toBeNull();
  });

  it('normalizes reactionMessage correctly', () => {
    const result = extractMessages(reactionFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.type).toBe('reaction');
    expect(msg.text).toBe('👍');
    expect(msg.mediaUrl).toBeNull();
  });

  it('every returned NormalizedMessage has correct base fields', () => {
    const result = extractMessages(textFixture, mockLog);
    expect(result).toHaveLength(1);
    const msg = result[0]!;

    // id matches key.id from fixture
    expect(msg.id).toBe('FIXTURE_TEXT_001');
    // chatId matches key.remoteJid
    expect(msg.chatId).toBe('5511999999001@s.whatsapp.net');
    // senderName matches pushName
    expect(msg.senderName).toBe('Remetente Texto');
    // timestamp is a Date object (not a number)
    expect(msg.timestamp).toBeInstanceOf(Date);
    // embedding is null (not yet computed)
    expect(msg.embedding).toBeNull();
    // rawJson is the data object
    expect(msg.rawJson).toBeDefined();
  });

  it('handles array data correctly (batched Evolution webhook)', () => {
    const batchBody = {
      event: 'messages.upsert',
      instance: 'brainny',
      data: [textFixture.data, audioFixture.data],
    };
    const result = extractMessages(batchBody, mockLog);
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe('text');
    expect(result[1]!.type).toBe('audio');
  });
});
