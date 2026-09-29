# Achados de produto e de ferramenta: campanha `safe-to-hand-to-a-friend`

Cada achado traz o sintoma, a causa, o custo medido e a correção sugerida. A ponte
com a campanha de melhoria do faberun: cada item aqui vira requisito lá.

O veredito dos 21 está na tabela do fim do arquivo, e é ela que manda. O texto de
cada achado fica como foi escrito quando o achado apareceu, sugestão inclusive: o
registro de um problema não se reescreve depois que ele fecha.

## AP1. O plano congela prova de comando que não mede nada

- **Sintoma:** dois nós (`declared-env-test`, `allowed-env-core`) reprovados pelo
  portão determinístico com *"the proof measured nothing"* — TAP `1..0`. As duas
  tentativas de cada nó foram consumidas pelo mesmo motivo, `doctor-env`, `env-docs`
  e `env-probe-judgment` ficaram bloqueados atrás deles, e a fase terminou 3/8.
- **Causa (corrigida em 27/09, medida no node v26.8.1):** a descrição anterior estava
  incompleta. `node --test --test-name-pattern=X` sem arquivo **funciona** num diretório
  com um arquivo de teste só. O que quebra é a execução com **vários arquivos**: cada
  arquivo em que o filtro não seleciona nada imprime o próprio `1..0` sem recuo, seguido
  da linha `ok N - <arquivo>`. O portão (`engine/judge-gate.mjs`) tinha sido calibrado em
  21/09 com um arquivo só e lia qualquer `1..0` sem recuo como "o filtro não selecionou
  nada". Sem caminho, `node --test` roda todos os arquivos da árvore, então quase todos
  imprimem `1..0`, e o portão recusou provas cujo filtro **tinha** selecionado o teste do
  nó. Com o caminho do arquivo só roda um arquivo, e por isso o mesmo comando passava.
  O defeito é do portão; a prova sem arquivo é o gatilho, e ainda custa a suíte inteira.
- **Custo:** 4 tentativas de worker (2 nós × 2), ~45 min de fase, US$ 0,44, e três
  nós que nunca chegaram a rodar. O juiz e o portão funcionaram: o defeito está na
  autoria do contrato, não na execução.
- **Correção sugerida (duas camadas):**
  1. **No motor (`freeze`/`contract validate`):** recusar prova de comando cujo
     filtro não casa com nenhum teste existente no repositório. O freeze já tem os
     `repoFacts` e o padrão é uma string: a checagem é barata e é exatamente a
     distinção que o portão faz na execução — só que antes de gastar tentativa.
  2. **Na autoria:** o gerador de contrato do planner passa a nomear o arquivo de
     teste no comando, em vez de depender da descoberta automática do runner.
- **Por que é achado de produto e não erro de um nó:** o planner escreveu o mesmo
  formato de prova em dois nós independentes, e nenhum dos dois poderia passar. Um
  estranho (`safe-to-hand-to-a-friend`) bateria nisso na primeira fase.

## AP2. O plano emite um no cuja prova nao passa sem editar o arquivo que a prova cita

- **Sintoma:** o no `env-docs` falhou com *"proof-cited unexpected write (1):
  test/docs/docs-diet.test.mjs"*. A fase 1b terminou 4/5.
- **Causa:** a spec exige um artigo novo em `skills/faberun/references/local-env.md`, e
  `test/docs/docs-diet.test.mjs` **enumera `references/` com lista exata** — sem editar esse
  teste, a prova (`node --test test/docs/docs-diet.test.mjs`) nao pode passar. O plano nao
  declarou o teste em `writeFiles`, entao o write entrou como inesperado, e o portao o
  recusa exatamente por ser um arquivo que a propria prova nomeia (a defesa contra o worker
  que conserta a prova em vez do codigo).
- **Custo:** 1 tentativa de worker, ~3 min de fase, US$ 0,02 e a fase fechando 4/5.
- **Correcao sugerida:** o `freeze` deveria detectar essa forma antes de gastar tentativa —
  cruzando os `repoFacts` (ou os `readFiles`/escritas declaradas) com o fato de existir um
  teste de guarda que enumera um diretorio que a entrega altera. Quando detectar, o caminho
  e declarar o arquivo de guarda em `writeFiles` **no proprio plano**, com o motivo, em vez
  de deixar o worker descobrir por reprovacao. E o mesmo terreno do AP1: prova e escopo
  precisam ser coerentes no congelamento, nao na execucao.

### Resolução do AP1 e do AP2 (27/09, branch `fix/proof-filter-and-guard-tests`)

- **Portão:** o filtro só conta como "nada selecionado" quando todo resultado de primeiro
  nível é uma linha de arquivo sem seleção (cada `1..0` tem a sua). Teste que reproduz o
  defeito: `test/engine/proof-selected-no-test.test.mjs`.
- **Congelamento (`plan/proof-scope.mjs`, no `freezePlan` e no pre-flight das rodadas):**
  recusa prova filtrada por nome que não nomeia arquivo de teste; recusa arquivo nomeado
  que existe, que nenhum nó escreve e que não tem teste cujo título case com o filtro.
- **Decisão sobre o critério pedido** ("recusar filtro que não casa com nenhum teste
  existente"), aprovada pelo dono em 27/09: a versão literal barraria toda prova de teste
  novo, porque o nó escreve o teste e ele não existe no congelamento. Por isso o título só é
  conferido quando o arquivo existe e nenhum nó o escreve.
- **Autoria:** o rascunho e o revise recebem a regra de nomear o arquivo do teste.
- **AP2:** um nó que cria arquivo num diretório que algum teste enumera (o teste cita o
  diretório e todos os nomes que ele tem hoje) recebe esse teste em `writeFiles`, com o
  motivo registrado como `guards-declared` no `pipeline.jsonl`. Contra o repositório real,
  declara `test/docs/docs-diet.test.mjs` para quem cria `references/local-env.md`.
- **Fica de fora (fila da próxima fase):** a prova escrita na própria spec continua sem
  arquivo (o `spec validate --run-proofs` usa `plan/proof-run.mjs`, outro caminho); e o AP2
  só vê arquivo criado, não apagado nem renomeado dentro de diretório enumerado.

## AP3. O `repo-facts` passa uns 6 minutos sem sinal de vida

- **Sintoma:** todo `faberun plan` começa medindo cada diretório de teste; em 25 e 26/09 a
  etapa levou de 5 a 8 minutos (ex.: `repo-facts` às 12:39:35, `draft` às 12:45:15) sem
  escrever nada no `pipeline.jsonl` nem no terminal até terminar.
- **Custo:** o operador não distingue "medindo" de "travado"; eu verifiquei o processo à mão
  a cada relançamento do portão da 3a (seis relançamentos).
- **Correção sugerida:** registrar no `pipeline.jsonl` o início da etapa e uma linha por
  diretório medido (ou reusar a medição do mesmo `gitHead`, que não muda entre relançamentos).

## AP4. O `plan --detach` morreu sem gravar registro de falha

- **Sintoma:** em 26/09 o portão foi lançado com `--detach` (pid 64270) e o processo sumiu
  durante o `repo-facts`: o diretório `plans/phase-1` ficou vazio, sem `pipeline.jsonl` e
  sem `bootstrap-failure.json`. O mesmo comando em primeiro plano, logo depois, rodou até o
  fim.
- **Causa:** não identificada. A janela de observação do lançador (`watchPlanBootstrap`)
  só cobre o bootstrap; uma morte depois dela, por sinal, não passa pelo `catch` que grava o
  registro.
- **Correção sugerida:** o processo destacado grava um registro de vida (pid, etapa,
  batimento) e o `plan`/`status` acusa o processo morto sem registro, como a run já faz com
  o controlador.

## AP5. O limite mensal de gasto do Fable derrubou o revisor sem trocar de revisor

- **Sintoma:** em 25/09 o `claude-fable-5-1` respondeu *"You've hit your monthly spend
  limit"*; o estágio terminou `provider_error` e a lista de revisores do planner não passou
  ao próximo.
- **Correção feita:** a frase agora é esgotamento (`insufficient_balance`, sem hora de
  reset), commit `cbc280a`. O revisor voltou a ser trocado; o Fable continua fora até o
  crédito ser restaurado.

## AP6. `cancel` recusa uma run cujo contrato antigo não valida mais

- **Sintoma:** em 27/09, `faberun cancel` das três runs estacionadas de
  `planner-and-routing-routing-and-planner*` falhou com *"runtime claude-sonnet declares
  vendor anthropic-sonnet but claude claude-sonnet-5 is provider anthropic"*: a regra de
  provedor canônico que a própria 3a introduziu recusa o rótulo livre que esses contratos
  usavam quando foram lançados.
- **Custo:** as runs ficam estacionadas para sempre; `campaign close` passou mesmo assim, mas
  o bloco do `AGENTS.md` continua listando-as como retomáveis.
- **Correção sugerida:** `cancel` (e `status`) leem o contrato persistido como registro, sem
  revalidá-lo pelas regras atuais; só `resume` precisa do contrato válido hoje.

## AP7. A fase 1 integrou uma árvore vermelha, e nenhum portão viu

- **Sintoma:** ao trazer a `main` (0.26.0) para a branch da campanha em 27/09, quatro testes
  estruturais falharam, todos introduzidos pela fase 1: `src/host/preflight.mjs` com 840
  linhas (teto de 800), `declaredEnvironment` exportado por sete módulos, três arquivos de
  teste novos sem `scoped-home.mjs` como primeiro import, e uma asserção do zcode que a
  mudança do R1 tornou falsa.
- **Causa:** `plan-inputs/verification.json` só punha `npm run typecheck` em cada nó e
  `npm run check` (sintaxe) e `docs:check` no fim. Nenhum comando rodava
  `test/repo/source-shape.test.mjs`, e o juiz aprovou nós que só rodaram os próprios testes.
- **Correção feita:** os quatro reparos em commits separados na branch da campanha
  (`refactor(host)`, dois `test(harnesses)`, `test(repo)`), com a decisão de isentar
  `declaredEnvironment` da regra de nome único pelo mesmo motivo que isenta `harness`, e
  `node --test test/repo/source-shape.test.mjs` (0,36 s medido) entrou na verificação
  compartilhada de todo nó a partir da fase 2.
- **Correção sugerida no produto:** o planner lê as regras que a suíte do alvo impõe à forma
  do código e propõe o teste delas como verificação compartilhada, em vez de depender do
  operador lembrar.

## AP8. A prova escrita na própria spec continua sem arquivo de teste

- **Sintoma:** as provas de R1 a R7 na spec são `node --test --test-name-pattern="<título>"`
  sem arquivo. O planner agora acrescenta o arquivo (AP1), mas `spec validate
  --run-proofs` roda a prova como a spec a escreve, por `plan/proof-run.mjs`, que não passa
  pelo congelamento.
- **Decisão (27/09):** fica fora da fase 2, que cobre R5 a R7. Vira requisito candidato: a
  checagem de `spec validate` recusa (ou avisa) prova filtrada sem arquivo, com a mesma regra
  de `plan/proof-scope.mjs`.

## AP9. O reparo do AP2 só vê arquivo criado

- **Sintoma:** um nó que apaga ou renomeia um arquivo dentro de um diretório que algum teste
  enumera também quebra esse teste, e `declareDirectoryGuards` só olha caminhos que ainda não
  existem.
- **Decisão (27/09):** fora do escopo da fase 2. O plano não declara remoções (`writeFiles`
  não distingue criar de apagar), então fechar isso pede primeiro um jeito de o plano dizer
  que um nó remove um arquivo.

## AP10. Uma recusa de lançamento num estágio do planner vira "failed before readiness"

- **Sintoma:** em 27/09 o primeiro `faberun plan` da fase 2 levou 16 min no `repo-facts` e
  morreu no rascunho com *"detached bootstrap failed before readiness for pid 82057"*, sem
  run dir e sem motivo. Rodando o mesmo contrato em primeiro plano, a causa apareceu:
  *"refusing to launch against HEAD: the working tree has 2 uncommitted paths"* (os
  contratos `phase-1b`/`phase-1c` fora do git).
- **Causa:** o estágio lança a run destacada, e a recusa acontece antes de o controlador
  escrever o registro de bootstrap; o stderr do filho é descartado. É o caso do R32.
- **Correção sugerida:** o `plan` confere a árvore limpa antes do `repo-facts` (e não 16 min
  depois), e a recusa do filho destacado é gravada no registro de bootstrap (R32).

## AP11. O plano escreveu uma prova mais estrita que a spec

- **Sintoma:** o nó `r6-legacy-sweep` da fase 2 falhou duas vezes na prova
  `! grep -q "\.runs" README.md docs/*.md`, embora o R6 aceite menção dentro de trecho
  rotulado como layout legado; o worker também tratou `docs/COMMANDS.md` inteiro como gerado,
  quando só sinopses e tabelas de flags o são.
- **Custo:** 2 tentativas do nó e a fase 2 fechando 2/3.
- **Decisão (27/09, autorizada pelo dono):** R6 replanejado como fase 2b pelo `faberun plan`,
  com a spec esclarecendo a prova e o escopo do `COMMANDS.md`, e o trabalho da tentativa 2
  salvo em `salvage/r6-legacy-sweep.patch` como ponto de partida. Nenhum contrato editado à
  mão.
- **Correção sugerida no produto:** o revisor do plano compara cada prova de comando com a
  frase da spec que ela prova e acusa a prova mais estrita que o requisito.

## AP12. O `status.json` diz "controller active" com o pid já morto

- **Sintoma:** depois que a run `safe-to-hand-to-a-friend-phase-2` terminou (27/09), o
  `status.json` seguiu com `controller.state: "active"` e o pid 43002, que já não existia; um
  watcher que esperava o controlador sair ficou em loop por duas horas.
- **Correção sugerida:** o controlador grava o estado final ao sair, e o `status` confere a
  vida do pid antes de dizer `active`.

## AP13. Uma prova de comando que o shell nem lê passa pelo congelamento

- **Sintoma:** na fase 3, o nó `r8-offline-first-campaign` passou no trabalho (teste de ponta
  a ponta verde em 15 s) e esgotou as duas tentativas porque a prova congelada era
  `… --test-name-pattern=a stranger's first campaign completes offline …`, sem aspas: o
  `/bin/sh -c` falhou com *"unexpected EOF while looking for matching `'`"*.
- **Decisão (27/09):** R8 replanejado como fase `phase-3r8` com o teste renomeado para um
  título sem apóstrofo e o trabalho salvo em `salvage/r8-offline-first-campaign.patch`.
- **Correção sugerida no produto:** o congelamento roda `sh -n -c` (ou o equivalente) em cada
  prova de comando e recusa a que não parseia. É o terreno do R34, da fase 5.

## AP14. Uma chave de bullet com espaço gruda em silêncio no bullet anterior da spec

- **Sintoma:** em `phase-3r8.SPEC.md`, um `- **esclarecimento (27/09):**` logo depois do
  `- **proof:**` fez o `spec validate` dizer que R8 não tinha prova: o parser só aceita chave
  `[a-zA-Z-]+`, ignora a linha de bullet que não casa e cola as linhas seguintes na chave
  anterior. Em `phase-2b.SPEC.md` o mesmo formato passou calado.
- **Correção sugerida:** `spec validate` avisa de uma linha `- **…:**` cuja chave não casa, em
  vez de tratá-la como nada.

## AP15. Cada fase deixou regressões em testes vizinhos que nenhum nó rodou

- **Sintoma:** com as fases 3, 4, 5 e 3r8 integradas, `npm test` deu 4 falhas em 1763:
  um defeito real (`shellWords` partia um `node -e "…\"fs\"…"` na aspa escapada, e a checagem
  do R34 recusou um script que parseia) e três expectativas que R1 e R22 tornaram velhas
  (variável ambiente chegando ao worker, `withoutNotifyEnv` no probe, ignore declarado
  falhando). Todos os nós tinham passado nos próprios testes.
- **Causa:** a verificação compartilhada é typecheck mais o teste de forma; nenhum nó roda os
  testes dos módulos que ele muda indiretamente, e a verificação final não roda `npm test`
  (35 min medidos).
- **Correção feita:** o defeito e as três expectativas corrigidos em dois commits na branch da
  campanha.
- **Correção sugerida no produto:** o planner acrescenta, por nó, os arquivos de teste que
  importam os módulos que o nó escreve (o mesmo grafo que a checagem de fechamento de escopo
  já percorre), e a campanha roda a suíte inteira uma vez antes de fechar.

## Achados da campanha `open-source-readiness` (Fordita, frb-linux2), recebidos em 27/09

Conferidos contra AP1 a AP15. N1 compartilha o sintoma com o AP10; os outros quatro são novos.

## AP16. O teto de saída do harness fx estava cravado em 8192 nos dois clientes (N1)

- **Sintoma:** o `draft` de um `faberun plan` morria com `{"code":-32603,"message":"OutputTruncated"}`,
  e o operador via só *"detached bootstrap failed before readiness for pid N"*.
- **Causa:** `MAX_OUTPUT_TOKENS = 8192` em `src/harnesses/fx/runner.mjs` e `max_output_tokens =
  8192` em `src/harnesses/fx/native/main.zig`, sem configuração; o adapter prefere o cliente
  nativo, então corrigir só o Node deixava o defeito no caminho preferido.
- **Relação:** a mensagem opaca é o mesmo caso do AP10 (recusa de um estágio destacado que chega
  ao operador sem a causa). O teto cravado é novo.
- **Correção:** `config.max_output_tokens` do runtime vira `--max-output-tokens` nos dois
  clientes, 8192 como default; o `deepseek-flash` aceita 65536 (medido pela Fordita).

## AP17. O `revise` devolve o plano inteiro, e um plano de 9 nós não cabe em 65536 tokens (N2)

- **Sintoma:** dois `revise` falharam em `prompt_failed` com 65.932 e 66.821 tokens de saída, no
  teto de 65536; o `deepseek-flash` como worker produz 68k a 156k tokens por nó.
- **Relação:** o commit que faz o `revise` ler o plano que revisa (27/09) resolveu a perda de
  conteúdo, não o tamanho da resposta: o estágio ainda pede o plano completo de volta.
- **Correção sugerida:** o `revise` devolve um patch sobre os nós afetados, ou o estágio é fatiado
  por nó.

## AP18. Um artefato acima de 16 KiB vira `protocol_failure` opaco (N3)

- **Sintoma:** um worker GLM produziu `artifacts[0]` com 19.810 bytes contra o limite de 16.384, e
  o nó falhou com `protocol_failure`, sem nomear tamanho nem limite.
- **Correção sugerida:** o artefato grande transborda para arquivo com o caminho no lugar, ou o
  erro nomeia o tamanho e o limite.

## AP19. `plan` sem `--runtimes` ignora em silêncio o catálogo da campanha (N4)

- **Sintoma:** a campanha tinha `plan-inputs/runtimes.json` com o teto maior, e o `plan` caiu no
  catálogo padrão (8192) sem avisar; o operador descobriu depois de queimar rodadas.
- **Correção sugerida:** o `plan` usa o `plan-inputs/runtimes.json` da campanha quando existe, ou
  avisa na subida que ele existe e não foi passado.

## AP20. O juiz aprovou um nó que entregou o requisito pela metade (N5)

- **Sintoma:** o nó `guards-core` entregou a guarda sem as exclusões padrão que o R1 da campanha
  declara, o juiz aprovou, e o operador interveio duas vezes na ref de integração (`6f47f4a`,
  `4881faf`) para a fase fechar.
- **Relação:** é o avesso do AP11 (prova mais estrita que a spec): aqui a entrega fica aquém do
  statement e passa. O AP15 é vizinho (o portão não roda o que devia), mas o mecanismo é outro:
  o juiz não conferiu o statement classe por classe.
- **Correção sugerida:** o juiz confere cada classe do statement contra a entrega, ou o
  fechamento da fase roda a guarda da spec sobre a árvore final e reprova enquanto houver
  classe aberta.

## AP21. O `prune` libera a worktree e deixa a branch de tentativa

- **Sintoma:** em 28/09, depois de `faberun prune --parked` liberar 20 worktrees, restavam 133
  branches locais `faberun/<run>/<nó>/<n>`, todas com o commit já alcançável por
  `refs/faberun-archive/`, pela ref da run ou por uma branch normal.
- **Causa:** `releaseRunWorktrees` (`src/repo/worktree.mjs`) só apaga a branch que a worktree
  tem em checkout; as demais tentativas da mesma run ficam.
- **Correção aceita pelo dono (28/09):** o `prune`, e o prune automático do `run`, apagam também a
  branch de tentativa cujo commit já é alcançável por uma dessas refs, e nunca uma que não seja.

## Desfecho dos 21 (28/09)

- **estado:** CORRIGIDO ou ABERTO. Vinte fechados, um aberto.
- **entrou em:** a versão que carrega a correção, com o commit entre parênteses. A
  0.29.0 é a leva da triagem deste mesmo dia e a 0.30.0 a dos três que viraram
  item de fila em vez de correção; as anteriores são tags publicadas, e um leitor
  não precisa abrir o `git log` para saber desde quando a correção existe.
- **prova:** o teste que quebra sem a correção, ou o que falta quando ele não existe.
- **RM:** o item do `docs/ROADMAP.md` que carrega o que sobrou. AP7, AP15 e AP17
  mudavam comportamento visível demais para entrar na leva de 0.29.0 e foram
  corrigidos na 0.30.0, em 28/09, por ordem do dono. Só AP9 continua aberto:
  adiado por ele em 27/09, fecha quando o formato do plano puder dizer o que um
  nó remove, e é o primeiro passo de qualquer correção dele.

| achado | estado | entrou em | prova | RM |
| --- | --- | --- | --- | --- |
| AP1 | CORRIGIDO | 0.26.0 (`2729d12`, PR #84; commit original `af5765a`) | `test/engine/proof-selected-no-test.test.mjs` | - |
| AP2 | CORRIGIDO | 0.26.0 (`2729d12`, PR #84; commit original `2843205`) | `test/plan/proof-scope.test.mjs` | - |
| AP3 | CORRIGIDO | 0.29.0 (`bcf36a4`) | `test/plan/repo-facts.test.mjs` e o `pipeline.jsonl` da fase no `test/cli/plan.test.mjs` | - |
| AP4 | CORRIGIDO | 0.29.0 (`bcf36a4`) | `test/plan/progress.test.mjs`; o aviso no `--detach` no `test/cli/plan.test.mjs` | - |
| AP5 | CORRIGIDO | 0.26.0 (`2729d12`; commit original `cbc280a`) | `test/harnesses/claude-exhaustion.test.mjs` | - |
| AP6 | CORRIGIDO | 0.29.0 (`90c1345`) | `test/contract/persisted-load.test.mjs` | - |
| AP7 | CORRIGIDO | 0.30.0 (`66cc9604`) | `test/plan/pipeline.test.mjs`, `test/plan/freeze.test.mjs` e `test/plan/template.test.mjs`; o plano propõe as suítes do alvo, e o operador ainda pode sobrepor | RM-107 |
| AP8 | CORRIGIDO | 0.29.0 (`5887dcb`) | `test/plan/spec.test.mjs` | - |
| AP9 | ABERTO | - | sem teste: `writeFiles` não distingue criar de apagar, e é isso que falta primeiro. Adiado pelo dono em 27/09, e fecha quando o formato do plano puder dizer o que um nó remove | RM-108 |
| AP10 | CORRIGIDO | 0.29.0 (`7574c17`) | `test/cli/plan.test.mjs` | - |
| AP11 | CORRIGIDO | 0.29.0 (`b00e2b6`) | `test/plan/template.test.mjs` | - |
| AP12 | CORRIGIDO | 0.29.0 (`7d20119`) | `test/engine/heartbeat.test.mjs` | - |
| AP13 | CORRIGIDO | 0.29.0 (`7e436b1`) | `test/plan/proof-check.test.mjs`, `test/contract/definition-of-done.test.mjs` | - |
| AP14 | CORRIGIDO | 0.29.0 (`5887dcb`) | `test/plan/spec.test.mjs` | - |
| AP15 | CORRIGIDO | 0.30.0 (`f28d1c6c`) | `test/plan/repo-facts.test.mjs`, `test/plan/sizing.test.mjs` e `test/repo/scope-closure.test.mjs`: um arquivo de teste cobre o módulo que ele importa, e o escalonamento troca o comando acima do orçamento por eles; a suíte inteira roda uma vez no fechamento (`finalVerification`, `66cc9604`) | RM-109 |
| AP16 | CORRIGIDO | 0.27.0 (`ab6decd`, PR #93); prova em 0.29.0 (`318202b`) | `test/harnesses/fx.test.mjs` | - |
| AP17 | CORRIGIDO | 0.30.0 (`82118659`) | `test/plan/template.test.mjs` (a fusão do patch) e `test/plan/rounds.test.mjs` (as rodadas); `test/cli/plan.test.mjs` roda o pipeline inteiro com um revise em forma de patch | RM-110 |
| AP18 | CORRIGIDO | 0.29.0 (`b06824a`) | `test/contract/worker-result-output.test.mjs` | - |
| AP19 | CORRIGIDO | 0.29.0 (`9ed379d`) | `test/cli/plan.test.mjs` | - |
| AP20 | CORRIGIDO | 0.29.0 (`d2cedd6`) | `test/contract/packet.test.mjs` | - |
| AP21 | CORRIGIDO | 0.29.0 (`10f007e`) | `test/repo/worktree-prune.test.mjs` | - |

Duas notas de escopo que a tabela não cabe:

- **AP19** só passa a ler `plan-inputs/runtimes.json`. Um `verification.json` no
  mesmo diretório continua sem ser lido: o contrato congelado já fixa as suítes
  que o operador escolheu, e uma segunda fonte silenciosa é o defeito que o AP19
  fecha, não a correção dele.
- **AP7, AP9, AP15 e AP17** foram corrigidos onde a campanha podia (a árvore
  vermelha, a suíte vizinha) e o que sobra é decisão de produto. A ordem do dono
  em 28/09 suspendeu o critério de entrada da regra de congelamento para que os
  vinte e um fossem triados nesta leva, e a suspensão está registrada em
  `docs/campaigns/leaving-home/PROGRAM.md`.

