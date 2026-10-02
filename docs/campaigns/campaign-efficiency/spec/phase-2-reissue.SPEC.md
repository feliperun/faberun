---
id: campaign-efficiency-phase-2-reissue
title: "F2 reemissão: classes de omissão e contexto do preflight"
version: 1.0.0
status: draft
date: 2026-09-29
owner: Felipe Broering
target: feliperun/faberun
baseline: c0145d38
derived_from: campaign-efficiency-phase-2
---

# F2: reemissão

## Intenção

Concluir R4 e R5 da [spec original da fase 2](phase-2.SPEC.md), incorporando os achados que apareceram no primeiro run. O relatório de omissões precisa dizer que tipo de caminho foi descartado. O preflight precisa refletir as regras que o freeze aplica e dar ao worker acesso declarado ao código e aos testes dessas regras.

## Requisitos

### R4. O relatório identifica os tipos de caminhos omitidos

- **statement:** o corte continua limitado por bytes e derivado de requisitos, testes e referências. O artefato informa quantidade e bytes omitidos, separa os caminhos descartados por tipo de fonte e mantém o índice completo para descoberta autorizada. Um rótulo genérico como `other` não descreve categorias conhecidas. Um fixture cobre documentos, logs arquivados, manifests e código, e confere que as contagens por tipo somam o total omitido.
- **proof:** command: node --test test/plan

**origin:** finding `r4-omission-text-legible` do juiz Sol no run `campaign-efficiency-phase-2`, registrado no journal da campanha.

### R5. O preflight cobre as regras de freeze com contexto declarado

- **statement:** as checagens determinísticas completas rodam antes da revisão semântica, encaminham diagnósticos ao reparo dentro do limite existente e entregam ao reviewer o mesmo plano que será congelado. O pacote que implementa as checagens declara em `readFiles` o código e os testes necessários para conferir as regras de freeze e de prova, incluindo `src/plan/freeze.mjs`, `src/plan/proof-scope.mjs`, `src/plan/sizing.mjs`, `src/contract/index.mjs`, `src/contract/verification.mjs` e `src/contract/definition-of-done.mjs`, além dos testes correspondentes em `test/plan/` e `test/contract/`. Workers de execução leem somente os caminhos do pacote. A recusa mecânica não consome uma chamada ao modelo.
- **proof:** command: node --test test/plan

**origin:** finding F1 da revisão Astra do plano F2, registrado no journal da campanha, e requisito R5 da spec original.

## Não-objetivos

- Reescrever o planner ou remover o reviewer adversarial.
- Alterar a política de gasto do produto ou tratar duração de medição como prova de correção.
- Reabrir ou editar os contratos e runs históricos da fase 2.

## Restrições

- Cada worker recebe um pacote fechado com os arquivos que pode ler e escrever. Uma descoberta fora desse pacote precisa de um nó explícito de descoberta somente leitura.
- Cada `argv` em `sharedVerification`, `finalVerification` e `verification` coincide com um candidato medido em `repo-facts.json` para esta reemissão. A lista de fatos mede os comandos completos, sem trocar argumentos por uma variante não medida.
- Nenhuma prova usa `--test-name-pattern`.
