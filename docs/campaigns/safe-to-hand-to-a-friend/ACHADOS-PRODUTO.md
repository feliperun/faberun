# Achados de produto e de ferramenta: campanha `safe-to-hand-to-a-friend`

Cada achado traz o sintoma, a causa, o custo medido e a correção sugerida. A ponte
com a campanha de melhoria do faberun: cada item aqui vira requisito lá.

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

