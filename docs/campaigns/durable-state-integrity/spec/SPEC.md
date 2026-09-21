---
id: durable-state-integrity
title: "O estado durável é completo, alcançável e reparável"
version: 1.0.0
status: draft
date: 2026-09-21
owner: Felipe Broering
target: feliperun/faberun
baseline: 4837e0a
---

# O estado durável é completo, alcançável e reparável

## Intenção

Seis defeitos achados por uso, não por leitura, durante a campanha
`state-location-and-routing-economics`. Nenhum é de funcionalidade ausente:
todos são do estado que o produto já guarda. Ele descarta em silêncio, órfã o
que preserva, escreve na home de quem só rodou os testes, e não sabe reparar um
registro escrito por uma versão anterior de si mesmo.

**O que o cancelamento órfã.** `cancel` apaga o ref da run e todo branch de
tentativa, e o comentário que justifica isso argumenta que o sha sobrevive no
snapshot do nó. Sobrevive a *string*; o *commit* não. Nada em `src/` cria ref
para `integratedHead`, então trabalho já integrado por um nó fica sem nenhuma
referência apontando pra ele, à mercê do próximo `git gc`. Isso aconteceu de
verdade em 2026-09-21: o trabalho integrado de R17 e o branch de tentativa de
R18 só foram recuperados porque os shas foram lidos do snapshot e tagueados à
mão antes da poda.

**O que a suíte escreve na home de quem a roda.** `test/helpers.mjs` já aponta
`FABERUN_HOME` para um diretório descartável, e o comentário em cima explica
exatamente por quê. O mecanismo é opt-in: 54 dos 135 arquivos de teste não
resolvem o helper da raiz nem declaram `FABERUN_HOME` por conta própria, e
rodar um deles grava um registro permanente em `~/.faberun/projects` do
operador.

O argumento mais forte não é a contagem, é o histórico. Este vazamento já foi
consertado **duas vezes, um arquivo por vez**, e cada conserto deixou o
próximo arquivo vazando. Medido em 2026-09-21 sobre os 392 registros
acumulados, por origem e por dia: em 19/09 as fixtures de eval gravaram 222
registros e `test/integrations/statusline.test.mjs` gravou 72; as primeiras
pararam quando `evals/case.mjs` ganhou `withScopedFaberunHome`, o segundo
parou quando `e85a9e6` lhe deu um `FABERUN_HOME` próprio. Nenhum dos dois
gravou nada depois disso. Sobrou `test/contract/derived-fields.test.mjs`, que
nunca recebeu nem um nem outro e segue gravando um registro por execução: 27
em 19/09, 29 em 20/09, 36 em 21/09.

Uma convenção aplicada arquivo a arquivo é exatamente o que vem falhando
aqui. A regra certa já existe, escrita e comentada — falta ela valer para a
suíte inteira de uma vez e virar ratchet que mede o **efeito** sobre a home,
não a presença de um import.

**O que o journal descarta calado.** `campaign note` corta qualquer nota em 2048
bytes (`JOURNAL_TEXT_BYTES`), anexa reticências e devolve sucesso. Duas
tentativas de gravar a fila desta campanha foram cortadas sem diagnóstico algum,
e é por isso que `proposals/queue.md` existe como arquivo solto em vez de estar
no journal. Uma camada de registro durável que aceita e joga fora é pior que uma
que recusa.

**O que um portão determinístico certifica sem medir.** Uma prova de DoD por
comando que usa `--test-name-pattern` passa quando o padrão não casa com nada,
e nada na saída denuncia isso. Medido em 2026-09-21 contra a árvore integrada
da fase 1: um padrão inexistente imprime um tique para o *arquivo*, reporta
`tests 1 pass 1 fail 0` e sai com `0` — idêntico em forma a um padrão que casa
de verdade. Aconteceu nesta campanha: três dos seis itens de DoD da fase 1
nomeavam padrões que nenhum teste carregava, e o portão reportou que todo item
determinístico passou. O trabalho estava certo por sorte; a certificação não
mediu metade do que dizia medir.

**O que o bloco de sinal atribui à campanha errada.** `src/repo/signal.mjs:144`
seleciona uma entrada de inbox quando `entry.campaignId === campaign.id` **ou**
`entry.campaignId === null`. Todas as 12 entradas de atenção do inbox carregam
`null`, então uma atenção órfã é atribuída a toda campanha ao mesmo tempo, para
sempre. Medido em 2026-09-21: o `AGENTS.md` anunciava, sob esta campanha criada
minutos antes, uma atenção de uma run da `harden-chain-and-verification`,
fechada em 17/09. O `AGENTS.md` é a primeira coisa que qualquer agente lê, e o
bloco existe justamente para dizer o que continuar.

**O que a migração não cura.** `faberun campaign list` reporta
`run-harness-audit-20260818 · corrupt · campaign.status must be active or
closed`. O `campaign.json` foi escrito em 2026-08-18, antes do campo `status`
existir. `migrate` não toca em registro de campanha, então o registro fica
permanentemente ilegível e não há verbo que o conserte. Quatro diretórios
`controller-snapshots` read-only também continuam bloqueando a limpeza.

## Estado medido

`4837e0a`, macOS, `~/.faberun` do operador com 389 projetos registrados.

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Refs apontando para `integratedHead` após `cancel` | 0 | 1 por nó integrado |
| Arquivos de teste que escopam a home | 81 de 135 | 135, pelo runner |
| Registros gravados em `~/.faberun` por uma execução dos 54 não escopados | 1 | 0 |
| Registros vazados em `~/.faberun/projects` | 392, dos quais 92 por `derived-fields.test.mjs` | 1, o próprio repositório |
| Vezes que este vazamento foi consertado arquivo a arquivo | 2, e um arquivo segue vazando | 0, a regra passa a ser do runner |
| Diagnóstico ao gravar nota acima do teto | nenhum | recusa nomeando o excesso |
| Registros de campanha ilegíveis por `campaign list` | 1 | 0 |
| Diretórios `controller-snapshots` bloqueando limpeza | 4 | 0 |

Peças existentes que o trabalho reusa em vez de reimplementar: o comentário e o
`mkdtempSync` de `test/helpers.mjs`, o ratchet de `test/repo/source-shape.test.mjs`,
`boundedText` em `src/util.mjs`, o comando `migrate` e seu contrato de
idempotência, `deleteRef`/`runRefName` em `src/repo/worktree.mjs`, e o campo
`integratedHead` que já existe no snapshot do nó.

## Requisitos

### R1. Cancelar uma run não torna trabalho integrado inalcançável

- **statement:** ao liberar o ref da run e os branches de tentativa, `cancel`
  cria antes uma referência durável para cada `integratedHead` não nulo dos nós
  daquela run; um `git gc --prune=now` depois do cancelamento não remove nenhum
  commit que um nó tenha integrado.
- **proof:** `command: node --test --test-name-pattern="cancel keeps integrated work reachable"`

### R2. Um cancelamento diz o que preservou

- **statement:** a saída de `cancel` nomeia cada referência que criou e cada
  artefato que liberou, de forma que o operador saiba onde procurar sem ler
  snapshot de nó; o mesmo cancelamento rodado duas vezes não cria referência
  duplicada nem falha.
- **proof:** `command: node --test --test-name-pattern="cancel reports what it preserved"`

### R3. Rodar a suíte não escreve na home do operador

- **statement:** a home de teste é escopada pelo runner, não por import: a suíte
  inteira resolve `FABERUN_HOME` para um diretório descartável, e um `npm test`
  completo deixa `~/.faberun` sem nenhum arquivo novo, alterado ou removido.
- **proof:** `command: node --test --test-name-pattern="a suite run leaves the operator home untouched"`

### R4. A regra de R3 é ratchet, não convenção

- **statement:** um arquivo de teste novo não consegue reintroduzir o vazamento;
  a regra vive junto das outras deste repositório e falha `npm test` quando
  violada, medindo o efeito e não a presença de um import.
- **proof:** `command: node --test --test-name-pattern="no test file can write to the real faberun home"`

### R5. Nota que não cabe é recusada, não encurtada em silêncio

- **statement:** gravar uma entrada de journal acima do teto falha nomeando o
  teto e o tamanho recebido, em vez de truncar e reportar sucesso; o teto
  continua sendo o mesmo valor, e a leitura de entradas já truncadas segue
  funcionando.
- **proof:** `command: node --test --test-name-pattern="a journal note that does not fit is refused"`

### R6. Registro de campanha de versão anterior é reparado

- **statement:** `migrate` cura registro de campanha escrito antes de um campo
  existir, aplicando o mesmo default que a escrita atual aplicaria, e reporta o
  que curou; depois dele nenhum registro é reportado `corrupt` por campo
  ausente; um registro corrompido por outro motivo continua sendo reportado.
- **proof:** `command: node --test --test-name-pattern="migrate heals a campaign record written before a field existed"`

### R7. A limpeza não trava em diretório read-only que ela mesma criou

- **statement:** `migrate` e o expurgo concluem contra diretório
  `controller-snapshots` sem permissão de escrita, restaurando permissão ou
  reportando em uma linha o que precisa de intervenção, em vez de abortar a
  passagem inteira.
- **proof:** `command: node --test --test-name-pattern="cleanup finishes against a read-only snapshot directory"`

### R8. Prova que não rodou teste nenhum não é prova

- **statement:** um comando de verificação ou de prova de DoD que restringe
  quais testes rodam e não casa com nenhum é recusado em vez de aprovado; o
  resultado nomeia o filtro e diz que ele não selecionou teste algum.
- **proof:** `command: node --test --test-name-pattern="a proof that selected no test is refused"`

### R9. Atenção sem campanha aparece em nenhuma, não em todas

- **statement:** uma entrada de atenção que não pode ser atribuída a uma
  campanha não é exibida sob todas elas; a atribuição sai do identificador de
  run que a entrada já carrega, e o que continuar sem dono é exibido fora de
  qualquer campanha.
- **proof:** `command: node --test --test-name-pattern="an unattributable attention belongs to no campaign"`

## Não-objetivos

- Não mudar o teto de 2048 bytes do journal. O defeito é o descarte silencioso,
  não o valor.
- Não fazer `cancel` preservar o worktree de tentativa. Worktree é descartável;
  commit integrado não é.
- Não apagar os 389 registros vazados como parte de um requisito. A limpeza é um
  comando que o operador roda, e ele já existe; o requisito é parar de produzir
  novos.
- Não introduzir versionamento de schema de campanha. R6 repara ausência de
  campo com o default vigente, não migra entre versões declaradas.
- Não mexer em `docs/history/`, em campanha já registrada sob `docs/campaigns/`,
  nem em `evals/golden/`.

## Restrições

- `CONTRACT_VERSION` permanece `0.3.0`. Nenhum requisito acrescenta campo ao
  contrato.
- Campo novo persistido em snapshot, identidade ou `run.json` obriga o validador
  e o typedef no mesmo packet.
- Nenhum arquivo `.mjs` passa de 800 linhas; subir o teto não é conserto.
- `npm run typecheck` limpo; `noUnusedLocals` continua ligado.
- Nenhum teste limita duração medida por cima, e nenhum depende de binário no
  PATH ou de layout de máquina.
- Toda verificação tem duração medida antes de ter tempo limite declarado, e
  prova de DoD por comando é limitada a 120s pelo scheduler.
- Um contrato por fase, com todos os nós e arestas autorados num turno só.
- R1 e R2 pousam juntos; R3 pousa antes de R4, que o mede.

## Critério de sucesso

| Métrica | Baseline | Alvo | Fonte |
| --- | --- | --- | --- |
| Commits integrados perdidos por cancelamento | recuperados à mão em 2026-09-21 | 0, sem intervenção | testes |
| Passos manuais para achar trabalho de run cancelada | 4 | 0 | saída de `cancel` |
| Registros escritos em `~/.faberun` por `npm test` | 1 por execução, 36 em 21/09 | 0 | testes |
| Arquivos de teste que podem vazar | 54 | 0 | ratchet |
| Notas de journal truncadas sem aviso | 2 nesta campanha | 0 | testes |
| Registros de campanha reportados `corrupt` | 1 | 0 | `campaign list` |
| Diretórios bloqueando limpeza | 4 | 0 | `migrate` |

Se R1 mostrar que nenhum `integratedHead` sobrevive a um cancelamento sem ref
porque o objeto já é alcançável por outro caminho, o desfecho correto é registrar
a medição e reduzir R1 a um teste que prove a alcançabilidade, sem criar ref
nova.

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| A ref de preservação vira lixo que ninguém poda | médio | R2 a nomeia na saída; o expurgo existente já é opt-in e reporta antes de remover |
| Escopar a home pelo runner quebra teste que depende da home real | médio | R3 pousa antes de R4; o helper que já faz isso para 67 arquivos é a prova de que o padrão funciona |
| O ratchet de R4 mede import em vez de efeito, e um teste novo escapa | alto | R4 exige medir o efeito sobre a home, não a presença do import |
| Recusar nota grande quebra chamador que hoje depende do truncamento | médio | R5 mantém a leitura de entradas já truncadas e o mesmo teto; só o caminho de escrita muda |
| O reparo de R6 mascara corrupção real | alto | R6 repara apenas campo ausente com o default vigente, e exige que outra corrupção continue sendo reportada |
| Restaurar permissão em diretório read-only apaga proteção intencional | baixo | R7 aceita reportar em vez de restaurar; abortar a passagem inteira é o que não pode |
