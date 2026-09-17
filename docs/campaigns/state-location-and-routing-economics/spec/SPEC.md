---
id: state-location-and-routing-economics
title: "Estado fora do repositório, entregável rastreado e economia de roteamento"
version: 1.1.0
status: draft
date: 2026-09-16
owner: Felipe Broering
target: feliperun/faberun
baseline: 82f4763
---

# Estado fora do repositório, entregável rastreado e economia de roteamento

## Intenção

Três frentes independentes, agrupadas porque nenhuma depende das outras e todas
podem pousar em qualquer ordem.

**Estado fora do repositório.** O diretório de execução vive dentro do
repositório alvo, e seu caminho é construído por concatenação literal em 83
pontos do código. Worktrees de tentativa também vivem dentro da árvore do alvo,
onde podem ser varridos por glob, linter ou test runner de quem não sabe que
eles existem. Um projeto não tem lugar único onde suas campanhas possam ser
vistas, e não há forma de expurgar execução antiga sem mexer no repositório de
trabalho. Mover o estado para a home do usuário centraliza a resolução de
caminho, tira os worktrees do alcance de varredura, dá visão de várias campanhas
em um lugar só, e permite expurgo controlado, como os harnesses já fazem com
seus próprios transcripts.

**Entregável rastreado.** Uma campanha hoje produz um merge e um registro, mas
nada confronta o entregue com o pretendido. Os requisitos da spec já têm
identificador estável, e o registro já guarda contratos, ledger e retrospectiva.
Falta o elo: o plano não carrega os identificadores até os nós, e o encerramento
não reporta qual requisito ficou sem cobertura. Sem esse elo, "a campanha
fechou" significa que os nós terminaram, não que a intenção foi atendida, e a
camada de evidência futura não terá onde ancorar.

**Economia de roteamento.** O roteamento resolve runtime por vendor, faixa e
ordem de custo. Ele não usa o horário de reset que o envelope de provedor já
carrega, e não preserva afinidade de prefixo entre tentativas do mesmo nó, onde
trocar de runtime joga fora o cache da tentativa anterior. Junto disso, a classe
estocástica de eval está desenhada e nunca rodou, porque suíte cara sem horário
próprio não roda, e verificação de mutação continua ausente apesar de a suíte já
caber no orçamento de tempo.

## Estado medido

`82f4763`, container Linux limpo, dependências instaladas.

| Indicador | Hoje | Alvo |
| --- | --- | --- |
| Referências literais ao caminho de execução em `src/` | 83 | 0 fora do resolvedor |
| Worktrees de tentativa dentro da árvore do alvo | sim | não |
| Campanhas de um projeto visíveis em um lugar | não | sim |
| Expurgo de execução antiga | manual, no repositório | comando, na home |
| Identificador de requisito presente no nó | não | sim |
| Requisito sem cobertura reportado no encerramento | não | sim |
| Roteamento usa horário de reset antes da falha | não | sim |
| Afinidade de prefixo entre tentativas do mesmo nó | não | sim |
| Estratégia de roteamento como campo declarado | não | sim |
| Workflows de CI | 3 | mais a agenda noturna |
| Classe estocástica de eval executada | nunca | semanal, no mínimo |
| Verificação de mutação | ausente | presente |

Peças existentes que o trabalho reusa em vez de reimplementar: `FABERUN_HOME`,
o ponteiro de estado de 1 KiB, `exhaustedUntil` e `error.resetAt` no envelope de
provedor, a amostragem de allowance do assento, o driver determinístico de
replay, a preservação de ledger no registro, a tabela de roteamento existente e
os identificadores de requisito do formato de spec.

## Requisitos

### R1. A resolução de caminho de execução é centralizada

- **statement:** um único módulo resolve caminho de run, campanha e worktree;
  nenhum outro arquivo de `src/`, `test/` ou `evals/` constrói esse caminho por
  concatenação literal.
- **proof:** `command: node --test --test-name-pattern="run path resolution is centralized"`

### R2. O estado de execução vive fora do repositório alvo

- **statement:** runs, worktrees de tentativa, journal, ledger e heartbeat vivem
  sob a home do usuário, organizados por projeto e campanha; nenhum artefato
  durável de execução é criado dentro da árvore do repositório alvo.
- **proof:** `command: node --test --test-name-pattern="no durable run state inside target repo"`

### R3. O sidecar de resultado permanece onde o protocolo o coloca

- **statement:** o sidecar que o worker escreve dentro do worktree de tentativa
  não é afetado pela mudança de layout; as exclusões de pathspec que o protegem,
  e a que protege o symlink de dependências, permanecem justificadas por
  comentário no código e cobertas por teste.
- **proof:** `command: node --test --test-name-pattern="attempt sidecar protocol unchanged"`

### R4. Um projeto é identificado por caminho, com recuperação

- **statement:** o projeto é chaveado pelo caminho do repositório; cada projeto
  registra caminho e remote conhecidos; existe um comando que reassocia um
  projeto cujo caminho mudou, sem perder campanhas; dois clones em caminhos
  distintos são projetos distintos.
- **proof:** `command: node --test --test-name-pattern="project identity"`

### R5. Scratch de toolchain é resolvido por variável, nunca por caminho literal

- **statement:** o runner exporta a variável de scratch apontando para dentro do
  run dir, a referência de contrato instrui o uso da variável, e nenhum packet
  cita caminho literal de diretório de execução.
- **proof:** `command: node --test --test-name-pattern="scratch resolved by env"`

### R6. O ponteiro ambiente tem caminho estável

- **statement:** existe um ponteiro global de no máximo 1 KiB na home apontando
  para o run ativo, e a integração de status line o lê por caminho fixo, sem
  glob nem ordenação por data de modificação.
- **proof:** `command: node --test --test-name-pattern="global pointer"`

### R7. A migração é segura, idempotente e reversível

- **statement:** existe um comando de migração que recusa executar com lease
  vivo, copia e verifica antes de remover, pode ser executado duas vezes sem
  efeito adicional, e durante uma versão a leitura aceita os dois layouts com
  aviso.
- **proof:** `command: node --test --test-name-pattern="migrate runs"`

### R8. O expurgo nunca come insumo de medição

- **statement:** o expurgo de runs antigos é opt-in, nunca automático, recusa
  remover campanha cujo ledger ainda não foi preservado no registro, e reporta o
  que removeria antes de remover.
- **proof:** `command: node --test --test-name-pattern="prune refuses unpreserved"`

### R9. O plano declara quais requisitos cada fase atende

- **statement:** o plano congelado declara, por fase, os identificadores de
  requisito que ela atende e o entregável que produz, em uma frase; fase sem
  requisito associado é reportada pela validação de plano.
- **proof:** `command: node --test --test-name-pattern="plan phase declares requirements"`

### R10. O identificador de requisito viaja até o nó

- **statement:** o contrato preserva, por nó, os identificadores de requisito
  herdados da fase, e o resultado de worker os carrega de volta sem que o worker
  precise declará-los.
- **proof:** `command: node --test --test-name-pattern="requirement ids reach the node"`

### R11. O encerramento confronta entregue com pretendido

- **statement:** encerrar uma campanha grava no registro, deterministicamente e
  sem invocar modelo, o mapa de requisito para nó para evidência de verificação,
  marcando requisito não coberto como aberto em vez de omiti-lo; a correlação sai
  dos identificadores carregados, nunca de casamento por texto.
- **proof:** `command: node --test --test-name-pattern="closure maps requirements to nodes"`

### R12. O catálogo de runtime registra apenas o que é observável

- **statement:** a descoberta registra, por runtime, o que o harness de fato
  reporta: horário de reset e janela de exaustão quando existirem, allowance
  restante apenas nos harnesses que a expõem, e quando cada dado foi observado;
  dado ausente é nulo, nunca zero e nunca folga cheia, e dado mais antigo que sua
  própria janela é tratado como desconhecido.
- **proof:** `command: node --test --test-name-pattern="runtime observability catalogue"`

### R13. Estratégia de roteamento é campo declarado

- **statement:** a tabela aceita uma estratégia nomeada por regra, com no mínimo
  prioridade, custo, proximidade de reset e afinidade de tentativa; a estratégia
  aplicada e o motivo da escolha ficam registrados na atribuição; estratégia que
  depende de dado não observável para o runtime em questão é inerte, não
  falha.
- **proof:** `command: node --test --test-name-pattern="routing strategy declared"`

### R14. A afinidade de prefixo vale dentro do mesmo nó

- **statement:** tentativas e revisões sucessivas do mesmo nó preferem o runtime
  da tentativa anterior enquanto ele estiver saudável e não exausto, e cedem
  para as demais regras quando isso violaria distinção de vendor, escopo ou
  disponibilidade.
- **proof:** `command: node --test --test-name-pattern="attempt affinity yields to correctness"`

### R15. A instrução de runtime do operador ganha de qualquer estratégia

- **statement:** runtime declarado pelo operador na invocação persiste no
  contrato congelado e prevalece sobre a tabela e sobre a estratégia.
- **proof:** `command: node --test --test-name-pattern="operator override wins"`

### R16. A repetição de payload entre tentativas é medida antes de ser tratada

- **statement:** o relatório expõe quantos bytes de packet se repetem entre
  tentativas sucessivas do mesmo nó, para que a decisão de deduplicar seja
  tomada sobre dado; esta spec não pede deduplicação.
- **proof:** `command: node --test --test-name-pattern="report exposes repeated packet bytes"`

### R17. A classe estocástica tem horário próprio

- **statement:** as suítes caras rodam em agenda noturna, fora do caminho de
  merge; regressão estocástica abre issue com dono declarado e não bloqueia pull
  request; a classe determinística continua bloqueando.
- **proof:** `path: .github/workflows/`

### R18. Mutação detecta teste sem asserção

- **statement:** existe verificação de mutação escopada aos caminhos de escrita
  do nó, com limiar declarado por nível de risco, que reprova quando um teste
  não mata o mutante correspondente, e que completa dentro do orçamento de tempo
  declarado.
- **proof:** `command: node --test --test-name-pattern="mutation catches empty test"`

### R19. Resiliência é exercitada, não só documentada

- **statement:** a tabela de política de falha é exercitada em agenda noturna
  pelo driver determinístico, injetando cada classe de falha declarada, e
  nenhuma recuperação invoca modelo.
- **proof:** `command: node evals/run.mjs --class resilience --assert-no-model`

## Não-objetivos

- Alterar o protocolo entre runner e worker. O sidecar de resultado continua
  sendo escrito onde é hoje; R3 existe para impedir que a migração o arraste
  junto.
- Roteamento por folga de quota em harness que não a reporta. R12 registra o que
  é observável; inventar folga a partir de ausência de falha é pior que não ter
  a estratégia.
- Afinidade de cache entre nós distintos. Packets distintos têm prefixos
  distintos, e nenhuma decisão de roteamento muda isso.
- Deduplicação de payload. R16 mede; deduplicar é decisão de outra spec, tomada
  sobre o número.
- Compressão com perda em qualquer caminho que alimente evidência. Se um
  artefato de evidência contém saída transformada por modelo, deixou de ser
  evidência.
- Contornar bloqueio de provedor por proxy, disfarce de tráfego ou rotação de
  identidade.
- Painel de modelos com síntese por juiz. O juiz é revisor independente, nunca
  co-autor.
- Agregar provedores, catalogar camadas gratuitas ou expor endpoint único. O
  produto orquestra trabalho, não roteia requisição de terceiros.
- Alterar qualquer registro existente em `docs/campaigns/`. R11 vale para
  campanhas encerradas daqui em diante.
- Fases ou decomposição no formato de spec. R9 e R10 vivem no plano e no
  contrato, que é onde a decomposição mora.
- Camada de evidência ancorada em requisito, com sonda e cadeia de digest.
  Continua bloco posterior; R9 a R11 preparam a âncora sem construí-la.
- Reduzir contagem de linhas ou de arquivos como objetivo.

## Restrições

Dependências de ordem, que valem como restrição e não como decomposição:

- R1 pousa antes de R2. Centralizar a resolução é o que torna a mudança de
  layout testável contra os dois lados.
- R3 pousa junto de R2, nunca depois. A migração precisa saber, no momento em
  que move, o que não deve ser movido.
- R7 pousa junto de R2. Migração atrasada encontra estado dividido entre dois
  layouts.
- R8 pousa antes de qualquer expurgo ser oferecido ao operador.
- R10 pousa antes de R11. O encerramento só correlaciona o que o contrato
  carregou.
- R12 pousa antes de R13. Estratégia sem catálogo de observabilidade decide
  sobre dado inventado.
- R17 pousa antes de R18 e R19, que são suas primeiras cargas.

Convenções de execução:

- Nenhum packet manda o worker rodar a suíte inteira; verificação é do
  controlador, com o arquivo de teste específico do nó.
- Toda verificação tem duração medida antes de ter tempo limite declarado.
- Um contrato por fase, com todos os nós e arestas autorados num turno só.
- Nenhum teste depende de relógio de parede, de binário no PATH, ou de layout de
  máquina.
- Todo teto de documento novo ou ampliado segue o ratchet datado já vigente,
  incluindo o teto do roteador de skill, o teto da pasta de referências e a
  asserção de quais documentos ela contém.
- O juiz mantém vendor resolvido distinto do worker e das arestas de fallback de
  ambos.

## Critério de sucesso

| Métrica | Baseline | Alvo | Fonte |
| --- | --- | --- | --- |
| Referências literais ao caminho de execução | 83 | 0 fora do resolvedor | testes |
| Worktrees de tentativa dentro da árvore do alvo | sim | não | testes |
| Campanhas encerradas com mapa de requisito para nó | 0 | 100% das novas | registro |
| Requisitos sem cobertura reportados no encerramento | não reportado | reportado | registro |
| Trocas de runtime entre tentativas do mesmo nó | não medido | cai | `usage.jsonl` |
| Proporção de leitura cacheada sobre entrada crua | 17 para 1 na baseline | não cai | `usage.jsonl` |
| Bytes de packet repetidos entre tentativas | não medido | medido | relatório |
| `costPerClosedCheckpoint` | `evals/baseline.json` | não sobe | evals |
| Classe estocástica executada | nunca | semanal, no mínimo | agenda |
| Mutantes sobreviventes em caminho tocado | não medido | abaixo do limiar declarado | noturno |
| Classes de falha exercitadas por execução noturna | 0 | todas as declaradas | noturno |

Se a afinidade de tentativa não reduzir trocas de runtime nem melhorar a
proporção de cache, o desfecho correto é manter a tabela simples e registrar o
experimento.

## Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| A migração arrasta o sidecar de resultado e quebra o protocolo de tentativa | alto | R3 declara o que não se move; pousa junto de R2 |
| A migração perde run ou corrompe campanha em curso | alto | R7: recusa com lease vivo, copia e verifica antes de remover, leitura compatível por uma versão |
| O expurgo apaga ledger de campanha ainda não preservada | alto | R8 recusa; a preservação de ledger no registro já está vigente |
| Projeto renomeado ou movido órfã suas campanhas | médio | R4: caminho como chave com remote registrado e comando de reassociação |
| Toolchain exige cache dentro da árvore do projeto | baixo | R5 resolve por variável; o worktree de tentativa é descartável |
| Estratégia decide sobre folga inventada em harness que não a reporta | alto | R12 registra só o observável; R13 torna inerte a estratégia sem dado |
| Afinidade de tentativa mantém um runtime exausto ou de vendor proibido | alto | R14 exige cessão explícita para correção e disponibilidade |
| Identificador de requisito vira campo preenchido sem pensar | médio | R10 faz o contrato carregá-lo, não o worker declará-lo; R11 expõe o não coberto |
| Suíte noturna vira alerta que ninguém lê | médio | R17 exige dono declarado na issue; determinística continua bloqueando PR |
| Mutação estoura o orçamento de tempo | baixo | R18: escopo limitado aos caminhos de escrita do nó, com limiar por risco |
