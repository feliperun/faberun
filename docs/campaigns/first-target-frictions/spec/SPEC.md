---
id: first-target-frictions
title: "O que o primeiro alvo real e o brief ensinaram, fechado antes de medir qualquer coisa"
version: 1.0.0
status: draft
date: 2026-09-23
owner: Felipe Broering
target: feliperun/faberun
baseline: 424c29b
derived_from: leaving-home
followed_by: evidence-you-can-recompute
---

# O que o primeiro alvo real e o brief ensinaram, fechado antes de medir qualquer coisa

## Intenção

Campanha zero do programa `leaving-home`. Ela existe porque, depois que o
programa foi escrito, duas campanhas reais terminaram e trouxeram achados que
mudam a ordem.

**A primeira campanha contra um repositório que o faberun não escreveu.** A
`rec-audit-remediation` (PR #62) corrigiu 22 achados de auditoria no
`feliperun/rec`, um gravador em Zig, rodando num host Linux: 12 de 12 nós
fechados, 138 para 162 testes no alvo, US$ 1,35 e 1 h 32 min. O mais útil do
registro são as seis fricções medidas (`RM-050` a `RM-055`), e todas são da
mesma família, nas palavras da retrospectiva: "um comportamento correto cujo
custo o operador descobre pagando". Um amigo vai pagar esse custo sem saber o
que está pagando.

**A campanha do Campaign Brief (PR #63).** Ela entregou o P1 do roadmap e, no
caminho, mostrou o planner errando de jeitos que um estranho não saberia
corrigir: um revisor atribuiu `timeoutSec: 120` à verificação final enquanto os
fatos de repositório mediam 178.904 ms e 246.955 ms para duas partes dela; um
rascunho propôs uma dependência npm que resolvia para um pacote sem relação; e
o juiz `codex-sol` precisou de `workspace-write` para conseguir gravar o
próprio `review.json`, o que dá ao juiz permissão de escrever onde não deveria.

**Dois testes que falham sob carga no macOS.** Os testes com orçamento de
contrato abaixo de um segundo (`done-when 1 and 4` e `a judge timeout re-asks
once`) falham com carga paralela no macOS. É a mesma família de contenção que o
`orchestration-arms` já tinha encontrado em `test/run/process.test.mjs`. Um
amigo em Mac que rodar a suíte vai ver vermelho que não é dele.

Por que antes das outras quatro campanhas: a próxima mede o produto, e medir
enquanto nós morrem por uma linha de `.gitignore`, controladores morrem com o
shell e a suíte pisca no macOS é medir ruído. Tudo aqui é pequeno, já tem
reprodução e não cria verbo novo.

## Estado medido

`424c29b` (0.20.0). Evidência das PRs #62 e #63.

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Nós perdidos por escrever uma fonte de ignore, em duas campanhas | 2 (uma tentativa de 80 min na `intent-factory-lean`, um nó na `rec-audit-remediation`) | 0: o contrato avisa antes |
| Fontes nomeadas pela mensagem `snapshot_ignore_changed` | 0 (`src/repo/workspace.mjs:56` e `:126`) | a fonte que mudou |
| Artefatos da verificação que atravessaram o selo na `rec-audit-remediation` | 14 | 0 |
| Runs cancelados porque o controlador destacado morreu com o shell | 3 | 0 sem instrução de retomada |
| Testes com orçamento de contrato abaixo de 1 s que falham sob carga no macOS | 2 | 0 |
| Verificação com `timeoutSec` abaixo da duração medida, num plano do planner | 1 (120 s contra 247 s medidos) | 0 |
| Runtimes de juiz que precisam de `workspace-write` para gravar o veredito | pelo menos 1 (`codex-sol`) | 0 |

Peças existentes que o trabalho reusa: `captureIgnoreSources` e
`compareWorkspaceSnapshot` (`src/repo/workspace.mjs`), `scopeFindings`, o
selo de tentativa, a mensagem `launch_failed` de `src/cli/launch.mjs`, o
ratchet de prazos de `test/repo/source-shape.test.mjs`, as durações medidas
que `repo-facts` já guarda, e o protocolo de resultado do worker.

## Requisitos

### R1. Escrever uma fonte de ignore é avisado antes e explicado depois

- **statement:** `faberun contract validate` emite o finding
  `writes_ignore_source` para todo nó cujo `writeFiles` inclua uma fonte que
  `captureIgnoreSources` acompanha (`.gitignore` em qualquer nível,
  `.faberunignore`, `.git/config`). Quando o nó falha mesmo assim, a mensagem de
  `snapshot_ignore_changed` nomeia o caminho de cada fonte que mudou.
- **proof:** `command: node --test --test-name-pattern="a node that writes an ignore source is warned before and told which one after"`

### R2. O que a verificação deixa no worktree não entra no selo

- **statement:** um arquivo não rastreado que aparece no worktree durante a
  verificação do nó, fora do `writeFiles` do nó, fica fora do commit de selo e é
  registrado como finding `verification_artifact`, com o caminho, no relatório
  do nó. Nada é apagado: o arquivo só não atravessa para a integração.
- **proof:** `command: node --test --test-name-pattern="a file the verification leaves behind is reported and not sealed"`
- **constraints:** arquivos criados pelo worker (antes da verificação) seguem
  a regra de hoje, via `scopeFindings`. A mudança vale só para o que surge
  durante a verificação.

### R3. Um controlador que morreu no bootstrap diz como retomar

- **statement:** quando o bootstrap destacado não fica pronto, a atenção
  `launch_failed` diz que o diretório da run existe, quantos nós estão em cada
  estado e o comando exato `faberun resume <run-dir>` que completa a run.
  `references/operations.md` ganha uma frase: o controlador destacado sobrevive
  ao processo que o lançou, não ao escopo de sessão (cgroup) que o contém, e run
  longa se conduz sob `tmux`, `systemd-run` ou o `seat`.
- **proof:** `command: node --test --test-name-pattern="a failed detached bootstrap names the run and the resume that completes it"`

### R4. Nenhum teste dá a um contrato orçamento abaixo de um segundo

- **statement:** os dois testes que falham sob carga no macOS passam a esperar
  por evento, e não por relógio. Um ratchet novo em
  `test/repo/source-shape.test.mjs` falha a suíte quando um teste declara
  `timeoutSec` ou `stallTimeoutSec` abaixo de 1 num contrato ou nó, a não ser
  numa lista nomeada com o motivo.
- **proof:** `command: node --test --test-name-pattern="no test gives a contract a budget under one second"`

### R5. O planner nunca congela uma verificação mais curta que a medida

- **statement:** `freeze` recusa um plano em que o `timeoutSec` de um comando de
  verificação fica abaixo de 1,5 vez a duração que `repo-facts` mediu para ele,
  ou para a soma das partes que ele inclui. Quando a duração medida passa do
  teto de `VERIFICATION_LIMITS.maxTimeoutSec` (1.800 s), o plano fica contestado
  com um finding que nomeia o comando e sugere dividi-lo.
- **proof:** `command: node --test --test-name-pattern="a frozen verification timeout covers its measured duration"`

### R6. Um juiz somente-leitura entrega o veredito

- **statement:** o veredito do juiz chega ao gate sem que o juiz precise
  escrever no worktree de revisão, para todo harness que hoje exige
  `workspace-write` só para gravar `review.json`. Um catálogo de runtimes em que
  o juiz declara `workspace-write` recebe um aviso de `contract validate`.
- **proof:** `command: node --test --test-name-pattern="a read-only judge's verdict reaches the gate"`

## Não-objetivos

- `RM-050` (`workspace-write` e toolchain com cache no `$HOME`) e `RM-054`
  (override de operador para defeito de pacote). Os dois vão para
  `safe-to-hand-to-a-friend`, junto com o ambiente permitido e a reautoria, que
  são da mesma família.
- `RM-055` (métrica que pune a recuperação). Vai para
  `evidence-you-can-recompute`, que é a campanha das métricas.
- Detectar dependência inventada pelo planner. Fica registrada no roadmap como
  item novo, sem requisito aqui, porque ainda não há um jeito determinístico de
  distinguir dependência nova legítima de alucinada.
- Mudar o comportamento de `snapshot_ignore_changed`. O nó continua falhando: o
  que muda é o aviso antes e a mensagem depois.
- A condição `!job.logDir` do detector de liveness, que ficou morta depois do
  #54. É decisão do dono, fora deste programa.

## Restrições

- Nenhum verbo novo e nenhuma dependência de runtime nova.
- As frases novas em `references/` são pagas com corte no mesmo arquivo. Nenhum
  teto de `test/docs/docs-diet.test.mjs` sobe nesta campanha.
- Nenhum teste chama provedor.
- Linux, macOS e Windows continuam verdes, e a suíte passa com
  `--test-concurrency` alta no macOS do operador antes do fechamento.

## Critério de sucesso

| Indicador | Baseline | Alvo |
| --- | --- | --- |
| Achados de `validate` para nó que escreve fonte de ignore | 0 | 1 por nó |
| Artefatos de verificação no commit de integração, reproduzindo o caso do `rec` numa fixture | 14 | 0 |
| Testes vermelhos sob carga no macOS | 2 | 0 |
| Verificações congeladas abaixo da duração medida | possível | recusado |
| Juízes que precisam de escrita | pelo menos 1 | 0 |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Tirar do selo um arquivo que o worker precisava | correção incompleta integrada | R2 só vale para o que surge durante a verificação e fora do `writeFiles`; o finding nomeia o caminho |
| A margem de 1,5 vez superdimensiona verificações rápidas | run mais lenta ao falhar | o timeout só limita falha; verificação que passa não espera por ele |
| Mudar o protocolo do juiz quebra um harness | juiz sem veredito | R6 é testado por harness com `replay`, e a campanha fecha com o probe do operador |
