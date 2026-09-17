---
id: chain-ergonomics-and-fairness
title: "The chain's own ergonomics and fairness"
version: 1.0.0
status: draft
date: 2026-09-17
owner: Felipe Broering
target: feliperun/faberun
baseline: 372eef2
---

# The chain's own ergonomics and fairness

## Intenção

Quatro campanhas do loop foram dirigidas por `supervise campaign`, e cada uma
deixou a fábrica com uma marca de uso: um lançamento que falha porque a run
revalida contra o checkout em vez do ref que ela mesma vai cortar, slots livres
parados enquanto um nó verifica, a suíte completa rodando uma vez por nó
terminal em vez de uma por fase, e três lugares onde o status ou a mensagem
mentem sobre o que está acontecendo. Nenhum é um defeito de correção: são
defeitos de ergonomia e de justiça, e todos custaram intervenção do operador ou
orçamento de revisão de um nó que não tinha culpa.

Esta campanha fecha os seis, que são exatamente o que sobrou de substancial na
retrospectiva do loop. O que vem depois é operacional (rodar o braço do
planejador de verdade) ou já foi adiado pelo dono (camada de evidência,
mutation testing).

## Estado medido

`372eef2`, esta máquina, depois de quatro campanhas.

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Contrato que lê arquivo da fase anterior | falha ao lançar pelo chain | lança |
| Slot livre com um nó em verificação | ocioso até o tick liberar | despacha |
| `finalVerification` por fase | uma vez por nó terminal | uma vez por fase |
| Fase exibida na verificação do candidato | `judge` | `candidate` |
| `campaign unpark` recusando | não diz como seguir | nomeia `--force` |
| Veredito com achados menores | mostra `(fail)` | mostra o resultado do gate |

## Requisitos

### R1. Uma run lançada com `--base-ref` valida contra esse ref

- **statement:** `run --base-ref <ref>` valida o contrato contra o ref de onde
  as worktrees serão cortadas, não contra o checkout, de modo que um contrato
  cujos `readFiles` nomeiam arquivos criados pela fase anterior lança sem o
  operador destacar o checkout.
- **proof:** `command: node --test --test-name-pattern="run --base-ref validates against the ref" test/repo/base-ref.test.mjs`

### R2. O chain não precisa do checkout no branch de pouso

- **statement:** uma campanha encadeada cujo contrato seguinte lê arquivos que
  o contrato anterior criou é lançada pelo coordenador com o checkout em
  qualquer commit.
- **proof:** `command: node --test --test-name-pattern="chain launches a contract reading the previous phase" test/campaign/chain-launch.test.mjs`

### R3. Um slot livre despacha enquanto outro nó verifica

- **statement:** a verificação de um nó não bloqueia o despacho de um nó
  pronto e independente; com `maxParallel` maior que um, um nó elegível é
  despachado enquanto outro está em verificação ou no juiz.
- **proof:** `command: node --test --test-name-pattern="a free slot dispatches while another node verifies" test/engine/dispatch-during-verification.test.mjs`

### R4. `finalVerification` roda uma vez por fase

- **statement:** a verificação final de um contrato roda uma vez, no candidato
  integrado do último nó a fechar, e não uma vez por nó sem dependentes.
- **proof:** `command: node --test --test-name-pattern="finalVerification runs once per phase" test/engine/final-verification-once.test.mjs`

### R5. O status nomeia a fase do candidato

- **statement:** enquanto o controlador verifica o candidato integrado, o
  status mostra essa fase, não `judge`.
- **proof:** `command: node --test --test-name-pattern="candidate verification shows its own phase" test/report/now-line.test.mjs`

### R6. Uma recusa diz como seguir

- **statement:** `campaign unpark` recusando uma run ainda estacionada nomeia
  `--force`, e a recusa de promover um branch de pouso com checkout ativo diz
  que basta destacar o checkout.
- **proof:** `command: node --test --test-name-pattern="refusals name the way forward" test/campaign/unpark.test.mjs`

### R7. O status distingue o veredito do resultado do gate

- **statement:** um nó cujo juiz devolveu `fail` com achados abaixo do limiar
  e cujo gate passou não é exibido como `(fail)`; o status mostra o resultado
  do gate e o veredito separadamente.
- **proof:** `command: node --test --test-name-pattern="gate outcome is distinct from the verdict" test/report/now-line.test.mjs`

## Não-objetivos

- Camada de evidência e mutation testing, adiados pelo dono.
- Rodar o braço do planejador ao vivo: é ação do operador, com custo.
- Qualquer mudança no formato de spec, no planejador ou nos evals além do que
  os requisitos acima exigem.
- Mudar a invocação do operador.

## Restrições

- Nenhum packet manda o worker rodar a suíte inteira.
- Toda `verification` tem duração medida antes de ter `timeoutSec`.
- Um contrato por fase, nós e arestas autorados num turno só.
- Nenhum teste depende de relógio de parede, de binário no PATH ou de layout
  de máquina; nenhum fixture resolve `node` pelo PATH.
- Todo campo persistido novo vai com o allowlist do validador e o typedef.
- `CONTRACT_VERSION` continua `0.3.0`; artigos reservados e registros não são
  tocados.

## Critério de sucesso

| Métrica | Baseline | Alvo | Fonte |
| --- | --- | --- | --- |
| Intervenções do operador por campanha encadeada | 3 na última | 0 para essas causas | journal |
| Suítes completas por fase de 3 nós terminais | 3 | 1 | verificação |
| Nós que perderam revisão por flake alheio | 2 no loop | 0 | journal |
| Estados exibidos que não correspondem ao que ocorre | 3 | 0 | testes |
