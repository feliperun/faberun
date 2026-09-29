---
id: campaign-efficiency-phase-4
title: "F4: contexto medido e reparo com progresso"
version: 1.0.0
status: draft
date: 2026-09-29
owner: Felipe Broering
target: feliperun/faberun
baseline: 63760490
derived_from: campaign-efficiency
---

# F4: contexto medido e reparo com progresso

## Intenção

Continuar R1, R4 e R5 da [spec da campanha](SPEC.md). O objetivo é gastar menos tokens por resultado comprovado, preservando a capacidade do reviewer de detectar regressões e dando à recusa de contexto uma rota de reparo limitada.

## Requisitos

### R1. Economia de prompt não corta julgamento

- **statement:** medir bytes, tokens de entrada sem cache, leituras e escritas de cache disponíveis e saída por papel e tentativa. Instruções estáveis antecedem estado variável quando o harness permitir. DoD, evidência, re-ask e independência do juiz permanecem intactos sob o limite de bytes.
- **proof:** command: node --test --test-concurrency=1 test/engine/failover.test.mjs test/engine/routing.test.mjs

**origin:** review R1 e F4 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

### R4. O contexto enviado é relevante e rastreável

- **statement:** workers recebem a seleção de fatos da fase F2 como `readFiles` declarados; o reviser recebe nós alterados, seus achados e dependências necessárias, sem redigir novamente todo o plano. Falta de espaço para um fato obrigatório é erro explícito.
- **proof:** command: node --test --test-concurrency=1 test/plan/template.test.mjs test/plan/rounds.test.mjs

**origin:** review R4 e F4 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

### R5. Reparo repetido sem progresso para

- **statement:** falhas são classificadas por causa, e o `reauthor` existente só amplia contexto com validação e limite de rodadas. A mesma causa no mesmo nó e versão de artefato não dispara chamadas indefinidas. Ambiguidade de requisito vira pergunta durável. A avaliação compara custo por resultado aceito, não preço isolado de um modelo.
- **proof:** command: node --test --test-concurrency=1 test/engine/resume-reauthor.test.mjs test/plan/rounds.test.mjs

**origin:** review R5 e F4 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

## Não-objetivos

- Partilhar raciocínio do worker com o juiz.
- Ativar seleção empírica automática sem a decisão Q6 do roadmap.

## Restrições

- Manter revisão por patch já entregue na 0.30.0 e o limite de rodadas existente.
- Comparar o efeito em tarefas pareadas, com cache frio e quente separados.
