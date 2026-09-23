---
id: friends-pilot
title: "Três pessoas de fora fecham uma campanha real e o que elas viveram vira dado"
version: 1.0.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: 748d7ba
derived_from: safe-to-hand-to-a-friend
---

# Três pessoas de fora fecham uma campanha real e o que elas viveram vira dado

## Intenção

Última campanha do programa `leaving-home`. As três anteriores tornaram os
números recomputáveis, mediram o juiz e o benchmark com banda, e deixaram a
ferramenta segura e legível para um estranho. Esta põe a ferramenta na mão de
três a cinco pessoas próximas que já usam agentes de código (RM-036) e
transforma o que elas viverem em dado versionado, sem transformar os
repositórios delas em dado.

O sinal que interessa está escrito no próprio roadmap: "the signal is
spontaneous reuse, not 'nice'". Um amigo dizer que achou legal não prova nada.
Um amigo rodar uma segunda campanha sem ninguém pedir prova.

Duas coisas precisam existir para isso funcionar sem virar conversa de
WhatsApp que se perde.

**Um jeito de o amigo mandar o que aconteceu sem mandar o código dele.** O
ledger de uma campanha carrega caminhos de arquivo, textos de requisito, notas
do operador e nomes de repositório. Isso não sai da máquina de ninguém. O que
sai é um pacote exportado, minimizado e redigido, que o próprio amigo lê antes
de enviar. Minimização, finalidade declarada e consentimento explícito, do
jeito que a LGPD pede e do jeito que o dono deste repositório trabalha há 19
anos com software regulado.

**Um jeito de o atrito virar item do roadmap.** Hoje o journal aceita
`decision`, `open-question`, `constraint`, `outcome` e outros tipos
(`src/campaign/journal.mjs:22`), e não tem um tipo para "isso me travou". Sem
isso, o atrito do piloto fica na memória de quem ouviu, e a regra do roadmap
("the ideas this repository generates were being lost") se repete.

Esta campanha termina com uma decisão registrada: divulgar ou não, com base no
que o piloto mediu.

## Estado medido

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Pessoas de fora que fecharam uma campanha nos próprios repositórios | 0 | 3 ou mais |
| Stars no GitHub, em 22/09 | 2 | não é alvo |
| Forks | 0 | não é alvo |
| Tipo de journal para atrito | não existe (16 tipos em `JOURNAL_TYPES`, nenhum de atrito) | `friction` |
| Exportação redigida de campanha | não existe | `faberun campaign export --redacted` |
| Agregação de resultados de piloto | não existe | classe `pilot` em `evals/` |
| Atritos de piloto com id no roadmap | não se aplica | todos |

Peças existentes que o trabalho reusa: o journal e seus tipos, os indicadores
de `faberun metrics` (incluindo `intentToVerifiedSeconds`, `humanTouches`,
`judgeFindingRate` e a fração de custo desconhecido por motivo, das campanhas
anteriores), `redactSecrets`, o scan de segredos do pre-commit, `faberun
doctor --env` e `faberun uninstall` da campanha `safe-to-hand-to-a-friend`, e o
formato de ids do `docs/ROADMAP.md`.

## Requisitos

### R1. O protocolo do piloto está escrito antes do primeiro convite

- **statement:** `docs/PILOT.md` diz, em linguagem de quem não conhece o
  projeto: para quem é (quem já usa agente de código no dia a dia), o que se
  pede (uma campanha real no próprio repositório, com teto sugerido de US$ 10 e
  writers baratos como padrão), como instalar, como conferir o que o worker
  enxerga (`faberun doctor --env`), o que não está protegido (sem sandbox; o
  worker roda comandos com o usuário dele, dentro da lista de ambiente
  permitida), o que é coletado (só o pacote de R2, lido por ele antes de
  enviar), como enviar, como pedir ajuda, e como sair (`faberun uninstall`).
- **proof:** `command: node --test --test-name-pattern="the pilot protocol names what is collected, what is unprotected and how to leave"`
- **constraints:** o teste confere a presença de cada seção pelo título, não o
  texto. O texto é revisado pelo dono.

### R2. A exportação redigida não carrega caminho, prompt nem segredo

- **statement:** `faberun campaign export <campaign-id> --redacted --out
  <arquivo>` escreve um JSON com apenas: a versão do formato, os indicadores da
  campanha, e por nó o `taskKind`, o `riskTier`, harness e modelo, tentativas,
  revisões, desfecho, durações, tokens, custo com proveniência, contagem de
  provas aprovadas e reprovadas, e o estado de cada requisito (só o id). Traz
  também as entradas `friction` do journal. Caminhos de arquivo viram
  contagens, o nome e o remote do repositório viram um hash com sal local, e
  prompts, diffs, textos de spec, saídas de worker e valores de ambiente nunca
  entram. O comando imprime o conteúdo inteiro e só grava com `--yes`.
- **proof:** `command: node --test --test-name-pattern="a redacted export carries no path, prompt or secret"`
- **constraints:** o teste planta, numa campanha de fixture, um segredo no
  ambiente, um caminho absoluto num evento, um texto de requisito e uma nota
  com e-mail, e falha se qualquer um aparecer no pacote.

### R3. Atrito é um comando só

- **statement:** `faberun campaign note <campaign-id> --kind friction --text
  "<texto>"` grava uma entrada `friction` no journal, com data e, quando houver,
  a run e o nó em andamento. Diferente de `decision` ou `outcome`, `friction`
  não exige sessão anexada (fica fora de `SESSION_REQUIRED_TYPES`) e é aceita
  também em campanha fechada, porque o atrito muitas vezes aparece depois.
  `faberun campaign show` lista os atritos da campanha. O limite de tamanho do
  journal continua recusando em vez de cortar.
- **proof:** `command: node --test --test-name-pattern="a friction note is recorded with the run and node it happened in"`

### R4. Os pacotes do piloto se agregam numa tabela determinística

- **statement:** `node evals/run.mjs --class pilot <pacote>...` produz, por
  participante (identificado pelo hash) e no total, a North Star, o custo por
  checkpoint fechado, `humanTouches`, planos contestados, recusas por contexto,
  a fração de custo desconhecido e a contagem de atritos. A saída em
  `docs/pilot/<coorte>/summary.md` é idêntica para a mesma entrada, e um pacote
  de formato desconhecido é recusado com o nome do arquivo.
- **proof:** `command: node --test --test-name-pattern="pilot bundles aggregate into one deterministic table"`

### R5. Todo atrito vira uma linha do roadmap

- **statement:** `docs/pilot/<coorte>/frictions.md` tem uma linha por atrito
  recebido, e cada linha cita um id `RM-###` que existe em `docs/ROADMAP.md`,
  em qualquer estado, inclusive `dropped` com o motivo. Um ratchet falha a
  suíte se uma linha ficar sem id ou citar um id inexistente.
- **proof:** `command: node --test --test-name-pattern="every pilot friction has a roadmap id"`

### R6. O piloto acontece

- **statement:** pelo menos três pessoas de fora do repositório fecham pelo
  menos uma campanha cada, num repositório delas, com o pacote de R2 versionado
  em `docs/pilot/<coorte>/`. Pelo menos uma roda uma segunda campanha, sem ter
  sido pedida, em até 14 dias depois da primeira. Todo atrito recebido passa
  por R5.
- **proof:** `judgment: true`

### R7. A decisão de divulgar é registrada com o que o piloto mediu

- **statement:** `docs/ROADMAP.md` recebe uma decisão (D8) que diz divulgar ou
  não divulgar, citando: o critério de sucesso das três campanhas anteriores, o
  resultado de R6, a decisão D7 sobre o juiz, a tabela de R4 e os itens P0 ainda
  abertos. Se a decisão for não divulgar, ela nomeia o que falta e o próximo
  piloto.
- **proof:** `judgment: true`

## Não-objetivos

- Telemetria, envio automático ou qualquer dado que saia da máquina do
  participante sem ele rodar `export --yes` e mandar o arquivo.
- Lançamento público, post, landing page, vídeo ou mudança de tagline. Isso é
  o que vem depois da D8.
- Suporte a participante sem experiência com agentes de código.
- Pagar custo de provedor de participante.
- Corrigir durante o piloto tudo que o piloto achar. O piloto gera itens do
  roadmap; corrigir é outra spec, exceto defeito que impeça o participante de
  continuar ou que exponha dado dele.

## Restrições

- O piloto só começa com as três campanhas anteriores fechadas e com seus
  critérios de sucesso atingidos, ou com a exceção registrada no journal.
- Nenhum repositório de participante, nenhum trecho de código dele e nenhum
  nome de empresa entra neste repositório. Só o pacote redigido que o próprio
  participante gerou e aceitou enviar.
- Nada de repositório privado ou de empregador entra aqui, regra que o
  repositório já tem.
- O orçamento de bytes da skill continua valendo.

## Critério de sucesso

| Indicador | Baseline | Alvo |
| --- | --- | --- |
| Participantes externos com campanha fechada | 0 | 3 ou mais |
| Participantes com segunda campanha espontânea em 14 dias | 0 | 1 ou mais |
| Atritos com id no roadmap | não se aplica | 100% |
| Vazamentos de dado de participante encontrados em pacote | não se aplica | 0 |
| Decisão de divulgação registrada | não | D8 |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Os amigos são gentis demais e o sinal vira "ficou legal" | falso positivo | o critério é comportamento (segunda campanha sem pedido), não opinião |
| Um participante trava no primeiro dia e desiste calado | o atrito mais importante se perde | `docs/PILOT.md` pede o pacote mesmo de campanha abandonada, e R2 exporta campanha não fechada |
| O worker faz algo destrutivo no repositório de um amigo | dano real e fim da confiança | worktrees isoladas, lista de ambiente permitida, `doctor --env` antes do primeiro run, e o protocolo recomenda um repositório com remote e sem deploy automático |
| O custo surpreende o participante | abandono | teto sugerido, writers baratos como padrão no protocolo, e `faberun metrics` durante a campanha |
| O hash do repositório identifica o participante | exposição | sal local por máquina, nunca enviado |
