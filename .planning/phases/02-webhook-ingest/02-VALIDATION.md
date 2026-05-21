---
phase: 2
slug: webhook-ingest
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-21
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.x |
| **Config file** | `vitest.config.ts` (from Phase 1) |
| **Quick run command** | `npx vitest run src/lib/auth.test.ts src/services/ingest.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/lib/auth.test.ts src/services/ingest.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 2-01-01 | 01 | 1 | INGEST-01 | T-2-01 (timing attack) | Returns 401 on wrong or missing X-Webhook-Secret; no RangeError on length mismatch | unit | `npx vitest run src/lib/auth.test.ts` | ❌ W0 | ⬜ pending |
| 2-01-02 | 01 | 1 | INGEST-03 | EVO-4 | All 9 message types normalized correctly; unknown types return [] | unit | `npx vitest run src/services/ingest.test.ts` | ❌ W0 | ⬜ pending |
| 2-01-03 | 01 | 1 | INGEST-04 | EVO-1 | Same id inserted twice → exactly one row (onConflictDoNothing) | unit | `npx vitest run src/services/persist.test.ts` | ❌ W0 | ⬜ pending |
| 2-02-01 | 02 | 2 | INGEST-02 | — | POST with valid secret → 200 {ok:true} before queue drains | integration | `npx vitest run src/routes/webhook.test.ts` | ❌ W0 | ⬜ pending |
| 2-02-02 | 02 | 2 | INGEST-05 | — | Error in one job does not interrupt sibling jobs | unit | `npx vitest run src/routes/webhook.test.ts` | ❌ W0 | ⬜ pending |
| 2-02-03 | 02 | 2 | INGEST-06 | — | Failed job logs Pino error with {messageId, errorCode, phase} | unit | `npx vitest run src/routes/webhook.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/auth.test.ts` — covers INGEST-01 (timingSafeEqual, 401 paths, RangeError guard, missing header)
- [ ] `src/services/ingest.test.ts` — covers INGEST-03 (all 9 message types + unknown type + fromMe filter)
- [ ] `src/services/persist.test.ts` — covers INGEST-04 (dedup: same id twice → one row, no error)
- [ ] `src/routes/webhook.test.ts` — covers INGEST-02, INGEST-05, INGEST-06 (route integration)
- [ ] `tests/fixtures/` — JSON fixture files for each Evolution message type (text, audio, image, video, document, sticker, location, contact, reaction)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Evolution webhook actually reaches POST /webhook/evolution | INGEST-01, INGEST-02 | Requires live Evolution instance + real network | Configure Evolution webhook URL → send test message → check server logs for receipt |
| X-Webhook-Secret header injection confirmed | INGEST-01 | Depends on Evolution version + proxy config (A3 assumption) | Check Evolution Manager UI for custom header config or verify nginx proxy_set_header |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
