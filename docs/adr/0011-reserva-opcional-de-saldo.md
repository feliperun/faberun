---
type: ADR
id: "0011"
title: "Reserva opcional de saldo bloqueia novos dispatches"
status: active
date: 2026-09-29
---

## Contexto

A ADR 0004 registrou a decisão de não impor teto de gasto. Na época, o schema não tinha `maxCostUsd` nem `usagePolicy`, e o ledger servia para relatar consumo. A razão continua válida para chamadas já iniciadas: falta de saldo não deve cancelar trabalho em voo.

A etapa F3 acrescenta uma reserva opcional de campanha antes do dispatch. A decisão precisa limitar o bloqueio a novas chamadas, permitir que cobranças tardias apareçam no ledger e manter custo sem medição como `unknown`.

## Decisão

Uma campanha pode configurar um saldo opcional. Antes de cada novo dispatch com custo conhecido, o sistema reserva esse valor. Se o saldo disponível for insuficiente, o sistema bloqueia somente esse novo dispatch. Chamadas já iniciadas continuam até a liquidação.

Quando o custo de uma chamada não puder ser medido, o ledger mantém `unknown`. O sistema não inventa um valor para reservar nem converte o custo em zero. A chamada pode seguir sem uma reserva numérica, e essa exposição permanece visível como desconhecida até que uma cobrança real permita reconciliá-la.

Uma cobrança tardia reconcilia a reserva e pode exceder o saldo reservado. O sistema exibe essa diferença; a reserva não promete um teto absoluto. A política se aplica ao planejamento, aos workers, aos juízes e às tentativas de retry.

## Relação com a ADR 0004

A ADR 0004 rejeitou um teto de gasto que mata trabalho e manteve `usage.jsonl` como registro de relatório. Esta decisão acrescenta uma verificação opcional antes de novas chamadas com custo conhecido. Ela não cancela chamadas ativas nem transforma o saldo configurado em limite absoluto. As demais decisões da ADR 0004 continuam ativas.

## Opções consideradas

- Reserva opcional antes de novos dispatches (escolhida): impede novas chamadas com custo conhecido quando falta saldo e preserva as chamadas em voo.
- Somente contabilização (rejeitada): não impede uma nova chamada com custo conhecido mesmo quando o saldo configurado é insuficiente.
- Teto absoluto de gasto (rejeitado): a campanha não pode garantir esse comportamento sem suporte do provedor e uma política para chamadas já iniciadas.

## Consequências

- Sem saldo configurado, a campanha continua registrando gasto sem aplicar a reserva.
- Com saldo configurado, o sistema reserva custos conhecidos antes de despachar e libera ou reconcilia o valor quando recebe o custo real.
- Custos desconhecidos permanecem separados dos custos medidos; nenhum cálculo os trata como zero.
- Uma cobrança que chega depois pode ultrapassar a reserva. O ledger e os relatórios precisam mostrar o valor real e a diferença.

## Referências

- [phase-3.SPEC.md](../campaigns/campaign-efficiency/spec/phase-3.SPEC.md), requisito R5, restrições e não-objetivos.
- [REVIEW-AND-PLAN.md](../reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md), seção F3, política de saldo e critérios de aceite.
- [SPEC.md](../campaigns/become-faberun/spec/SPEC.md), não-objetivo "No spend ceiling"; esta ADR limita a reserva a dispatches novos e não cria teto absoluto.
- [ADR 0004](0004-closed-task-packets-and-cross-vendor-judges.md), decisão anterior sobre ausência de teto de gasto.
