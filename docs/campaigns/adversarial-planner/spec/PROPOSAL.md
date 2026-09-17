---
title: "Faberun: planejamento adversarial fora da sessão"
version: 1.0.0
status: proposed
date: 2026-09-16
owner: Felipe Broering
campaign_id: adversarial-planner
baseline: feliperun/faberun @ f3fdeb7
phases: 3
depends_on: "campanha env-independence-and-generated-docs (N5, contabilidade de bytes de referência)"
---

# Faberun: planejamento adversarial fora da sessão

## 1. Intenção

O planejamento adversarial já existe: hoje ele acontece como um debate entre dois
modelos dentro da sessão de controle. A intenção não é criá-lo, é **tirá-lo do
lugar mais caro do sistema** e dar a ele orçamento, isolamento, determinismo e
medição.

O que muda:

| Hoje | Depois |
|---|---|
| debate conversacional, contexto crescente | duas invocações com packet fechado |
| revisor vê o raciocínio do planejador | revisor recebe spec, fatos e plano, nada mais |
| "até chegarem num consenso", sem freio | `maxRevisions`, estado terminal `contested` |
| custo sai da allowance do harness, invisível | custo gravado em `usage.jsonl` |
| worker e juiz fixos pela instrução do operador | tabela por `taskKind` e `riskTier`, override do operador ganha |
| `timeoutSec` por palpite do modelo | duração medida por `preflight --time-verification` |
| plano sai de uma conversa, irreproduzível | plano congelado com digest e proveniência |
| planejamento morre com a sessão | planejamento é nó detached, sobrevive a troca de assento |

O que **não** muda:

- A invocação continua sendo uma linha em linguagem natural apontando para uma
  spec. Se a experiência do operador piorar, o desenho está errado.
- O operador mantém veto sobre o plano antes de qualquer execução começar.
- Instrução explícita de runtime pelo operador continua ganhando da tabela.

## 2. O que já existe e é reusado

Nada de orquestração nova. O pipeline de planejamento **é um contrato** que o
faberun já sabe executar.

| Peça existente | Papel no planejador |
|---|---|
| `mode: "discovery"`, `writeFiles` vazio | o nó de rascunho |
| gate com `failOn` e `maxRevisions` | o ciclo de revisão adversarial |
| `forbidSameVendorAsWorker` no gate | o isolamento do revisor |
| `preflight --time-verification` | a duração medida antes de declarar `timeoutSec` |
| `runtime-discovery`, `env-preflight` | o estágio de runtimes disponíveis |
| forma de tabela de `bulk-read.mjs` | a tabela de roteamento |
| `finalVerification` | o congelamento |
| `src/cli/*.mjs`, um arquivo por verbo | onde `plan.mjs` entra |

O que falta é um template de contrato, quatro módulos determinísticos e o braço
comparativo no eval.

## 3. ADRs

### ADR-0038: o modelo classifica, a tabela roteia

O rascunho devolve `taskKind` e `riskTier` por nó. Uma tabela declarativa decide
o runtime.

Se o modelo escolher o modelo, o roteamento deixa de ser comparável entre
execuções e a medição do próprio planejador perde sentido: você não conseguiria
distinguir um plano que ficou mais barato porque melhorou de um que ficou mais
barato porque o modelo sorteou outro runtime.

Coerente com a regra já vigente em `rules.md`: escolha de modelo só em
`runtimes`, `runtimeDefaults` ou override explícito de nó, nunca como
ramificação em prosa.

### ADR-0039: o revisor não recebe o raciocínio do planejador

O revisor recebe exatamente três entradas: a spec original, `repo-facts.json`, e
o plano final. Nunca cadeia de raciocínio, nunca justificativa de descarte.

Dois modelos conversando convergem socialmente: o segundo aceita o enquadramento
do primeiro e discute detalhes dentro dele. Isolamento é o que transforma
segunda opinião em revisão.

Mesmo invariante que o gate já impõe entre juiz e worker, aplicado ao
planejamento.

### ADR-0040: desacordo é estado terminal, não custo

`maxRevisions` limita as rodadas. Esgotado sem convergir, o plano sai
`contested`, para, e notifica o operador com os achados abertos.

"Consenso" não é critério verificável. Sem estado terminal, três resultados
diferentes (convergiu bem, um cedeu, concordaram em algo errado) são
indistinguíveis e todos custam.

### ADR-0041: o plano congelado não inicia execução sozinho

O congelamento emite `contract.json` com digest e para. A execução começa por
aprovação.

Isso preserva o gancho de intervenção que o fluxo atual tem de graça. A
aprovação é uma tocada pela superfície remota, ou automática por política
(`--approve-below`), nunca implícita.

### ADR-0042: planejamento é custo de campanha e é gravado

Toda invocação do planejador e do revisor entra em `usage.jsonl` atribuída ao
nó, como qualquer outra.

Hoje o debate consome allowance do harness e não aparece no ledger, então
`costPerClosedCheckpoint` **subestima sistematicamente** o custo real, e
subestima mais justamente nas campanhas cujo planejamento foi mais difícil.

## 4. Fase 1: estágios determinísticos

Zero modelo. A maior parte do código e a mais barata de provar.

### N1. `repo-facts`

**writeFiles**

    src/plan/repo-facts.mjs
    test/plan/repo-facts.test.mjs

**Intenção.** Inventário determinístico do repositório alvo, para que o rascunho
não precise ler nada para descobrir o que existe. Emite `repo-facts.json`.

Conteúdo: árvore de paths (respeitando `.gitignore`), scripts declarados em
`package.json` ou equivalente, comandos de verificação candidatos com **duração
medida** via `preflight --time-verification`, arquivos de teste e o que cada um
cobre por convenção de nome, e git HEAD.

**nonGoals.** Não invocar modelo. Não inferir intenção. Não ler conteúdo de
arquivo além do necessário para o inventário.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n1.1 | `repo-facts` emite JSON válido para o próprio repositório | `command: node --test test/plan/repo-facts.test.mjs` |
| n1.2 | nenhum modelo é invocado | `command: node --test --test-name-pattern="repo facts invokes no model" test/plan/repo-facts.test.mjs` |
| n1.3 | cada comando candidato traz duração medida, nunca estimada | `command: node --test --test-name-pattern="repo facts measures duration" test/plan/repo-facts.test.mjs` |
| n1.4 | comando acima de 600 s é marcado como inelegível para `verification` | `command: node --test --test-name-pattern="repo facts flags slow commands" test/plan/repo-facts.test.mjs` |
| n1.5 | a saída é limitada e determinística entre duas execuções no mesmo HEAD | `command: node --test --test-name-pattern="repo facts deterministic" test/plan/repo-facts.test.mjs` |

### N2. Tabela de roteamento

**writeFiles**

    src/plan/routing.mjs
    test/plan/routing.test.mjs
    skills/faberun/references/contract.md

**Intenção.** Mapeia `(taskKind, riskTier, capacidade exigida)` para preferência
de runtime, cruzando com o que `runtime-discovery` reporta como disponível e não
exaurido. Mesma forma de tabela já usada em `bulk-read.mjs`.

    routingRules:
      - when: { taskKind: docs, riskTier: low }
        prefer: [zcode-flash, flash, agy-flash]
      - when: { taskKind: implement, riskTier: high }
        prefer: [opus, luna]
      - when: { taskKind: judge }
        forbidSameVendorAsWorker: true

Precedência, da mais forte para a mais fraca: override explícito de nó,
`runtimeDefaults` declarado pelo operador, tabela, descoberta.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n2.1 | a tabela resolve runtime a partir de `taskKind` e `riskTier` | `command: node --test test/plan/routing.test.mjs` |
| n2.2 | `runtimeDefaults` do operador ganha da tabela | `command: node --test --test-name-pattern="operator defaults win" test/plan/routing.test.mjs` |
| n2.3 | runtime exaurido é pulado sem erro | `command: node --test --test-name-pattern="routing skips exhausted" test/plan/routing.test.mjs` |
| n2.4 | juiz nunca resolve para o mesmo vendor do worker nem do fallback | `command: node --test --test-name-pattern="routing keeps judge vendor distinct" test/plan/routing.test.mjs` |
| n2.5 | nenhum runtime disponível para uma regra emite erro nomeando a regra | `command: node --test --test-name-pattern="routing reports unmet rule" test/plan/routing.test.mjs` |

### N3. Regras de dimensionamento

**writeFiles**

    src/plan/sizing.mjs
    test/plan/sizing.test.mjs

**Intenção.** Pós-processamento determinístico do rascunho. "Nem nós demais nem
de menos" não se resolve pedindo bom senso ao modelo.

| Regra | Efeito |
|---|---|
| nó sem nenhum item de DoD com `proof` mecânico | funde no pai |
| `writeFiles` de A contido em B, A sem verificação própria | funde A em B |
| `verification` com duração medida acima do limiar do nó | divide, ou troca por arquivo de teste específico |
| nós sem relação de dependência com `writeFiles` disjuntos | marca como paralelizáveis |
| contrato resultante com um nó só, sem `--targeted-fix` | erro |
| cadeia serial com profundidade acima de 8 | exige justificativa no plano |

Toda transformação aplicada é registrada com a regra que a causou, para o plano
ser auditável.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n3.1 | nó sem prova mecânica é fundido no pai | `command: node --test test/plan/sizing.test.mjs` |
| n3.2 | `writeFiles` contido sem verificação própria é fundido | `command: node --test test/plan/sizing.test.mjs` |
| n3.3 | verificação acima do limiar do nó dispara divisão | `command: node --test test/plan/sizing.test.mjs` |
| n3.4 | contrato de um nó sem `--targeted-fix` é rejeitado | `command: node --test --test-name-pattern="sizing rejects micro contract" test/plan/sizing.test.mjs` |
| n3.5 | cada transformação registra a regra que a causou | `command: node --test --test-name-pattern="sizing records rule provenance" test/plan/sizing.test.mjs` |
| n3.6 | o dimensionamento é idempotente: aplicar duas vezes não muda o grafo | `command: node --test --test-name-pattern="sizing idempotent" test/plan/sizing.test.mjs` |

### N4. Congelamento

**writeFiles**

    src/plan/freeze.mjs
    test/plan/freeze.test.mjs

**Intenção.** Emite `plan.json` e `contract.json` com digest, mais a proveniência
que torna o plano comparável entre campanhas: versão do pacote, `schemaVersion`,
git HEAD do alvo, o par de runtimes que planejou e revisou, as regras de
dimensionamento aplicadas, e os achados do revisor com severidade.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n4.1 | o plano congelado carrega digest e bloco de proveniência completo | `command: node --test test/plan/freeze.test.mjs` |
| n4.2 | o `contract.json` emitido passa em `faberun contract validate` | `command: node --test --test-name-pattern="frozen contract validates" test/plan/freeze.test.mjs` |
| n4.3 | alterar um byte do plano invalida o digest | `command: node --test --test-name-pattern="freeze digest detects tampering" test/plan/freeze.test.mjs` |
| n4.4 | nenhum modelo é invocado no congelamento | `command: node --test --test-name-pattern="freeze invokes no model" test/plan/freeze.test.mjs` |

**finalVerification da fase 1**

    npm run check
    npm run typecheck
    npm test
    node evals/run.mjs --class deterministic --assert-no-model

## 5. Fase 2: o contrato de planejamento

### N5. `riskTier` no schema

**writeFiles**

    src/contract/index.mjs
    skills/faberun/references/contract.md
    test/contract/risk-tier.test.mjs

**Intenção.** Campo opcional por nó, default `standard`. Calibra a profundidade
da revisão pelo risco, em vez de aplicar o mesmo gate a tudo.

| Tier | Efeito |
|---|---|
| `low` | `failOn: ["critical"]`, `maxRevisions: 1`, runtime barato |
| `standard` | comportamento atual |
| `high` | `failOn: ["major","critical"]`, revisor adicional de vendor distinto, `finalVerification` obrigatório |

Sobe automaticamente para `high` quando o nó escreve em caminho compartilhado por
mais de um nó do grafo.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n5.1 | contrato sem `riskTier` continua válido e recebe `standard` | `command: node --test test/contract/risk-tier.test.mjs` |
| n5.2 | `high` exige revisor adicional e `finalVerification` | `command: node --test test/contract/risk-tier.test.mjs` |
| n5.3 | escrita em caminho compartilhado promove o nó a `high` | `command: node --test --test-name-pattern="shared path promotes tier" test/contract/risk-tier.test.mjs` |
| n5.4 | o ratchet de `contract.md` documenta o campo com o aumento justificado | `command: node --test test/docs/docs-diet.test.mjs` |

### N6. O contrato de planejamento

**writeFiles**

    src/plan/template.mjs
    src/plan/packets/draft.json
    src/plan/packets/review.json
    test/plan/template.test.mjs

**Intenção.** Três nós, dois deles invocando modelo uma vez cada.

    draft (discovery, frontier)
      -> review (discovery, vendor distinto)
        -> revise (gate: maxRevisions, failOn critical)

`draft` recebe a spec, `repo-facts.json` e o catálogo de `taskKind`. Devolve nós
com `dependsOn`, `readFiles`, `writeFiles`, DoD e classificação. **Não escolhe
runtime.**

`review` recebe spec, `repo-facts.json` e o plano. **Não recebe o packet do
draft nem seu raciocínio.** Devolve achados estruturados no mesmo formato do
juiz: id, severidade, nó afetado, achado verbatim.

Achados `critical` voltam ao draft dentro do orçamento. Esgotado sem convergir,
`contested`.

**nonGoals.** Não construir laço de conversa entre os dois. Não permitir que o
revisor edite o plano; ele emite achados, o draft revisa.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n6.1 | o contrato de planejamento executa fim a fim com o driver `replay` | `command: node evals/run.mjs --class deterministic --case D-plan-pipeline` |
| n6.2 | o packet do revisor não contém o packet nem a saída de raciocínio do draft | `command: node --test --test-name-pattern="review packet is isolated" test/plan/template.test.mjs` |
| n6.3 | draft e review resolvem para vendors diferentes | `command: node --test --test-name-pattern="planner vendors distinct" test/plan/template.test.mjs` |
| n6.4 | achado sem severidade ou sem nó afetado é inválido e não consome revisão | `command: node --test --test-name-pattern="review finding shape" test/plan/template.test.mjs` |
| n6.5 | orçamento esgotado sem convergir termina em `contested` e não emite contrato | `command: node evals/run.mjs --class deterministic --case D-plan-contested` |
| n6.6 | ambas as invocações aparecem em `usage.jsonl` atribuídas ao nó | `command: node --test --test-name-pattern="planner usage accounted" test/plan/template.test.mjs` |

### N7. `faberun plan`

**writeFiles**

    src/cli/plan.mjs
    src/cli.mjs
    skills/faberun/references/operations.md
    test/cli/plan.test.mjs

**Intenção.** A entrada do operador.

    faberun plan <spec.md> --campaign <id> [--phase <n>]
      [--review-rounds 2]
      [--approve-below standard|high|none]
      [--runtime-defaults worker=<id>,judge=<id>]

`--approve-below` é a política de aprovação, e substitui o booleano ingênuo:
`standard` aprova sozinho planos cujo `riskTier` máximo seja `standard`, e para
quando houver nó `high`. `none` sempre para. Default `standard`.

`--runtime-defaults` é o override do operador, que ganha da tabela. É como a
instrução atual ("juiz gpt sol, worker deepseek flash") continua funcionando.

Ao congelar, o comando emite `attention` com `requiresUser: true` quando a
política exige aprovação, e a aprovação chega pela superfície remota ou por
`faberun campaign resolve`.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n7.1 | `plan` produz contrato aprovável a partir de uma spec markdown | `command: node --test test/cli/plan.test.mjs` |
| n7.2 | o congelamento nunca inicia execução por conta própria | `command: node evals/run.mjs --class deterministic --case D-plan-no-autostart` |
| n7.3 | `--approve-below standard` para quando o plano contém nó `high` | `command: node --test --test-name-pattern="approval policy" test/cli/plan.test.mjs` |
| n7.4 | `--runtime-defaults` do operador aparece no contrato congelado | `command: node --test --test-name-pattern="operator override persists" test/cli/plan.test.mjs` |
| n7.5 | matar o assento durante o planejamento não interrompe o plano | `command: node evals/run.mjs --class deterministic --case D-plan-detached` |
| n7.6 | `operations.md` documenta o verbo, com o ratchet justificado | `command: node --test test/docs/docs-diet.test.mjs` |

**finalVerification da fase 2**

    npm run check
    npm run typecheck
    npm test
    npm run docs && git diff --exit-code docs/COMMANDS.md
    node evals/run.mjs --class deterministic --assert-no-model

## 6. Fase 3: a prova

Sem isto, o planejador é uma feature cara defendida por intuição, que é
exatamente o modo de falha que os evals existem para fechar.

### N8. Braço comparativo

**writeFiles**

    evals/planner/
    evals/run.mjs
    test/evals/planner-arm.test.mjs

**Intenção.** De oito a dez specs reais do próprio histórico, incluindo as das
campanhas `become-faberun` e `register-skill-and-harden`. Para cada uma já existe
o contrato que a sessão autorou e o resultado que ele produziu.

    node evals/run.mjs --class stochastic --arm session
    node evals/run.mjs --class stochastic --arm planner
    node evals/run.mjs --compare <session.json> <planner.json>

Indicadores comparados:

| Indicador | O que revela |
|---|---|
| `costPerClosedCheckpoint` | o número que decide |
| custo do próprio planejamento | o que a feature cobra |
| `firstPassGateRate` | qualidade do packet gerado |
| `blockedContextRate` | se o `readFiles` gerado é suficiente |
| nós por checkpoint fechado | se o dimensionamento acertou |
| achados críticos do revisor por plano | se a revisão acha algo, ou só implica |

O último é o critério de desligamento. **O modo de falha da revisão adversarial
é degenerar em implicância**, queimando revisões sem melhorar o plano. Média de
achados críticos próxima de zero com `firstPassGateRate` inalterado significa
revisor caro e inútil.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n8.1 | o braço comparativo roda os dois lados nas mesmas specs | `command: node --test test/evals/planner-arm.test.mjs` |
| n8.2 | `compare` emite delta por indicador com contagem de amostras | `command: node --test --test-name-pattern="planner arm compare" test/evals/planner-arm.test.mjs` |
| n8.3 | o golden set do braço tem no mínimo 8 specs derivadas de campanhas reais | `command: node evals/run.mjs --validate-planner-arm --min 8` |
| n8.4 | indicador sem registro de suporte é `null`, nunca `0` | `command: node --test --test-name-pattern="null vs zero" test/evals/planner-arm.test.mjs` |

### N9. Custo de allowance do assento

**writeFiles**

    src/seat/allowance.mjs
    test/seat/allowance.test.mjs

**Intenção.** Tornar visível o custo que hoje não aparece em lugar nenhum.

O assento amostra `rate_limits` do payload que o harness já entrega (hoje só o
Claude Code o expõe) no início da campanha e no congelamento do plano, e grava o
delta no journal.

É proxy grosseiro, não contabilidade precisa, e a spec declara isso. Mas é a
única medição existente do custo de planejar dentro da sessão, e é o número
contra o qual o planejador precisa se pagar.

**nonGoals.** Não inferir custo em dólar. Não tentar medir harness que não expõe
o sinal.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n9.1 | o delta de allowance é gravado no journal em harness que expõe o sinal | `command: node --test test/seat/allowance.test.mjs` |
| n9.2 | harness sem o sinal grava `null` e não falha | `command: node --test --test-name-pattern="allowance absent" test/seat/allowance.test.mjs` |
| n9.3 | o campo é declarado em `FIELD-OWNERSHIP.md` com dono e momento único | `path: docs/FIELD-OWNERSHIP.md` |

**finalVerification da fase 3**

    npm run check
    npm run typecheck
    npm test
    node evals/run.mjs --class deterministic --assert-no-model
    node evals/run.mjs --class deterministic --verify-discriminating

## 7. Não-objetivos

- Substituir a autoria pela sessão. Ela continua como caminho de exceção
  documentado em `rules.md`, e é o fallback quando o planejador sai
  `contested` ou quando o repositório é desconhecido demais.
- Laço de conversa entre planejador e revisor. ADR-0039.
- Planejar campanha inteira de uma vez. Uma fase por vez, como hoje.
- Camada de evidência e mutation testing. Continuam depois.
- Mudar a invocação do operador. A linha em linguagem natural permanece.

## 8. Risco declarado: partida a frio

O planejador começa gelado. A sessão que autora hoje já leu o repositório e tem
história: sabe que aquele teste é instável, que a fase anterior deixou
pendência.

Mitigações, em ordem de força:

1. `repo-facts.json` cobre a parte mecânica, que é a maior parte do que a sessão
   aprendeu lendo, e sai sem custo de modelo.
2. `mode: "discovery"` já é a válvula: o planejador emite nó de discovery quando
   não consegue autorar packet fechado, e o resultado alimenta o rascunho
   seguinte.
3. Autoria pela sessão continua disponível, o que também garante os dois braços
   comparáveis do N8 desde o primeiro dia.

## 9. Convenções

Herdadas de `rules.md` e das retrospectivas de campo:

1. Um contrato por fase, todos os nós e arestas autorados num turno só.
2. Nenhum packet manda o worker rodar a suíte inteira.
3. Toda `verification` tem duração medida antes de ter `timeoutSec` declarado.
   É literalmente o tema do N1.
4. Juiz em vendor diferente do worker e do fallback.
5. Nenhum teste novo depende de relógio, de binário no PATH ou de layout de
   máquina.
6. Todo teto novo segue o ratchet datado de `test/docs/docs-diet.test.mjs`.
7. Nenhum nó tem redução de linhas como objetivo.

## 10. Critério de sucesso

| Métrica | Baseline | Alvo |
|---|---|---|
| `costPerClosedCheckpoint` | `evals/baseline.json` | cai, ou não sobe com `firstPassGateRate` maior |
| Custo do planejamento | invisível hoje | gravado em `usage.jsonl` |
| Delta de allowance do assento durante o plano | não medido | medido, e menor que o braço da sessão |
| Achados críticos do revisor por plano | não medido | acima de zero, senão desligar o revisor |
| Contratos com `timeoutSec` acima da duração medida | ocorreu em campo | 0 |
| Planos `contested` | n/a | reportados, nunca executados |

A campanha fecha com retrospectiva registrando o delta dos dois braços. Se o
braço do planejador não ganhar em nenhum indicador, **o resultado correto é
manter a autoria pela sessão e registrar o experimento**. Spec que só admite um
desfecho não é experimento.

## 11. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Plano gerado sem contexto suficiente | alto | seção 8; `blockedContextRate` no N8 detecta |
| Revisor degenera em implicância | médio | critério de desligamento no N8 |
| Planejamento dobra o custo sem retorno | médio | N9 mede o lado invisível; N8 decide |
| Tabela de roteamento vira configuração paralela ao contrato | médio | precedência declarada no N2; override do operador sempre ganha |
| O congelamento inicia execução por acidente | alto | ADR-0041, n7.2 bloqueante |
| Planejar vira replanejar em runtime | alto | plano congelado com digest; execução consome tabela, nunca recalcula |
