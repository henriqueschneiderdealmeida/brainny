---
phase: 6
plan: "06-02"
subsystem: "ops"
tags: [docker, dockerfile, docker-compose, swarm, yowanet, ops]
dependency_graph:
  requires: [all-prior-phases, build-script, tsconfig-outDir]
  provides: [Dockerfile, docker-compose.yml, .dockerignore]
  affects: []
tech_stack:
  added: []
  patterns: [multi-stage-dockerfile, swarm-overlay-network, external-env-secrets]
key_files:
  created:
    - Dockerfile
    - docker-compose.yml
    - .dockerignore
  modified: []
decisions:
  - "Task 1 (build script + outDir) pre-satisfied — package.json already had 'build: tsc -p tsconfig.json' and tsconfig.json had outDir: dist from prior phases"
  - "stop_grace_period: 30s alinhado com shutdown handler SIGTERM em src/index.ts"
  - "healthcheck usa wget (disponivel no node:22-alpine) para GET /health"
  - "brainny_data volume persistente em /app/data para Markdown vault e sync_state"
  - "yowanet declarada como external network — ja existe no Portainer stack ID 8"
metrics:
  duration: "~2 minutes"
  completed: "2026-05-22"
  tasks_completed: 4
  files_created: 3
  files_modified: 0
  tests_added: 0
  tests_total: 98
---

# Phase 6 Plan 02: Dockerfile + Docker Swarm stack Summary

**One-liner:** Multi-stage Dockerfile (Node 22 Alpine) e docker-compose.yml para deploy no Swarm na rede overlay yowanet com volume persistente e healthcheck via /health (OPS-03).

## What Was Built

`Dockerfile` — build multi-stage:

- **Stage builder:** `node:22-alpine`, instala todas as deps com `npm ci`, copia `tsconfig.json` e `src/`, compila com `npm run build` (saída em `dist/`)
- **Stage production:** `node:22-alpine`, `ENV NODE_ENV=production`, instala apenas deps de produção com `npm ci --omit=dev`, copia `dist/` do builder, expõe porta 3000, CMD `node dist/index.js`

`docker-compose.yml` — Swarm stack:

- Serviço `brainny` com image `brainny:latest` e build context local
- Todas as env vars sensíveis (`DATABASE_URL`, `OPENAI_API_KEY`, `WEBHOOK_SECRET`, `SEARCH_TOKEN`, `EVOLUTION_API_KEY`) injetadas via `${VAR}` para resolução pelo Portainer/Swarm
- `EVOLUTION_URL: http://evolution:8080` — alcança Evolution API pelo service name na rede overlay
- `DATA_DIR: /app/data` — montado no volume `brainny_data` para persistência do vault Obsidian
- `deploy.stop_grace_period: 30s` — alinhado com timeout do graceful shutdown SIGTERM em `src/index.ts`
- `healthcheck` via `wget -qO- http://localhost:3000/health` (wget disponível no Alpine) — interval 30s, retries 3
- Rede `yowanet` como `external: true` — usa a overlay network já existente no Portainer
- Volume `brainny_data` com driver local

`.dockerignore`:

- Exclui `node_modules`, `dist`, `.planning`, `.env`, `*.md`, `.git`, `data` — reduz contexto de build

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Verify build script + tsconfig outDir (pre-satisfied) | — | package.json (unchanged), tsconfig.json (unchanged) |
| 2 | Create .dockerignore | 169a3df | .dockerignore |
| 3 | Create Dockerfile (multi-stage Node 22 Alpine) | a387a4b | Dockerfile |
| 4 | Create docker-compose.yml (yowanet Swarm, OPS-03) | 7f6b585 | docker-compose.yml |
| 5 | Full suite gate (tsc --noEmit + vitest run) | — (verification only) | — |

## Deviations from Plan

### Minor Adjustments

**1. Task 1 pre-satisfied — sem commit necessário**
- **Found during:** Task 1 verification
- **Issue:** O plano pedia para adicionar `"build": "tsc"` ao package.json e verificar `outDir`. Ambos já existiam desde fases anteriores: `"build": "tsc -p tsconfig.json"` no package.json e `outDir: "dist"` no tsconfig.json
- **Fix:** Nenhuma alteração necessária — documentado como pre-satisfied, sem commit para Task 1
- **Files modified:** nenhum

## Verification

- `npx tsc --noEmit` — exits 0 (sem erros de tipo)
- `npx vitest run` — 98 testes passam em 9 arquivos de teste (sem regressões)

## Requirements Satisfied

| Requirement | Description | Status |
|-------------|-------------|--------|
| OPS-03 | Container artifacts (Dockerfile + docker-compose.yml) para deploy em produção | satisfied |

## Known Stubs

None.

## Threat Flags

None — Dockerfile e docker-compose.yml são artefatos de deploy, não expõem nova superficie de rede. As env vars sensíveis continuam injetadas via Swarm/Portainer, sem hardcoding de secrets.

## Self-Check: PASSED

- [x] Dockerfile — FOUND (18 linhas, multi-stage builder + production)
- [x] docker-compose.yml — FOUND (50 linhas, yowanet external, brainny_data volume, healthcheck)
- [x] .dockerignore — FOUND (7 entradas)
- [x] commit 169a3df — FOUND (chore(06): add .dockerignore)
- [x] commit a387a4b — FOUND (feat(06): add multi-stage Dockerfile (Node 22 Alpine))
- [x] commit 7f6b585 — FOUND (feat(06): add docker-compose.yml for yowanet Swarm deployment (OPS-03))
- [x] 98 tests pass (vitest run)
- [x] tsc --noEmit exits 0
