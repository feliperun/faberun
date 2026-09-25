---
id: planner-and-routing
title: "O planner congela, e cada nó tem o juiz certo"
version: 1.0.0
status: draft
date: 2026-09-24
owner: Felipe Broering
target: feliperun/faberun
baseline: 6ecb804
derived_from: choose-the-judges
followed_by: safe-to-hand-to-a-friend
---

# O planner congela, e cada nó tem o juiz certo

## Intenção

Campanha 3a do programa `leaving-home`, separada da `safe-to-hand-to-a-friend`
(3b) para que a 3b seja o teste do planner em vez de depender dele. Os
requisitos vieram da 3b com o texto e os números que já tinham (R9 e R14 a R21):
os ids são estáveis e o ROADMAP os cita.

**O planner está em 0 de 13.** Nenhum contrato de implementação saiu dele nas
três últimas campanhas que o usaram (os 10 escritos à mão abaixo), e os 3 planos
que o R5 da `choose-the-judges` fez sobre a fase 1 desta spec também não
congelaram (`evals/results/planner-roles/results.json`: dois por formato de
`proof.ref` e escopo, um porque o revisor e o juiz do contrato compartilham o
mesmo default).

**A regra de vendor compara texto livre.** `validateContract` recusa juiz do
mesmo `vendor` do worker, mas `vendor` é o que o contrato declarar: o exemplo da
skill usa `openai-sol` e `zhipu-flash`, e um juiz do mesmo provedor passa com um
rótulo diferente. Por isso R18 vem primeiro nesta campanha: a D9 (juiz por lista
ordenada) só significa alguma coisa se "outro provedor" for um fato, e não um
rótulo.

**O modo de um provedor só não tem régua ainda.** O R20 pede um juiz de `tier`
igual ou maior que o do worker, e o catálogo hoje não distingue Sonnet, Opus e
Fable: medido em `6ecb804`, os modelos declarados do harness `claude` são
`claude-sonnet-5`, `claude-opus-5` e `claude-sonnet-4-6` (sem `claude-opus-5-5` e
sem Fable), e `tier` só existe por runtime, como ordem de custo (o runtime de
descoberta `claude-sonnet` tem `tier` 2, igual aos três do Codex). R20 declara um
`tier` por modelo.

**Quando o planner contesta, só o autor sabe continuar.** A retrospectiva de
`durable-state-integrity` registra: "the planner contested both plans it was
given and I authored both contracts by hand", e acrescenta que as objeções eram
reais. Um plano contestado grava `status: "contested"` com os findings
(`src/plan/pipeline.mjs:238`) e para ali. Não existe verbo para responder a um
finding e continuar do estágio de revisão. Um amigo não vai escrever contrato à
mão.

**O planner ficou em 0 de 3, e o motivo não é só a contestação.** Nas três
campanhas mais recentes que usaram o planner, nenhum contrato de implementação
saiu dele: os dois da `durable-state-integrity` (segundo a retrospectiva dela),
os cinco da `evidence-you-can-recompute` (A, A2, A3, A4 e B) e os três da
`evals-with-a-budget` (`instruments`, `instruments-2` e `review-fixes`) foram
escritos à mão, e as duas últimas registram isso no journal como `decision` com
a palavra `hand-authored`. Só a `evidence-you-can-recompute`
gastou US$ 3,79 em planejamento que não congelou. Os journals mostram três
falhas diferentes, e só a primeira é a que o R9 já trata:

- **O revisor tinha razão.** As objeções da `evidence-you-can-recompute` eram
  defeitos reais da spec: um `measure` com `grep -c` que sai com código 1
  quando a contagem é zero, uma prova cujo arquivo de teste não estava no
  `writeFiles` de nenhum nó, e um passo declarado como fronteira humana
  (`reledger` na home do operador) que o plano não tinha como representar, então
  o nó que dependia dele nunca teria o que ler.
- **O revise piora o plano.** Na rodada 4, o revise do `gpt-5.6-luna` chegou a
  28 findings críticos e devolveu saída mecanicamente inválida (`proof.ref`
  como texto e não como índice, caminho de `scopeAcknowledged` que não
  existe). Cada rodada assim consome orçamento de revisão e deixa o plano mais
  longe de congelar.
- **O operador desiste do planner antes de tentar.** Na `evals-with-a-budget`,
  o contrato foi escrito à mão sem passar pelo planner, "porque o revise
  divergiu nos dois planos da campanha anterior".

O portão 3 para 4 do programa pede que a próxima campanha do operador feche
sem contrato escrito à mão. Com o planner assim, esse portão não se atinge.

**O bloco gerenciado do `AGENTS.md` bloqueia o lançamento.** Na campanha zero,
o faberun reescreveu o bloco de sinal do `AGENTS.md` a cada comando de campanha,
e o `faberun run` recusou lançar contra o HEAD por caminho não commitado. O
operador teve que dar `git checkout AGENTS.md` antes de cada lançamento. A
identidade de fonte já exclui esse bloco (`src/repo/source-identity.mjs:132`),
mas a checagem que recusou o lançamento não.

## Estado medido

`6ecb804`, com a evidência dos journals das campanhas 0, 1, 2 e 2b.

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Plano contestado que continua sem contrato escrito à mão | não | sim |
| Contratos saídos do planner nas três últimas campanhas que o usaram | 0 de 10 (todos escritos à mão) | a campanha fecha com os contratos das fases 2 em diante saídos do planner |
| Gasto de planejamento que não congelou, `evidence-you-can-recompute` | US$ 3,79 | o pipeline para quando a revisão não melhora |
| Findings críticos na última rodada do revise, `evidence-you-can-recompute` | 28 na rodada 4 | nunca mais que na rodada anterior sem parar |
| Passo humano declarado numa spec que o plano consegue representar | não | sim |
| Lançamentos recusados só pelo bloco gerenciado do `AGENTS.md` | todos, na campanha zero | 0 |
| Juiz de nó escolhido de uma lista ordenada (D9) | não: o contrato nomeia um juiz e um fallback | primeiro elegível da lista, com fallback de vários saltos |
| Regra de vendor que compara o provedor canônico | não: compara o campo `vendor`, texto livre (o exemplo da skill usa `openai-sol` e `zhipu-flash`) | provedor derivado do harness e do modelo |
| Revisor do planner configurado à parte do juiz do contrato (D11) | não: um `--runtime-defaults judge=` nomeia os dois | lista própria de revisores |
| Operador de um provedor só consegue juiz | não | sim, por opt-in, marcado em tudo o que um humano lê |
| Planos contestados por `proof.ref` escrito como texto | os dois configs de worker do R5 da `choose-the-judges` | 0 |
| `tier` por modelo Anthropic no catálogo | nenhum: `tier` só por runtime (`claude-sonnet` 2); Opus e Fable sem `tier` | Sonnet 2, Opus 3, Fable 4 |

Peças existentes que o trabalho reusa: o pipeline de plano com seus estágios,
`validateContract` com `scopeClosureFindings` e `crossNodeScopeFindings`, o
roteamento de `src/plan/routing.mjs` e `src/engine/failover.mjs`, o registro de
disponibilidade e de recusas da máquina (`src/run/availability.mjs`), as janelas
de uso (`src/run/usage-windows.mjs`), o catálogo de `src/harnesses/catalogue.mjs`
e o canário do juiz (`evals/judge-canary/`).

## Requisitos

### R18. O juiz de cada nó sai de uma lista ordenada, com fallback de vários saltos

- **statement:** a lista de juízes é estática e ordenada, declarada no contrato
  e no default da máquina (`faberun setup`); a do contrato vale sobre o default,
  como já é com o worker. Para cada nó, o engine escolhe o primeiro da lista cujo provedor
  canônico (`openai`, `anthropic`, `zhipu`, `deepseek`, `google`) é diferente do
  provedor do worker, pulando quem tiver recusa registrada na máquina ou janela
  de uso acima de 90%. Se o juiz escolhido for recusado durante a run, a vez
  passa ao próximo elegível, quantas vezes for preciso, sem voltar a um que já
  foi recusado. A run registra o juiz escolhido e, para cada um pulado, o
  motivo. O provedor canônico é derivado do harness e do modelo, e não do campo
  `vendor`: a regra de vendor de `validateContract` passa a compará-lo, e um
  `vendor` que o contradiz é recusado. A lista da D9 é `gpt-6-sol`,
  `claude-opus-5-5`, `glm-5.3-flash`.
- **proof:** `command: node --test --test-name-pattern="the judge is the first eligible entry of the list and falls back hop by hop" test/engine/judge-list.test.mjs`

### R9. Um plano contestado entrega uma decisão ao operador

- **statement:** quando o pipeline termina contestado, a saída lista cada
  finding crítico com id, o nó ou requisito a que se refere e o que o resolveria.
  `faberun plan --resolve <plan-dir> --answer <finding-id>=accept` ou
  `--answer <finding-id>=reject:<motivo>` retoma a partir do estágio de revisão,
  sem redesenhar do zero, grava as respostas no journal da campanha como
  `decision`, e um plano com todos os findings críticos respondidos pode
  congelar.
- **proof:** `command: node --test --test-name-pattern="a contested plan resumes from the operator's answers"`

### R14. O revise não piora o plano

- **statement:** toda saída do revise passa pela validação determinística do
  plano antes de contar como rodada. Um defeito mecânico com reparo único é
  reparado e registrado (o `proof.ref` escrito como texto deixa de ser defeito:
  R21 o aceita); um defeito sem reparo único volta ao mesmo revise uma vez, com as mensagens do validador, sem
  consumir rodada de revisão. O pipeline para e contesta, com um finding
  `revision_not_converging` que mostra a contagem de críticos por rodada, quando
  uma rodada termina com tantos ou mais críticos que a anterior, em vez de gastar
  as rodadas que sobram.
- **proof:** `command: node --test --test-name-pattern="a revise that does not reduce critical findings stops the pipeline"`

### R15. Uma prova que nenhum nó pode escrever é achada antes da revisão

- **statement:** um estágio determinístico, depois do rascunho e antes da
  primeira revisão, confere cada prova do DoD: um `--test-name-pattern` precisa
  casar com um teste que já existe na árvore ou estar num arquivo de teste que
  algum nó declara em `writeFiles`, e um comando de verificação precisa poder
  sair com 0 no estado que o nó promete (um `grep -c` ou `grep` sozinho que
  verifica ausência é marcado). Cada achado vira finding do plano, com o nó e a
  prova, sem invocar modelo.
- **proof:** `command: node --test --test-name-pattern="a proof no node can write is found before review"`

### R16. O plano representa um passo humano declarado na spec

- **statement:** um requisito cujas `constraints` declaram um passo do operador
  (por exemplo, rodar um comando na home real e commitar o resultado) vira, no
  plano congelado, um ponto de parada explícito: os nós que dependem desse passo
  esperam, a run para ali com uma atenção que nomeia o passo e o comando, e
  `faberun campaign resolve` (ou `resume --answer`) continua depois que o
  operador registra que fez. O mecanismo (nó humano, divisão de fase ou outro)
  fica a critério da implementação, desde que o Campaign Brief mostre o passo na
  lista de decisões humanas.
- **proof:** `command: node --test --test-name-pattern="a human step declared in the spec becomes a stop the plan carries"`

### R17. O bloco gerenciado do `AGENTS.md` não bloqueia o lançamento

- **statement:** `faberun run` e `faberun campaign supervise` lançam quando a
  única mudança não commitada é o bloco de sinal que o próprio faberun gerencia
  no `AGENTS.md`, e continuam recusando qualquer outra mudança não commitada,
  inclusive fora do bloco no mesmo arquivo. Se a falha já não se reproduzir em
  `1357ea6`, o requisito fecha com o teste de regressão.
- **proof:** `command: node --test --test-name-pattern="the managed signal block alone does not block a launch"`

### R19. O planner tem uma lista própria de revisores, separada do juiz do contrato

- **statement:** `faberun plan` recebe uma lista ordenada de revisores,
  declarada como a de juízes (contrato do plano ou config da máquina), e o
  estágio `review` usa o primeiro elegível dela. O juiz de cada nó do contrato
  congelado sai da lista de juízes de R18, e nunca da de revisores: um revisor de
  planejamento não julga nó de worker (D11: Fable e Astra revisam planos). Um
  revisor do mesmo provedor do planner deixa de tornar o contrato congelado
  impossível de rotear, porque os dois papéis não compartilham mais o
  `--runtime-defaults judge=`.
- **proof:** `command: node --test --test-name-pattern="the plan reviewer comes from its own list and never judges a node" test/plan/reviewer-list.test.mjs`

### R20. O modo de um provedor só é opt-in e aparece em tudo o que um humano lê

- **statement:** um operador com um provedor só declara, de forma explícita,
  `judgeIndependence: "same-vendor"` no contrato ou no config da máquina; sem
  isso, um nó sem juiz de outro provedor continua recusado. No modo, o juiz é
  outro modelo, com `tier` igual ou acima do `tier` do worker, e um juiz de
  `tier` menor é recusado. O catálogo passa a declarar um `tier` por modelo
  Anthropic, na ordem do preço de tabela: Sonnet 2 (`claude-sonnet-5`, US$ 2 /
  10 por MTok), Opus 3 (`claude-opus-5`, 5 / 25; `claude-opus-5-5`, 4 / 20),
  Fable 4 (`claude-fable-5`, `claude-fable-5-1`, 10 / 50). Sonnet trabalha, Opus
  ou Fable julga. O
  Campaign Brief, o relatório da run e as métricas marcam cada nó assim como
  "revisão do mesmo provedor". O canário ganha a leitura desse cenário: um juiz
  sobre os defeitos escritos por outro modelo da mesma família, lido à parte.
- **proof:** `command: node --test --test-name-pattern="same-vendor review is opt-in, needs a judge of equal or higher tier and is marked everywhere" test/contract/judge-independence.test.mjs`

### R21. O `proof.ref` de um plano é aceito pelo texto do comando ou pelo índice

- **statement:** no plano, o `proof.ref` de uma prova de verificação pode ser o
  índice do comando ou o texto exato de um comando da verificação do nó; o
  congelamento normaliza o texto para o índice. Um texto que não casa com nenhum
  comando continua sendo defeito, com o nó e os comandos que existem na
  mensagem. Medido na `choose-the-judges` (R5): o `proof.ref` inválido veio do
  revise do `gpt-5.6-luna` e do rascunho do `claude-opus-5-5`, então é formato,
  não modelo.
- **proof:** `command: node --test --test-name-pattern="a plan proof names its verification by text or by index" test/plan/proof-ref.test.mjs`

## Não-objetivos

- Tudo o que ficou na `safe-to-hand-to-a-friend`: ambiente permitido, guia
  executado, repositório fora do Node, campanha offline, reautoria de pacote,
  `uninstall`, custo do sandbox e override de nó (R1 a R8, R10 a R13).
- Escolher quais modelos estão nas listas de juízes e de revisores, ou a ordem
  delas. R18 e R19 dão o mecanismo; as listas são a D9 e a D11.
- Revisar a D9 ou a D11. São decisões do dono, fora desta spec.
- Calibrar a severidade dos findings (RM-103).
- `RM-086` (o `faberun plan` que morreu dentro de um painel tmux sem reproduzir
  fora dele). Fica medido e não reproduzido; o programa usa `plan --detach`.

## Restrições

- Contrato escrito à mão é permitido nesta campanha, porque é ela que conserta o
  planner; cada um é registrado como decision `hand-authored`.
- Até a quota do Codex voltar (30/09), o worker é `deepseek-flash` ou
  `glm-5.3-flash` e o juiz é `claude-opus-5-5`. Depois de R18, o juiz sai da
  lista da D9.
- Todo `measure` e toda prova por comando desta spec saem com 0 no estado
  esperado; um `grep` que verifica ausência usa `! grep -q` ou termina com
  `|| true` quando é só medida.
- Nenhuma dependência de runtime nova. Nenhum teto de docs sobe. Nenhum teste
  chama provedor.
- O orçamento de bytes da skill vale aqui: cada frase nova em `references/` sai
  de um corte, sem exceção.
- Linux, macOS e Windows continuam verdes.
- **Orçamento de execução:** até US$ 15.

## Critério de sucesso

| Indicador | Baseline | Alvo |
| --- | --- | --- |
| Plano da fase 1 da `safe-to-hand-to-a-friend` que congela sem edição à mão | 0 de 3 (R5 da `choose-the-judges`) | congela |
| Regra de vendor que compara o provedor canônico | não | sim |
| Rodadas de revisão gastas depois que os críticos pararam de cair | até 2 por plano | 0 |
| Nós cujo juiz sai da lista da D9 sem juiz nomeado à mão | 0 | todos os contratos lançados depois de R18 |

**Portão para a 3b.** No fim desta campanha, o operador roda `faberun plan` na
fase 1 da `safe-to-hand-to-a-friend` com `--detach`, sem lançar. O plano precisa
congelar sem edição à mão. Se contestar, esta campanha não fecha: os findings
são registrados e o dono é chamado.

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| R14 para cedo demais um plano que convergiria na rodada seguinte | um plano bom vira contestado | o finding mostra a contagem por rodada, e `plan --resolve` (R9) continua de onde parou |
| R16 cresce até virar um motor de workflow | escopo estoura | o requisito pede só parar, nomear o passo e continuar; nada de agendamento ou condição |
| Derivar o provedor canônico recusa contratos que hoje passam com um rótulo de `vendor` | um contrato antigo deixa de validar | a mensagem nomeia o provedor derivado e o declarado; contratos históricos em `docs/campaigns/` são registro e não são revalidados |
