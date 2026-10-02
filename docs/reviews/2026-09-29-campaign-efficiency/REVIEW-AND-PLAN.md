# Campanhas: review e plano de melhorias

Review de 29/09/2026 sobre `af880acc600d6d89c543b6f73db8f5bce64ebf32`, versão 0.30.0. Escopo: planejamento, execução, retomada, consumo de contexto e visibilidade. Esta entrega altera apenas documentação. As reproduções usaram funções reais com fixtures locais e dependências injetadas, sem chamadas a provedores.

A primeira prioridade é tornar retomada e revisão confiáveis. Para economizar, o maior alvo encontrado foi o planejamento: em uma campanha recente, ele respondeu por 90,87% do custo conhecido. Minha recomendação é validar mais coisas antes de chamar modelos, recuperar etapas concluídas e reduzir o contexto de cada rodada. Aumentar o paralelismo vem depois de corrigir a admissão de trabalho e medir a fila de verificações.

## Evidência de custo

Valores recalculados dos ledgers versionados pelo comando `faberun metrics`. Os dados completos e a separação por tipo de run estão em [evidence.json](evidence.json).

| Campanha | Runs | Custo conhecido | Registros sem custo conhecido |
| --- | ---: | ---: | ---: |
| `safe-to-hand-to-a-friend` | 102 | US$ 36,9041 | 3 |
| `planner-and-routing` | 7 | US$ 90,9208 | 7 |
| `evidence-you-can-recompute` | 16 | US$ 7,3584 | 0 |

São campanhas com trabalhos e versões diferentes. A tabela localiza gastos e lacunas de medição; não compara produtividade entre modelos nem demonstra o desempenho da versão atual.

Em `safe-to-hand-to-a-friend`:

| Tipo de run | Runs | Invocações registradas | Custo conhecido | Tokens de saída |
| --- | ---: | ---: | ---: | ---: |
| Planejamento | 92 | 93 | US$ 33,5332 | 2.823.349 |
| Execução | 10 | 69 | US$ 3,3708 | 2.757.349 |

A classificação usa os arquivos de usage cujo nome contém `-plan-`; os demais são execução. Inclui os 102 runs, inclusive o substituído, pois ele também custou. As três invocações sem preço estão no planejamento. O custo conhecido de planejamento é 9,95 vezes o de execução nessa amostra.

O indicador `intentToVerifiedSeconds` dessa campanha registra aproximadamente 50,2 horas corridas, incluindo esperas. Isso não equivale a 50,2 horas de inferência. Tokens de entrada, leitura de cache e saída permanecem separados no JSON: somá-los como se tivessem o mesmo preço distorceria a economia.

A versão 0.30.0 já entrega revisão por patch, suíte compartilhada e melhor associação entre código e testes. O histórico acima antecede essas correções e não mede o ganho delas. O experimento de comparação proposto adiante precisa estabelecer uma nova referência.

## Achados do code review

P1 identifica falhas que comprometem revisão ou continuidade. P2 identifica desperdício ou perda de informação com recuperação possível. Confiança alta significa reprodução local ou fluxo diretamente verificável; o risco de concorrência abaixo permanece explicitamente não reproduzido.

### R1. P1: a troca de sessão pode apagar as instruções do juiz

Local: [phase-session.mjs](../../../src/engine/phase-session.mjs), linhas 103 a 105 e 192 a 215; [dispatch.mjs](../../../src/engine/dispatch.mjs), linhas 531 a 541.

Quando existe uma sessão de juiz de outro nó da mesma fase, `phaseInvocationPlan` pode selecionar `rotate`. O helper reconstrói o texto com `node.prompt`, que é o prompt de implementação. O prompt recebido do caller, contendo critérios, evidências e instruções de nova consulta, é descartado.

Reprodução: dois nós na mesma fase, snapshot anterior válido e prompt com marcadores de evidência e re-ask. Resultado: `mode=rotate`, evidência ausente, re-ask ausente e instrução de worker presente. Isso pode comprometer a revisão e provocar chamadas desnecessárias. A reprodução prova a perda do contexto; não mediu um falso aceite por modelo.

Correção: preservar o prompt efetivo do papel, acrescentando somente o contexto permitido dentro do espaço restante. Para juiz, manter a independência prevista no projeto e não importar resumos do autor. Critérios e evidências obrigatórios não podem ser cortados silenciosamente.

Teste necessário: dois nós julgados na mesma fase, incluindo re-ask, provando que critérios, evidência e papel sobrevivem à rotação. O teste de rotação em `test/engine/failover.test.mjs` cobre worker com `gate:false`. Confiança alta.

### R2. P1: a cadeia não recupera o controller que morreu depois de iniciar

Local: [chain.mjs](../../../src/campaign/chain.mjs), linhas 506 a 549; [cli/campaign.mjs](../../../src/cli/campaign.mjs), linha 428.

A supervisão da campanha lança um `run` destacado. Se o processo morre depois do bootstrap, o run existente pode permanecer `unfinished`. Esse ramo da cadeia apenas espera: não consulta a necessidade de recuperação nem solicita `resume`. O coordenador continua vivo, embora a campanha não avance.

Reprodução: run temporário com nó `running`, sem controller vivo. `runProgress` retorna `unfinished` e `controllerAlive=false`. Com três ticks injetados, a cadeia fez três esperas e zero lançamentos. Saiu apenas porque a fixture impôs `maxTicks`; a operação normal não tem esse limite.

Correção: conectar a cadeia à política de recuperação existente em `superviseRun`, com um único responsável por retomar cada run, lock e identidade do processo verificados, limites persistidos e atenção durável quando a recuperação se esgotar. Pausa solicitada pelo usuário deve impedir a retomada automática.

Teste necessário: matar controller depois da prontidão, recuperar o mesmo run e avançar ao próximo contrato, sem duplicar invocações. É um cenário diferente da falha de bootstrap já corrigida em RM-053. Confiança alta.

### R3. P1: o painel responde sucesso ao retomar sem executar nada

Local: [api.mjs](../../../src/web/api.mjs), linhas 142 a 146 e 226 a 238.

Pausar chama `cancel`. Retomar procura apenas runs com nós fora dos estados terminais, excluindo `canceled`. Depois de uma pausa efetiva, a lista pode ficar vazia e `every()` retorna verdadeiro.

Reprodução: campanha com um único nó cancelado recebeu HTTP 200 com `{"ok":true,"results":[]}`, sem chamar o CLI. O planejamento de retry do CLI aceita esse nó cancelado por padrão. O teste atual usa um CLI falso que registra argumentos, mas não altera o estado entre pausa e retomada.

Correção: definir pausa durável de campanha, selecionar runs retomáveis e coordenar `resume`, desbloqueio da cadeia e supervisão. Retornar operação aplicada, operação pendente ou nenhuma ação necessária com motivo. Ampliar somente o filtro deixa a cadeia estacionada.

Teste necessário: sequência completa pausar, observar estado persistido, retomar e avançar. Também cobrir campanha já concluída e chamadas repetidas. Confiança alta.

### R4. P2: o inventário corta os arquivos úteis por ordem alfabética

Local: [repo-facts.mjs](../../../src/plan/repo-facts.mjs), linhas 306 a 328, especialmente `allPaths.slice(0, maxPaths)`.

No HEAD revisado há 2.509 caminhos rastreados e 199 arquivos sob `src/`. O corte dos primeiros 2.000 caminhos contém zero caminhos de `src/` e zero de `test/`: documentos e resultados históricos ocupam o espaço primeiro.

Reprodução com `collectRepoFacts` real e medidor injetado: `paths=2000`, `truncated=true`, `srcPaths=0`, `testPaths=0`. O mapa separado `testFiles` ainda carrega 217 entradas, portanto não houve perda de toda informação sobre código. Houve perda da lista principal usada como inventário, obrigando descoberta adicional e favorecendo planos incompletos.

Correção: selecionar fatos por relevância para requisitos, manifestações do projeto e dependências, com orçamento de bytes. Preservar um índice completo consultável pelo estágio de descoberta. Quando faltar espaço, registrar os grupos omitidos. Evitar que arquivos históricos consumam todo o inventário operacional.

Teste necessário: repositório com mais de 2.000 documentos e fontes relevantes no final da ordenação, incluindo nomes e layouts diferentes dos deste projeto. Confiança alta.

### R5. P2: o reviewer é chamado antes de uma recusa determinística conhecida

Local: [rounds.mjs](../../../src/plan/rounds.mjs), chamada de review na linha 377 e `freezePreflightError` na linha 404.

Uma estrutura válida pode continuar impossível de congelar por fechamento de escopo, roteamento ou outra restrição. O loop paga pelo review antes de executar essa checagem. O projeto já faz algumas correções mecânicas e `proof-check`; a lacuna está na ordem dessa validação completa.

Correção: executar a validação completa antes do review, devolver todos os diagnósticos determinísticos aplicáveis ao reviser e revisar semanticamente quando o plano estiver apto a congelar. Preservar o limite de rodadas e o histórico de achados. Um erro de estrutura não deve ganhar rodadas infinitas gratuitas.

Teste necessário: plano que falha no preflight não chama reviewer; após reparo válido, chama reviewer; esgotamento continua produzindo contestação. Confiança alta por inspeção da ordem de chamadas. A economia exata não foi medida.

### R6. P2: alertas de ociosidade de campanhas diferentes se anulam

Local: [watch.mjs](../../../src/campaign/watch.mjs), linha 122; [notify/index.mjs](../../../src/notify/index.mjs), linha 408.

A chave `idle:1` não identifica campanha nem episódio. A deduplicação consulta o inbox compartilhado pelo projeto. Assim, uma campanha pode consumir o alerta que outra precisaria emitir.

Reprodução com duas campanhas ativas e relógio avançado vinte minutos: apenas a primeira produziu notificação. Reinícios e novos episódios também podem reencontrar chaves antigas.

Correção: chave composta por campanha, episódio durável de ociosidade e intervalo. Persistir o início do episódio para que reiniciar não duplique nem silencie alertas. Testar duas campanhas, reincidência e reinício. Confiança alta.

### R7. P1 potencial: verificar admissão de juiz e limite de concorrência

Local: [scheduler.mjs](../../../src/engine/scheduler.mjs), linhas 491 a 497; [dispatch.mjs](../../../src/engine/dispatch.mjs), linhas 538 a 589; [settle.mjs](../../../src/engine/settle.mjs), linha 84.

O scheduler libera o slot do worker antes do settlement. Um sibling pode ocupá-lo enquanto a prova roda. Ao terminar a prova, `startJudge` inicia diretamente outro processo. A inspeção não encontrou admissão equivalente à aplicada à revisão do worker, nem reserva comum por runtime nesse caminho.

Consequência possível: exceder `maxParallel` ou a capacidade do provedor, gerando contenção, recusa e retries. Confiança média: o fluxo foi identificado, mas a corrida não foi reproduzida nesta revisão.

Próximo passo: fixture com worker lento e prova liberada por sinal de prontidão, registrando simultaneidade de todos os papéis. Se confirmar, centralizar a admissão de worker, judge, re-ask, revisão e failover antes de cada spawn. Contar somente depois de lançar não limita a concorrência.

## O que já funciona e deve ser preservado

- Provas determinísticas antes do julgamento e dispensa de juiz quando a política permite prova mecânica suficiente.
- Evidência compacta para o juiz: stdout verde já é omitido; saídas vermelhas já têm limites por fluxo e no total.
- Revisão do plano por patch, entregue na 0.30.0. A melhoria seguinte é reduzir leituras e rodadas, sem voltar a pedir o plano inteiro.
- `reauthor` com descoberta e rodadas limitadas; respostas do operador e resolução de plano contestado já existem.
- Rotação de sessão entre siblings como padrão. O próprio código registra que reutilizar sessões longas custou 1,87 vez mais em uma medição anterior.
- `buildCampaignProgress`, métricas e brief já fornecem uma base sem chamadas a modelos. A interface deve consumir essa base.

## Plano de implementação

Cada etapa deve terminar com produto utilizável e mudança revisável. Os arquivos abaixo delimitam as áreas a alterar; os pacotes fechados de execução ainda precisam nomear os arquivos exatos afetados após discovery. Isto é um plano de melhorias, não um contrato pronto para dispatch.

| Ordem | Entrega | Principal resultado | Dependência |
| --- | --- | --- | --- |
| F1 | Corrigir R1, R2, R3 e R6; reproduzir R7 | Revisão preservada, retomada real e alertas confiáveis | Nenhuma |
| F2 | Inventário relevante e validação antes do reviewer | Menos descoberta repetida e reviews desperdiçados | F1 |
| F3 | Checkpoints de planejamento e política de gasto | Retomar do ponto comprovado e controlar novas chamadas | F2 |
| F4 | Contexto enxuto e reparo por causa | Menos tokens por resultado aceito | F2, F3 |
| F5 | Admissão comum e provas fora da fila de integração | Menor espera com concorrência controlada | F1, medição da fila |
| F6 | Estado único para CLI, painel e notificações | Usuário entende progresso, custo e próxima ação | Começar em F1 e completar após F3 |

### F1. Corrigir confiança e continuidade

Entregar R1, R2, R3 e R6 em mudanças separadas. A pausa pertence à campanha e precisa ser consultada antes de despachar, recuperar e avançar fases. A retomada remove essa intenção de pausa explicitamente. Reaproveitar os mecanismos de lock, retry e recuperação existentes.

Aceite: nenhum caminho de rotação perde critérios; controller morto é recuperado ou gera atenção com causa; pausa sobrevive a reinício; retomar realmente muda o estado; duas campanhas ociosas produzem dois alertas. R7 começa por uma reprodução e só vira correção se confirmado.

Áreas: `src/engine/phase-session.mjs`, `src/campaign/chain.mjs`, `src/campaign/record.mjs`, `src/campaign/watch.mjs`, `src/web/api.mjs`, respectivos comandos, validações e testes.

### F2. Tornar o planejamento barato antes de escolher modelos mais baratos

Corrigir R4 e R5. Separar inventário completo persistido do recorte entregue ao modelo. Materializar requisitos relevantes, dependências e testes no pacote; a seleção deve explicar o que ficou de fora. A descoberta continua restrita ao papel autorizado a explorar.

O planner atual mede candidatos de teste novamente em cada nova entrada de `runPlanningStages`. Neste repositório, o coletor encontrou 19 candidatos. Propor reaproveitamento de medições por identidade de árvore, comandos, dependências e ambiente relevante. Medição de duração serve ao dimensionamento; não substitui uma prova atual de correção. Revalidar quando a identidade mudar e não tratar timeout como duração completa.

Aceite: documentos históricos não expulsam todo o código do recorte; plano impossível de congelar não gasta uma chamada de review; nova entrada com os mesmos dados reaproveita fatos elegíveis; mudança relevante invalida o reaproveitamento.

Áreas: `src/plan/repo-facts.mjs`, `src/plan/pipeline.mjs`, `src/plan/rounds.mjs`, `src/plan/proof-check.mjs` e formatos dos fatos persistidos.

### F3. Retomar planejamento e controlar o gasto de novas chamadas

Hoje uma nova entrada do pipeline pula IDs de runs já existentes e chama `draft` novamente (`pipeline.mjs`, linhas 249 a 281). `plan --resolve` já reaproveita um plano contestado mediante respostas; falta retomada automática de uma execução de planejamento interrompida no meio.

Persistir etapa concluída, digest dos inputs, output validado, achados abertos e operação em andamento. No reinício, reconciliar a operação e reutilizar etapas compatíveis. Se spec, árvore ou política mudar, invalidar apenas os dependentes afetados, com motivo visível. A retomada não pode importar um resultado de outro commit silenciosamente.

Proponho também orçamento opcional de campanha para autorizar novas chamadas. Essa proposta requer nova ADR: a [ADR 0004](../../../docs/adr/0004-closed-task-packets-and-cross-vendor-judges.md) rejeitou explicitamente tetos que matam trabalho. A mudança sugerida reserva saldo antes do dispatch e preserva trabalho já iniciado. Inclui planejamento, execução, juízes e retries; custo desconhecido tem estado próprio e política explícita.

Reserva estimada não garante um teto absoluto: uma chamada ativa pode ultrapassá-la quando o harness só informa consumo ao terminar. Expor essa limitação. Garantia estrita exige limite suportado pelo provedor e uma política adicional para chamadas em curso. Não anunciar controle rígido quando só há bloqueio de novas chamadas.

Aceite: interromper entre draft e review não cria outro draft; repetir recuperação não duplica operação; saldo insuficiente bloqueia novo dispatch; uma cobrança tardia reconcilia a reserva; gasto desconhecido nunca vira zero.

### F4. Economizar contexto e reparar a causa do bloqueio

Ordenar prompts com instruções estáveis primeiro e estado variável depois, quando o harness permitir. Medir bytes do pacote, tokens de entrada sem cache, leitura/escrita de cache quando informadas, saída e quantidade de requisições. Um prompt menor sem redução de chamadas não garante uma campanha mais barata.

Manter revisões por patch e entregar ao reviser os nós afetados, os achados e as dependências necessárias. O reviewer precisa continuar vendo requisitos e relações suficientes para encontrar regressões fora do trecho alterado. O budget de contexto deve falhar de forma explícita se o recorte não comportar a prova, em vez de remover informação obrigatória.

Automatizar o uso do `reauthor` existente conforme classe de falha e limites aprovados. Contexto faltando pede ampliação validada; resultado inválido pede reparo de formato; problema transitório de provedor segue backoff/failover existente; ambiguidade de requisito vira pergunta durável. Usar uma assinatura de causa, nó e versão do artefato para detectar repetição sem progresso. Só texto diferente não demonstra progresso.

Escolher workers pelo custo por resultado aceito, incluindo revisões, julgamento e falhas. Manter a ordem de juízes e decisões do proprietário. Roteamento empírico começa como recomendação; a promoção automática depende da decisão Q6 já aberta no roadmap.

Aceite: repetição da mesma falha no mesmo artefato não produz chamadas indefinidas; contexto insuficiente aparece como tal; nenhum reviewer compartilha a memória de raciocínio do autor; comparação pareada mede economia sem perder detecção de defeitos.

### F5. Acelerar o trecho que efetivamente espera

Medir tempos de fila, prova, julgamento e integração separadamente. `scheduler.mjs`, linhas 427 a 442, serializa todo settlement porque a integração e a continuação compartilham estado. Provas de worktrees independentes podem ganhar uma etapa própria com limite de recursos, mantendo integração e ref compartilhada serializadas.

Começar pela admissão comum se R7 confirmar. Só depois separar provas e integração. Priorização pelo caminho crítico depende de durações medidas; usar uma ordem determinística quando elas faltarem. Aumentar workers sem conhecer o gargalo pode apenas aumentar contenção.

Há outra oportunidade em `verify.mjs`, linhas 133 a 150: uma verificação interrompida parcialmente reinicia a lista inteira. Avaliar checkpoint por comando somente para provas cuja árvore, comando, ambiente e dependências continuem iguais. Comandos mutantes ou dependentes de serviços externos exigem política explícita de invalidação. Medir o desperdício antes de adicionar esse cache.

Aceite: duas provas independentes podem avançar com limite de recursos; integração mantém exclusão mútua; o candidato integrado continua passando sua prova; resultado antigo não sobrevive a alteração relevante. Validar ordem e concorrência com sinais de prontidão, sem testes que imponham duração máxima à máquina.

### F6. Mostrar o que aconteceu, o que falta e quem age

Estender a projeção existente em `src/report/progress.mjs` e fazê-la alimentar todas as superfícies. Corrigir divergências de significado, como cancelado apresentado como concluído, e distinguir heartbeat do coordenador de progresso efetivo dos filhos.

Na visão principal, mostrar:

- Objetivo, fase e requisitos comprovados sobre o total, com revisão do plano identificada quando o denominador mudar.
- Atividade atual e tempo desde o último progresso útil; espera por provedor, prova, orçamento e decisão devem ter motivos distintos.
- Custo conhecido, parte sem medição, reservas e orçamento, quando configurado. Planejamento aparece separado de implementação e julgamento.
- Próxima ação, responsável e execução automática ou dependência de decisão. Exibir recuperação em andamento e limite restante.
- Acesso às evidências, achados e logs. ETA só quando houver base comparável, em intervalo e com incerteza.

Texto ilustrativo com placeholders, sem números fictícios de uma campanha real:

```text
Implementando <objetivo>, fase <atual>/<total>.
<comprovados>/<requisitos> requisitos comprovados.
Agora: validando <nó>. Último avanço: <tempo>.
Custo conhecido: <valor>. Sem medição: <quantidade> chamadas.
Próximo passo: <ação>, <automática ou decisão necessária>.
```

Notificar transições úteis: fase concluída, recuperação esgotada, decisão necessária e resultado final. Progresso do mesmo assunto pode editar a mensagem anterior dentro da janela de 15 minutos definida pelo projeto. Eventos que precisam de atenção recebem mensagem nova. Guardar o recibo e só afirmar entrega quando houver `message_id`. Gerar a narrativa a partir do estado, sem gastar uma chamada de modelo por atualização.

Aceite: CLI, painel e mensagem concordam sobre motivo de espera e próximo passo; evento repetido é deduplicado, outro episódio não; interface nunca anuncia retomada sem ação registrada. As correções básicas de estado começam em F1, sem esperar pelas otimizações seguintes.

## Como verificar o ganho

Usar custo e tempo até requisito comprovado como medidas principais. Acompanhar planejamento versus execução, chamadas por etapa, sucesso na primeira tentativa, achados reabertos, tempo sem progresso, trabalho repetido após crash e intervenções por motivo. Reduzir perguntas necessárias sobre requisitos não é uma meta.

Primeiro rodar cenários determinísticos com provedores falsos: falha de controller, pausa/retomada, saturação de slots, repetição de achado, corte de inventário e recuperação entre etapas. Eles verificam o mecanismo sem gastar tokens.

Depois comparar baseline 0.30.0 e mudança com as mesmas tarefas, commits de entrada, políticas de modelos e critérios de aceite. Incluir trabalho pequeno, dependências entre módulos e falhas induzidas; repetir execuções suficientes para mostrar dispersão. Separar cache frio e quente. Fixar previamente o orçamento do experimento e preservar todas as tentativas, inclusive recusas.

Uma melhoria é aceita quando reduz custo ou tempo sem piorar o aceite independente dos requisitos e a detecção dos defeitos conhecidos. Reportar tamanho da amostra e incerteza. Este review não sustenta uma promessa de redução percentual.

## Verificação realizada e reprodução dos números

Rodado nesta revisão:

```sh
node --test --test-concurrency=1 test/plan/repo-facts.test.mjs test/plan/rounds.test.mjs test/web/api.test.mjs
```

Resultado: 28 testes passaram, zero falhas, aproximadamente 6,20 segundos. Esses testes não cobrem os cenários defeituosos identificados. Não foi rodada a suíte completa nem uma campanha paga.

Para recalcular cada campanha, substituir `<id>` pelo nome da tabela:

```sh
node bin/faberun.mjs metrics <id> --ledger docs/campaigns/<id>/ledger --json
```

Para conferir o corte alfabético, no commit revisado:

```sh
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
const all = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').sort();
const selected = all.slice(0, 2000);
console.log({ total: all.length, source: selected.filter(p => p.startsWith('src/')).length,
  tests: selected.filter(p => p.startsWith('test/')).length, last: selected.at(-1) });
NODE
```

As reproduções de R1, R2, R3 e R6 foram locais, sem alterações em `src/` ou `test/`. Seus cenários e resultados estão descritos nos achados; devem virar testes de regressão junto de cada correção. R7 requer a reprodução indicada antes de ser tratado como bug confirmado.

## Relação com decisões e referências

O plano aproveita RM-016 a RM-021 (medição e roteamento), RM-024 (encadear planejamento de fases), RM-025 já entregue (`reauthor`), RM-032 (loops) e RM-033 (perguntas assíncronas). Não reabre AP9/RM-108, adiado pelo proprietário, nem antecipa a memória entre harnesses de P9. Memória entra depois de uma baseline estável, conforme D6.

Os padrões externos consultados apoiam escolhas específicas, não justificam trocar a stack: separar execução durável e retry por etapa é o padrão descrito na [documentação do Temporal](https://docs.temporal.io/tasks). Para contexto, a [documentação de prompt caching da Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) exige prefixos idênticos; a aplicação disso depende do controle oferecido por cada harness. A preferência por fluxos simples e avaliações antes de aumentar a autonomia segue [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents). Os ganhos propostos para Faberun continuam dependendo dos experimentos acima.
