---
id: leaving-home
title: "Sair de casa: estabilizar, medir, entregar a amigos e só então divulgar"
version: 1.0.0
status: draft
date: 2026-09-22
owner: Felipe Broering
target: feliperun/faberun
baseline: 748d7ba
campaigns:
  - evidence-you-can-recompute
  - evals-with-a-budget
  - safe-to-hand-to-a-friend
  - friends-pilot
---

# Sair de casa

## Por que um programa, e não uma campanha

Em `748d7ba` o faberun tem 1.500 testes verdes, CI em três sistemas, 28
campanhas registradas e um roadmap que exige medição para promover ideia. E
tem 2 stars, 0 forks e nenhum usuário além do autor. Quase todas as campanhas
melhoraram o próprio faberun. A retrospectiva mais recente diz que o planner
contestou os dois planos que recebeu e que os contratos foram escritos à mão.

O P0 do roadmap já nomeia o objetivo: "I trust faberun enough to leave a
campaign running without watching it". Este programa estende isso para "e
confio o bastante para pôr na mão de um amigo". A ordem importa, e cada passo
depende do anterior:

1. **`evidence-you-can-recompute`.** Todo número que o projeto afirma sobre si
   mesmo precisa ser recomputável a partir de main. Sem isso, nenhuma eval
   posterior é comparável e nenhum resultado de piloto é verificável.
2. **`evals-with-a-budget`.** O benchmark pareado sai do spike e vira classe
   versionada, com banda e orçamento duro. O juiz ganha um canário que mede se
   ele pega defeitos que a prova mecânica não vê. É aqui que o projeto passa a
   gerar eval de verdade.
3. **`safe-to-hand-to-a-friend`.** O worker deixa de herdar o ambiente inteiro,
   o guia de primeiros passos passa a ser executado, o planner enxerga
   repositório que não é Node, plano contestado e pacote recusado têm caminho
   de volta, e sair é um comando.
4. **`friends-pilot`.** Três a cinco pessoas próximas rodam uma campanha real
   nos próprios repositórios. O que elas vivem volta como pacote redigido e como
   atrito com id no roadmap. O programa termina com a decisão D8: divulgar ou
   não.

## Portões entre campanhas

Uma campanha só começa quando a anterior fechou com o critério de sucesso
atingido, ou com a exceção registrada no journal como `decision`, com o motivo.

| Portão | Condição para abrir a próxima |
| --- | --- |
| 1 para 2 | `evals/baseline.json` recomputa a partir de ledgers versionados; o registro do `orchestration-arms` está em main; o orçamento de bytes da skill está em vigor |
| 2 para 3 | três repetições do round complexo com banda; canário medido em pelo menos dois runtimes de juiz; D7 registrada |
| 3 para 4 | segredo plantado não chega ao worker; `GETTING-STARTED.md` conferido no CI; primeira campanha offline de um estranho verde; a próxima campanha do próprio operador fecha sem contrato escrito à mão |
| 4 para divulgação | D8 registrada |

## Regras que valem para o programa inteiro

- **Congelamento de escopo.** Nenhum harness novo, nenhuma UI, nenhuma
  reescrita em outra linguagem, nenhum verbo novo que não esteja numa destas
  quatro specs. Defeito achado durante o programa entra como `RM-###` e só é
  corrigido dentro do programa se bloquear a campanha em andamento ou expuser
  dado de alguém.
- **Orçamento de docs.** O teto de soma de bytes da skill e das referências,
  criado na primeira campanha, vale para as outras três. Frase nova é paga com
  corte.
- **Nenhum teste chama provedor.** Tudo que precisa de modelo real é classe
  estocástica, rodada pelo operador, com `--budget-usd`.
- **Writers baratos por padrão.** As campanhas do programa usam como worker
  padrão os runtimes que o `orchestration-arms` e os ledgers mostraram
  entregando com uma a duas ordens de grandeza a menos de custo (deepseek-flash,
  glm-5.3-flash, gpt-5.6-luna). Sonnet ou opus entram só por nó com
  `riskTier: high`, com o motivo no pacote.
- **Juiz só onde há julgamento.** Até a D7, item `judgment: true` só entra em
  nó onde nenhum comando prova o requisito, com `reason` declarado.
- **Nada de repositório de terceiro entra aqui.** Nem de empregador, nem de
  participante do piloto. Do piloto entra só o pacote redigido que o próprio
  participante gerou e aceitou enviar.

## Orçamento declarado

| Campanha | Gasto estimado de execução | Gasto de leitura estocástica |
| --- | --- | --- |
| `evidence-you-can-recompute` | até US$ 15 com writers baratos | 0 |
| `evals-with-a-budget` | até US$ 20 | até US$ 100 (R11) |
| `safe-to-hand-to-a-friend` | até US$ 25 | 0 |
| `friends-pilot` | até US$ 10 | 0 (o custo do participante é dele, com teto sugerido) |

As estimativas de execução vêm dos ledgers de `durable-state-integrity` (10
requisitos, 13 runs, US$ 1,88 com GLM) e de `state-location-and-routing-economics`
(19 requisitos, 62 runs, US$ 132,61 precificados, dos quais US$ 111,44 de
worker sonnet). A diferença entre as duas é a principal razão da regra de
writers baratos.

## Itens do roadmap que o programa promove

Ao abrir cada campanha, as linhas correspondentes de `docs/ROADMAP.md` passam
para `specified` com o caminho da spec. Itens novos recebem ids a partir de
`RM-050`.

| Campanha | Itens existentes | Itens novos |
| --- | --- | --- |
| `evidence-you-can-recompute` | RM-030, RM-016 (parcial) | ledger completo, `reledger`, motivo de custo desconhecido, North Star medida, orçamento de bytes |
| `evals-with-a-budget` | RM-013, RM-035, RM-031 (parcial) | orçamento estocástico, `reason` em item de julgamento |
| `safe-to-hand-to-a-friend` | RM-025, D2 (parcial) | ambiente permitido, guia executado, fatos fora do Node, `plan --resolve`, `uninstall` |
| `friends-pilot` | RM-036 | exportação redigida, atrito no journal, classe `pilot` |

## Como rodar

Para cada campanha, na ordem:

    mkdir -p docs/campaigns/<id>/spec
    # salvar a spec como docs/campaigns/<id>/spec/SPEC.md
    faberun spec validate docs/campaigns/<id>/spec/SPEC.md --strict-traceability
    faberun campaign init <id> --cwd . --goal "<title da spec>"
    faberun plan docs/campaigns/<id>/spec/SPEC.md --campaign <id> --detach

Este arquivo fica em `docs/campaigns/leaving-home/PROGRAM.md`. Cada fechamento
de campanha acrescenta aqui uma linha com a data, o custo real, o
`intentToVerifiedSeconds` (a partir da primeira campanha, que o cria) e o
portão atingido.

## Fora do programa, de propósito

- Tagline, README novo, posts, vídeo e qualquer divulgação. Vêm depois da D8, e
  com os números que este programa produzir.
- Sandbox de container ou microVM (P6).
- Memória entre harnesses (P9, que a D6 põe por último).
- Roteamento empírico automático (P4, pergunta Q6).
- Reescrita em Rust ou Zig.
