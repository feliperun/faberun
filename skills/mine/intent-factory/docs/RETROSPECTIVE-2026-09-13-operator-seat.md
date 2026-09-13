---
title: "Retrospectiva: assento de operador, acesso remoto e lições do SwarmForge"
campaign_id: operator-seat-and-remote-20260912
date: 2026-09-13
spec: docs/TECH-SPEC-2026-09-12-operator-seat.md
baseline: evals/baseline.json (intent-factory-measurement-20260910, recalculado 2026-09-12)
range: 3dd7702..fbd65a6
---

# Retrospectiva — `operator-seat-and-remote-20260912`

Sete fases, quinze nós, doze fechados. Cinco fases entregues e integradas; uma
— S5.1, estado por diretório — **não entrou, de propósito**, e a §4 diz por quê.

## 1. Delta medido

| Indicador | Antes (n=9) | Depois | Melhora é |
|---|---|---|---|
| `costPerClosedCheckpoint` | 5,5908 | **3,3998** (n=2) | ↓ |
| `wallClockPerClosedCheckpoint` | 1688,2 s | **2609,0 s** (n=12) | ↓ — **regrediu** |
| `revisionsPerDone` | 0,3333 | **0,4167** (n=12) | ↓ — **regrediu** |
| `blockedContextRate` | 0 | **0,1333** (n=15) | ↓ — **regrediu** |
| `firstPassGateRate` | 3/9 | **7/15** | ↑ |
| `protocolFailureRate`, `providerFailoverRate` | 0 | 0 | ↓ |

Três indicadores pioraram, e a leitura honesta é que **duas das causas são
minhas, não do sistema**:

`wallClockPerClosedCheckpoint` quase dobrou porque lancei quatro fases em
paralelo. Verifiquei os seis pares de `writeFiles` e não há conflito de
arquivo — mas paralelismo não é de graça: as fases competiram por CPU com as
verificações umas das outras, e um nó cuja verificação roda a suíte inteira
passa fome. O nó que morreu disse isso em prosa: *"the machine has many
concurrent test processes from other sessions, so it's slow"*.

`blockedContextRate` e `revisionsPerDone` carregam os três bloqueios de
envelope de juiz e os dois nós que não fecharam. O `n=2` do custo continua
sendo o problema que a campanha anterior já nomeou: só `claude` reporta custo,
então doze dos quinze checkpoints entraram sem preço.

## 2. O que entrou

| Fase | Entrega |
|---|---|
| S-P1 | brief de operador determinístico (4 KiB, sem modelo); notificação lossy |
| S-P2 | `seat start/attach/status/stop/switch`, cinco harnesses, aviso de allowance |
| **S-P2.5** | **fechamento de escopo: quatro detectores, `contract validate` recusa** |
| S-P3 (2/3) | `changedFiles` sai do protocolo; caminho do snapshot com dono único |
| S-P4 | fronteira privada + rotas que disparam o CLI; sem rota de replanejamento |
| S-P5 | campo gerado por modelo marcado como dado; dono por campo com gate |
| S-P6 | `SKILL.md` 5.993 → **990 B**, quatro artigos reservados |

## 3. A fase que não estava no plano, e que se pagou

A S-P2.5 nasceu no meio da campanha, de uma pergunta direta: *"já vi isso
acontecer várias vezes — erro meu de contrato, horas perdidas. O que sugere
pra isso nunca mais acontecer?"*

Três vezes em duas campanhas eu escrevi packet cujo escopo não fechava. Escrevi
memória depois da primeira. Repeti. Escrevi a lição no packet seguinte. Repeti.
Isso é evidência de que **"prestar mais atenção" não é solução** — tinha de
virar recusa.

Quatro detectores, calibrados contra os seis contratos gravados: 26
apontamentos, com os três incidentes reais entre eles. A versão ingênua
reportava 23 só para um packet; o aperto foi fazer o detector seguir apenas
importador que consome um `symbols` declarado — o que transforma um campo até
então decorativo no que controla a precisão da checagem inteira.

**Pagou-se na hora.** Validei os quatro contratos das fases seguintes e ele
achou três testes que teriam travado a S-P3 e a colisão cross-node idêntica à
que travou o assento.

E me ensinou duas coisas que eu não sabia estar errando:

- **`symbols` significa "símbolos cujo *contrato* este nó muda"**, não
  "símbolos que ele encosta". Declarei `status` — palavra em quase todo módulo
  — e ele apontou cem arquivos, corretamente.
- **`scopeAcknowledged` diz "olhei e não quebra"; `writeFiles` diz "e se
  quebrar, você pode consertar".** Foi um nó sem a segunda autoridade que
  travou o assento por uma hora e meia.

## 4. S5.1 não entrou, e por quê

`renameSync` atômico e o layout por diretório foram entregues. **`status`
continuou campo gravado e validado.** Integrar isso deixaria duas fontes de
verdade para o mesmo fato — que é precisamente o defeito que a S5.1 existe para
remover, e pior que qualquer uma das duas pontas.

O nó falhou duas vezes no envelope do resultado (prosa em vez de JSON), a
US$ 3,40, sem o juiz chegar a opinar. Re-rodar uma terceira vez o worker mais
caro, no fim de uma sessão longa, para uma mudança que reescreve o formato em
disco que dez módulos leem, é trabalho para ser supervisionado.

## 5. O envelope do juiz foi o ponto mais frágil

Três bloqueios, **todos no envelope, nenhum no trabalho entregue**:

1. `findings` fora de `required` — a OpenAI recusa o *schema* com 400 antes do
   modelo rodar. Defeito meu, da correção da campanha anterior para o caso
   oposto do Claude: dois provedores com exigências contrárias, e eu só tinha
   medido um.
2. `resume` relia a cópia velha do `judge.schema.json` — a correção não
   alcançava a run que ela existia para consertar.
3. Dependência resolvida não reconciliava sozinha.

## 6. Template literal enganou a quarta ferramenta

Remover `changedFiles` do protocolo alcançou quatro camadas de fixture:
três testes (o detector viu), `test/helpers.mjs` (12) e `test/runner-helpers.mjs`
(28) — programas de worker dentro de template literals — e catorze fixtures de
eval, JSON com o campo escapado dentro de string.

O detector 2 agora tira só comentários, o que cobre as duas camadas de
template. **A camada de JSON continua fora de alcance:** nenhuma varredura de
fonte chega nela. Fica aberto.

## 7. Aberto

1. **S5.1**, com metade do trabalho num worktree e a razão acima.
2. **Fixtures de dado não são varridas** pelo fechamento de escopo.
3. **`costPerClosedCheckpoint` ainda mede pouco**: `n=2` de 15 checkpoints.
4. **Paralelismo entre fases precisa de orçamento de CPU**, não só de
   verificação de conflito de arquivo.
