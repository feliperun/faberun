---
id: spec-format-and-planning-stages
title: "Formato de spec e estágios determinísticos do planejador"
version: 1.1.0
status: draft
date: 2026-09-17
owner: Felipe Broering
target: feliperun/faberun
baseline: ead7d1e
derived_from: adversarial-planner v1.0.0 (primeira metade), com as cinco correções acordadas em 2026-09-17
followed_by: adversarial-planner v1.1.0
---

# Formato de spec e estágios determinísticos do planejador

## Intenção

Primeira metade do planejamento adversarial fora da sessão. Tudo aqui é
testável sem invocar modelo: o formato de spec e seu validador, o inventário
determinístico do repositório, a tabela de roteamento, o dimensionamento do
grafo e o congelamento com digest. São a rede de segurança dos nós que invocam
modelo na segunda metade, e pousá-los cedo dá à segunda campanha uma spec
validada para consumir — se o formato for chore, descobre-se antes de espalhar.

A spec que alimenta o planejamento é hoje escrita em conversa e chega à fábrica
como markdown livre. Um formato estruturado torna a autoria de spec um nó como
outro qualquer, torna o trabalho do planejador quase mecânico, e dá à camada de
evidência a âncora de requisito que hoje não existe. A deliberação continua
invisível, e deve continuar: o que sai da sombra é tudo depois dela.

Inclui também a correção urgente de uma perda de dado em curso: cada campanha
fechada hoje descarta seu ledger, e é esse ledger que o braço comparativo da
segunda campanha precisa como baseline.

## Estado medido

`ead7d1e`, esta máquina.

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Formato de spec | markdown livre | validável, versionado |
| Validação de spec invoca modelo | n/a | nunca |
| `timeoutSec` derivado de duração medida | por palpite | medido |
| Plano reproduzível e comparável | não | digest e proveniência |
| Ledger de campanha fechada versionado | não (`.runs/` é gitignored) | sim, no registro |

Peças existentes reusadas: `preflight --time-verification` (duração medida),
`runtime-discovery` e `env-preflight` (disponibilidade e exaustão), a forma de
tabela de `src/engine/bulk-read.mjs` (roteamento), `finalVerification`
(congelamento), o invariante do validador de contrato de que worker, sua cadeia
de fallback e juiz carregam rótulos `vendor` distintos.

## Requisitos

### R1. O formato de spec é versionado e documentado

- **statement:** existe um formato de spec com versão própria, documentado como
  referência carregável, cujas seções obrigatórias são Intenção, Requisitos e
  Não-objetivos.
- **proof:** `path: skills/faberun/references/spec-format.md`
- **constraints:** a referência nova sobe três ratchets com justificativa
  datada, no padrão de `test/docs/docs-diet.test.mjs`: o teto de bytes da pasta
  de referências, a asserção de que ela contém exatamente os documentos de
  fundação e os artigos reservados, e o teto de 1.024 B do `SKILL.md`, que
  cresce para linkar a referência. Os artigos reservados não são tocados.

### R2. A validação de spec é determinística

- **statement:** validar uma spec não invoca modelo nenhum.
- **proof:** `command: node --test --test-name-pattern="spec validate invokes no model"`

### R3. A validação reprova spec que oneraria o planejamento

- **statement:** requisito sem id estável, requisito sem `proof`, ausência de
  não-objetivos, critério de sucesso sem baseline, e `target` ou `baseline` que
  não resolve para um commit são reprovados; advisory por default, bloqueante
  sob `--strict-traceability`.
- **proof:** `command: node --test --test-name-pattern="spec validate rejects"`

### R4. Specs novas validam; registros antigos são classe aceita

- **statement:** o validador reconhece um documento sem o front matter
  estruturado como `legacy` e o aceita sem reprovar, dizendo isso; a prova
  incide sobre toda spec escrita a partir desta campanha e sobre um `SPEC.md`
  estruturado gerado ao lado de cada `PROPOSAL.md` já existente em
  `docs/campaigns/`, sem alterar um byte dos originais nem de `docs/history/`.
- **proof:** `command: node --test --test-name-pattern="existing specs validate"`

### R7. Os fatos do repositório são determinísticos e trazem duração medida

- **statement:** o inventário do repositório alvo é gerado sem invocar modelo, é
  idêntico entre duas execuções no mesmo HEAD, e cada comando de verificação
  candidato traz duração medida por `preflight --time-verification`, com
  comandos acima de 600 s marcados como inelegíveis.
- **proof:** `command: node --test --test-name-pattern="repo facts"`

### R8. O modelo classifica, a tabela roteia

- **statement:** o rascunho do plano devolve classificação por nó e nunca nomeia
  runtime; a resolução de runtime sai de uma tabela declarativa cruzada com o
  que a descoberta reporta como disponível e não exaurido.
- **proof:** `command: node --test --test-name-pattern="routing is table driven"`

### R10. O juiz de um plano gerado nunca compartilha vendor com worker ou fallback

- **statement:** nenhum plano gerado resolve um juiz cujo rótulo de vendor seja
  o de um worker do nó ou de qualquer runtime da cadeia de fallback desse
  worker; o requisito não nomeia mecanismo, e a prova usa o mesmo invariante
  que o validador de contrato já impõe.
- **proof:** `command: node --test --test-name-pattern="judge vendor distinct"`

### R11. O dimensionamento do grafo é determinístico e auditável

- **statement:** fundir, dividir e marcar paralelizáveis são decisões de
  pós-processamento sem modelo, idempotentes, e cada transformação registra a
  regra que a causou.
- **proof:** `command: node --test --test-name-pattern="sizing"`

### R12. O plano congelado é reproduzível

- **statement:** o plano carrega digest, versão do pacote, `schemaVersion`, git
  HEAD do alvo, o par de runtimes que planejou e revisou, as regras de
  dimensionamento aplicadas e os achados do revisor com severidade; alterar um
  byte invalida o digest.
- **proof:** `command: node --test --test-name-pattern="freeze"`

### R18. Campanha fechada preserva seu ledger

- **statement:** encerrar uma campanha copia `usage.jsonl` de cada run vinculada
  e o journal da campanha para o registro em `docs/campaigns/<id>/`, redigidos
  pelo redator que a cápsula já usa, fora de `.runs/`. Entra cedo na campanha:
  cada dia sem ele é um ponto de dado a menos para o braço comparativo.
- **proof:** `command: node --test --test-name-pattern="campaign close preserves ledger"`

## Não-objetivos

- Qualquer nó que invoque modelo: autoria e revisão de spec, contrato de
  planejamento, `faberun plan`, braço comparativo e allowance ficam na
  segunda campanha (`adversarial-planner` v1.1.0).
- Declarar nós, fases ou arquitetura na spec. A spec declara intenção,
  requisitos e aceite; derivar nós é trabalho do planejador (até ele existir,
  do orquestrador).
- Reescrever qualquer documento sob `docs/campaigns/` ou `docs/history/`.
- Mudar a invocação do operador.

## Restrições

- Nenhum packet manda o worker rodar a suíte inteira; verificação é do
  controlador, com o arquivo de teste específico do nó.
- Toda `verification` tem duração medida antes de ter `timeoutSec` declarado.
- Um contrato por fase, com todos os nós e arestas autorados num turno só.
- Nenhum teste depende de relógio de parede, de binário no PATH, ou de layout
  de máquina.
- Todo teto novo de documento segue o ratchet datado de
  `test/docs/docs-diet.test.mjs`.
- Nenhum trabalho tem redução de linhas como objetivo.
- `src/plan/` é camada nova e entra na tabela de layout do `AGENTS.md`.

## Critério de sucesso

| Métrica | Baseline | Alvo | Fonte |
| --- | --- | --- | --- |
| Specs de campanha validáveis | 0 | todas as novas, mais um `SPEC.md` por registro | validador |
| Ledgers de campanha fechada versionados | 0 | 100% das campanhas fechadas daqui em diante | registro |
| Contratos com `timeoutSec` abaixo da duração real | ocorreu em campo | zero nos planos congelados | `preflight` |
| Estágios determinísticos sem modelo | n/a | quatro, todos provados por fixture | testes |

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| O formato de spec vira chore e o operador volta ao markdown livre | médio | três seções obrigatórias, validação advisory por default, scaffold por comando |
| A tabela de roteamento vira configuração paralela ao contrato | médio | precedência declarada, com override do operador sempre vencendo |
| O ledger preservado carrega algo que não deveria ser público | médio | redator da cápsula aplicado na cópia; o hook de pré-commit escaneia |
