---
id: safe-to-hand-to-a-friend
title: "Um estranho instala, roda e desinstala sem ajuda e sem expor as credenciais dele"
version: 1.3.0
status: draft
date: 2026-09-24
owner: Felipe Broering
target: feliperun/faberun
baseline: 3847121
derived_from: evals-with-a-budget
followed_by: friends-pilot
---

# Um estranho instala, roda e desinstala sem ajuda e sem expor as credenciais dele

## Intenção

Terceira campanha do programa `leaving-home`. Até aqui o faberun rodou num
único repositório (ele mesmo), numa única máquina, com um único operador que
conhece cada convenção porque escreveu todas. Um amigo não conhece nenhuma
delas. Esta campanha remove, com medição, cada coisa que hoje só funciona
porque o operador é o autor.

**O worker vê o ambiente inteiro de quem o lançou.** O processo de gate que
lança worker e juiz monta o ambiente do filho a partir de `{ ...process.env }`
(`src/engine/gate.mjs:167`), e o probe de disponibilidade passa
`withoutNotifyEnv(process.env)` (`src/harnesses/index.mjs:498`), que remove só
as variáveis de notificação. Na máquina de um amigo, isso é o `AWS_*`, o
`GITHUB_TOKEN`, o `DATABASE_URL` de produção e qualquer chave exportada no
`.zshrc`, entregues a um modelo que roda comandos arbitrários. A decisão D2 já
registra o risco e adia o sandbox de verdade para a P6. Esta campanha não faz
sandbox. Ela faz o mínimo que torna aceitável entregar a ferramenta a outra
pessoa: o worker recebe o ambiente que foi permitido, não o que estava lá.
O vazamento já causou defeito, não só risco: na campanha do Campaign Brief (PR
#63), uma `CODEX_VERSION` herdada do ambiente mascarou o banner de versão do
probe, e o operador teve que removê-la à mão do ambiente do comando para a run
voltar.

**O guia de primeiros passos descreve um layout que não existe mais.** O
passo 1 de `docs/GETTING-STARTED.md` mostra como saída
`[campaign] hello initialized · .runs/campaigns/hello`. Rodando o mesmo comando
em `748d7ba` com `FABERUN_HOME` isolado (e ainda igual em `1357ea6`), a saída real é
`... · <home>/projects/<uuid>/runs/campaigns/hello`. O `.runs` aparece em 7 linhas
de `docs/GETTING-STARTED.md`, 11 de `docs/CONCEPTS.md`, 11 de
`docs/ARCHITECTURE.md` e 2 do `README.md`. Um amigo segue o guia ao pé da
letra, e a primeira saída já não confere.

**O planner só enxerga repositório Node.** Os fatos de repositório que o
planner lê saem de `readScripts` (`src/plan/repo-facts.mjs:52`), que lê
`package.json`, e das pastas sob `test/`. Um repositório Python, Go ou Rust
chega ao planner sem nenhum comando de verificação candidato. A primeira
campanha contra um alvo externo (`rec-audit-remediation`, PR #62) era Zig: o
operador mediu `zig build test -Dtarget=x86_64-linux-gnu` à mão e escreveu os
três contratos sem o planner.

**O modo de sandbox do worker esconde a consequência.** A mesma campanha mediu
que, sob `sandbox: workspace-write` (o padrão do `dsh`), o compilador morre com
`ReadOnlyFileSystem` antes do primeiro arquivo, porque o cache do toolchain
fica no `$HOME`; sob `danger-full-access`, o mesmo pacote compila em 19 s. A
documentação descreve o modo como "executa e escreve dentro do worktree", e a
mensagem que o operador vê fala de sistema de arquivos, não de sandbox
(`RM-050`).

**Um defeito de pacote joga fora o trabalho bom.** Ainda na mesma campanha, a
tentativa que falhou por uma linha errada do pacote já tinha feito a correção
certa. A única saída foi cancelar e reemitir o contrato, que recomeça do zero.
`resume --answer` é o mecanismo certo e só cobre `context_missing`
(`RM-054`).

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

**Quando um worker recusa o pacote, o nó morre.** O RM-005 mediu seis pacotes
que passaram em `validate` e foram recusados depois com `context_missing`. O
arm I do round complexo recusou o pacote com `blocked_context` depois de 4
chamadas de ferramenta, e nomeou o arquivo e o motivo. O RM-025 descreve o
conserto (reautorar o pacote a partir da recusa, com orçamento de rodadas) e
chama isso de gargalo na prática: a informação para consertar o pacote chega
dentro da recusa.

**Não há como sair.** Nenhum verbo desfaz o que `setup`, `init` e
`skills register` escreveram fora do repositório alvo (`grep -rn
"uninstall|unregister" src` volta vazio).

## Estado medido

`3847121` (0.25.0), com a evidência dos journals das campanhas 0, 1, 2 e 2b.

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Variáveis de ambiente do controlador que chegam ao worker | todas, menos as de notificação | só a lista permitida |
| Harnesses que declaram o ambiente de que precisam | 0 de 7 (claude, codex, agy, dsh, zcode, exec-jsonl, replay) | 7 de 7 |
| Saídas do `GETTING-STARTED.md` conferidas contra o CLI | 0 | todas as do passo a passo |
| Linhas que citam `.runs` nas docs correntes | 31 (7, 11, 11, 2) | 0 sem rótulo de legado |
| Ecossistemas com comando de verificação detectado pelo planner | 1 (Node) | 6 (Node, Python, Go, Rust, Zig, Makefile) |
| Consequência do modo de sandbox dita na doc e na mensagem de erro | não | sim |
| Nós não terminais que aceitam override do operador | só os com `context_missing` | todos |
| Plano contestado que continua sem contrato escrito à mão | não | sim |
| Contratos saídos do planner nas três últimas campanhas que o usaram | 0 de 10 (todos escritos à mão) | a campanha fecha com os contratos das fases 2 em diante saídos do planner |
| Gasto de planejamento que não congelou, `evidence-you-can-recompute` | US$ 3,79 | o pipeline para quando a revisão não melhora |
| Findings críticos na última rodada do revise, `evidence-you-can-recompute` | 28 na rodada 4 | nunca mais que na rodada anterior sem parar |
| Passo humano declarado numa spec que o plano consegue representar | não | sim |
| Lançamentos recusados só pelo bloco gerenciado do `AGENTS.md` | todos, na campanha zero | 0 |
| Nó recusado por contexto que continua sem intervenção manual no pacote | não | sim, com aprovação do operador |
| Verbo que remove o que o faberun escreveu fora do repositório | não | `faberun uninstall` |
| Juiz de nó escolhido de uma lista ordenada (D9) | não: o contrato nomeia um juiz e um fallback | primeiro elegível da lista, com fallback de vários saltos |
| Regra de vendor que compara o provedor canônico | não: compara o campo `vendor`, texto livre (o exemplo da skill usa `openai-sol` e `zhipu-flash`) | provedor derivado do harness e do modelo |
| Revisor do planner configurado à parte do juiz do contrato (D11) | não: um `--runtime-defaults judge=` nomeia os dois | lista própria de revisores |
| Operador de um provedor só consegue juiz | não | sim, por opt-in, marcado em tudo o que um humano lê |
| Planos contestados por `proof.ref` escrito como texto | os dois configs de worker do R5 da `choose-the-judges` | 0 |

Peças existentes que o trabalho reusa: `childEnv` de `src/engine/gate.mjs`,
`missingEnvironmentVariables` e o `env_key` dos runtimes, `redactSecrets`,
`faberun doctor` e `faberun models --probe`, o gerador de manual
(`npm run docs:check`), o harness `replay`, `faberun init`, `faberun spec
scaffold`, o pipeline de plano com seus estágios, `validateContract` com
`scopeClosureFindings` e `crossNodeScopeFindings`, e o resultado estruturado
`blocked_context`.

## Requisitos

### R1. O worker recebe só o ambiente permitido

- **statement:** o ambiente de todo processo de worker e de juiz é a união de
  um conjunto base (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
  `LC_*`, `TERM`, `TMPDIR`, `TZ` e, no Windows, `SYSTEMROOT`, `USERPROFILE`,
  `APPDATA`, `LOCALAPPDATA`, `COMSPEC`, `PATHEXT`), dos nomes que o adaptador do
  harness declara, dos nomes dos `env_key` do runtime e de um `envPassthrough`
  explícito no runtime ou no contrato. Qualquer outra variável do controlador
  fica de fora.
- **proof:** `command: node --test --test-name-pattern="a worker sees only the environment it was allowed"`
- **constraints:** os comandos de verificação do DoD e a `finalVerification`
  mantêm o ambiente de hoje nesta campanha, e as docs dizem isso em uma frase.
  Mudar isso é outra spec.

### R2. Todo adaptador declara o ambiente de que precisa

- **statement:** cada harness em `src/harnesses/` (claude, codex, agy, dsh,
  zcode, exec-jsonl, replay) exporta a lista de nomes de ambiente que usa para
  se autenticar e se configurar, e um teste falha se um adaptador ler
  `process.env` por um nome que não declarou.
- **proof:** `command: node --test --test-name-pattern="every harness adapter declares the environment it reads"`

### R3. A lista permitida é inspecionável

- **statement:** `faberun doctor --env [<contract.json>]` lista, por runtime,
  os nomes (nunca os valores) que passariam e os que ficariam de fora, e marca
  como "retido" todo nome de fora que case com `*_KEY`, `*_TOKEN`, `*_SECRET`,
  `*_PASSWORD`, `AWS_*` ou `GITHUB_*`.
- **proof:** `command: node --test --test-name-pattern="doctor lists the environment each runtime would see without values"`

### R4. Todo runtime habilitado ainda autentica com a lista permitida

- **statement:** na máquina do operador, `faberun models --probe` responde
  disponível para todo runtime que respondia em `748d7ba`, agora rodando sob a
  lista de R1. O resultado do probe, antes e depois, é anexado ao ledger.
- **proof:** `judgment: true`

### R5. O guia de primeiros passos é executado, não só lido

- **statement:** cada par comando e saída do passo a passo de
  `docs/GETTING-STARTED.md` é conferido por `npm run docs:check` contra um
  repositório descartável, com `FABERUN_HOME` isolado e runtimes `replay`. As
  partes que variam por máquina são normalizadas para marcadores fixos
  (`<home>`, `<project>`, `<run>`), e uma saída que diverge do CLI falha a
  checagem com o trecho esperado e o obtido.
- **proof:** `command: node --test --test-name-pattern="the getting started walkthrough matches the CLI it describes"`
- **measure:** `command: grep -c '\.runs' docs/GETTING-STARTED.md docs/CONCEPTS.md docs/ARCHITECTURE.md README.md || true`

### R6. Nenhuma doc atual descreve o layout antigo como atual

- **statement:** toda menção a `.runs` em `README.md` e em `docs/*.md` (fora de
  `docs/history/`, `docs/campaigns/` e `docs/adr/`) é removida ou fica dentro de
  um trecho rotulado como layout legado, e um ratchet impede a volta.
- **proof:** `command: node --test --test-name-pattern="no current doc describes the legacy run layout as current"`

### R7. O planner encontra verificação fora do Node

- **statement:** os fatos de repositório detectam comandos de verificação
  candidatos em `pyproject.toml` ou `pytest.ini` (`pytest`), `go.mod`
  (`go test ./...`), `Cargo.toml` (`cargo test`), `build.zig` (`zig build
  test`) e `Makefile` com alvo `test` (`make test`), além do `package.json` de
  hoje. Cada candidato registra o
  arquivo de onde veio. A detecção continua determinística, sem modelo, e
  idêntica em duas execuções no mesmo HEAD. Nenhum desses comandos é executado
  na detecção.
- **proof:** `command: node --test --test-name-pattern="repo facts find verification commands outside node"`

### R8. A primeira campanha de um estranho fecha sem rede

- **statement:** um teste de ponta a ponta parte de um repositório de fixture
  em Python (`pyproject.toml`, sem `package.json`), sem nenhuma convenção do
  faberun, roda `faberun init --yes`, `faberun spec scaffold`, `faberun plan`
  com runtimes `replay`, congela o contrato, roda uma campanha de um nó até
  `done` e fecha a campanha com ledger completo. Tudo sem rede e em menos de 60
  segundos. O teste confere que o candidato Python apareceu nos fatos de
  repositório, mas a verificação do contrato usa um comando presente em todo
  runner do CI (`git diff --check`), para não depender de Python instalado.
- **proof:** `command: node --test --test-name-pattern="a stranger's first campaign completes offline"`

### R9. Um plano contestado entrega uma decisão ao operador

- **statement:** quando o pipeline termina contestado, a saída lista cada
  finding crítico com id, o nó ou requisito a que se refere e o que o resolveria.
  `faberun plan --resolve <plan-dir> --answer <finding-id>=accept` ou
  `--answer <finding-id>=reject:<motivo>` retoma a partir do estágio de revisão,
  sem redesenhar do zero, grava as respostas no journal da campanha como
  `decision`, e um plano com todos os findings críticos respondidos pode
  congelar.
- **proof:** `command: node --test --test-name-pattern="a contested plan resumes from the operator's answers"`

### R10. Um pacote recusado é reautorado, não abandonado

- **statement:** quando um nó termina com `blocked_context` ou
  `context_missing` e o resultado nomeia arquivos e motivo,
  `faberun resume <run-dir> --reauthor <node-id>` roda um nó de descoberta com
  orçamento de rodadas (padrão 1) que propõe um pacote alargado (acréscimos em
  `readFiles` e `writeFiles`). A proposta passa por `validateContract`, com as
  checagens de fechamento de escopo e de escopo entre nós, é mostrada como diff
  e só é aplicada com a aprovação do operador ou abaixo do nível de
  `--approve-below`. Aprovada, o nó retoma.
- **proof:** `command: node --test --test-name-pattern="a refused packet is widened and the node resumes"`
- **constraints:** um pacote alargado que invade o `writeFiles` de outro nó é
  recusado, nunca aplicado. O orçamento de rodadas é duro.

### R11. Sair é limpo

- **statement:** `faberun uninstall [--dry-run]` lista e remove o que o
  faberun escreveu fora de qualquer repositório alvo: skills registradas nos
  diretórios dos harnesses, integrações de statusLine e hooks que ele instalou,
  e `~/.faberun`. A remoção de `~/.faberun` pede confirmação e recusa enquanto
  houver campanha com ledger não preservado, a menos que venha `--force`. Nenhum
  arquivo rastreado de um repositório alvo é tocado. A saída final diz como
  remover o pacote npm.
- **proof:** `command: node --test --test-name-pattern="uninstall removes everything faberun wrote outside the repository"`

### R12. O modo de sandbox diz o que custa

- **statement:** a linha de `sandbox` de cada harness em
  `references/contract.md` diz a consequência de `workspace-write` para
  toolchain com cache fora do worktree, e o executor classifica uma falha de
  `ReadOnlyFileSystem` fora do worktree sob `workspace-write` como
  `sandbox_blocked_write`, nomeando o modo e o caminho que foi negado.
- **proof:** `command: node --test --test-name-pattern="a write blocked by the sandbox names the mode and the path"`
- **constraints:** a frase nova em `references/contract.md` é paga com corte
  no mesmo arquivo.

### R13. Todo nó não terminal aceita override do operador

- **statement:** `faberun resume <run-dir> --node <id> --answer <texto>` vale
  para qualquer nó não terminal, e não só para `context_missing`, com o mesmo
  limite de 8 KiB e o mesmo registro em `executionOverrides`. O pacote autorado
  e o `packetHash` ficam intactos, e a próxima tentativa parte do selo da
  anterior quando ele existe.
- **proof:** `command: node --test --test-name-pattern="an operator override reaches any non-terminal node"`

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

### R18. O juiz de cada nó sai de uma lista ordenada, com fallback de vários saltos

- **statement:** a lista de juízes é estática e ordenada, declarada no contrato
  e no config da máquina (`faberun setup`); a do contrato ganha, como já é com o
  worker. Para cada nó, o engine escolhe o primeiro da lista cujo provedor
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
  outro modelo, com `tier` igual ou acima do `tier` do worker no catálogo
  (Sonnet trabalha, Opus ou Fable julga), e um juiz de `tier` menor é recusado. O
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

- Sandbox de container, microVM ou `ai-jail` (RM-027 a RM-029, RM-048). A lista
  de ambiente permitido é o mínimo, não o sandbox.
- Restringir rede ou sistema de arquivos do worker.
- Mudar o ambiente dos comandos de verificação (ver restrição de R1).
- Ecossistemas além dos seis de R7.
- Instalador gráfico, app ou página web.
- Reautoria automática sem aprovação para risco `high`.
- Suporte a Windows além do que o CI já cobre hoje.
- Escolher quais modelos estão nas listas de juízes e de revisores, ou a ordem
  delas. R18 e R19 dão o mecanismo; as listas são a D9 e a D11.
- `RM-086` (o `faberun plan` que morreu dentro de um painel tmux sem reproduzir
  fora dele). Fica medido e não reproduzido; o programa usa `plan --detach`.
- Revisar a D9 ou a D11. São decisões do dono, fora desta spec.
- Calibrar a severidade dos findings (RM-103).

## Restrições

- **Ordem das fases.** A fase 1 é o planner e o lançamento (R14, R15, R16, R17,
  R9 e R18 a R21). Só ela pode ter contrato escrito à mão, registrado como `hand-authored`.
  Da fase 2 em diante, todo contrato desta campanha sai do `faberun plan`; um
  contrato escrito à mão depois da fase 1 é registrado e conta contra o critério
  de sucesso, não é proibido.
- Todo `measure` e toda prova por comando desta spec saem com 0 no estado
  esperado; um `grep` que verifica ausência usa `! grep -q` ou termina com
  `|| true` quando é só medida.
- Nenhuma dependência de runtime nova.
- Nenhum teste chama provedor, nem mesmo R8.
- R1 não pode quebrar o fluxo do próprio operador: as fases que tocam o
  ambiente terminam com R4 verificado antes de fechar.
- O orçamento de bytes da skill (campanha `evidence-you-can-recompute`, R8) vale
  aqui. Os verbos novos (`uninstall`, `--resolve`, `--reauthor`, `doctor --env`)
  entram em `docs/COMMANDS.md`, que é gerado, e a skill ganha no máximo uma
  linha de roteamento, paga com corte.
- O orçamento de bytes da skill tinha 3 bytes de folga em `1357ea6` (46.852 de
  46.855): cada frase nova em `references/` sai de um corte, sem exceção.
- Linux, macOS e Windows continuam verdes.

## Critério de sucesso

| Indicador | Baseline | Alvo |
| --- | --- | --- |
| Segredo plantado no ambiente do controlador visível ao worker de fixture | sim | não |
| Saídas do guia que divergem do CLI | pelo menos 1 (`.runs/campaigns/hello`) | 0, verificado no CI |
| Ecossistemas detectados | 1 | 6 |
| Tentativas boas descartadas por defeito de pacote | 1 na `rec-audit-remediation` | 0 |
| Tempo da primeira campanha offline de ponta a ponta | não existe | menos de 60 s |
| Contratos escritos à mão nas fases 2 em diante desta campanha | 10 de 10 nas três campanhas anteriores | 0 |
| Rodadas de revisão gastas depois que os críticos pararam de cair | até 2 por plano | 0 |
| Nós cujo juiz sai da lista da D9 sem juiz nomeado à mão | 0 | todos os desta campanha da fase 2 em diante |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Um harness lê uma variável não declarada e para de autenticar | o operador perde um runtime | R2 falha o teste antes, e R4 confere na máquina real antes de fechar |
| O teste do guia fica frágil com a formatação | falso vermelho no CI | a normalização é explícita e testada; o guia marca os blocos conferidos, e texto em prosa fica fora |
| A reautoria vira um laço caro | custo sem entrega | orçamento de rodadas duro, aprovação humana acima do nível declarado, e a métrica de laço improdutivo do RM-032 fica como follow-up nomeado |
| R14 para cedo demais um plano que convergiria na rodada seguinte | um plano bom vira contestado | o finding mostra a contagem por rodada, e `plan --resolve` (R9) continua de onde parou |
| R16 cresce até virar um motor de workflow | escopo estoura | o requisito pede só parar, nomear o passo e continuar; nada de agendamento ou condição |
| `uninstall` apaga evidência que o operador queria | perda de ledger | recusa enquanto houver ledger não preservado, `--dry-run` por padrão na doc |
