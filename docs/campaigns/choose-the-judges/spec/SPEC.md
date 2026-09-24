---
id: choose-the-judges
title: "Juiz e revisor escolhidos por medição, com um corpus que não favorece o autor"
version: 1.0.0
status: draft
date: 2026-09-24
owner: Felipe Broering
target: feliperun/faberun
baseline: 1357ea6
derived_from: evals-with-a-budget
followed_by: safe-to-hand-to-a-friend
---

# Juiz e revisor escolhidos por medição, com um corpus que não favorece o autor

## Intenção

Campanha curta, entre a 2 e a 3 do programa `leaving-home`. Ela existe porque
a D9 foi tomada com um instrumento novo e uma amostra pequena, e porque o dono
quer trocar os juízes e o revisor do planner por modelos mais fortes. A
intuição é razoável, e o primeiro canário mostra que ela precisa ser medida:

| juiz | recall | falso alarme | US$/caso |
| --- | --- | --- | --- |
| gpt-5.6-sol | 1,00 (25/25) | 0,20 | 0,139 |
| glm-5.3-flash | 0,83 | 0 | 0,012 |
| claude-sonnet-5 | 0,30 | 0 | 0,263 |

O modelo mais caro da tabela foi o pior juiz, e o mais barato foi o segundo
melhor. O tamanho do modelo não previu a qualidade do julgamento. Então a troca
proposta pelo dono (DeepSeek v4 Pro, GLM 5.3 Pro, GPT Sol 6 e Opus 5.5 como
juízes; GPT Astra 6 no planejamento adversarial; Sonnet fora) entra aqui como
lista de candidatos, e a campanha decide com números.

**O corpus atual favorece a família de quem o escreveu.** Os 35 casos de
`evals/judge-canary/` foram reconstruídos pelo nó `canary-rebuilt` da
`evals-with-a-budget`, com o worker `claude-opus-5-5`. Um juiz da mesma família
do autor tende a enxergar melhor os defeitos que aquela família planta. Medir o
Opus 5.5 nesse corpus daria um número inflado, e nada no relatório de hoje
diria isso.

**A regra de vendor limita a escolha.** `validateContract` recusa juiz do mesmo
vendor do worker (`src/contract/index.mjs:293`). Com worker `deepseek-flash`, o
DeepSeek v4 Pro não pode julgar; com worker GLM, o GLM 5.3 Pro também não. O
resultado útil não é um juiz vencedor, é uma matriz: para cada vendor de
worker, o melhor juiz permitido.

**O planner falhou no reviser, não no revisor.** Na
`evidence-you-can-recompute`, o revisor (Opus) deu 17 findings, 4 críticos,
todos procedentes. Quem divergiu foi o revise do `gpt-5.6-luna`, que chegou a
28 críticos na rodada 4 com saída inválida. No planner, `draft` e `revise`
usam o papel `worker` e `review` usa o papel `judge` (`src/plan/template.mjs`),
então `--runtime-defaults worker=<id>,judge=<id>` já troca os dois. O Astra tem
um dado a favor como revisor adversarial: no round complexo do
`orchestration-arms`, foi o único writer que recusou o pacote, e a recusa foi
registrada como "defensável, bem diagnosticada". Mas trocar só o revisor não
ataca a falha que aconteceu.

## Estado medido

`1357ea6` (0.24.0).

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Casos de defeito do canário escritos fora da família Anthropic | 0 de 25 | pelo menos 9 de 25 |
| Autor registrado em cada caso do canário | não | sim |
| Repetições por juiz no canário | 1 | 2 |
| Juízes candidatos medidos | 3 | 3 anteriores mais DeepSeek v4 Pro, GLM 5.3 Pro, GPT Sol 6, Opus 5.5 |
| Matriz de juiz permitido por vendor de worker | não existe | versionada |
| Configurações de papel do planner comparadas no mesmo spec | 0 | 3 |

Peças existentes que o trabalho reusa: `evals/judge-canary/corpus.json` e o
construtor determinístico do canário, a checagem de que todo defeito passa na
prova mecânica, `--class judge-canary` com `--budget-usd` e `--repeat`, o
módulo de orçamento estocástico, a proveniência dos resultados em
`evals/results/`, a regra de vendor de `validateContract`, e `faberun plan`
com `--runtime-defaults` e `--review-rounds`.

## Requisitos

### R1. Todo caso do canário diz quem escreveu o defeito

- **statement:** cada caso de `evals/judge-canary/corpus.json` carrega
  `authoredBy` com o runtime e a família de vendor que escreveu o defeito, e o
  relatório do canário dá recall e falso alarme separados por família de autor,
  além do total.
- **proof:** `command: node --test --test-name-pattern="the canary reports recall by the family that authored each defect"`

### R2. Um terço dos defeitos vem de fora da família Anthropic

- **statement:** pelo menos 9 dos 25 casos de defeito, cobrindo os cinco tipos,
  são escritos por um runtime de outra família (OpenAI, DeepSeek ou Zhipu),
  gerados por um nó de descoberta do faberun a partir das mesmas tarefas do
  golden set. Todo caso novo passa pela checagem que já existe: o defeito passa
  na prova mecânica do nó, ou o construtor o recusa.
- **proof:** `command: node --test --test-name-pattern="a third of the canary defects come from outside the anthropic family"`

### R3. O canário diz quem pode julgar quem

- **statement:** o relatório combinado do canário produz uma matriz: para cada
  família de vendor de worker presente no catálogo, os juízes permitidos pela
  regra de vendor, com recall, falso alarme, erros e custo por caso de cada um,
  e o melhor por recall ajustado ao custo marcado. A matriz é gerada por um
  comando, a partir dos arquivos de resultado versionados, sem invocar modelo.
- **proof:** `command: node --test --test-name-pattern="the canary report says which judges may judge each worker vendor"`

### R4. Os candidatos são medidos com duas repetições

- **statement:** o operador roda o canário com o corpus de R2 e `--repeat 2`
  para DeepSeek v4 Pro, GLM 5.3 Pro, GPT Sol 6 e Opus 5.5, com `gpt-5.6-sol` e
  `glm-5.3-flash` como controles, dentro do orçamento das Restrições. Um
  candidato que `faberun models --probe` não encontrar fica registrado como
  indisponível, com o motivo. O recall do Opus 5.5 é lido no subconjunto escrito
  fora da família Anthropic.
- **proof:** `judgment: true`

### R5. Três configurações de papel do planner planejam o mesmo spec

- **statement:** a spec `safe-to-hand-to-a-friend` (fase 1) é planejada três
  vezes, sem lançar nada: (a) a configuração das campanhas anteriores (worker
  `gpt-5.6-luna`, juiz Opus), (b) juiz GPT Astra 6 com o mesmo worker, e (c) juiz
  GPT Astra 6 com worker forte (GPT Sol 6 ou Opus 5.5, o que a regra de vendor
  permitir). Para cada uma, `evals/results/planner-roles/` registra: congelou
  ou contestou, rodadas usadas, críticos por rodada, saídas inválidas do revise
  e custo.
- **proof:** `judgment: true`

### R6. As decisões são revistas com a evidência

- **statement:** `docs/ROADMAP.md` recebe a D9 revisada, com a matriz de R3 no
  lugar do juiz único e a regra do Sonnet, e uma decisão nova (D11) sobre os
  papéis do planner, citando R5. O `PROGRAM.md` troca a regra "juiz barato,
  fallback do mesmo nível" pela matriz, e o plano congelado melhor avaliado em R5
  vira o candidato da fase 1 da campanha 3.
- **proof:** `judgment: true`

## Não-objetivos

- Mudar o comportamento do produto sobre quando chamar o juiz. Isso continua
  com o R10 da `evals-with-a-budget` e com a D9 revisada.
- Novos tipos de defeito no canário.
- Repetir o benchmark pareado.
- Separar os papéis `draft` e `revise` do planner em runtimes diferentes; se R5
  mostrar que isso importa, vira item do roadmap.
- Lançar qualquer plano de R5.

## Restrições

- Orçamento das leituras de R4 e R5: US$ 70, dividido entre os processos pelo
  módulo de orçamento; leitura anulada fica registrada com o motivo e fora da
  média. O operador confirma o valor antes de R4.
- Os casos novos de R2 são escritos por nó do faberun e passam pela
  checagem determinística; nenhum caso é escrito à mão pela sessão que conduz a
  campanha.
- Nenhum teste chama provedor.
- O orçamento de bytes da skill continua valendo.

## Critério de sucesso

| Indicador | Baseline | Alvo |
| --- | --- | --- |
| Defeitos do canário de fora da família Anthropic | 0 de 25 | 9 ou mais |
| Juízes com recall medido em duas repetições | 0 | 6, ou o que estiver disponível |
| Matriz de juiz por vendor de worker | inexistente | versionada e citada na D9 |
| Configurações do planner comparadas | 0 | 3 |
| Gasto das leituras | 0 | até US$ 70 |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Um candidato não existe com esse nome no catálogo | leitura faltando | R4 registra como indisponível e segue com o resto |
| Casos novos são mais fáceis ou mais difíceis que os antigos | recall muda por causa do corpus, não do juiz | R1 separa o recall por família de autor, e os controles rodam no corpus novo |
| Três planos de uma spec só não bastam para decidir papéis | D11 fraca | D11 registra o que R5 sustenta e marca o resto como provisório |
| Opus avalia o próprio corpus | viés a favor do Opus | R4 lê o Opus no subconjunto de fora da família |
