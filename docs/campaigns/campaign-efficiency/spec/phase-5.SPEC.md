---
id: campaign-efficiency-phase-5
title: "F5: admissão comum e provas paralelas"
version: 1.0.0
status: draft
date: 2026-09-29
owner: Felipe Broering
target: feliperun/faberun
baseline: 63760490
derived_from: campaign-efficiency
---

# F5: admissão comum e provas paralelas

## Intenção

Continuar R7 da [spec da campanha](SPEC.md) depois do experimento da fase F1. Aumentar vazão depende de medir os tempos em fila, verificação, julgamento e integração, além da memória da máquina com processos reais.

## Requisitos

### R7. Toda invocação respeita a admissão e provas independentes avançam

- **statement:** se F1 confirmou a corrida, worker, juiz, re-ask, revisão e failover reservam slot global e por runtime antes de cada spawn. Se refutou, a fase registra a prova e não adiciona essa correção. Provas em worktrees independentes podem executar com concorrência limitada, enquanto refs e integração continuam serializadas. Um checkpoint de comando só é reutilizado quando árvore, comando, ambiente e dependências permanecem idênticos; prova mutante requer invalidação segura.
- **proof:** command: node --test --test-concurrency=1 test/engine/max-parallel.test.mjs test/engine/dispatch-during-verification.test.mjs test/engine/resume-reauthor.test.mjs

**origin:** review R7 e F5 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

## Não-objetivos

- Elevar o teto do planner apenas porque oito chamadas HTTP do provedor funcionaram.
- Usar cache de prova por argv isolado ou paralelizar operações em ref compartilhada.

## Restrições

- Medir o host antes de elevar concorrência. O teto do contrato permanece no que a máquina comprovou.
- Testes de simultaneidade usam sinais de prontidão, sem limite superior de duração como asserção.
