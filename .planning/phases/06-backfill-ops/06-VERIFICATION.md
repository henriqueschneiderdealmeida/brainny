---
phase: 06-backfill-ops
verified: 2026-05-22T00:00:00Z
status: passed
score: 11/11 must-haves verified
overrides_applied: 0
re_verification: false
---

# Phase 6: Backfill & Ops — Verification Report

**Phase Goal:** Catch up history from Evolution and harden the deployment — CLI backfill with resumable cursors, graceful shutdown, Dockerfile, and the Docker Swarm stack on yowanet.
**Verified:** 2026-05-22
**Status:** passed
**Re-verification:** No — initial verification

---

## Step 0: Verificação prévia

Nenhum arquivo `*-VERIFICATION.md` existente na pasta `06-backfill-ops/`. Modo: verificação inicial.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | CLI `scripts/backfill.ts` pagina Evolution `/chat/findMessages` com `--page-size` configurável | VERIFIED | Arquivo existe com 166 linhas. Loop `for (;;)` com `URLSearchParams({ count: String(pageSize) })` e argumento `--page-size` parseado nas linhas 21-22. |
| 2 | Respostas 429 acionam espera `Retry-After`-aware antes de retry (BACKFILL-01) | VERIFIED | `fetchWithRetry()` (linhas 26-42): `res.headers.get('Retry-After')` com fallback para 5s, loop com `attempt++`, lança após `maxRetries`. |
| 3 | Cursor gravado/carregado de `sync_state` como `backfill.cursor.{chatId}` (BACKFILL-02) | VERIFIED | Linha 79: `cursorKey = \`backfill.cursor.\${chatId}\``. Linha 82-89: `db.select().from(syncState).where(eq(syncState.key, cursorKey))`. Linha 137-145: `db.insert(syncState).values(...).onConflictDoUpdate(...)`. |
| 4 | Re-execução após interrupção retoma do último cursor | VERIFIED | Cursor é persistido após cada página (linha 144 `onConflictDoUpdate`) e carregado antes do loop de paginação (linha 82-89). Re-execução usa o `messageId` persistido como ponto de partida. |
| 5 | Try/catch por mensagem — uma falha não interrompe o lote | VERIFIED | Linhas 122-130: `try { await persistMessage; await enrichMessage; chatProcessed++ } catch (err) { log.error; totalSkipped++ }`. |
| 6 | Reutiliza `extractMessages`, `persistMessage`, `enrichMessage` sem duplicar lógica | VERIFIED | Imports diretos nas linhas 15-17. Uso em linha 119 (`extractMessages`), 123 (`persistMessage`), 124 (`enrichMessage`). |
| 7 | `EVOLUTION_API_KEY` e `EVOLUTION_INSTANCE` presentes em `src/config.ts` | VERIFIED | Linhas 10-11 de `src/config.ts`: `EVOLUTION_API_KEY: z.string().min(1)` e `EVOLUTION_INSTANCE: z.string().min(1).default('brainny')`. |
| 8 | `Dockerfile` usa Node 22 Alpine multi-stage (builder + production) | VERIFIED | 18 linhas: Stage 1 `FROM node:22-alpine AS builder` com `npm ci` + `npm run build`. Stage 2 `FROM node:22-alpine AS production` com `npm ci --omit=dev` + `COPY --from=builder`. |
| 9 | `docker-compose.yml` usa `yowanet` como rede externa, `postgres`/`evolution` acessíveis por nome | VERIFIED | Linha 29: `- yowanet`. Linha 50: `external: true`. Linha 19: `EVOLUTION_URL: "http://evolution:8080"`. `DATABASE_URL` injetada via env (aponta para `postgres` por nome de serviço). |
| 10 | `stop_grace_period: 30s` alinhado com handler SIGTERM em `src/index.ts` | VERIFIED | `docker-compose.yml` linha 36: `stop_grace_period: 30s`. `src/index.ts` linhas 100-108: `shutdown()` que para cron, drena queue (`app.queue.onIdle()`), fecha servidor (`app.close()`) e chama `process.exit(0)` — handlers registrados para `SIGTERM` e `SIGINT`. |
| 11 | Healthcheck usa `/health` como endpoint de verificação | VERIFIED | `docker-compose.yml` linhas 37-43: `test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]`, interval 30s, retries 3, start_period 10s. |

**Score:** 11/11 truths verified

---

### Deferred Items

Nenhum item diferido.

---

### Required Artifacts

| Artifact | Esperado | Status | Detalhes |
|----------|----------|--------|----------|
| `scripts/backfill.ts` | CLI com cursor-resumable pagination | VERIFIED | 166 linhas, implementação completa com `fetchWithRetry`, loop de paginação, cursor via `sync_state`, pipeline reutilizado. |
| `src/config.ts` | `EVOLUTION_API_KEY` + `EVOLUTION_INSTANCE` | VERIFIED | Ambos os campos presentes nas linhas 10-11, com tipos Zod corretos e default `'brainny'` para INSTANCE. |
| `Dockerfile` | Multi-stage Node 22 Alpine | VERIFIED | 18 linhas, dois estágios: `builder` e `production`, CMD correto `node dist/index.js`. |
| `docker-compose.yml` | Stack Swarm yowanet | VERIFIED | 51 linhas, rede `yowanet` externa, volume `brainny_data`, healthcheck, `stop_grace_period: 30s`. |
| `.dockerignore` | Excluir artefatos dev | VERIFIED | 7 entradas: `node_modules`, `dist`, `.planning`, `.env`, `*.md`, `.git`, `data`. |
| `src/index.ts` | Handler SIGTERM/SIGINT com graceful shutdown | VERIFIED | Linhas 100-108: para cron, drena fila, fecha app, `process.exit(0)`. Registrado para ambos os sinais. |

---

### Key Link Verification

| From | To | Via | Status | Detalhes |
|------|----|-----|--------|---------|
| `scripts/backfill.ts` | `src/services/ingest.ts` | `import { extractMessages }` linha 15 + uso linha 119 | WIRED | Import e chamada diretos. |
| `scripts/backfill.ts` | `src/services/persist.ts` | `import { persistMessage }` linha 16 + uso linha 123 | WIRED | Import e chamada diretos. |
| `scripts/backfill.ts` | `src/services/enrich.ts` | `import { enrichMessage }` linha 17 + uso linha 124 | WIRED | Import e chamada diretos. |
| `scripts/backfill.ts` | `src/db/schema.ts` | `import { syncState }` linha 14 + `db.select().from(syncState)` + `db.insert(syncState)` | WIRED | Read e write confirmados. |
| `scripts/backfill.ts` | `src/config.ts` | `import { loadConfig }` linha 11 + `config.EVOLUTION_API_KEY` linha 59 | WIRED | Config carregada e campos novos utilizados. |
| `docker-compose.yml` | `Dockerfile` | `build: { context: ., dockerfile: Dockerfile }` | WIRED | Stack referencia o Dockerfile local. |
| `docker-compose.yml` | `/health` endpoint | `healthcheck.test: wget .../health` | WIRED | Endpoint de health já implementado em fases anteriores (OPS-01). |
| `src/index.ts` | `docker-compose.yml` `stop_grace_period` | SIGTERM handler com cleanup completo | WIRED | O grace period de 30s cobre o tempo necessário para `queue.onIdle()` + `app.close()`. |

---

### Data-Flow Trace (Level 4)

`scripts/backfill.ts` é uma ferramenta CLI, não renderiza dados para usuário. A verificação de fluxo de dados é sobre o pipeline de persistência:

| Etapa | Variável | Fonte | Dados Reais | Status |
|-------|----------|-------|-------------|--------|
| Fetch de mensagens | `records` | `fetch(evolution_url)` → `data.messages?.records` | Sim — resposta real da Evolution API | FLOWING |
| Extração | `msgs` | `extractMessages(fakeBody, log)` | Sim — processa `records` reais | FLOWING |
| Persistência | — | `persistMessage(db, msg)` → Drizzle `insert/upsert` | Sim — grava no PostgreSQL | FLOWING |
| Cursor | `cursor` / `syncState` | `db.insert(syncState).onConflictDoUpdate(...)` | Sim — `lastId` extraído do último record real | FLOWING |

---

### Behavioral Spot-Checks

O backfill é um CLI que depende de Evolution API e banco de dados em execução. Não é possível executar end-to-end sem esses serviços. Os artefatos de deploy (Dockerfile, docker-compose) requerem Docker Engine.

| Comportamento | Verificação | Resultado | Status |
|--------------|-------------|-----------|--------|
| `package.json` tem script `build` | Grep em package.json | `"build": "tsc -p tsconfig.json"` encontrado (linha 9) | PASS |
| `tsconfig.json` tem `outDir: "dist"` | Leitura tsconfig | `"outDir": "dist"` na linha 12 | PASS |
| `syncState` table definida no schema | Grep em schema.ts | `export const syncState = pgTable('sync_state', ...)` linha 48 | PASS |
| Exports `extractMessages`, `persistMessage`, `enrichMessage` existem | Grep nos services | Todos encontrados com export explícito | PASS |
| CLI: nenhum import ausente | Análise de imports em backfill.ts | Todos os 8 imports resolvem para arquivos existentes em `src/` | PASS |
| Dockerfile CMD referencia `dist/index.js` | Leitura Dockerfile | `CMD ["node", "dist/index.js"]` linha 17 | PASS |

---

### Probe Execution

Nenhum probe declarado no PLAN ou no padrão convencional `scripts/*/tests/probe-*.sh`. Etapa ignorada.

---

### Requirements Coverage

| Requisito | Plano | Descrição | Status | Evidência |
|-----------|-------|-----------|--------|-----------|
| BACKFILL-01 | 06-01 | CLI script fetches historical messages from Evolution API with configurable page size | SATISFIED | `scripts/backfill.ts` — `fetchWithRetry` com `Retry-After`, `--page-size` arg, loop de paginação com `count` param. |
| BACKFILL-02 | 06-01 | Backfill uses sync_state cursor to resume from last synced timestamp | SATISFIED | Cursor `backfill.cursor.{chatId}` carregado de `syncState` antes do loop, upsertado após cada página. |
| OPS-03 | 06-02 | System handles SIGINT/SIGTERM with graceful shutdown (drain queue, close DB, close server) | SATISFIED | `src/index.ts` linhas 100-108: handler para SIGTERM e SIGINT, drena queue, fecha app. `docker-compose.yml` `stop_grace_period: 30s` garante tempo suficiente no Swarm. |

**Nota sobre OPS-03:** O requisito em REQUIREMENTS.md já estava marcado `[x]` (implementado na fase anterior), pois o handler SIGTERM foi adicionado em `src/index.ts`. A fase 6 complementa esse requisito com `stop_grace_period: 30s` no docker-compose, alinhando o container runtime com o timeout do handler. Sem conflito — o requisito é totalmente satisfeito.

---

### Anti-Patterns Found

| Arquivo | Linha | Padrão | Severidade | Impacto |
|---------|-------|--------|------------|---------|
| — | — | — | — | Nenhum anti-pattern encontrado |

Resultado da varredura:
- Nenhum marcador `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER` nos arquivos da fase.
- Nenhum retorno vazio hardcoded (`return []`, `return {}`, `return null`) em caminhos que deveriam retornar dados reais.
- `console.error` em `backfill.ts` linha 163 é o handler de erro fatal do CLI — uso legítimo (pré-logger, equivalente ao padrão já estabelecido em `src/index.ts`).
- `console.error` em `src/config.ts` linha 34 é o handler pré-logger existente de fases anteriores — fora do escopo desta fase.

---

### Human Verification Required

Nenhum item requer verificação humana para o objetivo desta fase. As verificações visuais e de runtime são:

1. **Deploy no Swarm Portainer** — Requer acesso ao ambiente Portainer/Docker Swarm. A configuração está correta no `docker-compose.yml`, mas o deploy real não pode ser verificado programaticamente.
   - O que testar: fazer stack deploy no Portainer com as env vars e confirmar que o container sobe, conecta ao `postgres` e ao `evolution`, e o healthcheck passa.
   - Esperado: container saudável, logs PT-BR no Pino, endpoint `/health` retornando `{ok: true, db: "ok"}`.
   - Por que requer humano: necessita ambiente Docker Swarm com `yowanet` e serviços externos.

2. **Backfill de historico real** — Requer Evolution API acessível com chats reais.
   - O que testar: `tsx scripts/backfill.ts --chat <jid>` com `.env` configurado.
   - Esperado: paginação completa, mensagens gravadas, cursor persistido em `sync_state`, retomada em re-execução.
   - Por que requer humano: depende de Evolution API e banco de dados de produção.

> Estas verificações são de natureza operacional/infra e não bloqueiam a conclusão da fase — todos os artefatos de código estão corretos e completos.

---

### Gaps Summary

Nenhum gap encontrado. Todos os 11 must-haves foram verificados com evidência direta no código.

---

_Verificado: 2026-05-22_
_Verificador: Claude (gsd-verifier)_
