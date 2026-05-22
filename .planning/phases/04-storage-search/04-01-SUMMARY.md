---
plan: "04-01"
phase: 4
status: complete
completed: "2026-05-22"
---

# Summary: 04-01 — Chat upsert + persist tests

## What Was Built

Extended `persistMessage` to upsert chat metadata (STORE-03) on every message. Updated `persist.test.ts` with 8 tests covering INGEST-04 (dedup), STORE-02 (rawJson), and STORE-03 (chat upsert).

## Key Files

- `src/services/persist.ts` — added `chats` upsert with `onConflictDoUpdate` (name, lastSeenAt)
- `src/services/persist.test.ts` — 8 tests, modulo-based mock handles 2 insert chains per call

## Deviations

None. Mock needed modulo-based call counter to handle second `persistMessage` call in dedup test.

## Self-Check: PASSED

- 70/70 tests pass
- 0 tsc errors
- STORE-02: rawJson flows through via NormalizedMessage.rawJson field
- STORE-03: chat upserted with isGroup (from @g.us suffix), name (senderName ?? chatId), lastSeenAt
