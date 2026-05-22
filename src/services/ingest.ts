// src/services/ingest.ts
// Source: RESEARCH.md Pattern 4 — Evolution payload parsing + message type discriminator
// T-02-02: Explicit allow-list of 10 types; unknown types logged and dropped (not stored)
import type { Logger } from 'pino';
import type { NewMessage } from '../db/schema.js';

// NormalizedMessage extends NewMessage so callers can pass it directly to persistMessage
export interface NormalizedMessage extends NewMessage {}

// Internal Evolution data item shape
interface EvolutionDataItem {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };
  pushName: string;
  messageType: string;
  messageTimestamp: number;
  message: Record<string, unknown>;
}

/**
 * Extracts and normalizes messages from an Evolution API MESSAGES_UPSERT webhook body.
 *
 * Handles both single-object and array `data` fields (RESEARCH Pitfall 3 — A1 assumption).
 * Returns [] for non-MESSAGES_UPSERT events.
 * Returns [] for unrecognized messageTypes (explicit allow-list — T-02-02).
 */
export function extractMessages(body: unknown, log: Logger): NormalizedMessage[] {
  const b = body as { event?: string; data?: unknown };

  if (b.event !== 'MESSAGES_UPSERT') {
    log.debug({ event: b.event }, 'Evento não é MESSAGES_UPSERT, ignorado');
    return [];
  }

  // Defensive guard: handle both array and single-object data (RESEARCH Pitfall 3)
  const dataItems: EvolutionDataItem[] = Array.isArray(b.data)
    ? (b.data as EvolutionDataItem[])
    : [b.data as EvolutionDataItem];

  const results: NormalizedMessage[] = [];

  for (const dataItem of dataItems) {
    const normalized = normalizeMessage(dataItem);
    if (!normalized) {
      log.info(
        { messageId: dataItem.key.id, messageType: dataItem.messageType },
        'Tipo de mensagem não suportado, ignorado',
      );
      continue;
    }

    results.push(normalized);
  }

  return results;
}

/**
 * Maps an Evolution data item to a NormalizedMessage.
 * Returns null for unrecognized messageTypes (allow-list pattern — T-02-02).
 */
function normalizeMessage(data: EvolutionDataItem): NormalizedMessage | null {
  const base = {
    id: data.key.id,
    chatId: data.key.remoteJid,
    sender: data.key.remoteJid,
    senderName: data.pushName ?? null,
    timestamp: new Date(data.messageTimestamp * 1000), // A5: epoch seconds → ms
    rawJson: data as unknown as Record<string, unknown>,
    embedding: null,
  };

  const msg = data.message;
  const mt = data.messageType;

  switch (mt) {
    case 'conversation': {
      return {
        ...base,
        type: 'text',
        text: (msg['conversation'] as string) ?? null,
        mediaUrl: null,
      };
    }

    case 'extendedTextMessage': {
      const ext = msg['extendedTextMessage'] as { text?: string } | undefined;
      return {
        ...base,
        type: 'text',
        text: ext?.text ?? null,
        mediaUrl: null,
      };
    }

    case 'audioMessage': {
      const audio = msg['audioMessage'] as { url?: string } | undefined;
      return {
        ...base,
        type: 'audio',
        text: null,
        mediaUrl: audio?.url ?? null,
      };
    }

    case 'imageMessage': {
      const img = msg['imageMessage'] as { url?: string; caption?: string } | undefined;
      return {
        ...base,
        type: 'image',
        text: img?.caption ?? null,
        mediaUrl: img?.url ?? null,
      };
    }

    case 'videoMessage': {
      const vid = msg['videoMessage'] as { url?: string; caption?: string } | undefined;
      return {
        ...base,
        type: 'video',
        text: vid?.caption ?? null,
        mediaUrl: vid?.url ?? null,
      };
    }

    case 'documentMessage': {
      const doc = msg['documentMessage'] as { url?: string; fileName?: string } | undefined;
      return {
        ...base,
        type: 'document',
        text: doc?.fileName ?? null,
        mediaUrl: doc?.url ?? null,
      };
    }

    case 'stickerMessage': {
      const sticker = msg['stickerMessage'] as { url?: string } | undefined;
      return {
        ...base,
        type: 'sticker',
        text: null,
        mediaUrl: sticker?.url ?? null,
      };
    }

    case 'locationMessage': {
      const loc = msg['locationMessage'] as
        | { degreesLatitude?: number; degreesLongitude?: number; name?: string }
        | undefined;
      const lat = loc?.degreesLatitude ?? 0;
      const lng = loc?.degreesLongitude ?? 0;
      const text = loc?.name ? `${loc.name} (${lat}, ${lng})` : `${lat}, ${lng}`;
      return {
        ...base,
        type: 'location',
        text,
        mediaUrl: null,
      };
    }

    case 'contactsArrayMessage': {
      const c = msg['contactsArrayMessage'] as
        | { contacts?: Array<{ fullName?: string }> }
        | undefined;
      const text = (c?.contacts ?? []).map((ct) => ct.fullName ?? '').join(', ');
      return {
        ...base,
        type: 'contact',
        text,
        mediaUrl: null,
      };
    }

    case 'reactionMessage': {
      const reaction = msg['reactionMessage'] as { text?: string } | undefined;
      return {
        ...base,
        type: 'reaction',
        text: reaction?.text ?? null,
        mediaUrl: null,
      };
    }

    default:
      // T-02-02: Unknown types are dropped — caller logs and skips
      return null;
  }
}
