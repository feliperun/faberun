---
id: adversarial-planner
title: "Planejamento adversarial fora da sessão"
version: 1.1.0
status: draft
date: 2026-09-17
owner: Felipe Broering
target: feliperun/faberun
baseline: ead7d1e
depends_on: spec-format-and-planning-stages v1.1.0 (formato de spec, repo-facts, roteamento, dimensionamento, congelamento, ledger preservado)
supersedes: adversarial-planner v1.0.0 (dividido em dois documentos em 2026-09-17, com as cinco correções acordadas)
---

# Planejamento adversarial fora da sessão

## Intenção

O planejamento adversarial já existe no fluxo atual: dois modelos debatem um
plano dentro da sessão de controle até chegarem a um consenso, e então a
execução começa. A intenção não é criar essa capacidade, é tirá-la do lugar mais
caro do sistema e dar a ela orçamento, isolamento, determinismo e medição.

Hoje o debate acontece em contexto conversacional crescente: cada turno reenvia
a sessão inteira, que só aumenta com as leituras de repositório e com as rodadas
anteriores. Esse custo sai da allowance do harness e nunca entra em
`usage.jsonl`, então `costPerClosedCheckpoint` subestima o custo real, e
subestima mais justamente nas campanhas cujo planejamento foi mais difícil. Além
disso, o revisor enxerga o raciocínio de quem escreveu o plano, o que produz
convergência social em vez de revisão independente, e "até chegarem num
consenso" não tem orçamento nem estado terminal de desacordo.

Esta é a segunda metade: os nós que invocam modelo, apoiados nos estágios
determinísticos e no formato de spec que a primeira metade pousou. A
deliberação continua invisível, e deve continuar: explorar, comparar e mudar de
ideia é pesquisa, não se industrializa. O que sai da sombra é tudo depois dela.

## Estado medido

`ead7d1e`, esta máquina, após `spec-format-and-planning-stages`.

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Custo de planejamento em `usage.jsonl` | 0% | 100% |
| Revisor recebe raciocínio do autor | sim | não |
| Rodadas de revisão com orçamento | não | sim |
| Estado terminal de desacordo | não existe | existe |
| Planejamento sobrevive à morte do assento | não | sim |
| Baseline do braço da sessão | ledgers preservados desde a primeira metade | comparável por indicador |

Peças reusadas: `mode: "discovery"` com `writeFiles` vazio, gate com `failOn`
e `maxRevisions`, o invariante de vendor por rótulo do validador de contrato,
`runtime-discovery`, `env-preflight`, e os estágios da primeira metade
(repo-facts, roteamento, dimensionamento, congelamento, validador de spec).

## Requisitos

### R5. Autoria e revisão de spec são nós, com custo registrado

- **statement:** transformar notas livres em spec, e revisar uma spec, acontecem
  como nós de `mode: "discovery"` executados fora da sessão de controle, e cada
  invocação entra em `usage.jsonl` atribuída ao nó.
- **proof:** `command: node --test --test-name-pattern="spec authoring usage accounted"`

### R6. O revisor não recebe o raciocínio de quem escreveu

- **statement:** o packet do revisor, tanto de spec quanto de plano, contém
  apenas a entrada original, os fatos do repositório e o artefato a revisar;
  nunca o packet nem a saída de raciocínio do autor.
- **proof:** `command: node --test --test-name-pattern="review packet is isolated"`

### R9. A instrução de runtime do operador ganha da tabela

- **statement:** runtime declarado pelo operador na invocação persiste no
  contrato congelado e prevalece sobre a tabela.
- **proof:** `command: node --test --test-name-pattern="operator override wins"`

### R13. Congelar um plano não inicia execução

- **statement:** o congelamento emite contrato e para; a execução começa por
  aprovação do operador, cujo limiar é definido por risco e configurável na
  invocação.
- **proof:** `command: node evals/run.mjs --case D-plan-no-autostart`

### R14. Desacordo é estado terminal, não custo

- **statement:** as rodadas de revisão têm orçamento; esgotado sem convergir, o
  plano termina como contestado, não emite contrato, e notifica o operador com
  os achados abertos.
- **proof:** `command: node evals/run.mjs --case D-plan-contested`

### R15. O planejamento sobrevive à morte do assento

- **statement:** encerrar a sessão de controle durante o planejamento não
  interrompe nem invalida o plano em curso.
- **proof:** `command: node evals/run.mjs --case D-plan-detached`

### R16. O custo de planejar dentro da sessão fica visível

- **statement:** em harness que expõe o sinal de allowance, o assento grava o
  delta entre o início da campanha e o congelamento do plano; harness sem o
  sinal grava ausência e não falha. O adapter do harness que expõe o sinal
  passa a entregá-lo; hoje nenhum o faz.
- **proof:** `command: node --test --test-name-pattern="allowance delta"`

### R17. A decisão de adotar o planejador é tomada por medição

- **statement:** existe um braço comparativo que roda as mesmas specs pela
  autoria em sessão e pelo planejador, sobre no mínimo oito specs derivadas de
  campanhas reais — os `SPEC.md` estruturados que acompanham os registros e os
  ledgers preservados são o lado da sessão — e reporta delta por indicador com
  contagem de amostras; indicador sem registro de suporte é nulo, nunca zero.
- **proof:** `command: node evals/run.mjs --validate-planner-arm --min 8`

## Não-objetivos

- Substituir a autoria de contrato pela sessão. Ela continua como caminho de
  exceção documentado, e é o fallback quando o plano sai contestado ou quando o
  repositório é desconhecido demais para um packet fechado.
- Industrializar a deliberação. Explorar, comparar e mudar de ideia continuam
  acontecendo em conversa livre, fora de qualquer contabilidade.
- Laço de conversa entre autor e revisor, em qualquer nível. O revisor emite
  achados; o autor revisa.
- Declarar nós, fases ou arquitetura na spec. A spec declara intenção,
  requisitos e aceite; derivar nós é trabalho do planejador.
- Planejar a campanha inteira de uma vez. Uma fase por vez, como hoje.
- Mudar a invocação do operador. A linha em linguagem natural apontando para uma
  spec permanece.
- Camada de evidência e mutation testing. Continuam sendo blocos posteriores.

## Restrições

- Nenhum packet manda o worker rodar a suíte inteira; verificação é do
  controlador, com o arquivo de teste específico do nó.
- Toda `verification` tem duração medida antes de ter `timeoutSec` declarado.
- Um contrato por fase, com todos os nós e arestas autorados num turno só.
- Nenhum teste depende de relógio de parede, de binário no PATH, ou de layout
  de máquina.
- Todo teto novo de documento segue o ratchet datado já usado em
  `test/docs/docs-diet.test.mjs`.
- Nenhum trabalho tem redução de linhas como objetivo.
- Toda referência nova carregável por worker respeita o teto de preâmbulo
  verificado em CI.

## Critério de sucesso

| Métrica | Baseline | Alvo | Fonte |
| --- | --- | --- | --- |
| `costPerClosedCheckpoint` | `evals/baseline.json` | não sobe, ou sobe com `firstPassGateRate` maior | evals |
| Custo de planejamento registrado | 0 | 100% das invocações | `usage.jsonl` |
| Delta de allowance do assento durante o plano | não medido | menor que o braço da sessão | journal |
| Achados críticos do revisor por plano | não medido | acima de zero | evals |
| `blockedContextRate` | `evals/baseline.json` | não sobe | evals |
| Planos contestados | n/a | reportados, nunca executados | journal |

Se nenhum indicador favorecer o braço do planejador, o desfecho correto é manter
a autoria em sessão e registrar o experimento. Spec que só admite um resultado
não é experimento.

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Partida a frio: o planejador não tem a história que a sessão acumulou | alto | fatos do repositório cobrem a parte mecânica; `mode: "discovery"` é a válvula quando o packet fechado não é possível; autoria em sessão continua disponível |
| O revisor degenera em implicância e queima rodadas sem melhorar o plano | médio | achados críticos por plano é critério explícito de desligamento no critério de sucesso |
| O planejamento dobra o custo sem retorno | médio | R16 mede o lado hoje invisível; R17 decide com número |
| O congelamento inicia execução por acidente | alto | R13 é bloqueante |
| Planejar vira replanejar em runtime | alto | plano congelado com digest; a execução consome a tabela, nunca recalcula |
| O baseline da sessão é fino demais para decidir | médio | R18 da primeira metade preserva todo ledger daqui em diante; a cópia manual de 2026-09-17 recuperou os ledgers ainda presentes em `.runs/` |
