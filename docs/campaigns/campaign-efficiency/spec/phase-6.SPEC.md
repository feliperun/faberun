---
id: campaign-efficiency-phase-6
title: "F6: progresso único e próxima ação clara"
version: 1.0.0
status: draft
date: 2026-09-29
owner: Felipe Broering
target: feliperun/faberun
baseline: 63760490
derived_from: campaign-efficiency
---

# F6: progresso único e próxima ação clara

## Intenção

Continuar R3 e R6 da [spec da campanha](SPEC.md). CLI, painel e notificações devem concordar sobre o que terminou, o que aguarda, quanto custou e quem age agora, usando projeção determinística do estado já persistido.

## Requisitos

### R3. Retomada aparece como operação real

- **statement:** o painel não desenha cancelado como concluído nem anuncia retomada sem operação. A mesma projeção indica ação aplicada, pendente ou nenhuma ação necessária e nomeia o responsável por uma decisão humana.
- **proof:** command: node --test --test-concurrency=1 test/web/api.test.mjs test/report/progress.test.mjs

**origin:** review R3 e F6 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

### R6. Cada superfície explica progresso, custo e próximo passo

- **statement:** projeção comum mostra objetivo, fase, requisitos comprovados sobre o total, atividade atual, tempo desde progresso útil, motivo de espera, custo conhecido, invocações sem preço e próxima ação. Alertas de fase concluída, recuperação esgotada, decisão necessária e encerramento são deduplicados por campanha e episódio, com recibo antes de afirmar entrega. Atualizações automáticas de progresso não chamam modelo.
- **proof:** command: node --test --test-concurrency=1 test/report/progress.test.mjs test/web/api.test.mjs test/campaign/watch.test.mjs

**origin:** review R6 e F6 em `docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md`.

## Não-objetivos

- Criar dashboard grande ou estimar conclusão sem amostra comparável.
- Fazer notificação sem transporte configurado ou afirmar entrega sem recibo.

## Restrições

- `buildCampaignProgress` continua sendo fonte de verdade; as superfícies derivam seus rótulos dele.
- Se uma mensagem de progresso da mesma campanha ainda puder ser editada, seguir a janela de 15 minutos. Evento que exige atenção é nova mensagem.
