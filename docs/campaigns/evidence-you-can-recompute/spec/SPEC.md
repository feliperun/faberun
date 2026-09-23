---
id: evidence-you-can-recompute
title: "Todo número que o faberun afirma sobre si mesmo é recomputável a partir de main"
version: 1.0.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: 748d7ba
derived_from: leaving-home
followed_by: evals-with-a-budget
---

# Todo número que o faberun afirma sobre si mesmo é recomputável a partir de main

## Intenção

Esta é a primeira campanha do programa `leaving-home`
(`docs/campaigns/leaving-home/PROGRAM.md`). O programa leva o faberun de
"fábrica que só fabricou a si mesma" até "ferramenta que três pessoas de fora
usaram nos próprios repositórios". Antes de medir qualquer coisa nova, e
principalmente antes de pedir a um amigo que confie num número, o número
precisa ser recomputável por qualquer um que clone o repositório. Hoje não é.

**O ledger versionado não carrega o que os projetores leem.**
`preserveCampaignLedger` (`src/campaign/index.mjs`) copia para
`docs/campaigns/<id>/ledger/` o `journal.jsonl`, o `campaign.json` e o
`usage.jsonl` de cada run. O projetor de evals (`readEvalRunSources`,
`evals/metrics.mjs`) lê `events.jsonl` e `usage.jsonl` do diretório da run. O
`faberun metrics` (`src/campaign/metrics.mjs`) lê snapshots de nó,
`events.jsonl`, `usage.jsonl` e `notify.jsonl`. Desde que o estado foi para
`~/.faberun/projects/<id>/runs/` e ganhou poda, a evidência que sustenta os
indicadores mora só na home do operador e morre com ela. O RM-030 registra o
mesmo vazamento para `proposals/`: 16 propostas só sobreviveram porque foram
resgatadas à mão.

**O baseline é de outra época.** `evals/baseline.json` foi gerado em
2026-09-12, teve o último commit em `0f5683f` (o rename de 15/09) e cita como
proveniência caminhos absolutos da máquina do operador
(`/Users/frb/dev/frb/skills/.runs/...`) que nem existem mais nesse layout.
Desde então entraram mais de 150 commits. O indicador primário
(`costPerClosedCheckpoint`, 5.5908 com n=9) não descreve o produto atual e
ninguém consegue recalculá-lo.

**A tese do roadmap cita uma medição que não está em main.** O parágrafo de
abertura de `docs/ROADMAP.md` apoia a tese ("rent intelligence") no
`orchestration-arms`: a organização do trabalho não move a conta com o modelo
fixo, e trocar o writer por um barato move de 16 a 50 vezes. O registro dessa
medição (`docs/campaigns/orchestration-arms/STATE.md`, a spec e
`spike/arms/resultados/`) existe só na branch `spike/orchestration-arms`. Pela
regra do próprio roadmap ("an item at `measured` or beyond cites the
measurement"), a tese principal hoje viola a regra.

**Custo desconhecido não diz por quê.** No ledger de
`state-location-and-routing-economics`, 73 de 186 invocações têm
`costProvenance: "unknown"` (todas as 36 do judge `deepseek-flash`, todas as 5
do `gemini-3.1-pro-high`, 22 de 60 do worker `glm-5.3-flash`). Depois do
RM-022 (preço pela seed vendorizada, 21/09), a `durable-state-integrity` caiu
para 1 de 21. O que sobra de `unknown` não carrega motivo, então não dá para
separar "o provedor não mede" de "o modelo não está na seed" de "a invocação
foi morta".

**A North Star não é calculada em lugar nenhum.** A decisão D4 escolheu
"intenção até resultado verificado" como North Star. Nenhum módulo em `src/` ou
`evals/` calcula isso (`grep -rniE "north.?star|intentTo"` volta vazio).

**O teto das docs virou uma catraca que só sobe.** `test/docs/docs-diet.test.mjs`
registra 12 aumentos de teto entre 13/09 e 22/09: 5 no `contract.md` (20.480
até 22.860 bytes), 6 no `operations.md` (10.240 até 12.280) e 1 no `SKILL.md`
(1.024 até 1.100). Cada um tem justificativa datada. A regra funciona como
registro, mas não freia nada.

Esta campanha não cria capacidade nova. Ela faz o que já existe provar o que
diz.

## Estado medido

`748d7ba`, suíte completa verde num container Linux (1.500 testes, 0 falhas, 8
pulados).

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Fontes dos projetores presentes no ledger versionado | 1 de 3 (`usage.jsonl`; faltam `events.jsonl` e os snapshots de nó) | 3 de 3 |
| `proposals/` preservado no fechamento | não | sim |
| Idade do baseline em commits | mais de 150 | 0, recomputado nesta campanha |
| Caminhos absolutos de máquina em `evals/baseline.json` | 5 | 0 |
| Invocações `unknown` sem motivo, `state-location` | 73 de 186 | 0 sem motivo |
| Invocações `unknown` sem motivo, `durable-state-integrity` | 1 de 21 | 0 sem motivo |
| North Star calculada | não | `faberun metrics` e evals reportam |
| Registro do `orchestration-arms` em main | não (só em `spike/orchestration-arms`) | sim |
| Aumentos de teto nas docs da skill entre 13/09 e 22/09 | 12 | 0 sem corte equivalente |
| Bytes de `SKILL.md` + `references/*.md` | 46.855 | 46.855 ou menos |

Peças existentes que o trabalho reusa em vez de reimplementar:
`preserveCampaignLedger` e seu contrato de idempotência, `projectMetrics`
(função pura sobre registros já lidos), `readEvalRunSources` e o merge de
fontes de `evals/metrics.mjs`, o seed de preços do RM-022, o resolver de
caminhos de `src/run/paths.mjs`, o registro de projeto da home e o ratchet de
`test/docs/docs-diet.test.mjs`.

## Requisitos

### R1. O ledger fechado carrega toda fonte que os projetores leem

- **statement:** `campaign close` preserva em `docs/campaigns/<id>/ledger/`,
  além do que já preserva, o `events.jsonl` de cada run vinculada, uma projeção
  dos snapshots de nó com exatamente os campos que `projectMetrics` lê, e o
  diretório `proposals/` da campanha quando existir. A preservação continua
  idempotente, e uma run sem algum desses arquivos é pulada e nomeada na saída,
  nunca lançada como erro.
- **proof:** `command: node --test --test-name-pattern="a closed ledger carries every source the projectors read"`
- **constraints:** a projeção de snapshot é um arquivo por run
  (`<runId>.nodes.json`), com campos listados num único lugar do código e
  testados. Nenhum prompt, diff ou saída de worker entra no ledger.

### R2. Métricas recomputadas do ledger são iguais às da run

- **statement:** `faberun metrics <campaign-id> --ledger <dir>` e
  `node evals/run.mjs --project-ledger <dir>` produzem, para uma campanha de
  fixture, exatamente os mesmos indicadores que as leituras a partir dos
  diretórios de run. Uma fonte ausente no ledger aparece como indicador `null`
  com o nome da fonte que faltou, nunca como zero.
- **proof:** `command: node --test --test-name-pattern="metrics from a ledger equal metrics from its run directories"`

### R3. Uma campanha já fechada pode ter o ledger completado

- **statement:** `faberun campaign reledger <campaign-id>` recopia para o
  ledger versionado as fontes de R1 a partir das runs que ainda existem na home
  do operador. Rodar duas vezes dá o mesmo resultado, nenhum arquivo já presente
  no ledger é apagado ou encurtado, e a saída lista, por run, o que foi copiado
  e o que já não existe mais.
- **proof:** `command: node --test --test-name-pattern="reledger completes a ledger without losing what it had"`
- **constraints:** rodar `reledger` na home real do operador, para as
  campanhas fechadas desde 15/09, e commitar o resultado é passo do operador,
  declarado como fronteira humana no contrato, não trabalho de worker.

### R4. Custo desconhecido carrega o motivo

- **statement:** todo registro de uso com `costProvenance: "unknown"` carrega
  `unknownReason` de um vocabulário fechado: `no-usage-stream` (o harness não
  emite contagem), `model-not-priced` (o modelo não está na seed),
  `provider-reported-nothing` (o stream veio e não trouxe custo nem tokens) e
  `invocation-killed` (a invocação terminou antes de reportar). `faberun
  metrics` reporta a fração desconhecida separada por motivo, e `campaign close`
  imprime essa fração. Registros antigos sem o campo são lidos como `legacy`.
- **proof:** `command: node --test --test-name-pattern="an unknown cost names its reason"`

### R5. A North Star vira indicador

- **statement:** `projectMetrics` reporta `intentToVerifiedSeconds`: o tempo
  entre o evento `campaign.initialized` e o evento em que o último requisito
  declarado pelas fases da campanha passa a ter prova aprovada no closure. O
  valor é `null` enquanto houver requisito sem prova. Reporta também, como
  diagnóstico sem direção, `humanTouches`: quantos comandos do operador mudaram
  o estado da campanha depois do primeiro lançamento (`campaign resolve`,
  `resume --answer`, `resume --reconcile`, `cancel`, `campaign add-contract`).
- **proof:** `command: node --test --test-name-pattern="the north star is measured from initialization to the last proven requirement"`
- **constraints:** a decisão D4 continua valendo: `humanTouches` é diagnóstico
  e nunca entra num alvo com direção "down".

### R6. O baseline se recomputa a partir de ledgers versionados

- **statement:** `evals/baseline.json` passa a citar como proveniência apenas
  diretórios de ledger relativos ao repositório. Um teste recomputa cada
  indicador a partir desses ledgers e confere com o arquivo até a quarta casa.
  O baseline desta campanha é gerado a partir das três campanhas fechadas mais
  recentes cujo ledger esteja completo depois de R3.
- **proof:** `command: node --test --test-name-pattern="the baseline recomputes from versioned ledgers"`
- **measure:** `command: grep -c '/Users/' evals/baseline.json`

### R7. O registro do orchestration-arms está em main

- **statement:** `docs/campaigns/orchestration-arms/` em main contém o
  `STATE.md`, a `spec/SPEC.md`, o ledger de resultados (`runs.jsonl`) e as
  análises da branch `spike/orchestration-arms`, sem o código do driver. O
  parágrafo de tese de `docs/ROADMAP.md` e o comentário de
  `src/engine/settle.mjs` que citam a campanha apontam para esse caminho.
- **proof:** `command: node --test --test-name-pattern="the measurement the roadmap thesis cites is versioned"`
- **measure:** `command: git ls-tree -r --name-only origin/spike/orchestration-arms docs/campaigns/orchestration-arms spike/arms/resultados | grep -v '/contracts/'`

### R8. A skill e suas referências dividem um orçamento só

- **statement:** além dos tetos por arquivo, `test/docs/docs-diet.test.mjs`
  impõe um teto para a soma dos bytes de `skills/faberun/SKILL.md` e
  `skills/faberun/references/*.md`, fixado no valor medido no baseline
  (46.855). Subir o teto de um arquivo sem descer o de outro, de forma que a
  soma passe do orçamento, falha a suíte. O orçamento total só pode subir com um
  ADR novo em `docs/adr/` que o teste exige estar citado no comentário.
- **proof:** `command: node --test --test-name-pattern="the skill and its references share one byte budget"`

## Não-objetivos

- Indicadores novos além de `intentToVerifiedSeconds`, `humanTouches` e a
  fração desconhecida por motivo.
- Dashboard, página web ou gráfico dos indicadores.
- Reescrever ledgers de campanhas cujas runs já não existem na home. Eles
  ficam como estão e são lidos como incompletos.
- Mudar a seed de preços ou perseguir exatidão de preço (decisão do RM-022).
- Qualquer rodada estocástica ou com modelo real. Isso é da campanha
  `evals-with-a-budget`.
- Trazer o driver `spike/arms/` para main. Isso também é da campanha seguinte.

## Restrições

- Nenhuma dependência de runtime nova. `package.json` continua sem
  `dependencies`.
- Nenhum teste chama um provedor. Toda fixture usa o harness `replay` ou
  registros escritos à mão.
- Nenhum teste escreve na home real do operador. O runner já escopa
  `FABERUN_HOME`, e o ratchet que mede isso continua verde.
- O orçamento de R8 vale para a própria campanha: toda frase nova nas
  referências da skill é paga com um corte equivalente.
- Linux, macOS e Windows continuam verdes no CI.
- Comentários registram medição, não intenção, como no resto do repositório.

## Critério de sucesso

| Indicador | Baseline | Alvo |
| --- | --- | --- |
| Fontes dos projetores no ledger versionado | 1 de 3 | 3 de 3 |
| Indicadores do baseline recomputáveis a partir de main | 0 | todos |
| Invocações `unknown` sem motivo em campanha fechada nesta campanha | não medido por motivo | 0 |
| `intentToVerifiedSeconds` desta própria campanha | inexistente | reportado no fechamento |
| Bytes da skill e referências | 46.855 | 46.855 ou menos |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| `events.jsonl` de runs longas deixa o git pesado | clone lento, diffs ruidosos | a fase 1 mede o tamanho real por run na home do operador antes de decidir; se passar do limite medido, preserva uma projeção dos eventos que os projetores leem, com os tipos listados num só lugar |
| Um segredo chega ao ledger por um evento com texto livre | vazamento no repositório público | o scan de segredos do pre-commit continua sendo a guarda; R1 adiciona um teste com segredo plantado num evento de fixture |
| Recomputar o baseline muda o número e parece regressão | leitura errada da tendência | o baseline novo registra o valor anterior e o motivo da diferença, no mesmo formato da nota de 12/09 |
| R8 trava uma frase que é capacidade real | documentação pior | o caminho existe e é caro de propósito: ADR citado no teste |
