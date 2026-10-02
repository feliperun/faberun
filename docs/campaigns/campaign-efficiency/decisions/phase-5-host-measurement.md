---
id: campaign-efficiency-decision-phase-5-host-measurement
title: "F5: teto de concorrência do host medido — 4 verificações reais em paralelo, 8 processos leves"
date: 2026-10-02
status: accepted
campaign: campaign-efficiency
phase: F5
requirement: R7
---

# Decisão de medição do host — fechamento da fase 5

## Veredito

**A máquina provou 4 verificações reais simultâneas e 8 processos leves concorrentes. O teto de
concorrência para provas em worktrees independentes fica em 4** — o maior número que este nó provou
com processos reais carregando verificação completa. Onde a máquina não provou mais (6 e 8
verificações simultâneas), o teto não sobe. O teto do planner permanece 2, e refs e integração
continuam serializadas — ambas por decisão da
[spec da fase](../spec/phase-5.SPEC.md), não por limite do host.

Isso fecha a restrição da fase ("medir o host antes de elevar concorrência") com o número que faltava
à [decisão de admissão](phase-5-admission.md): o portão comum impõe o `maxParallel` congelado; este
registro diz até onde um contrato pode congelá-lo.

## Medições (2026-10-02, host de medição)

Host: Apple M1 Pro, 8 núcleos (arm64), 16 GB de memória total, macOS darwin 25, node v26.8.1.
Pressão no momento da medição: swap de 2 GB com 1,12 GB ocupados; `os.freemem()` reportou 0,35 GB
(o restante em cache do sistema). Todas as medidas abaixo são de processos reais, cronometradas com
`/usr/bin/time -l` ou `Date.now()` em volta do processo filho; nenhuma chamada de provedor foi feita.

### Fila (spawn e espera por slot)

- **Piso de spawn:** 10 execuções de `node -e ""`: **30 ms** por processo (criação + boot + saída).
- **Rampa de concorrência** (processos CPU-bound de 200 ms cada, fila = latência máxima menos a
  serial): 1 → 234 ms; 2 → 234 ms (speedup 2,00×); 4 → 238 ms (**3,93×**, fila ≤ 3 ms);
  6 → 251 ms (5,59×, fila ≤ 16 ms); 8 → 263 ms (7,12×, fila ≤ 29 ms). Os 8 núcleos são reais; a
  perda além de 4 vem do par de núcleos de eficiência.

### Verificação

- `npm run typecheck` (passo estrito completo): **4,15 s** de parede, pico de **617.365.504 B
  (589 MiB)** de RSS, exit 0.
- **Quatro typechecks completos simultâneos:** os quatro exit 0, parede de **5,53 s**
  (+33% sobre o serial) — a prova empírica do teto 4 com a carga real de verificação.
- `node --test --test-concurrency=1 test/repo/source-shape.test.mjs` (segunda verificação
  compartilhada do contrato): **0,31 s**, exit 0.
- Processo node vazio: pico de **51.757.056 B (49 MiB)** de RSS — o envelope de um processo que só
  espera provedor.

### Julgamento (custo de host)

O componente local de um spawn de juiz é o mesmo de um worker: **30 ms de spawn + ~49 MiB de pico**.
A latência do provedor não é propriedade do host e fica fora desta medição por definição — o tempo
de parede de julgamento observado em campanha é tempo de provedor, não capacidade da máquina.

### Integração

`git merge-tree --write-tree main HEAD`: **0,08 s**, exit 0. O custo de compute da integração é
trivial nesta árvore; manter refs e integração serializadas é restrição da spec da fase, e custa
quase nada.

### Memória

Envelope por nó concorrente: **589 MiB** quando o nó carrega verificação, **~49 MiB** quando espera
provedor. Projeção: 4 verificações simultâneas ≈ 2,3 GiB (provado acima); 6 ≈ 3,5 GiB e
8 ≈ 4,7 GiB (**não** provados com processos reais neste fechamento). Com 1,12 GB já em swap no
momento da medição, a folga real de hoje é menor que a nominal de 16 GB.

### Ambiente

Um worktree recém-criado não tem `node_modules`: `npm run typecheck` sai com **127**
(`sh: tsc: command not found`) e o primeiro comando de verificação de qualquer nó falha igual.
`npm install` (75 pacotes) resolve em 1,67 s. Todo executor precisa da instalação antes do primeiro
comando compartilhado.

## Decisão de teto

1. **Provas em worktrees independentes: até 4 em paralelo.** Provado com 4 verificações completas
   simultâneas (todas exit 0, +33% de parede), speedup de CPU de 3,93× com fila ≤ 3 ms e envelope de
   memória de ~2,3 GiB.
2. **Onde a máquina não provou mais, o teto não sobe.** 6 e 8 verificações simultâneas não foram
   exercitadas com processos reais e ficam fora da prova deste fechamento. O cap `maxConcurrent: 6`
   do runtime continua coberto na CPU (5,59×, fila ≤ 16 ms), mas o teto declarado para nós que
   carregam verificação é 4 até que alguém meça 6-way.
3. **O teto do planner permanece 2.** O tempo de parede do planner é do provedor; a prova do host
   limita o custo local de processo, não a vazão do provedor. O não-objetivo da spec se mantém:
   não elevar o teto porque chamadas HTTP funcionaram.
4. **Contratos congelados não mudam retroativamente.** Os `maxParallel` já congelados (ex.: 1 no
   contrato `phase-2`) permanecem; contratos novos podem declarar até 4 — o número que a máquina
   provou — nunca acima.
5. **Refs e integração continuam serializadas**, por restrição da spec da fase (a medição de 80 ms
   mostra que a restrição é barata, não que deva ser relaxada).

## Prova do requisito R7

`node --test --test-concurrency=1 test/engine/max-parallel.test.mjs
test/engine/dispatch-during-verification.test.mjs test/engine/resume-reauthor.test.mjs` — o comando
de prova da [spec da fase](../spec/phase-5.SPEC.md). O controlador o executa no fechamento deste nó e
o resultado gravado na run é a prova do requisito; este worker não o executou porque os três arquivos
iniciam e terminam processos filhos, o que o pacote proíbe à parte de execução. Com sinais de
prontidão e sem limite superior de duração como asserção (restrição da spec).

Fechar a fase com o próprio comando de prova do R7 pegou uma interação entre o nó de identidade de
checkpoint e o teste de retomada. `resume terminates an interrupted verification attempt and re-runs
the phase` (test/engine/resume-reauthor.test.mjs:540) falhou com 1 tentativa de verificação onde
esperava 2. Bisecado: passa até a integração das provas paralelas e falha a partir da integração do
nó de identidade de checkpoint — `src/engine/run-command.mjs` passou a gravar `checkpoint-<ordinal>.json`
junto ao log de verificação e a servir o resultado de um comando quando árvore, comando, ambiente e
entradas de dependência são idênticos. O teste fabrica uma tentativa interrompida sobre uma run que
já completou e deixou seu checkpoint; na retomada, o comando inalterado é servido do checkpoint e a
fase não roda de novo — exatamente o comportamento que o requisito de checkpoint pede, não um defeito
a remover. Assentou-se no teste, não no motor: antes de retomar, o teste apaga os `checkpoint-<n>.json`
do diretório de log de verificação do nó (`logs/build.<tentativa>.verification`), porque o crash
simulado não deixou checkpoint completo; todas as asserções do teste foram mantidas. Medido neste
fechamento, 2026-10-02.

## Conformidade

Este registro reconhece `test/plan/existing-specs.test.mjs` e não o modifica: ele enumera os `.md`
diretamente sob `docs/campaigns/<id>/spec/` e valida o front matter de cada um. Este fechamento não
adiciona nem edita arquivo algum sob `spec/`, portanto o enumerate permanece como está.
