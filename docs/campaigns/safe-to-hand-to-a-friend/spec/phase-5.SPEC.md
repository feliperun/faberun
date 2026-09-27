---
id: safe-to-hand-to-a-friend-phase-5
title: "Um estranho instala, roda e desinstala sem ajuda e sem expor as credenciais dele"
version: 2.1.0
status: draft
date: 2026-09-27
owner: Felipe Broering
target: feliperun/faberun
baseline: 6ecb804
derived_from: safe-to-hand-to-a-friend
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

**A primeira campanha fora deste repositório achou doze atritos.** A campanha
`agent-belt-security-quality-review` (faberun 0.10.0, repositório
`feliperun/agent-belt`, 2026-09-25: 64 achados, 60 corrigidos, cerca de US$ 207
de worker, 3 intervenções do operador) deixou os achados F1 a F12 na sua
retrospectiva. Conferidos contra a árvore da 0.25.1: F1 (veredito do dsh
ilegível) e F2 (retomada de `judge_unavailable`) já estão corrigidos, e os
outros dez viram R22 a R31. Cada um cita o achado de origem. R32 a R36 vêm da
própria campanha `planner-and-routing`, que achou esses defeitos enquanto rodava. Os dez são o que
um estranho encontra na primeira campanha, fora do repositório do autor.

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

Esta fase cobre R30 a R36: ids gerados pelo campaign note, custo por tentativa no status, lançamento destacado recusado que diz por quê, limite de sessão que espera o reset, prova que não roda na base, regra do juiz e atribuição de runtimes coerentes, e o modo de um provedor só pelo config da máquina.

### R30. `campaign note` gera os ids que pode gerar

- **origin:** agent-belt F11, medido aqui também em 2026-09-25.
- **statement:** sem `--decision-id` ou `--question-id`, o comando gera um id a
  partir do texto, com sufixo curto, e o imprime. Sem `--session-id`, usa a
  última sessão anexada à campanha e só recusa quando não há nenhuma. O uso
  gerado deixa de mostrar entre colchetes um flag exigido.
- **proof:** `command: node --test --test-name-pattern="a decision note without ids gets a generated id and the attached session" test/campaign/campaign.test.mjs`

### R31. O `status` mostra o custo por tentativa e avisa quando re-tentar custa mais

- **origin:** agent-belt F12 (um nó custou cerca de US$ 112 em 4 tentativas).
- **statement:** o payload de cada nó ganha o custo de cada tentativa, derivado
  das `invocations` que o snapshot já guarda. A linha de texto marca quando a
  soma das tentativas depois da primeira passa o custo da primeira.
- **proof:** `command: node --test --test-name-pattern="status flags retries that out-spend the first attempt" test/report/cost.test.mjs`

### R32. Um lançamento destacado recusado diz por quê e não deixa resto

- **origin:** `planner-and-routing`, 2026-09-25: um `run --detach` que a
  atribuição de runtimes recusou imprimiu só `detached bootstrap failed before
  readiness`, e o diretório da run que ficou para trás (só o `contract.json`)
  recusou a nova tentativa com `run already exists`.
- **statement:** o bootstrap destacado repassa ao terminal a mensagem de erro
  do controlador que morreu antes da prontidão. Um diretório de run que nunca
  chegou a ter um nó é removido pelo próprio lançamento que falhou.
- **proof:** `command: node --test --test-name-pattern="a refused detached launch prints the controller error and leaves no run directory" test/engine/detach.test.mjs`

### R33. Um limite de sessão com hora de reset espera o reset

- **origin:** `planner-and-routing`, 2026-09-25: três nós esgotaram com
  `quota_exhausted` num 429 do Claude cujo texto dizia `You've hit your session
  limit · resets 2:40pm (America/Sao_Paulo)`.
- **statement:** a classificação de disponibilidade lê a hora de reset desse
  texto, com o fuso que ele nomeia, e o nó espera o reset como já espera um
  `exhaustedUntil` de outro provedor, em vez de esgotar.
- **proof:** `command: node --test --test-name-pattern="a session limit that names its reset time waits for it" test/harnesses/claude.test.mjs`

### R34. Uma prova que não roda nem na base é recusada no lançamento

- **origin:** `planner-and-routing`, 2026-09-25: a prova `r9-named` de um
  contrato escrito à mão tinha um apóstrofo dentro de uma string entre aspas
  simples de `node -e`, e o nó pagou três tentativas antes de alguém ver que
  nenhuma entrega passaria.
- **statement:** antes do primeiro despacho, cada prova `command` que é um
  `node -e` tem o corpo checado pelo parser. Um erro de sintaxe recusa o
  lançamento, nomeando o nó e o item.
- **proof:** `command: node --test --test-name-pattern="a proof command that cannot parse refuses the launch" test/contract/definition-of-done.test.mjs`

### R35. A regra do juiz e a atribuição de runtimes dizem a mesma coisa

- **origin:** `planner-and-routing`, 2026-09-25: o `validate` aceitou um
  contrato em `judgeIndependence: "same-vendor"` que a atribuição de runtimes
  recusou no lançamento (corrigido em `fix(engine): same-vendor mode admits a
  same-provider judge at runtime assignment`).
- **statement:** `faberun validate` roda a atribuição de runtimes do lançamento
  sobre o contrato, com a disponibilidade dada como tudo disponível, e recusa o
  que o lançamento recusaria.
- **proof:** `command: node --test --test-name-pattern="validate refuses what runtime assignment would refuse" test/cli/validate.test.mjs`

### R36. O modo de um provedor só também vale pelo config da máquina

- **origin:** R20 da `planner-and-routing` pede o opt-in "no contrato ou no
  config da máquina". Só a metade do contrato pousou, porque a validação do
  contrato não lê o config da máquina.
- **statement:** `judgeIndependence` no config da máquina vale para um contrato
  que não o declara. O lançamento grava no snapshot da run o modo efetivo, e o
  Brief, o relatório e as métricas leem esse modo.
- **proof:** `command: node --test --test-name-pattern="the machine config opts a contract into same-vendor review" test/engine/runtime-discovery.test.mjs`

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
