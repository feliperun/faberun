---
id: evals-with-a-budget
title: "Evals que gastam dinheiro têm orçamento, banda e lugar em main"
version: 1.0.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: 748d7ba
derived_from: evidence-you-can-recompute
followed_by: safe-to-hand-to-a-friend
---

# Evals que gastam dinheiro têm orçamento, banda e lugar em main

## Intenção

Segunda campanha do programa `leaving-home`. A primeira tornou os números
recomputáveis. Esta cria os dois instrumentos estocásticos que faltam para
responder às duas perguntas que um amigo vai fazer antes de gastar o dinheiro
dele: "isso é melhor que eu rodar uma sessão?" e "o juiz vale o que custa?".

**A única evidência estocástica do projeto foi produzida fora de main.** O
`orchestration-arms` rodou com um driver em `spike/arms/` (ports de arm,
corpus, fork, medição, análise), na branch `spike/orchestration-arms`. O round
simples teve duas repetições por arm. O round complexo teve uma, e o próprio
`STATE.md` diz que sem segunda repetição nenhuma leitura de H1 a H4 é
resultado: as duas runs de faberun com sonnet do mesmo round ficaram em US$ 3,37
e 5,07 com a mesma configuração, uma dispersão da ordem de 40%. O driver
também achou e corrigiu defeitos de medição que um instrumento permanente
precisa ter desde o primeiro dia: guardas que passavam na base contavam como
entrega (um arm que não mudou nada marcava 2 de 4), e o teste aceito era
escrito sobre o do arm antes de as suítes rodarem.

**O juiz é o maior custo sem evidência de retorno.** Nos dois rounds, 34 nós
julgados, 0 findings, e o juiz custou de 24% a 45% do arm (RM-013). O próprio
registro corrigiu a leitura depois da revisão: o produto já não despacha juiz
para nó sem item `judgment: true` (`src/engine/judge-gate.mjs`,
`judgeRequired`), e o arm A pagou juiz porque os contratos da campanha puseram
item de julgamento em todo nó que já tinha prova mecânica. Então há duas
perguntas separadas. A primeira é de autoria: por que o contrato pede
julgamento onde um comando já prova? A segunda é de calibração: quando o
julgamento é de fato necessário, o juiz pega alguma coisa? A segunda ninguém
mediu. Sem ela, a revisão cross-vendor, que é princípio do `docs/VISION.md`, é
uma aposta. A decisão D3 já reconhece que a confiança de uma intent eval é só
sinal exploratório até o canário reportar.

Esta campanha traz o instrumento para main, dá a ele orçamento duro e banda, e
constrói o canário do juiz de forma que a parte determinística (o corpus, a
contagem e o orçamento) seja provada sem modelo, e a parte estocástica (as
leituras) seja rodada pelo operador com dinheiro declarado.

## Estado medido

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Driver do benchmark pareado em main | não (`spike/arms/`) | classe `paired` em `evals/` |
| Repetições do round complexo | 1 | 3 |
| Classes de eval com orçamento duro | 0 | toda classe estocástica |
| Nós julgados com finding, nos dois rounds | 0 de 34 | não é alvo, é o que o canário explica |
| Participação do juiz no custo do arm julgado | 24% (complexo), 45% (simples) | reportado por campanha |
| Casos de canário do juiz | 0 | pelo menos 35 |
| Runtimes de juiz com recall medido | 0 | pelo menos 2 |
| Itens `judgment: true` com motivo declarado | não existe o campo | todo item novo |

Peças existentes que o trabalho reusa: o driver e as análises de
`spike/arms/` (trazidos, não reescritos do zero), o harness `replay`, a flag
`--repeat` e o `--band` de `evals/run.mjs`, o golden set de `evals/golden/`
com `fixtures.bundle`, `judgeRequired` e `gate.skipWhen` de
`src/engine/judge-gate.mjs`, o seed de preços do RM-022, e os ledgers
recomputáveis da campanha anterior.

## Requisitos

### R1. Toda classe estocástica tem orçamento duro

- **statement:** um módulo único de orçamento serve toda classe de eval que
  invoca modelo real. A classe recusa começar sem `--budget-usd`, para de
  lançar invocações quando o gasto precificado mais a estimativa das
  invocações em voo alcança o orçamento, e registra no resultado o gasto
  anulado (invocações descartadas ou mortas). Uma invocação de custo
  desconhecido conta pelo maior preço já observado para aquele runtime, nunca
  por zero.
- **proof:** `command: node --test --test-name-pattern="a stochastic class stops at its budget"`

### R2. O benchmark pareado é uma classe versionada

- **statement:** `node evals/run.mjs --class paired` roda arms declarados em
  `evals/paired/arms.json` sobre um corpus em `evals/paired/corpus/<id>/`, em
  ordem embaralhada por semente registrada, com `--repeat <n>`. O relatório dá,
  por arm, provas entregues, custo por prova entregue, tempo de parede,
  requisições quando o harness mede, arquivos fora do escopo, e a banda: mínimo
  e máximo sempre, e intervalo de 95% por reamostragem quando `n` for 3 ou
  mais. A classe inteira roda com arms `replay` num teste determinístico.
- **proof:** `command: node --test --test-name-pattern="the paired class reports a band per arm"`
- **constraints:** o código vem de `spike/arms/` e mantém os nomes de arm e
  de hipótese do `STATE.md`, para que as leituras antigas continuem
  comparáveis.

### R3. Entrega é prova passando com toda guarda passando

- **statement:** cada verificação da aceitação escondida tem um tipo, `proof`
  ou `guard`. Uma run entrega as provas que passam enquanto todas as guardas
  passam, e um arm que não altera nada entrega zero. A aceitação roda sobre a
  árvore do arm antes de qualquer arquivo aceito ser restaurado por cima.
- **proof:** `command: node --test --test-name-pattern="a paired arm that changes nothing delivers zero"`

### R4. O corpus pareado começa com as duas fases já medidas

- **statement:** o corpus contém o round simples (os dez requisitos em
  `a1117f7`) e o round complexo (a fase `1c-run-path-resolver` em `4913ef2`),
  cada um com sha base, pacotes registrados palavra por palavra, aceitação
  escondida tipada e a referência histórica de custo e tempo. `--validate-corpus`
  confere que cada sha resolve no bundle de fixtures, que toda prova falha na
  base e que toda guarda passa na base.
- **proof:** `command: node --test --test-name-pattern="every paired corpus entry fails its proofs and passes its guards at base"`

### R5. O canário do juiz tem defeitos que a prova mecânica não vê

- **statement:** `evals/judge-canary/` contém casos construídos a partir de
  tarefas do golden set. Cada caso é um diff selado, o pacote e o DoD do nó, e
  um rótulo: `clean` ou `defect:<kind>`. Os tipos são os que um comando não
  pega: `nongoal-violated`, `requirement-half-done` (os testes passam e um
  comportamento declarado falta), `scope-drift-inside-writefiles`,
  `doc-contradicts-code` e `test-weakened` (asserção removida ou afrouxada).
  São pelo menos 5 casos por tipo e 10 limpos. A construção é determinística e
  versionada.
- **proof:** `command: node --test --test-name-pattern="the judge canary corpus has every defect kind and clean controls"`

### R6. Todo defeito do canário passa pela prova mecânica que ele esconde

- **statement:** para cada caso `defect:<kind>`, as verificações do nó rodam
  sobre a árvore com o defeito e passam. Um caso cujo defeito uma verificação
  pega é rejeitado pelo construtor, com o nome do caso, porque não mede o juiz.
  Este é o `--verify-discriminating` do canário, e roda sem modelo.
- **proof:** `command: node --test --test-name-pattern="every canary defect passes the mechanical proof it hides behind"`

### R7. O canário reporta recall e falso alarme por runtime de juiz

- **statement:** `node evals/run.mjs --class judge-canary --runtime <id>
  --budget-usd <n> [--repeat <k>]` reporta, por tipo de defeito, o recall
  (defeitos rejeitados com finding citando o item), a taxa de falso alarme nos
  casos limpos e o custo por caso. O resultado vai para
  `evals/results/judge-canary/<data>-<runtime>.json`. Um juiz `replay` que
  sempre aprova tem recall 0, e um que sempre rejeita tem falso alarme 1, e as
  duas leituras são testadas.
- **proof:** `command: node --test --test-name-pattern="the canary scores a judge that always passes and one that always rejects"`

### R8. Todo resultado estocástico carrega a própria proveniência

- **statement:** cada arquivo de resultado de `paired` e `judge-canary` registra
  o commit, a semente, o número de repetições, o orçamento, o gasto precificado,
  o gasto anulado e, por runtime, harness, modelo e versão do CLI quando o
  harness a reporta. `--compare` aceita dois resultados da mesma classe e recusa
  classes diferentes.
- **proof:** `command: node --test --test-name-pattern="a stochastic result names everything that produced it"`

### R9. O rendimento do juiz aparece nas métricas da campanha

- **statement:** `faberun metrics` reporta `judgeFindingRate` (nós com pelo
  menos um finding sobre nós julgados) e `judgeCostShare` (custo de juiz sobre
  custo total precificado), calculados a partir do ledger versionado.
- **proof:** `command: node --test --test-name-pattern="judge yield is reported per campaign"`

### R10. Um item de julgamento diz o que nenhum comando verifica

- **statement:** um item de DoD com `judgment: true` pode declarar `reason`,
  uma frase sobre o que nenhum comando consegue checar. `faberun contract
  validate` emite o finding `judgment_without_reason` para item sem motivo, e o
  finding `judgment_beside_mechanical_proof` para nó em que todo item de
  julgamento divide o nó com itens de prova mecânica e não declara motivo. Os
  dois são advisory por padrão e bloqueiam com `--strict-traceability`. O
  formato de saída do planner inclui `reason`.
- **proof:** `command: node --test --test-name-pattern="a judgment item without a reason is a finding"`

### R11. As primeiras leituras reais são feitas e registradas

- **statement:** o operador roda o round complexo do `paired` com 3
  repetições para os arms A, B, D, E, H e J, e o `judge-canary` para pelo menos
  dois runtimes de juiz de vendors diferentes, dentro do orçamento declarado nas
  Restrições. Os resultados são versionados, e `docs/ROADMAP.md` recebe uma
  decisão nova (D7) sobre o juiz: manter, restringir a um tipo de nó ou tornar
  advisory por padrão, citando os arquivos de resultado.
- **proof:** `judgment: true`

## Não-objetivos

- Rodar classe estocástica em CI, por cron ou em pull request. Isso fica com o
  operador, na máquina dele, com as credenciais dele.
- Mudar o default de juiz do produto nesta campanha. R11 registra a decisão, e
  aplicá-la é trabalho de outra spec.
- Roteamento empírico automático (RM-020, pergunta Q6).
- Intent evals por campanha (RM-011). O canário é o pré-requisito que a D3
  nomeia, não a intent eval em si.
- Arms novos além dos já medidos no `orchestration-arms`.
- Métrica de requisição para codex e zcode (RM-017). O relatório diz
  "não medido" para esses harnesses, como hoje.

## Restrições

- Orçamento total declarado para R11: US$ 100, sendo cerca de US$ 60 para três
  repetições de seis arms do round complexo (a repetição de dez arms custou
  US$ 26,55) e cerca de US$ 20 para o canário em dois runtimes. O resto é folga
  para voids. O operador confirma o valor antes da fase de R11.
- Nenhum teste de `npm test` invoca provedor. `--assert-no-model` continua
  valendo para toda classe determinística.
- A suíte determinística não fica mais que 10% mais lenta (hoje, cerca de 11
  minutos no container de referência).
- Os limites de docs da campanha anterior valem aqui: nada entra nas
  referências da skill sem corte equivalente.

## Critério de sucesso

| Indicador | Baseline | Alvo |
| --- | --- | --- |
| Repetições do round complexo com banda | 1 | 3 |
| Runtimes de juiz com recall e falso alarme medidos | 0 | 2 ou mais |
| Casos de canário que passam na prova mecânica | 0 | todos, verificado sem modelo |
| Decisão sobre o juiz registrada com evidência | nenhuma | D7 no roadmap |
| Gasto real das leituras | 0 | até US$ 100 |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Os defeitos plantados são fáceis demais e o recall sai inflado | falsa confiança no juiz | os tipos vêm de falhas reais do histórico (retrospectivas, RM-005, RM-032) e cada caso é revisado à mão antes de entrar no corpus |
| Uma leitura com n=3 ainda tem banda larga | nenhuma hipótese resolve | o relatório diz "não resolvido" quando a diferença cabe na banda, como o `STATE.md` já faz |
| Quota de assinatura acaba no meio de um round | round anulado | o orçamento conta o gasto anulado, e a classe retoma pelo arm e repetição seguintes da semente registrada |
| Trazer o driver do spike arrasta código morto ou duplicado | módulos grandes demais, nomes exportados duas vezes | `test/repo/source-shape.test.mjs` continua valendo sem exceção nova: teto de 800 linhas por arquivo, nenhum nome exportado por dois módulos, nenhum ciclo, e `evals/` nunca soletra o diretório de runs |
