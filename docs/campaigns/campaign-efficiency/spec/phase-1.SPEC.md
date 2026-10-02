---
id: campaign-efficiency-phase-1
title: "F1: revisão íntegra, recuperação e retomada"
version: 1.0.0
status: draft
date: 2026-09-29
owner: Felipe Broering
target: feliperun/faberun
baseline: 63760490
derived_from: campaign-efficiency
---

# F1: revisão íntegra, recuperação e retomada

## Intenção

Primeira entrega executável da [spec da campanha](SPEC.md). Corrige R1, R2, R3 e R6 e começa R7 pela reprodução. As quatro correções têm superfícies de escrita separáveis; o plano deve preservar dependências reais e não serializá-las por conveniência. Cada worker recebe pacote fechado com arquivos exatos e provas curtas. O grafo declara sua largura real; `maxParallel` do contrato segue o limite que o planner e o host comprovarem.

## Requisitos

### R1. Rotação preserva o juiz

- **statement:** uma sessão de juiz de outro nó da mesma fase não substitui o prompt efetivo do novo juiz pelo prompt do worker. Preservar DoD, evidência, papel e re-ask sem incluir resumo de raciocínio do autor. Se o limite de bytes não comportar a prova, falhar explicitamente.
- **proof:** command: node --test --test-concurrency=1 test/engine/failover.test.mjs

**origin:** review R1 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

### R2. Cadeia recupera controller após bootstrap

- **statement:** ao ver run inacabado sem controller vivo, a campanha retoma o mesmo run ou registra atenção durável depois de tentativas limitadas, sem duplicar execução e sem contrariar pausa solicitada.
- **proof:** command: node --test --test-concurrency=1 test/campaign/chain-restart.test.mjs

**origin:** review R2 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

### R3. Pausa e retomada pelo painel alteram estado

- **statement:** pausar registra intenção durável; retomar alcança run cancelado, limpa a pausa da campanha, ativa supervisão e responde com ação registrada. Repetir a operação é seguro e não relata sucesso vazio como ação.
- **proof:** command: node --test --test-concurrency=1 test/web/api.test.mjs

**origin:** review R3 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

### R6. Alertas de ociosidade não colidem

- **statement:** a chave de deduplicação inclui campanha e episódio durável, conserva supressão dentro do mesmo intervalo após reinício e permite novos alertas quando a ociosidade volta.
- **proof:** command: node --test --test-concurrency=1 test/campaign/watch.test.mjs

**origin:** review R6 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

### R7. Concorrência do juiz é medida antes de mudar admissão

- **statement:** um teste com sinais de prontidão coloca um worker ativo durante a liberação do juiz de outro nó e registra a quantidade simultânea de processos por papel e runtime. Se confirmar excesso, corrigir admissão antes do spawn; se refutar, registrar por que a política atual segura a corrida. Não alterar o teto de dois do planner com base só em chamadas HTTP ao provedor.
- **proof:** command: node --test --test-concurrency=1 test/engine/max-parallel.test.mjs

**origin:** review R7 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`, classificado como hipótese.

## Não-objetivos

- Implementar F2 a F6 nesta fase.
- Trocar juízes por worker, permitir escrita ao juiz ou elevar paralelismo sem prova de memória do host.
- Aceitar um teste por `--test-name-pattern` que não nomeie arquivo e título exato.

## Restrições

- Sem dependências de runtime novas. Cada nó declara todos os arquivos que sua mudança força a tocar.
- As provas do nó se concentram nos testes afetados; a verificação compartilhada e a final vêm do catálogo versionado.
- O reviewer adversarial do plano é `codex-astra`; o juiz de execução é `codex-sol`.
