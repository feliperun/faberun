---
id: safe-to-hand-to-a-friend
title: "Um estranho instala, roda e desinstala sem ajuda e sem expor as credenciais dele"
version: 2.0.0
status: draft
date: 2026-09-24
owner: Felipe Broering
target: feliperun/faberun
baseline: 6ecb804
derived_from: planner-and-routing
followed_by: friends-pilot
---

# Um estranho instala, roda e desinstala sem ajuda e sem expor as credenciais dele

## Intenção

Campanha 3b do programa `leaving-home`. Até aqui o faberun rodou num
único repositório (ele mesmo), numa única máquina, com um único operador que
conhece cada convenção porque escreveu todas. Um amigo não conhece nenhuma
delas. Esta campanha remove, com medição, cada coisa que hoje só funciona
porque o operador é o autor.

R9 e R14 a R21 foram para `planner-and-routing` (campanha 3a), que conserta o
planner e o roteamento de juízes antes desta. Esta campanha é o teste do portão 3
para 4: todo contrato dela sai do `faberun plan`.

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

## Não-objetivos

- Sandbox de container, microVM ou `ai-jail` (RM-027 a RM-029, RM-048). A lista
  de ambiente permitido é o mínimo, não o sandbox.
- Restringir rede ou sistema de arquivos do worker.
- Mudar o ambiente dos comandos de verificação (ver restrição de R1).
- Ecossistemas além dos seis de R7.
- Instalador gráfico, app ou página web.
- Reautoria automática sem aprovação para risco `high`.
- Suporte a Windows além do que o CI já cobre hoje.
- Consertar o planner ou o roteamento de juízes: é a `planner-and-routing`.

## Restrições

- **Todo contrato desta campanha sai do `faberun plan`.** Um contrato escrito à
  mão é registrado como decision `hand-authored` e reprova o critério de sucesso.
  Esta campanha é o teste do portão 3 para 4.
- **Orçamento de execução:** até US$ 20.
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
| Contratos escritos à mão nesta campanha | 13 de 13 (os 10 das três campanhas anteriores e os 3 planos do R5 da `choose-the-judges` que não congelaram) | 0 |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Um harness lê uma variável não declarada e para de autenticar | o operador perde um runtime | R2 falha o teste antes, e R4 confere na máquina real antes de fechar |
| O teste do guia fica frágil com a formatação | falso vermelho no CI | a normalização é explícita e testada; o guia marca os blocos conferidos, e texto em prosa fica fora |
| A reautoria vira um laço caro | custo sem entrega | orçamento de rodadas duro, aprovação humana acima do nível declarado, e a métrica de laço improdutivo do RM-032 fica como follow-up nomeado |
| `uninstall` apaga evidência que o operador queria | perda de ledger | recusa enquanto houver ledger não preservado, `--dry-run` por padrão na doc |
