---
title: "Retrospectiva: 22 achados de auditoria corrigidos no `rec`, e as seis fricções que a ferramenta mostrou no caminho"
campaign_id: rec-audit-remediation
date: 2026-09-22
spec: docs/campaigns/rec-audit-remediation/spec/SPEC.md
baseline: faberun 0.18.0 instalado (origin/main estava em 0.20.0 quando este relatório foi escrito)
range: alvo `feliperun/rec`, base `3c7f5cb` → `campaign/rec-audit-remediation` @ `daa85ee`
---

# Retrospectiva — `rec-audit-remediation`

A pergunta desta campanha não era "a ferramenta funciona". Era outra, mais
desconfortável: **um alvo real, com 22 defeitos reais, escritos por outra
campanha, sai do outro lado corrigido — ou sai do outro lado com a aparência de
corrigido?**

Saiu corrigido. E o mais útil deste registro não é isso: é que a campanha
inteira custou **US$ 1,35** e ainda assim produziu seis fricções medidas, cada
uma com reprodução e evidência. É esse o material que serve para melhorar o
faberun, e é ele que ocupa a maior parte deste documento.

---

## 1. O que a campanha era

O alvo é o [`feliperun/rec`](https://github.com/feliperun/rec), um gravador de
áudio de terminal em Zig. Uma campanha anterior (`rec-bug-and-security-audit`)
auditou o repositório e produziu 19 achados consolidados; uma revisão
independente depois acrescentou três achados tardios e corrigiu três erros
factuais do relatório. Nada disso tinha sido corrigido.

A ordem era: **corrigir os 22**, cada um com teste de regressão, sem tocar em
nada fora do escopo. Fixo por instrução do dono: worker `deepseek-flash`,
juiz `GLM 5.3 flash` — e nenhum subagente nativo do harness, tudo pela faberun.

Um detalhe do ambiente decidiu metade do desenho: **o host não tinha toolchain
Zig**. Sem ele, o worker não compila, e um worker que não compila não corrige
Zig. Instalei `zig 0.16.0` antes de emitir o primeiro contrato, e medi a
invocação que funciona ali (`zig build test -Dtarget=x86_64-linux-gnu`, porque o
alvo nativo falha no link contra a glibc do host). Isso virou restrição de
campanha e verificação compartilhada de todos os nós.

---

## 2. Delta medido

| Indicador | Valor |
|---|---|
| Achados corrigidos | **22 de 22** (4 críticos, 10 maiores, 5 menores, 3 tardios) |
| Contratos | 3 (mais 2 reemissões de um deles) |
| Nós executados / fechados | **12 / 12** nos contratos que valeram |
| Runs | 5 (2 cancelados pelo operador, 3 promovidos) |
| Testes do alvo | 138 → **162** (+24 de regressão) |
| `sentrux check` / `sentrux gate` | passou / sem degradação |
| Custo total | **US$ 1,3474** |
| Wall clock | **1 h 32 min** |
| Eventos no diário | 96 |
| `silentStallRate` | 0 — duas paralisações de rede detectadas pelo `stallTimeoutSec` |
| Revisões de juiz (contrato principal) | 0 em 8 nós |
| Taxa de 1ª passada do juiz | `glm-5.3-flash` 8/9 · `claude-sonnet-5` 3/3 |

O número que importa é a razão entre o primeiro e o último: **22 correções com
teste por US$ 1,35**, num repositório que eu não conhecia e cuja suíte eu não
sabia rodar quando comecei.

---

## 3. O que entrou

| Contrato | Nós | Entrega |
|---|---|---|
| `remediation` | 8 / 8 | Os 19 `FINDING-SYNTH-*` + os 3 tardios, agrupados por arquivos disjuntos: buffers e `--out`, arquivos de gravação, rede, caminhos e entrada, update, supply chain, terminal, e o relatório de remediação |
| `hygiene` (v3) | 3 / 3 | Fecha os residuais que o próprio relatório declarou: `rec play` sem filtro, `.?` no `--refine`, teste próprio do modo `0600`, suíte que não escreve mais na árvore |
| `cleanup` | 1 / 1 | Remove os dois últimos artefatos que o selo das runs anteriores tinha commitado |

O contrato principal usou **oito nós em paralelo com conjuntos de escrita
disjuntos**; um único `dependsOn` serializou os dois nós que compartilhavam
`src/record.zig`, e o nó de relatório esperou os outros sete. Zero conflitos de
integração.

O juiz cross-vendor fez o trabalho dele de um jeito que merece registro: em
`path-and-input-hardening` ele deu o único `fail` da campanha — **menor**, e
portanto sem re-despacho, porque o gate era `failOn: [major, critical]` — e o
achado era real:

> `src/transcribecmd.zig:297` ainda desembrulha `templatesDirPath` com `.?`, o
> único call site que não trata o `null` novo; a falha passa de estouro de
> buffer para pânico.

O worker tinha **relatado** isso em vez de editar um arquivo fora do seu
`writeFiles`, e o juiz confirmou a leitura. Os dois se comportaram como
projetado, e foi esse `fail` menor que virou o item do contrato `hygiene`.
Um gate que só olha severidade crítica teria perdido — e o desenho de
`failOn` foi o que permitiu fechar o nó **e** guardar o achado.

---

## 4. O que a ferramenta fez bem

**O pacote fechado paga a conta.** O patch de pacote fechado é o que faz um
pacote de contrato com 12 nós custar US$ 1,35: o juiz GLM fez 15 chamadas com
158 k tokens de entrada e **13 k de saída**, por **US$ 0,0417**. O mesmo tipo de
chamada no harness com preamble aberto teria reenviado dezenas de milhares de
tokens de ferramentas que ninguém pediu.

**O juiz cross-vendor é barato e não é decorativo.** 2,8 % do custo total, uma
taxa de 1ª passada de 8/9, e o único `fail` foi um achado verdadeiro que o
relatório de outra campanha tinha deixado passar.

**A aresta de fallback declarada funciona.** Quando a quota semanal do Z.ai
acabou (`429`, código `1310`, reset em 2026-09-24), o nó virou `exhausted` com o
motivo e o instante, e o contrato reemitido com `fallback: claude-sonnet-5`
tomou a aresta exatamente como documentado — cross-vendor em relação ao worker,
como o validador exige. Nada travou, nada foi adivinhado.

**`scopeFindings` é a decisão certa.** O nó de higiene apagou 14 caminhos fora
do seu `writeRoots` e ainda assim chegou a `done`: o escopo registrou os 14 e a
verificação passou. Um escopo que fosse gate teria matado a única correção certa
possível.

**`replace-contract` + `unpark --force` é uma via de recuperação completa.** O
contrato reemitido substituiu o defeituoso no manifesto, limpou a atenção
sozinho e a campanha seguiu. Sem isso, o caminho seria recomeçar a campanha.

**O `stallTimeoutSec` pega rede parada, não só processo mudo.** Dois nós
pararam com 66 KB presos no `Send-Q` de uma conexão estabelecida com o provedor;
aos 900 s o controlador marcou `stalled`, o `resume` recortou a tentativa
seguinte do selo da anterior e os dois fecharam. Nenhum modelo ficou pendurado.

---

## 5. Fricções medidas

Seis. Cada uma com o sintoma, a evidência e o estado em `origin/main` (0.20.0)
no dia em que isto foi escrito. A sétima está fechada e vai no fim, como
crédito.

### F1 — o worker sob `workspace-write` não roda toolchain com cache global

`sandbox: workspace-write` é o default do harness `dsh` e a documentação o
descreve como "executa e escreve dentro do worktree". A segunda metade está
certa e é justamente o problema: o compilador quer escrever **fora** do
worktree.

Medido antes de emitir o contrato, com o mesmo worker e o mesmo pacote:

- `workspace-write` → `manifest_create ReadOnlyFileSystem`, `unable to load
  'std.zig': ReadOnlyFileSystem`, exit 2. O build nunca começa.
- `danger-full-access` → compila, exit 0, 19 s.

O operador que lê só a linha do `contract.md` escolhe o modo seguro e recebe um
worker que não consegue compilar a própria correção — e a mensagem que ele vê
fala de sistema de arquivos somente-leitura, não de modo de sandbox.

**Onde encosta:** P6 (sandboxing real) tem a correção de fundo. O curto prazo é
documental e barato: a linha do `sandbox` do `dsh` deve dizer a consequência
(*um toolchain com cache no `$HOME` não roda sob `workspace-write`; declare
`danger-full-access` ou aponte o cache para dentro do worktree*), e o executor
poderia classificar esse erro e nomear o modo. Ver `RM-050`.

### F2 — escrever `.gitignore` derruba o nó inteiro, e a regra não está em lugar nenhum

Um pacote pedia uma linha em `.gitignore`. O nó falhou com
`snapshot_ignore_changed` — *"workspace ignore sources changed during worker
execution"* — e o trabalho, que estava inteiro e correto, foi descartado junto.

`captureIgnoreSources` (`src/repo/workspace.mjs`) tem razão em existir: o
fingerprint do workspace inclui `.faberunignore`, `.gitignore`, `.git/config` e
os caminhos por-worktree do git. Deixar um worker mudar o que o snapshot
enxerga é deixar o worker escolher o que não será visto.

O problema não é o comportamento, é o silêncio em volta dele. A regra não está
no `SKILL.md`, nem em `references/contract.md`, nem em `references/rules.md`;
quem aprende, aprende perdendo um nó. E a mesma classe já tinha aparecido antes:
a campanha `intent-factory-lean` perdeu uma tentativa de 80 minutos quando o
`husky prepare` escreveu `.husky/_/.gitignore`. Duas ocorrências, duas
descobertas por acidente.

**Onde encosta:** uma frase em `references/contract.md`, no parágrafo do
snapshot, e a mensagem de erro nomeando **qual** fonte mudou (hoje ela nomeia
nenhuma). O arquivo tem teto de bytes e o aumento precisa do mesmo argumento que
os outros — mas o custo é de uma linha e o benefício é um nó inteiro por
ocorrência. Ver `RM-051`.

### F3 — o selo commita o que a verificação deixou no diretório de trabalho

A suíte do alvo escrevia `rec-wav-test-<pid>.*` no diretório de trabalho quando
`TMPDIR` não estava exportado. O selo do faberun commita a árvore do worktree —
corretamente, é o que ele deve fazer — e **14 artefatos de teste atravessaram
para a branch integrada**, um par por nó que rodou a suíte.

Nada disso é erro do faberun isoladamente: o selo faz o que promete, o
`scopeFindings` registrou os caminhos inesperados, e o worker não tinha como
saber que aquilo vazaria. Mas o resultado é uma branch de correção de segurança
com lixo de teste dentro, e o único conserto foi um contrato extra.

**Onde encosta:** um achado próprio para arquivos **não rastreados** deixados
pela verificação (distinto de "escrita fora do escopo", que é o que
`scopeFindings` cobre), ou uma frase no guia de pacote: *um comando de
verificação que escreve no worktree deixa o que escreveu no commit de
integração*. Ver `RM-052`.

### F4 — o controlador destacado morre com o cgroup de quem o lançou

`campaign supervise` lança o run com `detachSelf`. O filho é reparentado — mas
não sai do cgroup de quem lançou. Se o processo lançador vive dentro de um
escopo que é derrubado (o shell de um harness, um `systemd-run --scope`, uma
sessão que termina), **o controlador morre junto, no meio do bootstrap**.

A evidência é literal: a atenção da campanha ficou
`detached bootstrap did not become ready for pid 31966 (launch_failed)`, e o run
ficou no disco com todos os nós `pending` e `controller: none`. O mesmo run,
relançado com `resume` dentro de um processo durável, percorreu tudo sem
problema. Na primeira metade da sessão isso custou três runs cancelados.

O `contract.md` fala em "detached" e o `SKILL.md` fala em "supervisionado por um
processo determinístico destacado". Nenhum dos dois diz a parte que decide:
**destacado sobrevive ao processo, não à sessão que o contém.**

**Onde encosta:** a operação ganha uma frase explícita (*rode o controlador sob
`tmux`, `systemd-run` ou o `seat`, e não como filho de um shell que vai
morrer*), e o parque `launch_failed` poderia dizer que o run existe e que
`resume` o completa — hoje a mensagem nomeia o comando, mas não diz que metade
do trabalho já está no disco. Ver `RM-053`.

### F5 — defeito de pacote não tem override de operador

O nó `test-hygiene` já tinha, na tentativa que falhou, **apagado os 14 caminhos
e corrigido a causa raiz** do `testDir()`. O defeito era uma linha do pacote que
eu escrevi. A única saída disponível era cancelar o run e reemitir o contrato —
e a reemissão recomeça do zero, porque o selo de uma tentativa que falhou não
está no ancestral do run novo.

`resume --answer` existe e é exatamente o mecanismo certo: o texto não entra no
worktree, o pacote autorado e o `packetHash` ficam intactos, e o operador
acrescenta um override. Ele só cobre `context_missing`.

**Onde encosta:** estender o override a qualquer nó não-terminal, com o mesmo
limite de 8 KiB e o mesmo registro em `executionOverrides`. Não é mecanismo
novo; é o mecanismo existente deixando de ter uma única porta. Ver `RM-054`.

### F6 — os indicadores de `metrics` punem a recuperação do operador

`nodesDoneRate` deu **0,7778** (14 de 18). Os quatro registros que não fecharam
vêm inteiramente dos dois runs que **eu** cancelei de propósito para reemitir o
contrato — runs cujo trabalho, em um dos casos, foi o que acabou aterrissando.
O indicador não erra a conta; ele lê recuperação como falha.

O manifesto sabe da substituição: `replace-contract` registrou a troca. Um run
cancelado e substituído não deveria entrar no denominador do mesmo jeito que um
run que falhou por si.

**Onde encosta:** marcar a run substituída (o dado já existe) e excluir o par,
ou publicar numerador/denominador com os ids para o leitor poder subtrair. Ver
`RM-055`.

### F7 — o teto de 150 requisições por tentativa não estava documentado ✅ fechado

Duas tentativas do contrato de revisão de uma campanha anterior foram cortadas
**exatamente** em 150 requisições, com o entregável já escrito. Eu li o
`contract.md` inteiro antes de emitir e não encontrei o campo; o default só
aparecia em `src/contract/index.mjs`.

Isso **já está corrigido**: `references/contract.md` nomeia `maxTurns` (default
150) desde 0.19.x, e o comentário do teto em `test/docs/docs-diet.test.mjs`
descreve este caso exato — um autor que subiu `timeoutSec` e `stallTimeoutSec`,
"tudo o que sabia existir", e foi cortado por um teto que nunca lhe mostraram.
Registro aqui como crédito, não como pendência: a lição foi incorporada antes
deste relatório existir.

---

## 6. Custo por runtime

Vale a tabela inteira, porque ela diz onde o dinheiro vai e onde não vai.

| runtime | papel | chamadas | entrada | cache lido | saída | custo |
|---|---|---|---|---|---|---|
| `dsh-deepseek-flash` | worker (todas as tentativas) | 18 | 736 k | 29,4 M | 477 k | **US$ 0,4724** |
| `dsh-glm-5.3-flash` | juiz primário | 15 | 158 k | 378 k | 13 k | **US$ 0,0417** |
| `claude-sonnet-5` | juiz de fallback (3 nós) | 5 | 97 k | 1,08 M | 22 k | **US$ 0,8333** |

Duas leituras, e as duas importam para roteamento:

1. **O juiz GLM custou 2,8 % da campanha** e julgou 8 dos 12 nós. Um juiz
   cross-vendor de qualidade por menos de 5 centavos é o argumento empírico mais
   forte que esta campanha produziu sobre a tese de roteamento.
2. **O juiz de fallback custou 62 % da campanha por um terço dos nós.** Não é
   defeito do fallback — ele fez o que devia — mas é o preço de não ter
   alternativa do mesmo vendor quando a quota acaba. Um segundo runtime `zhipu`
   (ou um `glm-5.3` no mesmo vendor, declarado como fallback) teria custado uma
   fração.

---

## 7. O que eu, operador, faria diferente

Três coisas, todas minhas, nenhuma da ferramenta:

1. **Ter conferido o cgroup antes de culpar o `detach`.** Perdi três runs
   lançando controladores de um shell que morre. A regra que adotei — *run longo
   se conduz com `resume` em primeiro plano dentro de um processo durável* —
   devia estar na primeira linha do guia de operação, não aprendida por
   acidente três vezes.
2. **Ter lido o `.gitignore` do pacote como fonte de ignore, não como arquivo.**
   O nó caiu por uma linha que eu escrevi. Ver F2.
3. **Ter desconfiado de teste que escreve no diretório de trabalho.** O selo
   commita o worktree inteiro; um teste que suja o cwd suja a branch. Ver F3.

E uma que não é minha e vale para a ferramenta: as fricções F1–F6 são todas da
mesma família — **um comportamento correto cujo custo o operador descobre
pagando**. Documentar não é cosmético quando o documento é a única coisa que
separa um nó fechado de um nó perdido.

---

## 8. Como ler os arquivos desta campanha

| Arquivo | O que é |
|---|---|
| `spec/SPEC.md` | o que a campanha declarou fazer, com os requisitos R1–R12 e os critérios de sucesso |
| `contracts/` | os cinco contratos como foram emitidos, incluindo os dois reemitidos (o do `.gitignore` e o do `RATE_LIMIT`) |
| `campaign.json` | manifesto: estado, runs ligados, promoções e o `landBranch` |
| `journal.jsonl` | o diário append-only: intenções, decisões, restrições, resultados e a retrospectiva |
| `metrics.txt` | a saída de `faberun metrics` para a campanha |
| `usage/` | um `usage.jsonl` por run, com tokens e custo por invocação |

Os dois contratos reemitidos estão aqui de propósito. Um registro que só guarda
o contrato que deu certo não ensina ninguém a não repetir o que deu errado.
