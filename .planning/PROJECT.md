# brainny

## What This Is

brainny é um pipeline de ingestão e inteligência de mensagens do WhatsApp. Recebe webhooks da Evolution API (gateway WhatsApp), processa mensagens de qualquer tipo (texto, áudio via Whisper, imagens via GPT-4 Vision), armazena no PostgreSQL com embeddings pgvector, materializa arquivos Markdown diários no vault Obsidian e expõe um endpoint de busca semântica.

## Core Value

Toda mensagem do WhatsApp deve ser capturada, enriquecida e pesquisável — independente do tipo de mídia.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Receber webhooks da Evolution API e processar mensagens de todos os tipos
- [ ] Transcrever áudios em PT-BR via OpenAI Whisper
- [ ] Descrever imagens via GPT-4o-mini Vision
- [ ] Gerar embeddings vetoriais (text-embedding-3-small) e armazenar no PostgreSQL + pgvector
- [ ] Materializar arquivos Markdown diários no vault Obsidian, agrupados por data e conversa
- [ ] Expor endpoint de busca semântica autenticado
- [ ] Sincronização histórica (backfill) via API da Evolution
- [ ] Health check endpoint

### Out of Scope

- Interface de usuário — brainny é backend/pipeline, sem UI
- Envio de mensagens — apenas recepção e processamento
- Gerenciamento de instâncias WhatsApp — responsabilidade da Evolution API
- Multi-tenant — sistema pessoal, uma instância Evolution

## Context

- **Projeto anterior:** whatsapp-brain (Express + raw pg) na pasta adjacente — reescrita completa, não refatoração
- **Infraestrutura:** Docker Swarm no Portainer EE (3 nós: srv1 manager, svr2/svr3 workers), rede overlay `yowanet`
- **PostgreSQL compartilhado:** pgvector/pgvector:pg17, banco `whatsapp_brain` já criado com extensão vector
- **Evolution API:** rodando em `https://evolution.yowa.com.br`, instância `henrique`, API key `evo2026brain`
- **Vault Obsidian:** `C:\Users\Usuario12\OneDrive - HASAS\Obsidian\knowledge` (montado no container)
- **Bloqueio atual:** IP do servidor (177.7.43.170) com erro 405 do WhatsApp — proxy necessário no futuro
- **Usuário:** Henrique Schneider, uso pessoal

## Constraints

- **Tech Stack**: Node.js 22, TypeScript, Fastify, Drizzle ORM, PostgreSQL + pgvector, OpenAI SDK, Zod, Pino — decisão final
- **Runtime**: Node.js 22 (não Bun) — compatibilidade com ambiente Docker existente
- **Banco**: Usar banco `whatsapp_brain` já existente no PostgreSQL compartilhado (stack ID 8 no Portainer)
- **Rede**: Container deve estar na overlay network `yowanet` para alcançar postgres e evolution por nome de serviço
- **Idioma**: PT-BR em prompts e mensagens de log voltados ao usuário

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Fastify em vez de Express | Schema validation nativo, TypeScript first-class, melhor DX e performance | — Pending |
| Drizzle ORM em vez de raw pg | Type-safe queries, schema declarativo em TS, suporte pgvector, sem peso do Prisma | — Pending |
| Reescrita completa (não refatoração) | Código anterior tem race conditions, logging misto, sem retry, sem auth no /search | — Pending |
| PostgreSQL compartilhado | Consolidação da sessão anterior — evita container postgres dedicado no stack | ✓ Good |

## Evolution

Este documento evolui nas transições de fase e marcos.

**Após cada transição de fase** (via `/gsd-transition`):
1. Requisitos invalidados? → Mover para Out of Scope com motivo
2. Requisitos validados? → Mover para Validated com referência de fase
3. Novos requisitos surgiram? → Adicionar em Active
4. Decisões a registrar? → Adicionar em Key Decisions
5. "What This Is" ainda preciso? → Atualizar se divergiu

**Após cada milestone** (via `/gsd:complete-milestone`):
1. Revisão completa de todas as seções
2. Verificação de Core Value — ainda é a prioridade certa?
3. Auditoria de Out of Scope — motivos ainda válidos?
4. Atualizar Context com estado atual

---
*Last updated: 2026-05-21 after initialization*
