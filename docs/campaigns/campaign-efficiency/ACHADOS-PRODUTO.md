# ACHADOS-PRODUTO: campanha `campaign-efficiency`

Este livro reúne os achados de ferramenta da campanha. Cada seção apresenta o **sintoma** (a mensagem
exata do portão, do nó ou do runner), a **causa medida**, o **custo**, a **correção sugerida** e o
motivo para classificar o caso como achado de produto, não como erro de um nó.

Escopo: rodadas entre 29/09 13:47Z e 30/09 01:15Z (F1, F2, F2-reemissão e F3 em andamento), com as
evidências no journal da campanha (`journal.jsonl`) e nos `results/` das runs citadas. Custo total
da campanha no fechamento deste livro: **US$ 4,42**.

Base: branch `campaign/campaign-efficiency`, HEAD `f979117d` (ADR 0011).

---

## 1. O teto de saída de 8.192 tokens do harness `fx` mata o `draft` e não diz que era teto

- **Sintoma:** `draft: failed {"code":-32603,"message":"OutputTruncated"}`. A mensagem não cita
  nenhum limite.
- **Causa medida:** o adaptador `fx` crava **8.192** tokens de saída. F2 `plan-phase-2-draft-1`
  (29/09 17:18Z): 15 chamadas de ferramenta locais e o worker morreu quando uma resposta de
  ferramenta bateu no teto. Repetiu em F3: `plan-phase-3-draft-2` e `draft-3` morreram do mesmo jeito,
  e a transcrição isola o caso: uma consulta ampla de cobertura emitiu **exatamente 8.192** tokens de
  saída. As 14 respostas FX observadas foram **HTTP 200**; o maior resultado seguro anterior tinha
  6.658 tokens. Não é cota, não é credencial: é teto de saída.
- **Custo:** 3 runs de planejamento falhadas (US$ 0,0147 + 0,0166 + 0,0654 ≈ **US$ 0,10**), mais o
  desvio de um contrato inteiro (`phase-3-bounded-draft-output`, US$ 0,0125) para limitar consulta,
  além do atraso de ~2 h no cronograma da F3.
- **Correção sugerida:** declarar `max_output_tokens` no catálogo `--runtimes` do contrato (o teto
  real do provedor é 393.216) e fazer o adaptador **recusar** em vez de herdar 8192. Melhor ainda: o
  erro de teto deve dizer `output truncated at N tokens` no `status.json`, não um `-32603` genérico.
- **Por que é achado de produto:** qualquer usuário novo que peça um rascunho de plano num repositório
  de tamanho médio bate nisso no primeiro dia, e o erro não nomeia a causa. O conserto é do
  adaptador e do catálogo, não do plano de nenhuma campanha.

## 2. O motor não respeita `maxParallel` abaixo do cap do runtime, e o despacho começa durante o portão

- **Sintoma:** dois nós do mesmo contrato rodando juntos com `maxParallel: 1`.
- **Causa medida:** reproduzido **duas vezes** com evidência de heartbeat. Em 29/09 18:03Z,
  `r4-inventory` e `r5-checks` aparecem simultaneamente `running`/`executionPhase=worker`, ambos em
  `fx-deepseek`, embora o contrato `phase-2` declare `maxParallel=1`. O cap `maxConcurrent=6` do
  runtime venceu o contrato. Em 19:52Z de novo: `r5-preflight-before-review` começou às 19:52:09Z
  enquanto `r4-omission-kinds` ainda estava no **gate de verificação**.
- **Custo:** é a origem do nó `r7-judge-concurrency-measured` (still `advisory`) e da F5 existente;
  contabilizado aqui como risco de contenção, com as duas reproduções como prova. O R7 do review
  deixa de ser "potencial": está confirmado por medição.
- **Correção sugerida:** um único portão de admissão deve aplicar o `maxParallel` congelado em todas
  as etapas, inclusive quando `maxConcurrent` do runtime é maior ou outro nó está no gate de
  verificação. Registre o número efetivo de nós concorrentes no `status.json` para a prova ficar
  barata. **Fechado na F5:** admissão comum antes de cada spawn
  ([decisão de admissão](decisions/phase-5-admission.md)) e teto de concorrência medido no host com
  processos reais ([medição do fechamento](decisions/phase-5-host-measurement.md)), com a prova R7 do
  comando da spec executada pelo controlador no fechamento do nó `n6-measure-close`.
- **Por que é achado de produto:** o contrato é a promessa que o operador lê para decidir custo e
  contenção; um limite de plano que o motor ignora em silêncio invalida todo o diagnóstico de
  paralelismo que a ferramenta se propõe a fazer.

## 3. Omissão do artefato de `repo-facts` não identifica o que foi descartado

- **Sintoma:** gate fail major no item `r4-omission-text-legible` do juiz Sol: *"o grupo
  `omitted.groups.other` não identifica se as fontes descartadas são documentos, logs arquivados,
  manifests ou mistura"*.
- **Causa medida:** `src/plan/repo-facts.mjs` corta o array `paths` por limite de bytes e o texto da
  omissão não classifica o que ficou de fora. Os contadores e as amostras satisfaziam os itens
  determinísticos; o que reprovou foi a **legibilidade** da omissão.
- **Custo:** 1 run com gate fail (parte dos US$ 1,12 da família F2-reemissão) e uma rodada de
  revisão a mais no contrato de reemissão.
- **Correção sugerida:** a omissão passa a dizer **classe e contagem** por classe
  (`documents: N`, `archived logs: N`, ...), com o corte declarando também o critério aplicado.
  Fechada em `ace6e062` (`r4-omission-kinds`).
- **Por que é achado de produto:** o artefato de fatos do repositório é a entrada de todo plano; uma
  omissão ilegível impede o planejador de saber o que ficou de fora. O defeito reaparece em qualquer
  campanha com repositório grande.

## 4. O pacote declara menos escopo do que o worker de fato consulta

- **Sintoma:** o operador interrompeu o aceite do nó `r5-checks` (29/09 18:15Z) e depois o `typecheck`
  global falhou em `r4` (19:41Z).
- **Causa medida:** duas formas do mesmo defeito. (a) O log do worker mostrou consultas via `execute`
  a `src/plan/freeze.mjs`, `src/contract/index.mjs`, `src/contract/definition-of-done.mjs` e
  `test/integrations/first-campaign.test.mjs`, **ausentes** de `readFiles` e `scopeAcknowledged` do
  pacote. (b) Em `r4`, o `npm run typecheck` reprovou porque `test/plan/proof-check.test.mjs`
  constrói `RepoFacts` sem os novos `pathCut` e `pathIndex`. A mudança também forçava editar esse
  teste, que estava fora de `readFiles`/`writeFiles`.
- **Custo:** 1 run cancelada antes de qualquer diff, 1 run reprovada no portão global e a derivação de
  dois contratos corretivos (`packet-closed` US$ 0,0918, `read-closed` US$ 0,3142), cerca de
  **US$ 0,41** para consertar escopo, sem contar o relógio.
- **Correção sugerida:** o `freeze` deve cruzar a mudança com os testes de guarda que enumeram
  artefatos (o caso `proof-check.test.mjs` é detectável por `repoFacts`) e **exigir** que o arquivo
  entre em `writeFiles`, com o motivo no `taskPacket`. Para leitura, o `proof`/`readFiles` do nó deve
  ser derivado do próprio candidato de verificação, não escrito à mão.
- **Por que é achado de produto:** é a família de defeito que mais queimou rodadas nesta campanha
  (`writeFiles` estreito → nó morre por construção → nó seguinte bloqueia em cascata), e o portão
  tem toda a informação para reprovar isso **no congelamento**, não depois de pagar o worker.

## 5. Regra de revisão não é portátil entre o faberun e o repositório-alvo

- **Sintoma:** major finding do juiz em `r5-packet-declares-rules` (29/09 22:50Z): *"`PLAN_RULE_READ_FILES`
  aponta para fonte/testes do Faberun, mas a revisão a jusante resolve `readFiles` no repositório-alvo,
  onde esses caminhos podem estar ausentes ou não ter relação"*.
- **Causa medida:** o template de pacote embutia uma lista de caminhos **do próprio faberun**; quando o
  pacote é revisado num repositório de terceiro (o caso de uso real), a lista aponta para o vazio.
- **Custo:** um ciclo de reemissão inteiro só para isso: run `portable-review-context` (US$ 0,0592) mais
  a promoção posterior, no fim da F2-reemissão.
- **Correção sugerida:** regras de revisão viajam **inline** no pacote, não por referência a caminhos.
  Fechado em `fd261bac` (remove `PLAN_RULE_READ_FILES` do pacote gerado e carrega as regras no corpo).
- **Por que é achado de produto:** o faberun é instalado em repositórios de terceiros por definição;
  pacote que só funciona no repositório de origem é defeito de portabilidade, não de um nó.

## 6. Plano contestado/rejeitado não tem artefato retomável, e o operador reconstrói à mão

- **Sintoma:** 29/09 19:07Z: *"o registro `contested` não tem plan reanudável, mas o último candidato
  `plan-round-1-rejected.json` contém o plano de três nós correto"*.
- **Causa medida:** o pipeline guarda os candidatos rejeitados (`plan-round-1-rejected.json`,
  `findings-round-1-retry.json`) mas **não** deixa um plano retomável quando o estágio termina
  contestado. Quem continua precisa reconstruir o estado a partir de um candidato que já foi
  descartado, e provar por fora que era o bom.
- **Custo:** inspeção manual no meio do ciclo, com risco real de retomar o candidato errado; soma ao
  relógio da família F2-reemissão (3 h 47 min de parede).
- **Correção sugerida:** o gate que contesta deve materializar o candidato aceitável como plano
  retomável (`plan-round-N-resumable.json`) com o motivo da contestação ao lado, em vez de deixar o
  operador escolher entre arquivos rejeitados.
- **Por que é achado de produto:** qualquer campanha que passe por revisão adversarial chega nesse
  estado; exigir arqueologia de arquivo rejeitado para continuar transforma um fluxo mecânico em
  decisão humana.

## 7. A CLI recusa `plan --resolve` antes do despacho

- **Sintoma:** 29/09 19:11Z: *"o CLI rejeita `plan --resolve` antes do despacho: `parseArgs` aceita a
  forma documentada, mas `main` ainda exige um target de spec em `if (!target)`"*.
- **Causa medida:** a forma documentada e a implementação divergiam. A validação de argumentos e o
  despacho não aceitavam o mesmo contrato. O fluxo equivalente **existe** em
  `src/plan/resolve.mjs`, mas não é alcançável pela CLI.
- **Custo:** o operador teve de contornar pela API interna do módulo; interface e biblioteca passam a
  ter comportamentos diferentes, e todo comando documentado no brief fica não confiável.
- **Correção sugerida:** `main` deve aceitar o alvo de spec **ou** a resolução por pergunta pendente,
  com teste de CLI cobrindo as duas formas (hoje só a biblioteca é testada).
- **Por que é achado de produto:** a CLI é a interface do operador; divergência entre o que ela diz
  aceitar e o que ela aceita é o defeito que faz o dono desconfiar da ferramenta inteira.
- **Reproduzido na F5 (02/10):** `src/cli.mjs:390` (`if (!target) { usage(); return; }`) vem antes do
  despacho do `plan` (`src/cli.mjs:556`) e `--resolve` não aceita posicional, então no 0.30.0 o comando
  nunca chega a `resolvePlanCli`. Contornado chamando `resolvePlanningPipeline` de `src/plan/resolve.mjs`
  direto, com as respostas `f1=accept` e `f2=accept`.

## 8. Erros de forma no `definitionOfDone` consomem rodadas de `revise` inteiras

- **Sintoma:** 29/09 19:00Z: *"a validação encontrou um segundo erro de forma: `proof` continha o campo
  `judgment`, que não é permitido nesse objeto"*; e antes: nó local com `npm run check` no lugar de
  prova escopada (o repo check pertence ao `sharedVerification`).
- **Causa medida:** o esquema do DoD tem regras de forma (onde mora `judgment`, qual escopo de prova
  cabe no nó) que o gerador de plano **não** consulta antes de emitir. Cada plano novo redescobre a
  regra, e o custo é uma rodada de `revise`.
- **Custo:** 2 rodadas de `revise` na F2-reemissão (US$ 0,0352 + 0,0126) e 5 decisões de rejeição de
  forma no journal (19:11Z duas, 19:15Z três); o plano só congelou na terceira correção mecânica.
- **Correção sugerida:** validar o DoD **durante a geração** (o esquema já existe) e devolver os
  diagnósticos ao escritor no mesmo despacho, em vez de gastar um `revise` para cada erro de forma.
- **Por que é achado de produto:** erro de forma é detectável sem modelo e sem julgamento; pagar
  rodada de revisão semântica por isso é desperdício estrutural, e acontece em toda fase nova.

## 9. `stall_timeout` de 300 s no juiz, sem causa nomeada

- **Sintoma:** 29/09 14:18Z: *"R7 teve `stall_timeout` após 300 s sem progresso do provider, e sua
  invocation foi fechada"*.
- **Causa medida:** o provedor parou de emitir progresso e o runner fechou a invocação no limite. Não
  houve cota nem erro de credencial; a causa **do provedor** não é registrada, só o timeout.
- **Custo:** 1 tentativa perdida em F1 e uma terceira tentativa do mesmo nó (`attempt 3`) para fechar.
  Esse gasto está na conta dos US$ 0,5038 da F1.
- **Correção sugerida:** registrar o último evento do provedor antes do silêncio (último token, último
  keepalive, status HTTP) junto do `stall_timeout`, e classificar a retomada como automática quando o
  nó não chegou a produzir artefato.
- **Por que é achado de produto:** `stall_timeout` sem causa obriga o operador a relançar às cegas; o
  dado que explica já passou pelo runner e não é guardado.

## 10. O livro de achados não existe por padrão: a narrativa fica no journal e não há triagem

- **Sintoma:** a pergunta do dono *"quais achados de produto surgiram até agora?"* não tinha resposta
  em arquivo: `docs/campaigns/campaign-efficiency/ACHADOS-PRODUTO.md` **não existia** (nem na `main`,
  nem na branch da campanha), embora oito achados já tivessem sido pagos.
- **Causa medida:** a convenção do livro existe (há precedente em
  `docs/campaigns/safe-to-hand-to-a-friend/ACHADOS-PRODUTO.md`) mas não é criada pelo `freeze` nem
  exigida pelo fechamento de fase, então depende de alguém lembrar. O journal guarda tudo e não é
  triagem: mistura decisão, desfecho de nó e defeito de ferramenta na mesma linha do tempo.
- **Custo:** nenhum dólar. O dono pode reabrir trabalho pago por não conseguir ver o que já foi
  encontrado, justamente o que a triagem deveria evitar.
- **Correção sugerida:** o `freeze`/`add-contract` cria o livro com cabeçalho e o fechamento de fase
  **falha** (ou emite warning no relatório) se houver achado de ferramenta no journal sem entrada no
  livro. Cada linha termina com desfecho: corrigido em `<versão>` com a prova, ou `RM-###` aberto com
  dono, ou não-objetivo com o motivo.
- **Por que é achado de produto:** é o registro que faz a próxima campanha custar menos; enquanto ele
  for opcional, cada campanha redescobre e paga os mesmos defeitos.

## 11. `streamsOutput: false` faz uma tentativa saudável parecer "sem saída"

- **Sintoma:** F5, `n3-aux-spawn-admission`: `worker.jsonl` vazio, uso 0/0 e `exhausted`. A leitura natural,
  "o provider travou", estava errada.
- **Causa medida:** o runtime `zcode-glm-worker` declara `streamsOutput: false`, então o faberun nunca
  recebe stream. O log do provider mostrou 52 requests e 34 tool calls na tentativa 1 e 61 requests e 66
  tool calls na tentativa 2, as duas encerradas no meio do serviço.
- **Custo:** um diagnóstico errado e uma ordem de conserto errada (a primeira direção mandou tratar como
  provider travado), corrigida só depois de ler o log do provider.
- **Correção sugerida:** o status deve mostrar atividade do provider (requests e tool calls do log do
  harness) para runtimes sem stream, e marcar "sem stream" em vez de "sem saída".
- **Por que é achado de produto:** o operador só enxerga o que o faberun registra, e aqui o registro
  descreve o contrário do que aconteceu.

## 12. O teto de parede de 2400 s mata invocação saudável e selada, e o único retry automático já foi gasto

- **Sintoma:** F5, n3: `exhausted` por `wall_clock_timeout` na tentativa 2, com `sealedSha` preenchido e
  `sealError` nulo. O `exhausted` lê-se como "nada feito" quando há trabalho preservado.
- **Causa medida:** `contract.timeoutSec` default de 2400 s (`src/contract/index.mjs:400`) mata a
  invocação sem aviso de que o selo existe. A tentativa 1 consumiu o único retry automático do nó
  (`autoRetries` em `run.json`), então a tentativa 2 parkeou mesmo selada.
- **Custo:** o fechamento da fase ficou parado até um operador rodar `resume`; o nó cobria 10 arquivos
  e ~376 KB de leitura declarada e precisava de mais de uma janela.
- **Correção sugerida:** o status de `exhausted` com selo deve dizer que há selo e quantos arquivos
  mudaram; o retry automático deveria valer por janela esgotada com selo, não uma vez por nó; o
  planner deveria dimensionar `timeoutSec` pelo tamanho do pacote.
- **Por que é achado de produto:** trabalho pago e preservado aparece como perdido.
- **Contraprova na F6:** o `n6-3-alerts` bateu nos 2400 s na tentativa 1 com trabalho selado e o retry
  automático assumiu: a tentativa 2 fechou em cerca de 9 min. O retry funciona quando há selo; o defeito é o
  nó ficar sem ele depois de a primeira tentativa já ter gasto o único retry.

## 13. `HUSKY` em `envPassthrough` não chega ao shell do worker zcode, e o `snapshot_ignore_changed` derruba o nó

- **Sintoma:** três nós mortos por `workspace ignore sources changed during worker execution:
  .husky/_/.gitignore`: F4 `n4` tentativa 8, F5 `n3` tentativa 4 e F5 `n6` tentativa 1. Os dependentes
  ficaram `blocked` em cascata.
- **Causa medida:** o worker rodou `npm ci` para reproduzir o typecheck; `node_modules` e `.husky/_`
  nasceram no mesmo instante (11:47:13 no n3, 12:47:08 no n6). `HUSKY=0` estava no ambiente do controlador
  e em `envPassthrough`, mas o shell do zcode não o herdou. Sonda em worktree limpo: `HUSKY=0 npm ci` não
  cria `.husky/_`; sem o prefixo cria.
- **Custo:** uma tentativa inteira por ocorrência, mais o diagnóstico (o log do provider não grava os
  comandos que o worker executou).
- **Correção sugerida:** ignorar artefatos do próprio tooling no fingerprint de ignore sources, ou
  repassar `envPassthrough` ao shell do worker, ou preparar `node_modules` antes da janela do worker. A
  mensagem do erro deveria nomear o processo que escreveu o arquivo.
- **Por que é achado de produto:** um artefato do tooling derruba o nó inteiro e a mensagem não diz a causa.

## 14. Prova que exige devDependency ausente passa o `contract validate` e só morre no portão

- **Sintoma:** F5, `n1-verdict`: `npm run typecheck` com `exit=127` e `tsc: command not found`, porque o
  worktree do run não tem `node_modules`.
- **Causa medida:** o `sharedVerification` da F5 veio de `control/verification.json` sem `npm ci`, ao
  contrário da F4. `validate` e `preflight --static` não executam a prova.
- **Custo:** a tentativa 1 do n1 e, pelo conserto natural do worker (instalar dependências), o achado 13.
- **Correção sugerida:** `preflight` deveria rodar a prova num worktree limpo do ref base, ou o contrato
  deveria declarar o preparo de ambiente como parte do `sharedVerification`.
- **Por que é achado de produto:** o defeito passa por todos os checks baratos e custa uma tentativa.

## 15. Escopo faltante em nó já bloqueado ou falho só se corrige por contrato derivado

- **Sintoma:** F5 precisou de 6 contratos derivados e 7 runs para fechar 6 nós.
- **Causa medida:** `resume --reauthor` só lê `missingContext` e usa as frases como caminhos; quando o
  bloqueio vem em prosa ("write access to src/engine/scheduler.mjs (with the settlement chain...)") o
  pedido é recusado. `--answer` não alarga escopo e nó `failed` não aceita nenhum dos dois. Sobra editar o
  contrato congelado, o que é proibido, ou derivar contrato novo com base selada.
- **Custo:** cada continuidade custou selar o trabalho, montar base (às vezes unindo dois ramos), validar,
  preflight, trocar o contrato na campanha e relançar.
- **Correção sugerida:** o worker devolver os caminhos pedidos como lista estruturada em
  `missingContext`, e `reauthor` aceitar nó `failed` por `unexpected_write` e por `context_missing`.
- **Por que é achado de produto:** o conserto mais comum de uma fase é escopo, e o caminho oficial para
  ele só cobre o caso mais estreito.

## 16. O nó que muda a semântica de re-execução não roda os testes de resume que a spec lista como prova

- **Sintoma:** F5, `n6`: o teste `resume terminates an interrupted verification attempt and re-runs the
  phase` (`test/engine/resume-reauthor.test.mjs:540`) esperava 2 tentativas de verificação e veio 1.
- **Causa medida:** bisseção por commit: passa em `75ae961c`, `10cb43d7`, `4b3e1425` (n2) e `129b09ce`
  (n4) e falha em `551859af` (n5). O checkpoint por comando serve o resultado quando árvore, comando,
  ambiente e dependências são idênticos; o teste fabrica um crash em cima de uma run que já deixou o
  checkpoint. O comportamento novo é o pedido; o teste é que precisava apagar os `checkpoint-<n>.json`.
- **Custo:** descoberto só no último nó da fase, que é o único que roda o comando de prova do R7, e
  levou a mais uma continuidade.
- **Correção sugerida:** o nó que altera a re-execução de verificação deve carregar na sua `verification`
  os testes de resume que a spec do requisito nomeia, para a regressão aparecer no nó que a causa.
- **Por que é achado de produto:** a prova de fechamento chega tarde demais para apontar o culpado.

## 17. O chain valida o contrato registrado contra a land branch, então um contrato que lê arquivo criado na própria fase não promove

- **Sintoma:** com a F5 fechada, `supervise campaign` parkeou com `nodes[0].taskPacket.readFiles[1] does not
  exist: docs/campaigns/campaign-efficiency/decisions/phase-5-admission.md`, mesmo com o arquivo presente no
  head do run e no checkout de planejamento.
- **Causa medida:** `validate(entry, { repo, baseRef })` em `src/campaign/chain.mjs` usa
  `landBranchRef` (`10cb43d7`), onde o documento do n1 ainda não existe. A promoção só acontece depois da
  validação, então fica um ciclo.
- **Custo:** o operador avançou a land branch à mão para `4b3e1425` (n1 e n2 integrados, ancestral do commit
  final) e só então o chain promoveu até `4d2d88db`.
- **Correção sugerida:** validar o contrato de um run já terminado contra o ref do próprio run, ou
  promover antes de revalidar o que já foi executado.
- **Por que é achado de produto:** o fechamento normal de uma fase com nós dependentes de arquivos
  novos não consegue terminar sem intervenção.

## 18. `plan.json` continua com `approved: false` depois que a aprovação de risco é resolvida

- **Sintoma:** F5 e F6: depois de `plan-phase-N-approval` resolvida no journal, `plan.json` segue com
  `status: frozen` e `approved: false`. Quem lê o plano para saber se a fase foi aprovada conclui que não.
- **Causa medida:** a aprovação vive só na open question e no journal da campanha; o campo do plano
  congelado não é reescrito (e não pode ser, o plano é congelado com digest).
- **Custo:** nenhum dólar. Cada operador novo reabre a pergunta ou pede confirmação de uma aprovação já dada
  (a F6 só andou porque a autorização do dono estava num arquivo à parte).
- **Correção sugerida:** registrar a aprovação num arquivo irmão (`approval.json` com decisionId e data) que
  o `status` e o `supervise` leiam, em vez de depender do campo do plano.
- **Por que é achado de produto:** o estado de aprovação precisa ser legível num lugar só.

## 19. A verificação final de uma fase pode ser só `npm run check`, que não roda testes

- **Sintoma:** F5 e F6 fecharam "verdes" e o PR da campanha abriu com 2 testes vermelhos no CI:
  `single writer per field` (o `recordAuxRefusal` do n3 escreve `type`, `role` e `error` em
  `events.jsonl` e `docs/FIELD-OWNERSHIP.md` não o lista) e `launch-failed` (fixture da F2 que faz
  `git commit` sem identidade, só passa onde há identidade global).
- **Causa medida:** `finalVerification` da F5 e da F6 veio de `control/verification.json` com um único
  comando, `npm run check`, que é `node --check` de sintaxe. A F4 tinha 16 suítes por diretório; o catálogo
  novo perdeu todas. O relatório de fechamento disse "verificação final passou" sem dizer o que ela cobria,
  e o corpo do primeiro PR repetiu isso como "suíte completa".
- **Custo:** um PR aberto com CI vermelho, duas correções e a reabertura do PR; nenhum dólar de worker.
- **Correção sugerida:** o freeze deve recusar (ou avisar) um `finalVerification` que não execute
  nenhum `node --test`; o relatório de fechamento deve listar os comandos da verificação final e o que
  cada um cobre.
- **Por que é achado de produto:** "passou" sem o que foi rodado é a afirmação que o operador mais repete.

---

## Desfecho deste livro

Nenhum dos dezenove itens foi triado contra o código da branch padrão no momento da escrita. Este arquivo
registra o que foi pago, com número e evidência. A triagem (aberto/corrigido/não-objetivo) e
a decisão de quais viram requisito de qual campanha são passo seguinte, do operador com o dono.

Os itens 1 a 5 têm correção **já aplicada nesta campanha** por outro caminho (nós `r4-*`, `r5-*` e o
contrato de F3) e por isso aparecem aqui com o commit quando existe; os itens 6 a 19 estão abertos (o 7 foi reproduzido na F5; os itens 11 a 19 são da F4, da F5 e da F6).

Referências: `journal.jsonl` da campanha, `results/` das runs citadas e
`docs/reviews/2026-09-29-campaign-efficiency/REVIEW-AND-PLAN.md` (achados R1 a R7 do review, que são
o objeto da campanha e não se repetem aqui).
