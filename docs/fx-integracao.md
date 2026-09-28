---
title: "fx no Faberun: o que foi feito, como verificar e como integrar"
version: 1.0.0
status: reference
date: 2026-09-27
owner: Felipe Broering
source: "Branch feat/fx-harness (8fc8809), fork feliperun/fx branch fx-faberun (b41f984d), benchmark de memória de 2026-09-27."
---

# fx no Faberun: o que foi feito, como verificar e como integrar

Este documento é para quem não acompanhou o trabalho: a sessão `leave-home` e o
próprio Felipe. Ele explica por que o Faberun ganhou um harness novo, o que foi
construído, como conferir cada peça e o que falta para isso valer fora dos
testes. Os números vêm de medições feitas nesta máquina e estão datados.

## 1. O problema

O Faberun roda campanhas com vários workers em paralelo, cada um num worktree
próprio. O limite prático de uma campanha é quantos workers cabem na memória da
máquina, e o harness de cada worker era caro:

- `dsh --profile headless`, o harness DeepSeek que o Faberun usava, ocupava de
  310 a 370 MB por worker (medido em 2026-09-24 no fixture `parseDuration`) e de
  362 a 422 MB no benchmark de 2026-09-25.
- O ZCode, harness do GLM, passava de 1 GB por turno (medido de novo abaixo).
- O Codex CLI fica perto de 200 MB por turno, e o Claude Code perto de 300 MB (também abaixo).

Havia mais dois problemas que memória não resolve:

- **Contagem de cache.** O DeepSeek devolve quantos tokens de entrada vieram do
  cache, e o Faberun precisa disso para saber o custo real. Em 24 requisições
  medidas em 2026-09-24, 94,7% dos tokens de entrada eram cache, e o fx 0.0.11
  relatava todos como entrada comum.
- **Failover de cota.** Para trocar de provedor quando a cota acaba, o Faberun
  precisa ver o status HTTP (402 de saldo, 429 de limite). Os harnesses
  transformam esse erro em texto para o modelo ler, e o sinal se perde.

## 2. O que é o fx e o que é o relay

O [fx](https://github.com/vercel-labs/fx) é um agente de código da Vercel,
escrito em Zig e compilado para um binário nativo pequeno. Ele fala ACP (Agent
Client Protocol): um cliente abre o `fx acp`, conversa com ele por stdin e
stdout em JSON-RPC, manda o prompt e recebe cada chamada de ferramenta enquanto
ela acontece. O fx também pede permissão ao cliente antes de alterar um arquivo
ou rodar um comando, quando está no modo `ask`.

O Faberun não roda o fx direto. Ele roda um cliente próprio, o runner
(`src/harnesses/fx/`), que existe em duas versões com o mesmo comportamento: uma
nativa em Zig (`native/`, binário de 1,3 MB) e uma em Node (`runner.mjs`), usada
quando o binário nativo não foi compilado. O runner faz quatro coisas:

1. Cria um HOME descartável para o worker, com um `settings.json` que aponta o fx
   para o relay.
2. Sobe o **relay**: um servidor HTTP em `127.0.0.1`, numa porta efêmera, que
   fica entre o fx e o provedor. Ele repassa cada byte sem alterar e lê duas
   coisas no caminho de volta: o objeto `usage` (com os contadores de cache) e o
   status HTTP. É daí que saem a contagem de cache e o sinal de failover.
3. Responde aos pedidos de permissão do fx conforme o `sandbox` do contrato. Em
   `workspace-write`, recusa qualquer alteração de arquivo fora do worktree; em
   `read-only`, recusa todas. É a fronteira de efeito de arquivo.
4. Escreve a transcrição `fx.*` (uma linha JSON por evento) que o Faberun
   transforma no envelope do turno.

Cada worker tem o seu relay, então workers em paralelo nunca dividem o mesmo
medidor.

## 3. O que foi implementado

Tudo está no branch `feat/fx-harness` (13 commits sobre `59a9039`) e no branch
`fx-faberun` do fork `feliperun/fx`.

### Os runners e o modo GPT

Os dois runners falam com qualquer provedor compatível com Chat Completions da
OpenAI: é assim que rodam DeepSeek e GLM. O commit `8fc8809` acrescentou o modo
`--provider codex`, que usa o login do ChatGPT que o próprio fx já tem (`fx login
codex`). Nesse modo, o runner:

- escreve `provider: "codex"` no `settings.json` descartável;
- define `FX_AUTH_HOME` com o HOME real do operador (explicado abaixo);
- define `FX_E2E_OPENAI_CODEX_RESPONSES_URL` apontando para o relay. O fx aceita
  redirecionar o endpoint do Codex para um endereço de loopback, e é assim que o
  relay mede esse provedor como mede os outros.

Para o modo GPT funcionar, o relay mudou em três pontos:

- **Repassa todos os cabeçalhos da requisição**, e não só `authorization` e
  `accept`: o Codex exige `chatgpt-account-id` e `originator`.
- **Lê o uso no formato da Responses API** (`input_tokens`,
  `input_tokens_details.cached_tokens`).
- **Reconhece o stream sem `content-type`.** Medido em 2026-09-26: o endpoint do
  Codex manda SSE sem esse cabeçalho, e o relay passou a decidir pelos primeiros
  bytes da resposta.

### As três entradas de descoberta

Quando um contrato não declara runtimes, o Faberun usa o catálogo de descoberta
(`src/engine/runtime-discovery.mjs`). Ficaram três entradas de fx:

| Entrada | Modelo | Autenticação |
| --- | --- | --- |
| `fx-deepseek` | `deepseek-flash` | `DEEPSEEK_API_KEY` |
| `fx-glm` | `glm-5.3` | `ZAI_API_KEY` no endpoint do Coding Plan (`https://api.z.ai/api/coding/paas/v4`) |
| `fx-gpt` | `gpt-5.6-sol` | login do ChatGPT no fx (`config: {"provider": "codex"}`) |

Cada uma está declarada antes da rota antiga para o mesmo fornecedor (`dsh`,
`claude-glm`, `zcode-glm`, `codex-*`). O motivo é o desempate: dentro de um
mesmo tier, o Faberun escolhe a primeira entrada disponível na ordem de
declaração. Declarar o fx primeiro faz ele ganhar sempre que estiver disponível,
e as rotas antigas continuam como alternativa quando o fx não está.

O `fx-glm` usa o endpoint do plano por decisão do Felipe, sabendo que a política
de uso do plano da Z.ai lista Claude Code e ZCode entre as ferramentas
suportadas, mas não o fx, e prevê restrição e banimento da conta para uso
detectado fora da lista. A rota suportada pela Z.ai é o `claude-glm` (commit
`bd7b928`, Claude Code apontado para `https://api.z.ai/api/anthropic`). O
endpoint pago por uso é `https://api.z.ai/api/paas/v4`.

### `FX_AUTH_HOME`: por que o login do Codex não pode ser copiado

O worker roda num HOME descartável, e o login do ChatGPT mora em
`~/.fx/chatgpt-auth.json`, no HOME real. As saídas óbvias não funcionam:

- **Link simbólico:** o fx recusa (abre o arquivo sem seguir links).
- **Hard link:** também recusa (exige que o arquivo tenha um único link).
- **Cópia:** funciona até o primeiro refresh do token. O refresh troca a
  credencial, a cópia fica com a nova e o original fica com uma que o servidor
  já invalidou.

O patch `FX_AUTH_HOME` no fork diz ao fx onde ficam as credenciais,
separado do `HOME`. O worker continua com o HOME descartável para settings e
skills, e lê e renova o login no arquivo real, usando a trava de concorrência que
o fx já tem para vários processos. Sem a variável, o fx se comporta como o
oficial. O fx oficial, sem o patch, responde "fx needs a Codex subscription
login" nesse arranjo.

### O HOME descartável e o vazamento de skills

O fx carrega skills de `~/.fx`, `~/.claude`, `~/.codex`, `~/.agents` e
`~/.config/opencode`. Um worker do Faberun recebe um pacote de tarefa fechado e
não deve ver as skills pessoais do operador, e o HOME descartável resolve essas
cinco pastas.

Faltava uma sexta fonte. O fx também sobe as pastas a partir do workspace
procurando `skills/`, `.claude/skills` e outras, e só para quando chega no HOME.
Com o HOME descartável, o worktree nunca está abaixo dele, então o fx subia até
`/` e achava `~/skills` e `~/.codex/skills` no caminho. Medido em 2026-09-25 numa
execução real do Faberun: com o fx oficial, duas skills pessoais chegaram ao
DeepSeek 10 vezes cada em 6 requisições; com o fx-faberun, nenhuma vez em 9. Num `fx
ask` direto, a primeira requisição caiu de 40.066 para 25.014 bytes.

A correção está no fork: quando o HOME não está acima do workspace, a subida
para na raiz do repositório (a pasta com `.git`), que para um worker é o
worktree. Foi proposta upstream como
[vercel-labs/fx#1045](https://github.com/vercel-labs/fx/pull/1045). Uma
limitação: fora de um repositório git, a subida ainda vai até o HOME real. No
Faberun isso não acontece, porque o worker sempre roda num worktree.

### O fx-faberun

É o fx oficial com uma fila curta de patches no branch `fx-faberun` do fork
`feliperun/fx`:

| Patch | Upstream |
| --- | --- |
| Contadores de cache nos provedores Chat Completions | [#1043](https://github.com/vercel-labs/fx/pull/1043), aberto |
| Subida de skills para na raiz do repositório | [#1045](https://github.com/vercel-labs/fx/pull/1045), aberto |
| Build fx-faberun não se atualiza sozinho para o canal oficial | só no fork |
| `FX_AUTH_HOME` | só no fork |

Um vigia (`fx-faberun/watch.sh`, agendado a cada 6 horas pelo launchd nesta
máquina) rebaseia a fila sobre o upstream, compila, roda os testes e envia o
branch para o fork. Quando um PR upstream é aceito, o patch correspondente some
sozinho no rebase seguinte. As versões seguem `X.Y.Z-faberun.N` (hoje
`0.0.11-faberun.N`), e releases só são criados como rascunho: publicar é decisão
do dono.

## 4. Como verificar

Os comandos abaixo partem do worktree `~/dev/frb/faberun-fx`, no branch
`feat/fx-harness`.

Compilar o runner nativo e rodar os testes dele (parser de uso, relay):

```sh
cd src/harnesses/fx/native
zig build
zig build test --summary all
```

Rodar os testes do harness fx, que incluem o teste ponta a ponta dos dois
runners (DeepSeek e modo codex) contra um fx falso e um provedor falso:

```sh
cd ~/dev/frb/faberun-fx
node --test test/harnesses/fx.test.mjs
```

Rodar a suíte inteira e o typecheck:

```sh
npm test
npm run typecheck
```

Rodar um turno real e ler a transcrição. Cada linha `fx.request` é uma
requisição que passou pelo relay, com o status HTTP e o uso lido da resposta;
`cacheReadInputTokens` é a parte da entrada que veio do cache:

```sh
cd <um repositório git qualquer>
echo 'Leia o README e resuma em uma frase.' | \
  ~/dev/frb/faberun-fx/src/harnesses/fx/native/zig-out/bin/faberun-fx-runner \
  --fx ~/.local/share/fx-faberun/fx/zig-out/fx-faberun-dist/fx-macos-aarch64/bin/fx \
  --model deepseek-flash --sandbox read-only
```

Para GLM, acrescente `--model glm-5.3 --base-url
https://api.z.ai/api/coding/paas/v4 --key-env ZAI_API_KEY --context-window
200000`. Para GPT, `--provider codex --model gpt-5.6-sol` (exige o fx-faberun com
`FX_AUTH_HOME` e `fx login codex` feito uma vez).

Conferir um contrato inteiro sem gastar um turno de trabalho: o preflight manda
um "olá" a cada runtime e mostra o uso e o cache que o relay leu:

```sh
node ~/dev/frb/faberun-fx/bin/faberun.mjs preflight <contrato.json>
```

## 5. O que foi medido

### A medição antiga (DeepSeek, 2026-09-24)

| Cliente | Pico do cliente | Pico do `fx acp` | Total do worker |
| --- | ---: | ---: | ---: |
| runner nativo (Zig), três turnos | 15-16 MB | 9 MB | ~25 MB |
| `runner.mjs` (Node), um turno | 83 MB | 9 MB | ~92 MB |
| `dsh --profile headless`, três turnos | n/a | n/a | 310-370 MB |

### A medição nova (GPT e GLM, 2026-09-27)

A pergunta era quanto de memória cada modelo gasta no CLI nativo e no fx,
fazendo o mesmo trabalho.

| Modelo | Rota | Agente: menor / mediana / maior | Árvore inteira: menor / mediana / maior | Tempo (mediana) |
| --- | --- | ---: | ---: | ---: |
| `gpt-5.6-sol` | Codex CLI nativo (`codex`) | 197 / 199 / 200 MB | 319 / 381 / 382 MB | 39,2 s |
| `gpt-5.6-sol` | `fx-gpt` | 37 / 37 / 38 MB | 48 / 104 / 173 MB | 36,7 s |
| `glm-5.3` | `claude-glm` (Claude Code na Z.ai) | 304 / 306 / 313 MB | 312 / 390 / 448 MB | 70,5 s |
| `glm-5.3` | `fx-glm` | 22 / 22 / 23 MB | 84 / 100 / 165 MB | 32,5 s |
| `glm-5.3` | `zcode-glm` (referência) | 1.045 / 1.054 / 1.066 MB | 1.045 / 1.066 / 1.126 MB | 38,7 s |

Todas as 15 execuções terminaram com código 0, com a suíte do exercício passando
e só `src/parse-duration.mjs` alterado.

A coluna "Agente" soma o harness: no fx, o runner e o `fx acp` (o runner ficou
em 13-14 MB em todas; o `fx acp` em 24 MB com GPT e 9 MB com GLM); nas outras
rotas, o processo do CLI. A coluna "Árvore inteira" soma também o que o agente
executou (shell, `npm test`, `node --test`). Essa parte varia com o que o modelo
decide rodar e não com o harness, por isso a comparação entre harnesses deve ser
feita na coluna "Agente".

Para a rota A do GLM, escolhi o `claude-glm`: é a rota suportada pela política da
Z.ai e era a preferida da descoberta até o `fx-glm` entrar. O `zcode-glm` entrou
como referência porque é o harness que o Faberun usava antes, e o que o `main`
remoto ainda declara (com `glm-5.3-flash`, veja a seção 7).

### Leitura dos números

Pela coluna "Agente", o fx gasta cerca de um quinto da memória do Codex CLI com o
mesmo modelo GPT, e cerca de um catorze avos da do Claude Code com o mesmo GLM.
Contra o ZCode, a diferença passa de 45 vezes.

Em workers por GB de memória, só o agente (sem controlador e sem o que o agente
executa): cerca de 5 com o Codex CLI e 27 com o `fx-gpt`; cerca de 3 com o
`claude-glm`, 46 com o `fx-glm` e menos de 1 com o ZCode. Na prática, o que
passa a limitar uma campanha com fx é o controlador do Faberun (166 a 191 MB por
run nas campanhas tiny-text) e os testes que os workers rodam, não o harness.

O tempo não mudou de forma consistente entre as rotas GPT. O `claude-glm` foi a
rota GLM mais lenta (50 a 75 s, contra 31 a 41 s do `fx-glm`).

Uma verificação a mais, fora da tabela por ser uma execução só: o
`glm-5.3-flash` no `fx-glm` também completou o exercício (suíte passando, 24 MB no
agente), mas levou 109 s.

### Método

- **Fixture:** `~/fx-provider-benchmark/seed` (`parseDuration`), o mesmo da
  medição antiga. Cada execução recebe uma cópia nova do fixture num repositório
  git novo.
- **Prompt:** o mesmo texto para todas as rotas
  (`~/fx-provider-benchmark/mem-bench/prompt.txt`), tirado do pacote de tarefa do
  contrato `parseDuration`. Um turno por execução.
- **Comando:** o de cada rota vem do próprio `providerCommand` do Faberun
  (`mem-bench/command.mjs`), com os mesmos flags e variáveis de ambiente que o
  Faberun usaria. Sandbox `workspace-write` no fx e no Codex;
  `bypassPermissions` no Claude Code; `yolo` no ZCode (os modos que executam
  comandos em cada harness).
- **Amostragem:** `mem-bench/bench.py` roda `ps -axo pid=,ppid=,rss=,command=` a
  cada 200 ms, percorre a árvore de processos a partir do processo lançado, soma o
  RSS de todos os descendentes e guarda o pico. Cada processo é classificado pela
  linha de comando (runner, fx, codex, claude, zcode, ou ferramenta).
- **Execuções:** três rodadas, cada uma passando pelas cinco rotas intercaladas,
  entre 2026-09-27T10:58:02Z e 11:09:20Z. Resultados brutos em
  `mem-bench/results.jsonl`.
- **Versões:** fx `0.0.11-faberun.2` (build local do fork no commit `169374a5`);
  runner nativo compilado da árvore que virou o commit `8fc8809`; `codex-cli
  0.156.1`; Claude Code 2.1.283; ZCode 0.16.5; Node v26.8.1.
- **Máquina:** Apple M1 Pro, 16 GiB, macOS 26.0.1. Nenhuma campanha rodando, mas
  com sessões interativas abertas (Claude Code, o daemon dele, o painel do
  Faberun). A carga média ficou entre 3 e 6 e chegou a 10 depois da terceira
  execução do `fx-glm`, com `mediaanalysisd` e um `gh run list` de outra sessão no
  topo do uso de CPU.
- **Um ajuste no ambiente:** o terminal desta sessão (Orca) define `CODEX_HOME`
  apontando para um perfil sem login, e o Codex CLI falhava com 401. As execuções
  do Codex rodaram com `CODEX_HOME` removido, usando o `~/.codex` logado no
  ChatGPT. Um Faberun lançado do mesmo terminal herdaria o mesmo problema.

## 6. Estado e pendências

- **O fx instalado é o oficial.** `~/.local/bin/fx` é o 0.0.11 da Vercel, sem
  nenhum patch. As medições usaram o build local em
  `~/.local/share/fx-faberun/fx/zig-out/fx-faberun-dist/`, apontado por
  `FABERUN_FX_BIN`.
- **O patch `FX_AUTH_HOME` já está no GitHub.** O vigia rebaseou o branch
  `fx-faberun` sobre o upstream e o enviou para `feliperun/fx` em 2026-09-26
  (commit atual `b41f984d`). Isso é o que o vigia faz por projeto; nenhum release
  foi criado com o patch.
- **Releases:** existe um rascunho `v0.0.11-faberun.1` no GitHub, sem o patch
  `FX_AUTH_HOME`. O `0.0.11-faberun.2` existe só como build local, não como
  rascunho.
- **O branch `feat/fx-harness` não foi enviado.** Ele vive no worktree
  `~/dev/frb/faberun-fx` e está 7 commits atrás do `main` remoto (release 0.25.1).
- **O Faberun instalado roda do `main`** e não conhece nada deste trabalho.
- **O `~/.faberun/config.json` ainda aponta** worker `dsh-deepseek` e juiz
  `claude-sonnet`, com os harnesses `dsh`, `agy`, `zcode` e `claude` (sem `fx`).
- **O runner nativo não é distribuído.** O `install.sh` instala o fx-faberun, mas
  não compila nem baixa o runner em Zig. Sem ele, o adaptador cai no
  `runner.mjs`, que pesa cerca de 83 MB a mais por worker.
- **O vigia divide o clone com quem edita o fork.** O log dele mostra uma passada
  que falhou com "cannot rebase: You have unstaged changes", no momento em que o
  patch estava sendo editado no mesmo clone.

Para isso valer fora dos testes, falta, nesta ordem: publicar um release do
fx-faberun que contenha o `FX_AUTH_HOME`; fazer o merge do `feat/fx-harness` no
`main`; reinstalar o Faberun (o `install.sh` instala o fx-faberun junto);
resolver a distribuição do runner nativo; e rodar `faberun setup` para trocar os
padrões de worker e juiz.

## 7. O que a `leave-home` precisa fazer para integrar

O trabalho está no branch `feat/fx-harness` do repositório do Faberun (worktree
`~/dev/frb/faberun-fx`), linear sobre `59a9039`. As peças e o que cada uma
exige:

| Peça | Commits | Depende de |
| --- | --- | --- |
| Transcrição compartilhada entre runners | `3257fd2` | nada |
| Harness fx com DeepSeek, relay e runner Zig | `4879033`, `8ef8122`, `dd1cc54` | `3257fd2`; um binário fx (o oficial funciona, mas vaza skills) |
| Documentação do vazamento de skills e do fx-faberun | `044d1db`, `f434e30`, `7b82287`, `a46cb80` | nada no código |
| `install.sh` instala o fx-faberun | `87b1f35`, `1b1a010` | um release publicado do fx-faberun |
| Claude Code em endpoint próprio (`claude-glm`) | `bd7b928`, `4a311c3` | nada do fx; independente |
| GLM e GPT no fx | `8fc8809` | o harness fx; a parte GPT exige um fx-faberun com `FX_AUTH_HOME` (build `.2` ou posterior) |

Ordem sugerida:

1. Rebasear `feat/fx-harness` sobre o `main` atual. Há um conflito, em
   `src/engine/runtime-discovery.mjs`: o `main` trocou o `zcode-glm` para
   `glm-5.3-flash` (commit `5facc9e`, pelo canário de juízes: 0,85 contra 0,79 de
   acerto, a cerca de um nono do preço), e este branch acrescentou `fx-glm` e
   `claude-glm` com `glm-5.3` ao redor da mesma entrada. A decisão de modelo é da
   `leave-home`: se o flash for o padrão de GLM, o `fx-glm` e o `claude-glm`
   devem acompanhar. O `glm-5.3-flash` funcionou no fx na verificação acima. O
   `glm-4.7-flash` não funciona como worker no fx (manda o argumento da
   ferramenta de shell como texto, e o fx recusa).
2. Integrar o branch. O merge com `docs/leaving-home-program` sai sem conflitos.
3. O dono publica um release do fx-faberun com o `FX_AUTH_HOME`. Até lá, o modo
   GPT só funciona com `FABERUN_FX_BIN` apontando para um build local.
4. Reinstalar o Faberun e rodar `faberun setup` com os novos padrões.
5. Decidir como distribuir o runner nativo (release com binários ou compilação no
   `install.sh`).

A peça do `claude-glm` pode ser integrada sozinha, antes de tudo, se a
`leave-home` quiser o juiz GLM suportado pela Z.ai sem depender do fx.
