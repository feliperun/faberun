---
id: campaign-efficiency-phase-2
title: "F2: inventário útil e preflight antes do reviewer"
version: 1.0.0
status: draft
date: 2026-09-29
owner: Felipe Broering
target: feliperun/faberun
baseline: 63760490
derived_from: campaign-efficiency
---

# F2: inventário útil e preflight antes do reviewer

## Intenção

Implementar os achados R4 e R5 da [spec da campanha](SPEC.md). O planner deve oferecer código e testes relevantes dentro de um orçamento explícito de contexto e impedir review pago de um plano que uma checagem local já recusaria.

## Requisitos

### R4. O corte do inventário preserva fontes relevantes

- **statement:** um fixture com mais de 2.000 documentos e arquivos `src/` e `test/` depois deles mostra caminhos de código relevantes no recorte; as omissões são descritas e o índice completo continua consultável pela descoberta autorizada. O recorte é limitado por bytes e derivado dos requisitos, testes e referências, sem depender da ordem alfabética.
- **proof:** command: node --test --test-concurrency=1 test/plan/repo-facts.test.mjs

**origin:** review R4 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

### R5. A revisão semântica recebe somente plano apto a congelar

- **statement:** checagens determinísticas completas antecedem a chamada ao reviewer e seus diagnósticos vão ao reparo dentro do orçamento existente de rodadas. Após correção, o reviewer julga o plano que seria congelado. A recusa mecânica não consome uma chamada ao modelo.
- **proof:** command: node --test --test-concurrency=1 test/plan/rounds.test.mjs test/plan/pipeline.test.mjs

**origin:** review R5 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

## Não-objetivos

- Reescrever o planner ou remover o reviewer adversarial.
- Tratar duração de medição como prova de correção.

## Restrições

- Não consultar memória oculta do worker ou do juiz. Fatos usados pelo modelo são materializados em `readFiles` declarados.
- Compatibilidade histórica dos ledgers permanece como registro, sem editar contratos concluídos.
