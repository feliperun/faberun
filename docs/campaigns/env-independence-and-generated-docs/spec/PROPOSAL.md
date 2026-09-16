---
title: "Faberun: independência de ambiente e documentação gerada"
version: 1.0.0
status: proposed
date: 2026-09-16
owner: Felipe Broering
campaign_id: env-independence-and-generated-docs
baseline: feliperun/faberun @ f3fdeb7
phases: 2
---

# Faberun: independência de ambiente e documentação gerada

## 1. Intenção

Duas classes de defeito continuam abertas, e as duas são fecháveis de forma
estrutural em vez de caso a caso.

**Primeira: teste que depende do layout da máquina.** É a terceira ocorrência
da mesma classe em seis semanas. Toda vez a correção foi pontual, e toda vez a
classe reapareceu em outro lugar.

**Segunda: documentação escrita à mão que descreve superfície de código.**
`docs/COMMANDS.md` tem 39.465 bytes e é o maior arquivo do repositório. Ele
diverge na primeira flag nova, e nenhum teste percebe.

O objetivo desta campanha não é corrigir os dois casos. É tornar as duas classes
inexpressáveis.

## 2. Estado medido

`f3fdeb7`, container Linux limpo, dependências instaladas.

| Indicador | Valor |
|---|---|
| Testes | 927, 923 passando, 3 skipped, **1 falhando** |
| `npm run check` | verde |
| `npm run typecheck` | verde |
| `skills/faberun/SKILL.md` | 1.002 B |
| `skills/faberun/references/` | 38.667 B, dos quais `contract.md` tem 21.378 |
| `docs/COMMANDS.md` | 39.465 B, escrito à mão |
| `docs/` total | 100.523 B |
| Ponteiros de raiz | 5 arquivos, md5 idêntico `9d7d3462…` |

### 2.1 A falha

`test/host/install-sh.test.mjs:157`, "install.sh fails when node is missing from
PATH". Esperado exit 1, obtido 0.

O teste esvazia o PATH, readiciona `/bin` e `/usr/bin`, e o comentário na linha
161 afirma: node vive fora dos dois. Em máquina onde node veio do gerenciador de
pacotes, `node` é `/usr/bin/node`. O instalador encontra node, sai 0.

Passa no macOS com asdf. Passa no CI, porque `setup-node` usa o tool cache.
Falha em Linux com node do apt, que é a instalação mais comum do mundo.

### 2.2 O histórico da classe

| Ocorrência | Suposição codificada | Correção aplicada |
|---|---|---|
| heartbeat | velocidade da máquina do autor | tolerância ajustada, depois determinismo por evento |
| runtime `judge` | `codex` presente no PATH | `test/fixture-runtime-guard.mjs` |
| `install.sh` | node ausente de `/usr/bin` | **aberta** |

O `fixture-runtime-guard` fechou a metade de runtime de fixture. A metade de
layout de host continua aberta, e é ela que esta campanha fecha.

## 3. Não-objetivos

- Reduzir `contract.md`. Os tetos em `test/docs/docs-diet.test.mjs` já são
  ratchets com justificativa datada por aumento, e o mecanismo está funcionando.
  Mexer nele agora seria brigar com um sistema que funciona.
- Reduzir contagem de linhas de qualquer arquivo como objetivo.
- Planejador adversarial e camada de evidência. Continuam sendo os próximos
  blocos grandes, e não entram aqui.
- Rename, domínio, ou qualquer mudança de identidade.

## 4. Fase 1: independência de ambiente

### N1. `install.sh` sem suposição de layout

**writeFiles**

    test/host/install-sh.test.mjs
    test/helpers.mjs

**Intenção.** O teste deixa de afirmar onde node mora e passa a construir o
PATH que ele precisa. Em vez de readicionar `/bin` e `/usr/bin` e torcer, monta
um diretório com symlink apenas para os binários que o instalador legitimamente
usa (`sh`, `tar`, e o que o `install.sh` invocar), e usa só esse diretório como
PATH.

**nonGoals.** Não alterar `install.sh`. O instalador está correto; o teste é que
mente.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n1.1 | o teste passa em máquina com `node` em `/usr/bin` | `command: node --test --test-name-pattern="install.sh fails when node is missing" test/host/install-sh.test.mjs` |
| n1.2 | o teste passa em máquina sem `node` em `/usr/bin` | `command: node --test test/host/install-sh.test.mjs` |
| n1.3 | nenhum comentário ou código do arquivo afirma onde um binário reside | `judgment: true` |
| n1.4 | `withEmptyPath` recebe a lista de binários necessários em vez de o chamador remendar o PATH depois | `command: node --test test/host/install-sh.test.mjs` |

### N2. Guarda de layout de host

**writeFiles**

    test/host-layout-guard.mjs
    test/host/host-layout.test.mjs

**Intenção.** Fechar a classe, no mesmo espírito do `fixture-runtime-guard.mjs`
que já existe. A guarda varre os arquivos de teste e falha quando um teste
codifica suposição sobre a máquina.

Padrões a rejeitar, salvo marcação de isenção explícita:

- caminho absoluto de binário de sistema fora de um `writeFiles` declarado
  (`/usr/bin`, `/usr/local/bin`, `/opt`, `/bin`) usado para construir PATH;
- referência a gerenciador de versão (`asdf`, `nvm`, `.tool-versions`) em
  asserção;
- asserção sobre a **ausência** de um binário sem que o teste tenha construído
  o PATH que a garante;
- `process.platform` em asserção, quando o comportamento testado não é
  específico de plataforma.

Isenção segue o padrão já usado: um marcador em comentário na linha, como o
`guard-exempt: schema-only` do `fixture-runtime-guard.mjs`.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n2.1 | a guarda reprova um teste que readiciona `/usr/bin` ao PATH sem isenção | `command: node --test test/host/host-layout.test.mjs` |
| n2.2 | a guarda aprova um teste que monta o próprio diretório de binários | `command: node --test test/host/host-layout.test.mjs` |
| n2.3 | o marcador de isenção funciona e exige justificativa na mesma linha | `command: node --test test/host/host-layout.test.mjs` |
| n2.4 | a suíte inteira passa com a guarda ativa | `command: npm test` |
| n2.5 | a guarda roda em CI | `path: .github/workflows/ci.yml` |

### N3. Ponteiros de raiz

**writeFiles**

    AGENT.md
    CLAUDE.md
    CURSOR.md
    GEMINI.md
    test/repo/root-pointers.test.mjs

**Intenção.** Os cinco arquivos têm md5 idêntico. Quatro viram ponteiro de uma
linha para `AGENTS.md`. Cinco cópias divergem; uma fonte com quatro ponteiros
não.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n3.1 | os quatro ponteiros não duplicam conteúdo de `AGENTS.md` | `command: node --test test/repo/root-pointers.test.mjs` |
| n3.2 | cada ponteiro nomeia `AGENTS.md` e cabe em uma linha de conteúdo | `command: node --test test/repo/root-pointers.test.mjs` |
| n3.3 | um ponteiro que volte a divergir ou a duplicar falha o teste | `command: node --test test/repo/root-pointers.test.mjs` |

**finalVerification da fase 1**

    npm run check
    npm run typecheck
    npm test
    node evals/run.mjs --class deterministic --assert-no-model

## 5. Fase 2: documentação gerada

### N4. `COMMANDS.md` gerado da CLI

**writeFiles**

    src/cli/manual.mjs
    docs/COMMANDS.md
    test/cli/manual.test.mjs
    package.json

**Intenção.** `docs/COMMANDS.md` tem 39.465 bytes escritos à mão descrevendo
superfície que o código já declara. Isso é a mesma classe de divergência que já
apareceu uma vez neste projeto, quando o `SKILL.md` descrevia um formato de
cápsula que o `capsule.mjs` não implementava.

A regra que você já adotou em outro lugar vale aqui: **gerar em vez de
verificar**. O manual passa a sair da tabela de comandos sobre a qual a própria
CLI despacha.

Prosa que não é derivável (exemplo de uso, nota de operação) vive em blocos
nomeados que o gerador preserva entre execuções, do mesmo jeito que o bloco de
sinal gerenciado já funciona no repositório.

**nonGoals.** Não redesenhar a CLI. Não mudar nenhum verbo, flag ou exit code.
O escopo é a origem do documento, não a superfície.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n4.1 | `npm run docs` regenera `docs/COMMANDS.md` da tabela de comandos da CLI | `command: npm run docs && git diff --exit-code docs/COMMANDS.md` |
| n4.2 | uma flag nova sem documentação faz o teste falhar | `command: node --test --test-name-pattern="manual covers every flag" test/cli/manual.test.mjs` |
| n4.3 | um verbo removido do código some do manual na regeneração | `command: node --test --test-name-pattern="manual drops removed verbs" test/cli/manual.test.mjs` |
| n4.4 | prosa marcada como manual sobrevive à regeneração | `command: node --test --test-name-pattern="manual preserves authored blocks" test/cli/manual.test.mjs` |
| n4.5 | CI falha quando o manual está fora de sincronia com o código | `path: .github/workflows/ci.yml` |
| n4.6 | todo verbo, flag e exit code documentado existe no código | `command: node --test test/cli/manual.test.mjs` |

### N5. Guarda de carga de referência

**writeFiles**

    test/docs/reference-load.test.mjs
    skills/faberun/references/operations.md

**Intenção.** O `SKILL.md` de 1.002 bytes só vale enquanto o que ele roteia
permanece limitado. Nada hoje impede um packet de worker de apontar `readFiles`
para `docs/COMMANDS.md` e desfazer a dieta inteira em uma linha.

A guarda declara o conjunto de documentos que um packet de worker pode carregar
e falha quando um contrato de fixture aponta para fora dele. `docs/` é
documentação de operador e não entra em contexto de worker.

Acrescenta também a contabilidade que falta: `faberun report` passa a expor
quantos bytes de referência foram efetivamente carregados por invocação, para
que a dieta deixe de ser medida por tamanho de arquivo e passe a ser medida por
carga real.

**Definition of Done**

| id | item | prova |
|---|---|---|
| n5.1 | um contrato de fixture cujo `readFiles` aponte para `docs/` é rejeitado | `command: node --test test/docs/reference-load.test.mjs` |
| n5.2 | a lista de referências carregáveis por worker é declarada num só lugar | `command: node --test test/docs/reference-load.test.mjs` |
| n5.3 | `faberun report --json` expõe bytes de referência carregados por invocação | `command: node --test --test-name-pattern="report exposes reference bytes" test/report/metrics-report.test.mjs` |
| n5.4 | o caminho feliz de uma campanha carrega abaixo de 24 KiB de referência | `command: node evals/run.mjs --class deterministic --case D-reference-load` |

**finalVerification da fase 2**

    npm run check
    npm run typecheck
    npm test
    npm run docs && git diff --exit-code docs/COMMANDS.md
    node evals/run.mjs --class deterministic --assert-no-model
    node evals/run.mjs --class deterministic --verify-discriminating

## 6. Convenções desta campanha

Herdadas de `skills/faberun/references/rules.md` e das retrospectivas de campo:

1. Um contrato por fase, com todos os nós e arestas `dependsOn` autorados num
   turno só. Nada de micro-contrato serial.
2. Nenhum packet manda o worker rodar a suíte inteira. Verificação é do
   controlador, com o arquivo de teste específico do nó.
3. Toda `verification` tem duração medida antes de ter `timeoutSec` declarado.
   A suíte completa leva cerca de 233 s.
4. Juiz em vendor diferente do worker e do fallback.
5. Nenhum teste novo depende de relógio de parede, de binário no PATH, ou de
   layout de máquina. É literalmente o tema da campanha.
6. Todo teto novo segue o padrão de ratchet já usado em
   `test/docs/docs-diet.test.mjs`: comentário datado, justificativa do aumento,
   e a frase de que aumentar de novo exige o mesmo argumento.

## 7. Critério de sucesso

| Métrica | Baseline | Alvo |
|---|---|---|
| Testes falhando | 1 | 0 |
| Classes de dependência de ambiente abertas | 1 (layout de host) | 0 |
| `docs/COMMANDS.md` | 39.465 B à mão | gerado, divergência impossível |
| Ponteiros de raiz duplicados | 4 | 0 |
| Referência carregável por worker | não declarada | declarada e verificada |
| `costPerClosedCheckpoint` | `evals/baseline.json` | não regride |

A campanha fecha com retrospectiva registrando delta contra `evals/baseline.json`
e uma linha sobre a classe de ambiente: três ocorrências, uma guarda, encerrada.

## 8. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| A guarda de layout gera falso positivo em teste legítimo | médio | marcador de isenção com justificativa na linha, mesmo padrão do `fixture-runtime-guard` |
| A geração do manual perde prosa boa que existe hoje | médio | n4.4 exige preservação de bloco autorado; revisar o diff da primeira geração à mão |
| O gerador vira mais superfície para manter | baixo | ele lê a tabela sobre a qual a CLI já despacha; se precisar de tabela paralela, o desenho está errado |
| A guarda de referência quebra contrato existente | baixo | fixtures são a fonte; rodar contra todas antes de ativar |

## 9. Depois desta campanha

Não entram aqui, e continuam sendo os próximos blocos grandes, nesta ordem:

1. **Planejador adversarial.** Hoje o plano ainda é autorado pela sessão, que é
   o custo fixo mais caro que sobrou.
2. **Camada de evidência.** `FIELD-OWNERSHIP.md` já é o alicerce; falta a
   âncora em requisito e a fase `probe`.
3. **Mutation testing.** Com a suíte em 233 s, cabe no orçamento de tempo.
