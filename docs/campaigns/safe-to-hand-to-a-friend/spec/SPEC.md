---
id: safe-to-hand-to-a-friend
title: "Um estranho instala, roda e desinstala sem ajuda e sem expor as credenciais dele"
version: 1.0.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: 748d7ba
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
`withoutNotifyEnv(process.env)` (`src/harnesses/index.mjs:481`), que remove só
as variáveis de notificação. Na máquina de um amigo, isso é o `AWS_*`, o
`GITHUB_TOKEN`, o `DATABASE_URL` de produção e qualquer chave exportada no
`.zshrc`, entregues a um modelo que roda comandos arbitrários. A decisão D2 já
registra o risco e adia o sandbox de verdade para a P6. Esta campanha não faz
sandbox. Ela faz o mínimo que torna aceitável entregar a ferramenta a outra
pessoa: o worker recebe o ambiente que foi permitido, não o que estava lá.

**O guia de primeiros passos descreve um layout que não existe mais.** O
passo 1 de `docs/GETTING-STARTED.md` mostra como saída
`[campaign] hello initialized · .runs/campaigns/hello`. Rodando o mesmo comando
em `748d7ba` com `FABERUN_HOME` isolado, a saída real é
`... · <home>/projects/<uuid>/runs/campaigns/hello`. O `.runs` aparece em 7 linhas
de `docs/GETTING-STARTED.md`, 11 de `docs/CONCEPTS.md`, 11 de
`docs/ARCHITECTURE.md` e 2 do `README.md`. Um amigo segue o guia ao pé da
letra, e a primeira saída já não confere.

**O planner só enxerga repositório Node.** Os fatos de repositório que o
planner lê saem de `readScripts` (`src/plan/repo-facts.mjs:52`), que lê
`package.json`, e das pastas sob `test/`. Um repositório Python, Go ou Rust
chega ao planner sem nenhum comando de verificação candidato.

**Quando o planner contesta, só o autor sabe continuar.** A retrospectiva de
`durable-state-integrity` registra: "the planner contested both plans it was
given and I authored both contracts by hand", e acrescenta que as objeções eram
reais. Um plano contestado grava `status: "contested"` com os findings
(`src/plan/pipeline.mjs:233`) e para ali. Não existe verbo para responder a um
finding e continuar do estágio de revisão. Um amigo não vai escrever contrato à
mão.

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

`748d7ba`.

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Variáveis de ambiente do controlador que chegam ao worker | todas, menos as de notificação | só a lista permitida |
| Harnesses que declaram o ambiente de que precisam | 0 de 7 (claude, codex, agy, dsh, zcode, exec-jsonl, replay) | 7 de 7 |
| Saídas do `GETTING-STARTED.md` conferidas contra o CLI | 0 | todas as do passo a passo |
| Linhas que citam `.runs` nas docs correntes | 31 (7, 11, 11, 2) | 0 sem rótulo de legado |
| Ecossistemas com comando de verificação detectado pelo planner | 1 (Node) | 5 (Node, Python, Go, Rust, Makefile) |
| Plano contestado que continua sem contrato escrito à mão | não | sim |
| Nó recusado por contexto que continua sem intervenção manual no pacote | não | sim, com aprovação do operador |
| Verbo que remove o que o faberun escreveu fora do repositório | não | `faberun uninstall` |

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
- **measure:** `command: grep -c '\.runs' docs/GETTING-STARTED.md docs/CONCEPTS.md docs/ARCHITECTURE.md README.md`

### R6. Nenhuma doc atual descreve o layout antigo como atual

- **statement:** toda menção a `.runs` em `README.md` e em `docs/*.md` (fora de
  `docs/history/`, `docs/campaigns/` e `docs/adr/`) é removida ou fica dentro de
  um trecho rotulado como layout legado, e um ratchet impede a volta.
- **proof:** `command: node --test --test-name-pattern="no current doc describes the legacy run layout as current"`

### R7. O planner encontra verificação fora do Node

- **statement:** os fatos de repositório detectam comandos de verificação
  candidatos em `pyproject.toml` ou `pytest.ini` (`pytest`), `go.mod`
  (`go test ./...`), `Cargo.toml` (`cargo test`) e `Makefile` com alvo `test`
  (`make test`), além do `package.json` de hoje. Cada candidato registra o
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

## Não-objetivos

- Sandbox de container, microVM ou `ai-jail` (RM-027 a RM-029, RM-048). A lista
  de ambiente permitido é o mínimo, não o sandbox.
- Restringir rede ou sistema de arquivos do worker.
- Mudar o ambiente dos comandos de verificação (ver restrição de R1).
- Ecossistemas além dos cinco de R7.
- Instalador gráfico, app ou página web.
- Reautoria automática sem aprovação para risco `high`.
- Suporte a Windows além do que o CI já cobre hoje.

## Restrições

- Nenhuma dependência de runtime nova.
- Nenhum teste chama provedor, nem mesmo R8.
- R1 não pode quebrar o fluxo do próprio operador: as fases que tocam o
  ambiente terminam com R4 verificado antes de fechar.
- O orçamento de bytes da skill (campanha `evidence-you-can-recompute`, R8) vale
  aqui. Os verbos novos (`uninstall`, `--resolve`, `--reauthor`, `doctor --env`)
  entram em `docs/COMMANDS.md`, que é gerado, e a skill ganha no máximo uma
  linha de roteamento, paga com corte.
- Linux, macOS e Windows continuam verdes.

## Critério de sucesso

| Indicador | Baseline | Alvo |
| --- | --- | --- |
| Segredo plantado no ambiente do controlador visível ao worker de fixture | sim | não |
| Saídas do guia que divergem do CLI | pelo menos 1 (`.runs/campaigns/hello`) | 0, verificado no CI |
| Ecossistemas detectados | 1 | 5 |
| Tempo da primeira campanha offline de ponta a ponta | não existe | menos de 60 s |
| Contratos escritos à mão na próxima campanha do próprio operador | 2 de 2 (`durable-state-integrity`) | 0 |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Um harness lê uma variável não declarada e para de autenticar | o operador perde um runtime | R2 falha o teste antes, e R4 confere na máquina real antes de fechar |
| O teste do guia fica frágil com a formatação | falso vermelho no CI | a normalização é explícita e testada; o guia marca os blocos conferidos, e texto em prosa fica fora |
| A reautoria vira um laço caro | custo sem entrega | orçamento de rodadas duro, aprovação humana acima do nível declarado, e a métrica de laço improdutivo do RM-032 fica como follow-up nomeado |
| `uninstall` apaga evidência que o operador queria | perda de ledger | recusa enquanto houver ledger não preservado, `--dry-run` por padrão na doc |
