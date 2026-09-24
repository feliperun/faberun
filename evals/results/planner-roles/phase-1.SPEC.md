---
id: safe-to-hand-to-a-friend-phase-1
title: "Um estranho instala, roda e desinstala sem ajuda e sem expor as credenciais dele"
version: 1.2.0
status: draft
date: 2026-09-24
owner: Felipe Broering
target: feliperun/faberun
baseline: 1357ea6
derived_from: evals-with-a-budget
followed_by: friends-pilot
---

# Um estranho instala, roda e desinstala sem ajuda e sem expor as credenciais dele


> Recorte mecânico da fase 1 de `docs/campaigns/safe-to-hand-to-a-friend/spec/SPEC.md` (1.2.0, em `59a9039`), feito para o R5 da `choose-the-judges`: só os requisitos R9 e R14 a R17 ficam; o resto do texto é o original, sem edição.

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

`1357ea6` (0.24.0), com a evidência dos journals das campanhas 0, 1 e 2.

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

Peças existentes que o trabalho reusa: `childEnv` de `src/engine/gate.mjs`,
`missingEnvironmentVariables` e o `env_key` dos runtimes, `redactSecrets`,
`faberun doctor` e `faberun models --probe`, o gerador de manual
(`npm run docs:check`), o harness `replay`, `faberun init`, `faberun spec
scaffold`, o pipeline de plano com seus estágios, `validateContract` com
`scopeClosureFindings` e `crossNodeScopeFindings`, e o resultado estruturado
`blocked_context`.

## Requisitos

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
  plano antes de contar como rodada. Um defeito mecânico com reparo único (um
  `proof.ref` escrito como o texto de um comando de verificação que existe no
  nó vira o índice desse comando) é reparado e registrado; um defeito sem
  reparo único volta ao mesmo revise uma vez, com as mensagens do validador, sem
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

## Não-objetivos

- Sandbox de container, microVM ou `ai-jail` (RM-027 a RM-029, RM-048). A lista
  de ambiente permitido é o mínimo, não o sandbox.
- Restringir rede ou sistema de arquivos do worker.
- Mudar o ambiente dos comandos de verificação (ver restrição de R1).
- Ecossistemas além dos seis de R7.
- Instalador gráfico, app ou página web.
- Reautoria automática sem aprovação para risco `high`.
- Suporte a Windows além do que o CI já cobre hoje.
- Reescrever o revise com outro modelo ou mudar o modelo padrão do planner. R14
  mede e para; escolher o revisor é roteamento.
- `RM-086` (o `faberun plan` que morreu dentro de um painel tmux sem reproduzir
  fora dele). Fica medido e não reproduzido; o programa usa `plan --detach`.
- Revisar a D9. É decisão do dono, fora desta spec.

## Restrições

- **Ordem das fases.** A fase 1 é o planner e o lançamento (R14, R15, R16, R17 e
  R9). Só ela pode ter contrato escrito à mão, registrado como `hand-authored`.
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

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Um harness lê uma variável não declarada e para de autenticar | o operador perde um runtime | R2 falha o teste antes, e R4 confere na máquina real antes de fechar |
| O teste do guia fica frágil com a formatação | falso vermelho no CI | a normalização é explícita e testada; o guia marca os blocos conferidos, e texto em prosa fica fora |
| A reautoria vira um laço caro | custo sem entrega | orçamento de rodadas duro, aprovação humana acima do nível declarado, e a métrica de laço improdutivo do RM-032 fica como follow-up nomeado |
| R14 para cedo demais um plano que convergiria na rodada seguinte | um plano bom vira contestado | o finding mostra a contagem por rodada, e `plan --resolve` (R9) continua de onde parou |
| R16 cresce até virar um motor de workflow | escopo estoura | o requisito pede só parar, nomear o passo e continuar; nada de agendamento ou condição |
| `uninstall` apaga evidência que o operador queria | perda de ledger | recusa enquanto houver ledger não preservado, `--dry-run` por padrão na doc |
