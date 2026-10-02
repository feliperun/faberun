---
id: campaign-efficiency
title: "Campanhas rápidas, assertivas, econômicas e visíveis"
version: 1.0.0
status: draft
date: 2026-09-29
owner: Felipe Broering
target: feliperun/faberun
baseline: 63760490
---

# Campanhas rápidas, assertivas, econômicas e visíveis

## Intenção

Corrigir os sete achados do [review de 29/09/2026](../../../reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md) e implementar as melhorias F1 a F6 que ele fundamenta. A campanha usa o próprio faberun, mas a prova final de correção é a suíte do repositório. O review é uma leitura do código com reproduções locais; ele não é uma execução da campanha.

Na campanha histórica `safe-to-hand-to-a-friend`, 92 de 102 runs foram de planejamento e representaram 90,87% do custo conhecido. São dados anteriores à versão 0.30.0. Não atribuir a este trabalho uma economia percentual sem comparação nova e pareada.

Fases: F1 corrige confiança e continuidade; F2 evita trabalho pago que uma checagem local recusaria; F3 retoma planejamento e registra gasto antes de novas chamadas; F4 reduz contexto e reparos repetidos; F5 acelera as provas independentes; F6 mostra o estado real a quem opera a campanha. Cada fase usa os mesmos IDs de achado R1 a R7. A conclusão de uma fase não implica que todas as extensões daquele requisito estejam concluídas.

## Requisitos

### R1. O juiz conserva critérios e evidências ao trocar de sessão

- **statement:** a rotação de sessão preserva o prompt efetivo do juiz, inclusive definição de pronto, evidências e instrução de re-ask. O juiz continua read-only e independente do raciocínio do worker. A fase F4 mede bytes e tokens do prompt, sem cortar conteúdo obrigatório.
- **proof:** command: node --test --test-concurrency=1 test/engine/failover.test.mjs

**origin:** review R1, `src/engine/phase-session.mjs:103-105,192-215` e `src/engine/dispatch.mjs:531-541`.

### R2. A campanha recupera um controller morto após o bootstrap

- **statement:** um run inacabado cujo controller morreu é retomado sem duplicar invocações, respeitando lock, identidade e intenção persistida de pausa. Uma recuperação esgotada vira atenção explícita, e a fase F3 preserva estágios concluídos do planejamento quando seus inputs ainda conferem.
- **proof:** command: node --test --test-concurrency=1 test/campaign/chain-restart.test.mjs test/plan/pipeline.test.mjs

**origin:** review R2, `src/campaign/chain.mjs:506-549` e `src/cli/campaign.mjs:428`.

### R3. Pausar e retomar produz ações verificáveis

- **statement:** o painel persiste a intenção de pausa e consegue retomar os runs cancelados por ela, desbloqueando a cadeia. Respostas distinguem ação aplicada, ação pendente e nenhuma ação necessária; a fase F6 mostra o mesmo estado e a próxima ação no CLI e no painel.
- **proof:** command: node --test --test-concurrency=1 test/web/api.test.mjs

**origin:** review R3, `src/web/api.mjs:142-146,226-238`.

### R4. O inventário e o contexto incluem o código relevante

- **statement:** em um repositório com mais de 2.000 caminhos, documentos históricos não expulsam todos os arquivos de código e teste do inventário apresentado ao planner. O índice completo permanece consultável, omissões são explícitas e F3/F4 reaproveitam fatos válidos e selecionam somente contexto necessário.
- **proof:** command: node --test --test-concurrency=1 test/plan/repo-facts.test.mjs

**origin:** review R4, `src/plan/repo-facts.mjs:306-328`.

### R5. Falhas determinísticas são tratadas antes de gastar com reviewer

- **statement:** a checagem completa da possibilidade de congelar antecede o review sem consumir rodadas extras ilimitadas. F3 registra custo de planejamento, execução, juiz e retries com desconhecidos separados de zero. Qualquer política para reservar saldo antes de novas chamadas exige decisão nova em ADR, pois a ADR 0004 rejeitou teto que interrompe trabalho em curso. F4 detecta reparos sem progresso.
- **proof:** command: node --test --test-concurrency=1 test/plan/rounds.test.mjs test/plan/pipeline.test.mjs

**origin:** review R5, `src/plan/rounds.mjs:377,404`, e plano F3/F4 do mesmo review.

### R6. Alertas e progresso identificam a campanha e o episódio

- **statement:** duas campanhas ociosas emitem alertas distintos; outro episódio da mesma campanha volta a alertar e um reinício não duplica mensagens. F6 expõe objetivo, fase, requisitos comprovados, atividade, motivo da espera, custo conhecido, custo não medido e próxima ação a partir de estado persistido.
- **proof:** command: node --test --test-concurrency=1 test/campaign/watch.test.mjs test/report/progress.test.mjs

**origin:** review R6, `src/campaign/watch.mjs:122` e `src/notify/index.mjs:408`.

### R7. A admissão respeita capacidade antes de lançar processos

- **statement:** primeiro reproduzir ou refutar a possível ultrapassagem de `maxParallel` e `maxConcurrent` quando juiz e worker concorrem. Só corrigir se a prova confirmar. Na fase F5, medir fila, prova e integração; provas de worktrees independentes podem avançar em paralelo dentro da capacidade comprovada da máquina, mantendo a integração serializada.
- **proof:** command: node --test --test-concurrency=1 test/engine/max-parallel.test.mjs

**origin:** review R7, `src/engine/scheduler.mjs:491-497`, `src/engine/dispatch.mjs:538-589` e `src/engine/settle.mjs:84`.

## Não-objetivos

- Corrigir defeitos externos aos sete achados ou introduzir novos requisitos de produto.
- Trocar a stack, os provedores definidos ou a regra de fornecedores diferentes para worker e juiz.
- Mudar a ADR 0004 sem registrar a nova decisão e sem preservar chamadas já iniciadas.
- Declarar economia, ETA ou capacidade do host a partir apenas da sonda HTTP do provedor.
- Fazer merge, deploy ou alteração destrutiva de dados de produção nesta campanha.

## Restrições

- Todo contrato de execução vem do `faberun plan`, é validado e fica imutável depois de lançado. Derivações são registradas como novos contratos.
- Worker: `fx-deepseek` (DeepSeek Flash, escrita). Juiz: `codex-sol` (GPT Sol high, leitura). Revisor adversarial do plano: `codex-astra` (Astra high, leitura). Nenhum segredo entra no catálogo versionado.
- O máximo pedido de seis invocações deve ser confrontado com a largura do DAG e com a capacidade do host. A versão 0.30.0 limita o paralelismo provado pelo planner a dois porque o histórico registra três OOM; a campanha documenta essa restrição e não a eleva sem medição de processos reais.
- Provas `node --test` nomeiam seus arquivos; testes não chamam provedores. `npm run typecheck`, `npm run check` e a suíte final são medidos antes de entrar no contrato.
- `AGENTS.md` é o único arquivo de orientação. Specs e contratos históricos são imutáveis após execução.

## Critério de sucesso

| Indicador | Baseline | Alvo |
| --- | --- | --- |
| Contexto obrigatório preservado na rotação de juiz | reprodução R1 perde evidência e re-ask | preservado em teste de regressão |
| Recuperação de controller morto após bootstrap | reprodução R2 espera sem novo lançamento | o mesmo run retoma ou gera atenção |
| Retomada pelo painel após cancelamento | HTTP 200 com `results: []` | ação real ou motivo de nenhuma ação |
| Caminhos `src/` entre os primeiros 2.000 fatos | 0 de 199 arquivos rastreados no HEAD do review | código relevante incluído e omissões nomeadas |
| Review pago antes do preflight que falha | chamada ocorre primeiro | preflight falha sem chamada de review |
| Alertas de duas campanhas ociosas | só a primeira notifica | ambas notificam |
| Concorrência de juiz além do limite | hipótese não reproduzida | hipótese testada e limite respeitado se confirmado |
| Gasto histórico de planejamento em `safe-to-hand-to-a-friend` | US$ 33,5332 conhecidos, 3 invocações sem preço | baseline nova e comparação pareada, sem promessa percentual |
