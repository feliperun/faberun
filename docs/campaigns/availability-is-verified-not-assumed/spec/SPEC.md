---
id: availability-is-verified-not-assumed
title: "Disponibilidade é verificada falando, não presumida do crachá"
version: 1.0.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: b969a88
---

# Disponibilidade é verificada falando, não presumida do crachá

## Intenção

O achado é do dono, formulado assim: *"o preflight dos harness deve dar um oi
lá para o harness para ver se ele responde, não só ver se está com login. Ele
só vê se está logado e considera ok. Mas quando você dá um oi, você vê se está
com a cota estourada."*

**A capacidade de dar o oi já existe e é boa.** `src/engine/live-preflight.mjs`
manda um prompt real — `Respond with exactly FABERUN_PREFLIGHT_OK and do not
use tools` — num repositório git descartável, com cada runtime travado no seu
modo somente-leitura, e redige toda string de provedor contra o ambiente antes
de logar. O cabeçalho do módulo enuncia o problema quase nas mesmas palavras do
dono.

**O que falta é ligá-la aos caminhos que gastam.** `preflightContract` é
chamado de um único lugar em toda a árvore: `src/cli.mjs:401`, o comando
`faberun preflight`. Nada mais o invoca.

Esta campanha não constrói o oi. Ela o coloca onde ele evita prejuízo, faz o
veredito dizer qual das quatro causas ocorreu, e o torna barato o bastante para
ficar ligado.

## Estado medido

Medido em 2026-09-22 no `b969a88`, nesta máquina.

**Quem pergunta e quem não pergunta.**

| caminho | o que verifica |
| --- | --- |
| `faberun preflight` sem `--static` | fala com cada runtime roteado |
| `faberun run` | `assertEnvironmentReady` — binário e versão; **bloqueia**, nunca fala |
| `faberun plan` | nada |
| `faberun doctor`, `faberun models --probe` | alcance do binário |

**O oi custa pouco.** Rodado contra um contrato de quatro runtimes: **18
segundos**, com `usage in 5750 / 2491 / 16858` e saída de dezenas de tokens.

**E ele pega o que o estático aprova.** O mesmo comando reprovou o
`agy-gemini-pro-judge`:

```
[fail] agy-gemini-pro-judge · agy · gemini-3.1-pro-high · 1.2.7
       live failed · preflight_timeout: live generation timed out after 15s
```

Causa real, confirmada depois: **não existe diretório de configuração do
`agy`** — nem `~/.config/agy` nem `~/.agy`. O binário está instalado, reporta
`1.2.7`, e por isso `doctor`, `models --probe` e o portão estático do `run`
aprovam todos.

Esse runtime foi declarado **ontem, por este orquestrador**, como fallback do
juiz, para fechar a questão aberta "juiz sem rede de segurança". Foi declarado
sem nunca ter sido consultado. Uma rede de segurança que não responde é pior
que nenhuma, porque cria confiança falsa — e o oi de 18 segundos teria pego.

**O veredito conflata causas.** `preflight_timeout` não distingue "não tem
credencial" de "o modelo é lento". A causa real só apareceu quando um humano
foi olhar o diretório de configuração. Um veredito que junta causas é o mesmo
defeito uma camada acima.

**Peças que já existem e a campanha reusa:** `preflightContract` e
`safeLiveRuntime` em `src/engine/live-preflight.mjs`; a forma
`RuntimeAvailability` em `src/contract/runtime.mjs:176`, com `available`,
`reason`, `observedAt`, `window` e `remaining`, e a disciplina de três estados
(ausente / nulo / tipado) já validada; e `assertEnvironmentReady` em
`src/engine/run-identity.mjs:413`, que já é o portão que bloqueia.

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Caminhos que gastam e falam antes | 0 de 3 | todos |
| Chamadores de `preflightContract` | 1 | os portões |
| Causas que o veredito distingue | 1 | 4 |
| Runtimes declarados sem nunca responder | 1 de 4 neste catálogo | 0 |
| Custo de perguntar aos quatro | 18s | inalterado, e pago uma vez por janela |

## Requisitos

### R1. O portão que bloqueia usa o veredito de quem falou

- **statement:** o portão de despacho que hoje aprova por binário e versão passa
  a exigir que cada runtime roteado tenha respondido; um runtime que não
  respondeu bloqueia o run antes de qualquer worktree ou evento de campanha
  existir, com a mesma resumibilidade que o portão já oferece.
- **proof:** `command: node --test test/engine/live-gate.test.mjs`

### R2. O veredito nomeia qual das quatro causas

- **statement:** o resultado por runtime distingue binário ausente, não
  autenticado, modelo indisponível para a conta, e cota ou provedor fora; um
  tempo esgotado sem causa discernível é reportado como tal e não como uma das
  quatro.
- **proof:** `command: node --test test/engine/live-verdict.test.mjs`

### R3. Perguntar custa uma vez por janela

- **statement:** o veredito é gravado com o instante em que foi observado e
  reusado enquanto estiver dentro de uma janela declarada; fora dela pergunta de
  novo; e o operador pode forçar a pergunta. Nenhuma invocação paga o oi duas
  vezes pelo mesmo runtime na mesma janela.
- **proof:** `command: node --test test/engine/live-cache.test.mjs`

### R4. Planejar também pergunta antes

- **statement:** `faberun plan` não inicia um estágio contra um runtime que não
  respondeu; a recusa acontece antes do primeiro estágio, não no meio do
  terceiro.
- **proof:** `command: node --test test/plan/plan-asks-first.test.mjs`

### R5. Quem só olhou o crachá diz que só olhou

- **statement:** `doctor` e `models --probe` ou reportam o veredito de quem
  falou, ou dizem explicitamente que não perguntaram; nenhum dos dois reporta
  `ok` para um runtime que nunca respondeu sem nomear o que de fato verificou.
- **proof:** `command: node --test test/cli/availability-report.test.mjs`

## Não-objetivos

- Não reescrever `live-preflight.mjs`. Ele está certo; o que falta é chamá-lo.
- Não enfraquecer `safeLiveRuntime`. O oi continua travado em modo
  somente-leitura, em repositório descartável, com redação de segredo.
- Não fazer o oi implícito em caminho quente sem cache. Ele custa dinheiro e
  latência, e um probe que roda a cada invocação é um defeito novo.
- Não inferir cota a partir de silêncio. Um tempo esgotado sem causa é
  desconhecido, e dizer isso é a resposta certa.
- Não autenticar o `agy` como parte do trabalho. O catálogo é decisão do
  operador; a campanha faz o produto contar a verdade sobre ele.
- Não mexer em `docs/history/`, em campanha já registrada sob `docs/campaigns/`,
  nem em `evals/golden/`.

## Restrições

- `CONTRACT_VERSION` permanece `0.3.0` a menos que um requisito exija campo
  novo; se exigir, o validador e o typedef entram no mesmo packet.
- Nenhum `.mjs` passa de 800 linhas. `src/engine/live-preflight.mjs` está em 212
  linhas e `src/engine/run-identity.mjs` em 432, então ambos têm folga.
- `npm run typecheck` limpo; `noUnusedLocals` permanece ligado.
- Todo comando de verificação por diretório declara `--test-concurrency=1`, com
  o tempo limite medido sob essa flag. `test/engine/` como diretório fica fora
  das arrays: medido serializado em 1035s contra o teto de 600s.
- Nenhuma prova de DoD usa `--test-name-pattern`; aponte para o arquivo inteiro.
- Nenhum teste da campanha fala com provedor de verdade. O oi é exercitado por
  fixture; um teste que gasta token é um teste que falha sem rede.
- Teste que lê o que outro processo escreve espera sinal de prontidão, e o sinal
  é escrito depois da coisa que ele anuncia.
- Um contrato por fase, com todos os nós e arestas autorados num turno só.

## Critério de sucesso

| Métrica | Baseline | Alvo | Fonte |
| --- | --- | --- | --- |
| Caminhos que gastam e perguntam antes | 0 de 3 | 3 de 3 | testes |
| Causas distinguidas pelo veredito | 1 | 4, mais "desconhecido" | testes |
| Oi repetido para o mesmo runtime na mesma janela | não medido | 0 | testes |
| Runtimes aprovados pelo estático e mudos | 1 de 4 | 0 aprovados | `preflight` |
| Tentativas mortas por runtime indisponível | 4 num dia | 0 | relato do operador |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| O oi vira custo recorrente em caminho quente | alto | R3 exige janela e reuso; sem ela o requisito não está pronto |
| Um provedor lento é classificado como indisponível | alto | R2 obriga "desconhecido" a ser uma resposta, e o teto do oi é declarado, não implícito |
| O portão novo bloqueia run que hoje passa e funciona | alto | O bloqueio é resumível como o atual, e a campanha mede antes quantos runtimes do catálogo real respondem |
| O cache guarda um veredito velho e esconde uma queda | médio | `observedAt` já existe na forma validada; fora da janela pergunta de novo, e o operador força |
| Testes acabam falando com provedor de verdade | alto | Restrição explícita: fixture sempre; um teste que gasta token falha sem rede |
