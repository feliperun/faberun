---
id: leaving-home
title: "Sair de casa: estabilizar, medir, entregar a amigos e só então divulgar"
version: 1.1.0
status: draft
date: 2026-09-23
owner: Felipe Broering
target: feliperun/faberun
baseline: 424c29b
campaigns:
  - first-target-frictions
  - evidence-you-can-recompute
  - evals-with-a-budget
  - safe-to-hand-to-a-friend
  - friends-pilot
---

# Sair de casa

## Por que um programa, e não uma campanha

Em `748d7ba` o faberun tinha 1.500 testes verdes, CI em três sistemas, 28
campanhas registradas e um roadmap que exige medição para promover ideia. E
tinha 2 stars, 0 forks e nenhum usuário além do autor. Quase todas as campanhas
melhoraram o próprio faberun. A retrospectiva da `durable-state-integrity` diz
que o planner contestou os dois planos que recebeu e que os contratos foram
escritos à mão.

Depois que a primeira versão deste programa foi escrita, duas campanhas
terminaram e mudaram a ordem dele:

- **`rec-audit-remediation` (PR #62)**, a primeira contra um repositório que o
  faberun não escreveu: 22 achados corrigidos no `feliperun/rec` (Zig), num
  host Linux, por US$ 1,35. Ela confirma a tese dos writers baratos, dá o
  primeiro contraexemplo ao "juiz nunca acha nada" e registra seis fricções
  (`RM-050` a `RM-055`) que um amigo encontraria no primeiro dia.
- **`campaign-brief` (PR #63)**, que entrega o P1 do roadmap e mostra o planner
  errando de jeitos que só o autor sabe corrigir.

Por isso o programa ganhou uma campanha zero, e as outras receberam a
evidência nova.

O P0 do roadmap já nomeia o objetivo: "I trust faberun enough to leave a
campaign running without watching it". Este programa estende isso para "e
confio o bastante para pôr na mão de um amigo". A ordem importa, e cada passo
depende do anterior:

0. **`first-target-frictions`.** As fricções do alvo real e do brief que matam
   nó ou produzem ruído de medição: fonte de ignore, artefato de verificação no
   selo, controlador que morre com o shell, testes que piscam no macOS,
   verificação congelada abaixo da duração medida e juiz que precisa escrever.
   Pequena, sem verbo novo, e precede tudo porque a campanha seguinte mede.
1. **`evidence-you-can-recompute`.** Todo número que o projeto afirma sobre si
   mesmo precisa ser recomputável a partir de main, e recuperação do operador
   deixa de contar como falha. Sem isso, nenhuma eval posterior é comparável e
   nenhum resultado de piloto é verificável.
2. **`evals-with-a-budget`.** O benchmark pareado sai do spike e vira classe
   versionada, com banda e orçamento duro. O juiz ganha um canário que mede se
   ele pega defeitos que a prova mecânica não vê. É aqui que o projeto passa a
   gerar eval de verdade.
3. **`safe-to-hand-to-a-friend`.** O worker deixa de herdar o ambiente inteiro,
   o modo de sandbox diz o que custa, o guia de primeiros passos passa a ser
   executado, o planner enxerga repositório que não é Node, plano contestado,
   pacote recusado e pacote com defeito têm caminho de volta, e sair é um
   comando.
4. **`friends-pilot`.** Três a cinco pessoas próximas rodam uma campanha real
   nos próprios repositórios, começando pelo Campaign Brief. O que elas vivem
   volta como pacote redigido e como atrito com id no roadmap. O programa
   termina com a decisão D10: divulgar ou não.

## Portões entre campanhas

Uma campanha só começa quando a anterior fechou com o critério de sucesso
atingido, ou com a exceção registrada no journal como `decision`, com o motivo.
Toda campanha fecha com `faberun spec validate <spec> --strict-traceability
--run-proofs` verde: a prova de cada requisito roda, e não só existe.

| Portão | Condição para abrir a próxima |
| --- | --- |
| 0 para 1 | a suíte passa sob carga no macOS do operador; nó que escreve fonte de ignore é avisado; nenhum juiz precisa de `workspace-write` |
| 1 para 2 | `evals/baseline.json` recomputa a partir de ledgers versionados; o registro do `orchestration-arms` está em main; o orçamento de bytes da skill está em vigor |
| 2 para 3 | três repetições do round complexo com banda; canário medido em pelo menos dois runtimes de juiz; D9 registrada |
| 3 para 4 | segredo plantado não chega ao worker; `GETTING-STARTED.md` conferido no CI; primeira campanha offline de um estranho verde; a próxima campanha do próprio operador fecha sem contrato escrito à mão |
| 4 para divulgação | D10 registrada |

## Regras que valem para o programa inteiro

- **Congelamento de escopo.** Nenhum harness novo, nenhuma UI, nenhuma
  reescrita em outra linguagem, nenhum verbo novo que não esteja numa destas
  cinco specs. Defeito achado durante o programa entra como `RM-###` e só é
  corrigido dentro do programa se bloquear a campanha em andamento ou expuser
  dado de alguém.
- **Orçamento de docs.** Nenhum teto de `test/docs/docs-diet.test.mjs` sobe
  durante o programa. Na campanha zero, frase nova é paga com corte no mesmo
  arquivo; a partir da primeira, vale o teto de soma que ela cria.
- **Nenhum teste chama provedor.** Tudo que precisa de modelo real é classe
  estocástica, rodada pelo operador, com `--budget-usd`.
- **Writers baratos por padrão.** As campanhas do programa usam como worker
  padrão os runtimes que o `orchestration-arms` e os ledgers mostraram
  entregando com uma a duas ordens de grandeza a menos de custo (deepseek-flash,
  glm-5.3-flash, gpt-5.6-luna). Sonnet ou opus entram só por nó com
  `riskTier: high`, com o motivo no pacote.
- **Juiz barato, fallback do mesmo nível.** Até a D9, item `judgment: true` só
  entra em nó onde nenhum comando prova o requisito, com `reason` declarado. O
  juiz padrão é um runtime barato de outro vendor, e o fallback declarado é de
  custo parecido: na `rec-audit-remediation`, o juiz GLM custou 2,8% da campanha
  e o fallback sonnet custou 62% por três nós.
- **O brief antes do play.** A partir da campanha zero, todo plano congelado
  passa por `faberun campaign brief generate` e é lido antes do primeiro run.
- **Nada de repositório de terceiro entra aqui.** Nem de empregador, nem de
  participante do piloto. Do piloto entra só o pacote redigido que o próprio
  participante gerou e aceitou enviar.

## Orçamento declarado

| Campanha | Gasto estimado de execução | Gasto de leitura estocástica |
| --- | --- | --- |
| `first-target-frictions` | até US$ 5 | 0 |
| `evidence-you-can-recompute` | até US$ 15 com writers baratos | 0 |
| `evals-with-a-budget` | até US$ 20 | até US$ 100 (R11) |
| `safe-to-hand-to-a-friend` | até US$ 25 | 0 |
| `friends-pilot` | até US$ 10 | 0 (o custo do participante é dele, com teto sugerido) |

As estimativas de execução vêm de três ledgers: `durable-state-integrity` (10
requisitos, 13 runs, US$ 1,88 com GLM), `rec-audit-remediation` (22 achados, 12
nós, US$ 1,35 com deepseek-flash e juiz GLM) e
`state-location-and-routing-economics` (19 requisitos, 62 runs, US$ 132,61
precificados, dos quais US$ 111,44 de worker sonnet). A distância entre os dois
primeiros e o terceiro é a razão da regra de writers baratos.

## Itens do roadmap que o programa promove

As linhas correspondentes de `docs/ROADMAP.md` já estão como `specified`, com
a campanha e o requisito que as carregam, e passam a `running` e `landed` com
elas. `RM-050` a `RM-055` vêm da PR #62. Os
itens novos deste programa são `RM-056` a `RM-079`, e as decisões novas
seguem a D8 da PR #63: D9 (juiz) e D10 (divulgação).

| Campanha | Itens que já existiam | Itens novos |
| --- | --- | --- |
| `first-target-frictions` | RM-051, RM-052, RM-053 | RM-056 (orçamento de teste abaixo de 1 s), RM-057 (timeout congelado abaixo do medido), RM-058 (juiz somente-leitura); RM-059 (dependência inventada) fica registrado, sem requisito |
| `evidence-you-can-recompute` | RM-030, RM-016 (parcial), RM-055 | RM-060 (ledger completo), RM-061 (`reledger`), RM-062 (motivo de custo desconhecido), RM-063 (North Star), RM-064 (orçamento de bytes), RM-065 (`orchestration-arms` em main), RM-066 (baseline recomputável) |
| `evals-with-a-budget` | RM-013, RM-035, RM-031 (parcial) | RM-067 (orçamento estocástico), RM-068 (`reason` em item de julgamento) |
| `safe-to-hand-to-a-friend` | RM-025, RM-050, RM-054, D2 (parcial) | RM-069 (ambiente permitido), RM-070 (guia executado), RM-071 (layout legado nas docs), RM-072 (fatos fora do Node), RM-073 (primeira campanha offline), RM-074 (`plan --resolve`), RM-075 (`uninstall`) |
| `friends-pilot` | RM-036, RM-015 (parcial) | RM-076 (exportação redigida), RM-077 (atrito no journal), RM-078 (classe `pilot`), RM-079 (protocolo do piloto) |

O lugar de cada item que ficou fora do programa, e o que o traria para dentro,
está em `docs/ROADMAP.md`, na seção "Where every other item stands".

## Como rodar

As specs já estão em `docs/campaigns/<id>/spec/SPEC.md`. Para cada campanha, na
ordem:

    faberun spec validate docs/campaigns/<id>/spec/SPEC.md --strict-traceability
    faberun campaign init <id> --cwd . --goal "<title da spec>"
    faberun plan docs/campaigns/<id>/spec/SPEC.md --campaign <id> --detach
    faberun campaign brief generate <id> --phase <fase>
    # ler o brief, aprovar, e só então lançar

Este arquivo fica em `docs/campaigns/leaving-home/PROGRAM.md`. Cada fechamento
de campanha acrescenta aqui uma linha com a data, o custo real, o
`intentToVerifiedSeconds` (a partir da primeira campanha, que o cria) e o
portão atingido.

## Fechamentos

| Campanha | Data | Tempo | Custo real | Portão |
| --- | --- | --- | --- | --- |
| `first-target-frictions` | 2026-09-23 | 1 h 50 min (02:32 a 04:22, sessão Opus direta) | US$ 0,08 via faberun (revisão cross-vendor deepseek-flash); a sessão Opus não é medida em `usage.jsonl` | 0 para 1 atingido: três suítes verdes com `--test-concurrency=16` neste macOS (1.571 pass, 0 fail, 411 a 431 s), `writes_ignore_source` no `validate`, juiz somente-leitura entrega o veredito |

## Fora do programa, de propósito

- Tagline, README novo, posts, vídeo e qualquer divulgação. Vêm depois da D10, e
  com os números que este programa produzir.
- Sandbox de container ou microVM (P6).
- Memória entre harnesses (P9, que a D6 põe por último).
- Roteamento empírico automático (P4, pergunta Q6).
- A condição `!job.logDir` que ficou morta no detector depois do #54: decisão do
  dono, registrada à parte.
- Reescrita em Rust ou Zig.
