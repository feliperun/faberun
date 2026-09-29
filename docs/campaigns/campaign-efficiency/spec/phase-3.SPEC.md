---
id: campaign-efficiency-phase-3
title: "F3: retomada do plano e registro de gasto"
version: 1.0.0
status: draft
date: 2026-09-29
owner: Felipe Broering
target: feliperun/faberun
baseline: 63760490
derived_from: campaign-efficiency
---

# F3: retomada do plano e registro de gasto

## Intenção

Continuar R2, R4 e R5 da [spec da campanha](SPEC.md): recuperação sem refazer trabalho pago, fatos reutilizáveis e medição completa do planejamento. O plano do review propõe uma política opcional de saldo para novas chamadas; ela exige ADR antes de mudar o contrato de gasto do produto.

## Requisitos

### R2. Etapas de planejamento concluídas sobrevivem a interrupções

- **statement:** ao interromper depois de um draft validado, a retomada reconcilia operações pendentes e segue para review sem criar outro draft. O digest da spec, árvore e política governa reutilização; mudança relevante invalida o dependente com motivo visível. A recuperação repetida não duplica uma invocação.
- **proof:** command: node --test --test-concurrency=1 test/plan/pipeline.test.mjs

**origin:** review R2 e F3 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

### R4. Medições válidas são reaproveitadas

- **statement:** medições de candidatos de verificação são reaproveitadas apenas quando árvore, comando, dependências e ambiente relevante conferem. Qualquer alteração desses inputs invalida a medição; timeout não é duração final.
- **proof:** command: node --test --test-concurrency=1 test/plan/repo-facts.test.mjs test/plan/pipeline.test.mjs

**origin:** review R4 e F2/F3 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

### R5. Gasto de planejamento é contabilizado e novas chamadas podem ser reservadas

- **statement:** o ledger separa planejamento, worker, juiz e retries e mantém gasto não medido como desconhecido. Uma ADR nova decide se uma reserva opcional impede apenas novos dispatches quando falta saldo, preservando trabalho ativo e expondo que cobrança tardia pode exceder a reserva. O comportamento implementado corresponde à decisão registrada.
- **proof:** command: node --test --test-concurrency=1 test/campaign/metrics.test.mjs test/plan/pipeline.test.mjs

**origin:** review R5 e F3 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`; ADR 0004 rejeitou um teto que mata trabalho.

## Não-objetivos

- Impor teto absoluto sem suporte do provedor.
- Tratar preço ausente como zero ou editar ledgers históricos.

## Restrições

- A ADR explicita a diferença para a decisão anterior antes de implementar reserva de saldo.
- O estado de retomada é persistido fora dos worktrees e validado por identidade antes do reuso.
