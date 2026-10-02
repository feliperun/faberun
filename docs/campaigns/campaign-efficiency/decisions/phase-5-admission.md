---
id: campaign-efficiency-decision-phase-5-admission
title: "F5: corrida de spawn confirmada — a fase prossegue com admissão comum"
date: 2026-10-02
status: accepted
campaign: campaign-efficiency
phase: F5
requirement: R7
---

# Decisão de admissão da fase 5

## Veredito

**A corrida de spawn está confirmada.** A fase F5 prossegue com **admissão comum**: worker, juiz,
re-ask, revisão e failover reservam slot global e por runtime antes de cada spawn. O ramo de
refutação da [spec da fase](../spec/phase-5.SPEC.md) — registrar a prova e não adicionar a correção —
não se aplica: não existe prova de refutação, e existe medição de excesso em campanha real.

## Base da decisão

1. **O review identificou o fluxo como hipótese P1, não reproduzida ali**
   ([REVIEW-AND-PLAN.md](../../../reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md), achado
   R7). O scheduler libera o slot do worker antes do settlement; um sibling pode ocupá-lo enquanto a
   prova roda; ao terminar a prova, `startJudge` inicia outro processo sem a admissão equivalente à
   aplicada à revisão do worker e sem reserva comum por runtime (`scheduler.mjs:491-497`,
   `dispatch.mjs:538-589`, `settle.mjs:84` no commit revisado `af880acc`). Confiança média porque a
   corrida não tinha sido reproduzida no review; o próprio review prescreveu reproduzir antes de
   tratar como bug.

2. **A campanha reproduziu o excesso duas vezes, com evidência de heartbeat**
   ([ACHADOS-PRODUTO.md](../ACHADOS-PRODUTO.md), achado 2):
   - 29/09 18:03Z — `r4-inventory` e `r5-checks` simultaneamente `running` com
     `executionPhase=worker`, ambos em `fx-deepseek`, no contrato `phase-2` que declara
     `maxParallel: 1`. O cap `maxConcurrent: 6` do runtime venceu o limite congelado do contrato.
   - 29/09 19:52Z — `r5-preflight-before-review` começou às 19:52:09Z enquanto `r4-omission-kinds`
     ainda estava no gate de verificação: exatamente a janela descrita no review (sibling ocupa o
     slot durante a prova de outro nó).
   - Conclusão registrada no livro: "O R7 do review deixa de ser 'potencial': está confirmado por
     medição." O nó `r7-judge-concurrency-measured` permanece `advisory`.

3. **A condição da F1 para corrigir foi satisfeita** ([phase-1.SPEC.md](../spec/phase-1.SPEC.md),
   R7: "Se confirmar excesso, corrigir admissão antes do spawn"). Confirmado por medição, o ramo de
   confirmação da [spec da fase 5](../spec/phase-5.SPEC.md) é o que governa. No critério de sucesso
   da [spec da campanha](../spec/SPEC.md), o indicador "concorrência de juiz além do limite" passa de
   "hipótese não reproduzida" para "limite respeitado".

## O que a fase F5 deve entregar

- Um único portão de admissão consultado **antes** de cada spawn, cobrindo worker, juiz, re-ask,
  revisão e failover, aplicando o `maxParallel` congelado do contrato e o limite por runtime. Contar
  somente depois de lançar não limita a concorrência.
- O limite do contrato vence o cap do runtime em todas as etapas, inclusive quando outro nó está no
  gate de verificação — as duas reproduções foram violações exatamente dessas duas formas.
- O número efetivo de nós concorrentes registrado no `status.json`, para que a prova de admissão
  fique barata (correção sugerida no achado 2).
- Prova da fase: `node --test --test-concurrency=1 test/engine/max-parallel.test.mjs
  test/engine/dispatch-during-verification.test.mjs test/engine/resume-reauthor.test.mjs`, com sinais
  de prontidão e sem limite superior de duração como asserção (restrição da spec da fase).

## Limites que a confirmação não muda

- O teto de paralelismo do planner (dois) não sobe sem medição de processos reais no host. A
  confirmação da corrida autoriza impor a admissão, não elevar a concorrência.
- Provas em worktrees independentes só avançam em paralelo depois da admissão comum, dentro da
  capacidade comprovada da máquina; refs e integração continuam serializadas.
- Checkpoint de comando de verificação só é reutilizado com árvore, comando, ambiente e dependências
  idênticos; prova mutante exige invalidação segura.
