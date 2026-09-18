/**
 * The dashboard's browser module: fetches the campaign roll-up
 * (`src/report/progress.mjs`'s `renderCampaignProgress`, embedded in
 * `/api/snapshot`'s `progress` field by `src/web/server.mjs`), lays out its
 * graphs as inline SVG and wires selection to the drill-down panel. This is
 * the one file in the repository that runs in the browser, not Node: no
 * `import`, no `node:` builtin. Nothing in the source tree yet types browser
 * globals for `tsc`'s `checkJs`, so every DOM/browser global is reached
 * through a single `any`-cast of `globalThis` (`G()` below) rather than
 * adding a `dom` lib reference that would also change what every Node file
 * in this program sees.
 */
"use strict";

/** @returns {any} */
function G() {
  return globalThis;
}

const POLL_FALLBACK_MS = 3000;
const EVENT_PAGE_GUARD = 50;

/** @param {unknown} value @returns {string} */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

/** @param {number|null|undefined} value @returns {string} */
export function fmtUsd(value) {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "–";
}

/** @param {string|null|undefined} iso @returns {string} */
function fmtWhen(iso) {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return String(iso ?? "–");
  return new Date(t).toISOString().replace("T", " ").slice(0, 16);
}

const STATUS_LABELS = /** @type {Record<string, string>} */ ({ not_started: "not started", "no-op": "no-op" });

/** @param {string|null|undefined} status @returns {string} */
export function statusLabel(status) {
  return STATUS_LABELS[String(status)] ?? String(status ?? "unknown").replace(/_/gu, " ");
}

const FAIL_STATUSES = new Set(["failed", "blocked", "exhausted", "stalled", "canceled", "cancelled", "unreadable"]);

/** The dashboard's own semantic-role vocabulary (DESIGN.md): ok/progress/warn/fail/muted. @param {string|null|undefined} status @returns {string} */
export function statusRole(status) {
  if (status === "done" || status === "no-op") return "ok";
  if (FAIL_STATUSES.has(String(status))) return "fail";
  if (status === "not_started" || status === "pending") return "muted";
  return "progress";
}

/** Requirement id + verbatim statement, copied from docs/campaigns/state-location-and-routing-economics/spec/SPEC.md — never paraphrased or shortened. */
export const REQUIREMENTS = [
  { id: "R1", front: "state", statement: "um único módulo resolve caminho de run, campanha e worktree; nenhum outro arquivo de `src/`, `test/` ou `evals/` constrói esse caminho por concatenação literal." },
  { id: "R2", front: "state", statement: "runs, worktrees de tentativa, journal, ledger e heartbeat vivem sob a home do usuário, organizados por projeto e campanha; nenhum artefato durável de execução é criado dentro da árvore do repositório alvo." },
  { id: "R3", front: "state", statement: "o sidecar que o worker escreve dentro do worktree de tentativa não é afetado pela mudança de layout; as exclusões de pathspec que o protegem, e a que protege o symlink de dependências, permanecem justificadas por comentário no código e cobertas por teste." },
  { id: "R4", front: "state", statement: "o projeto é chaveado pelo caminho do repositório; cada projeto registra caminho e remote conhecidos; existe um comando que reassocia um projeto cujo caminho mudou, sem perder campanhas; dois clones em caminhos distintos são projetos distintos." },
  { id: "R5", front: "state", statement: "o runner exporta a variável de scratch apontando para dentro do run dir, a referência de contrato instrui o uso da variável, e nenhum packet cita caminho literal de diretório de execução." },
  { id: "R6", front: "state", statement: "existe um ponteiro global de no máximo 1 KiB na home apontando para o run ativo, e a integração de status line o lê por caminho fixo, sem glob nem ordenação por data de modificação." },
  { id: "R7", front: "state", statement: "existe um comando de migração que recusa executar com lease vivo, copia e verifica antes de remover, pode ser executado duas vezes sem efeito adicional, e durante uma versão a leitura aceita os dois layouts com aviso." },
  { id: "R8", front: "state", statement: "o expurgo de runs antigos é opt-in, nunca automático, recusa remover campanha cujo ledger ainda não foi preservado no registro, e reporta o que removeria antes de remover." },
  { id: "R9", front: "deliverable", statement: "o plano congelado declara, por fase, os identificadores de requisito que ela atende e o entregável que produz, em uma frase; fase sem requisito associado é reportada pela validação de plano." },
  { id: "R10", front: "deliverable", statement: "o contrato preserva, por nó, os identificadores de requisito herdados da fase, e o resultado de worker os carrega de volta sem que o worker precise declará-los." },
  { id: "R11", front: "deliverable", statement: "encerrar uma campanha grava no registro, deterministicamente e sem invocar modelo, o mapa de requisito para nó para evidência de verificação, marcando requisito não coberto como aberto em vez de omiti-lo; a correlação sai dos identificadores carregados, nunca de casamento por texto." },
  { id: "R12", front: "routing", statement: "a descoberta registra, por runtime, o que o harness de fato reporta: horário de reset e janela de exaustão quando existirem, allowance restante apenas nos harnesses que a expõem, e quando cada dado foi observado; dado ausente é nulo, nunca zero e nunca folga cheia, e dado mais antigo que sua própria janela é tratado como desconhecido." },
  { id: "R13", front: "routing", statement: "a tabela aceita uma estratégia nomeada por regra, com no mínimo prioridade, custo, proximidade de reset e afinidade de tentativa; a estratégia aplicada e o motivo da escolha ficam registrados na atribuição; estratégia que depende de dado não observável para o runtime em questão é inerte, não falha." },
  { id: "R14", front: "routing", statement: "tentativas e revisões sucessivas do mesmo nó preferem o runtime da tentativa anterior enquanto ele estiver saudável e não exausto, e cedem para as demais regras quando isso violaria distinção de vendor, escopo ou disponibilidade." },
  { id: "R15", front: "routing", statement: "runtime declarado pelo operador na invocação persiste no contrato congelado e prevalece sobre a tabela e sobre a estratégia." },
  { id: "R16", front: "routing", statement: "o relatório expõe quantos bytes de packet se repetem entre tentativas sucessivas do mesmo nó, para que a decisão de deduplicar seja tomada sobre dado; esta spec não pede deduplicação." },
  { id: "R17", front: "routing", statement: "as suítes caras rodam em agenda noturna, fora do caminho de merge; regressão estocástica abre issue com dono declarado e não bloqueia pull request; a classe determinística continua bloqueando." },
  { id: "R18", front: "routing", statement: "existe verificação de mutação escopada aos caminhos de escrita do nó, com limiar declarado por nível de risco, que reprova quando um teste não mata o mutante correspondente, e que completa dentro do orçamento de tempo declarado." },
  { id: "R19", front: "routing", statement: "a tabela de política de falha é exercitada em agenda noturna pelo driver determinístico, injetando cada classe de falha declarada, e nenhuma recuperação invoca modelo." },
];

export const FRONTS = [
  { id: "state", label: "State outside the repository" },
  { id: "deliverable", label: "Tracked deliverable" },
  { id: "routing", label: "Routing economics" },
];

/** @param {string} requirementId @param {{declaredRequirementIds?: string[], name?: string|null, contractId: string}[]} phases @returns {{name: string|null, contractId: string}|null} */
export function coveringPhase(requirementId, phases) {
  const phase = (phases ?? []).find((candidate) => (candidate.declaredRequirementIds ?? []).includes(requirementId));
  return phase ? { name: phase.name ?? null, contractId: phase.contractId } : null;
}

/** @param {{declaredRequirementIds?: string[], name?: string|null, contractId: string}[]} phases @returns {string} */
export function buildSpecMapHtml(phases) {
  const columns = FRONTS.map((front) => {
    const rows = REQUIREMENTS.filter((requirement) => requirement.front === front.id).map((requirement) => {
      const phase = coveringPhase(requirement.id, phases);
      const coverage = phase
        ? `${esc(phase.name ?? phase.contractId)} <span class="mono dim">${esc(phase.contractId)}</span>`
        : `<span class="dim">not yet declared</span>`;
      return `<div class="reqrow"><div class="reqid mono">${esc(requirement.id)}</div><div class="reqstatement">${esc(requirement.statement)}</div><div class="reqphase">${coverage}</div></div>`;
    }).join("");
    return `<div class="specfront"><h3>${esc(front.label)}</h3>${rows}</div>`;
  }).join("");
  return `<p class="caveat">Requirement coverage below is <b>declared</b>, read from each phase's own declared requirement ids — not yet measured against what a node delivered.</p><div class="specmap">${columns}</div>`;
}

/**
 * A node's column is its depth in the dependency graph (0 when it depends on
 * nothing in this phase); its row is its position, in the phase's own node
 * order, among the siblings sharing that depth — so two nodes that depend on
 * the same parent and on nothing else land in the same column, side by side.
 *
 * @template {{id: string, dependsOn?: string[]}} T
 * @param {T[]} nodes
 * @returns {(T & {depth: number, row: number})[]}
 */
export function layoutNodes(nodes) {
  const list = nodes ?? [];
  const byId = new Map(list.map((node) => [node.id, node]));
  /** @type {Map<string, number>} */
  const depthCache = new Map();
  /** @param {string} id @param {Set<string>} seen @returns {number} */
  const depthOf = (id, seen) => {
    if (depthCache.has(id)) return /** @type {number} */ (depthCache.get(id));
    if (seen.has(id)) return 0; // a cycle should never exist in an authored DAG
    seen.add(id);
    const node = byId.get(id);
    const deps = (node?.dependsOn ?? []).filter((dep) => byId.has(dep));
    const depth = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, seen)));
    depthCache.set(id, depth);
    return depth;
  };
  const rowCounters = new Map();
  return list.map((node) => {
    const depth = depthOf(node.id, new Set());
    const row = rowCounters.get(depth) ?? 0;
    rowCounters.set(depth, row + 1);
    return { ...node, depth, row };
  });
}

const NODE_COL_WIDTH = 260;
const NODE_ROW_HEIGHT = 76;
const NODE_BOX_W = 220;
const NODE_BOX_H = 56;
const NODE_MARGIN = 16;
/** A node id is long by this repository's own naming rule; this is the character budget that keeps a mono id's ellipsis inside the box at `NODE_BOX_W`, not a measurement of the rendered glyphs. */
const NODE_ID_MAX_CHARS = 24;

/**
 * A box's text, clipped to its own rectangle: a `<clipPath>` keyed to the same
 * `x, y, width, height` as the box's own `<rect>`, and a `clip-path` on the
 * group that owns both. Truncation with an ellipsis (`truncateOneLine`) keeps
 * the common case legible; the clip is what keeps an underestimate from
 * spilling into the next box's gap instead of merely looking wrong.
 *
 * @param {string} clipId
 * @param {number} x @param {number} y @param {number} width @param {number} height
 * @returns {string}
 */
function clipPathHtml(clipId, x, y, width, height) {
  return `<clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${width}" height="${height}" /></clipPath>`;
}

/** @param {{nodes?: {id: string, dependsOn?: string[], status: string}[]}|null|undefined} phase @returns {string} */
export function renderPhaseGraphSvg(phase) {
  if (!phase || !Array.isArray(/** @type {any} */ (phase).nodes) || /** @type {any} */ (phase).nodes.length === 0) {
    return `<p class="empty">this phase has no nodes yet</p>`;
  }
  const laidOut = /** @type {any[]} */ (layoutNodes(/** @type {any} */ (phase).nodes));
  const byId = new Map(laidOut.map((node) => [node.id, node]));
  const maxDepth = laidOut.reduce((max, node) => Math.max(max, node.depth), 0);
  const maxRow = laidOut.reduce((max, node) => Math.max(max, node.row), 0);
  const width = NODE_MARGIN * 2 + (maxDepth + 1) * NODE_COL_WIDTH;
  const height = NODE_MARGIN * 2 + (maxRow + 1) * NODE_ROW_HEIGHT;
  const posOf = (/** @type {any} */ node) => ({ x: NODE_MARGIN + node.depth * NODE_COL_WIDTH, y: NODE_MARGIN + node.row * NODE_ROW_HEIGHT });
  const edges = laidOut.flatMap((node) => (node.dependsOn ?? [])
    .filter((/** @type {string} */ dep) => byId.has(dep))
    .map((/** @type {string} */ dep) => {
      const from = posOf(byId.get(dep));
      const to = posOf(node);
      const x1 = from.x + NODE_BOX_W;
      const y1 = from.y + NODE_BOX_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_BOX_H / 2;
      const midX = (x1 + x2) / 2;
      return `<path class="edge" d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" />`;
    })).join("");
  const boxes = laidOut.map((node, index) => {
    const { x, y } = posOf(node);
    const clipId = `nodeclip${index}`;
    return `<g class="node ${esc(statusRole(node.status))}" data-node="${esc(node.id)}" tabindex="0" role="button" aria-label="node ${esc(node.id)}, ${esc(statusLabel(node.status))}">
      <rect x="${x}" y="${y}" width="${NODE_BOX_W}" height="${NODE_BOX_H}" rx="8" />
      <defs>${clipPathHtml(clipId, x, y, NODE_BOX_W, NODE_BOX_H)}</defs>
      <g clip-path="url(#${clipId})">
        <text x="${x + 10}" y="${y + 22}" class="node-id mono">${esc(truncateOneLine(node.id, NODE_ID_MAX_CHARS))}</text>
        <text x="${x + 10}" y="${y + 40}" class="node-status">${esc(statusLabel(node.status))}</text>
      </g>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="node graph">${edges}${boxes}</svg>`;
}

/**
 * The campaign chain: two fixed conceptual stages (intent, plan), one stage
 * per manifest phase in order, then integration and release. `current` marks
 * the first phase that is not fully settled — the last one once every phase
 * is. A phase's `idMark` is its own local phase id (the useful, short mark),
 * never the campaign-prefixed contract id that already prefixes the campaign
 * heading above the chain; a synthetic stage (intent, plan, integration,
 * release) carries no id at all, since its label and its id are the same
 * word.
 *
 * @param {{phases: {contractId: string, phase: string|null, runId: string|null, name: string|null, goal: string|null, counts: {done: number, settled: number, total: number}}[]}|null} progress
 * @param {string|null} campaignStatus
 * @returns {{id: string, idMark: string|null, label: string, goal?: string|null, state: string, current: boolean}[]}
 */
export function chainStages(progress, campaignStatus) {
  const phases = progress?.phases ?? [];
  // Whether the phase still needs attention: not started, no nodes yet, or
  // holding a node that has not reached `done`/`no-op` — a blocked, failed or
  // exhausted node settles (SETTLED) without finishing (SUCCESS), and this
  // reads it as unfinished, not as done.
  const notDone = (/** @type {any} */ phase) => !phase.runId || phase.counts.total === 0 || phase.counts.done < phase.counts.total;
  const firstUnsettled = phases.findIndex(notDone);
  const currentIndex = firstUnsettled === -1 ? phases.length - 1 : firstUnsettled;
  const allDone = phases.length > 0 && phases.every((phase) => !notDone(phase));
  /** @type {{id: string, idMark: string|null, label: string, goal?: string|null, state: string, current: boolean}[]} */
  const stages = [
    { id: "intent", idMark: null, label: "Intent", state: "done", current: false },
    { id: "plan", idMark: null, label: "Plan", state: "done", current: false },
  ];
  phases.forEach((phase, index) => {
    const started = phase.runId !== null;
    const done = started && phase.counts.total > 0 && phase.counts.done === phase.counts.total;
    stages.push({
      id: phase.contractId,
      idMark: phase.phase,
      label: phase.name ?? phase.contractId,
      goal: phase.goal,
      state: !started ? "not_started" : done ? "done" : "active",
      current: index === currentIndex,
    });
  });
  stages.push({ id: "integration", idMark: null, label: "Integration", state: allDone ? (campaignStatus === "closed" ? "done" : "active") : "not_started", current: false });
  stages.push({ id: "release", idMark: null, label: "Release", state: campaignStatus === "closed" ? "done" : "not_started", current: false });
  return stages;
}

const STAGE_W = 168;
const STAGE_H = 80;
const STAGE_GAP = 40;
const STAGE_MARGIN = 16;
const STAGE_LABEL_MAX_CHARS = 20;
const STAGE_ID_MAX_CHARS = 20;
const STAGE_GOAL_MAX_CHARS = 22;

/** @param {{id: string, idMark: string|null, label: string, goal?: string|null, state: string, current: boolean}[]} stages @returns {string} */
export function renderChainSvg(stages) {
  const width = STAGE_MARGIN * 2 + stages.length * STAGE_W + Math.max(0, stages.length - 1) * STAGE_GAP;
  const height = STAGE_MARGIN * 2 + STAGE_H;
  const edges = stages.slice(1).map((_stage, index) => {
    const x1 = STAGE_MARGIN + index * (STAGE_W + STAGE_GAP) + STAGE_W;
    const x2 = x1 + STAGE_GAP;
    const y = STAGE_MARGIN + STAGE_H / 2;
    return `<line class="edge" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" />`;
  }).join("");
  const boxes = stages.map((stage, index) => {
    const x = STAGE_MARGIN + index * (STAGE_W + STAGE_GAP);
    const y = STAGE_MARGIN;
    const clipId = `stageclip${index}`;
    const idLine = stage.idMark ? `<text x="${x + 10}" y="${y + 34}" class="mono dim stage-id">${esc(truncateOneLine(stage.idMark, STAGE_ID_MAX_CHARS))}</text>` : "";
    const goalLine = stage.goal ? `<text x="${x + 10}" y="${y + 66}" class="stage-goal">${esc(truncateOneLine(stage.goal, STAGE_GOAL_MAX_CHARS))}</text>` : "";
    return `<g class="stage ${esc(stage.state)}${stage.current ? " current" : ""}" data-phase="${esc(stage.id)}">
      <rect x="${x}" y="${y}" width="${STAGE_W}" height="${STAGE_H}" rx="8" />
      <defs>${clipPathHtml(clipId, x, y, STAGE_W, STAGE_H)}</defs>
      <g clip-path="url(#${clipId})">
        <text x="${x + 10}" y="${y + 20}" class="stage-label">${esc(truncateOneLine(stage.label, STAGE_LABEL_MAX_CHARS))}</text>
        ${idLine}
        <text x="${x + 10}" y="${y + 50}" class="stage-state">${esc(statusLabel(stage.state))}</text>
        ${goalLine}
      </g>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="campaign chain">${edges}${boxes}</svg>`;
}

/** @param {string} value @param {number} maxChars @returns {string} */
function truncateOneLine(value, maxChars) {
  const flat = value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  return flat;
}

/** The option label is the campaign id — its goal is a one-line-but-still-long sentence, which is what pushed the rest of the header off screen. @param {{id: string, goal: string, status: string}[]} campaigns @param {string|null} selectedId @returns {string} */
export function campaignOptionsHtml(campaigns, selectedId) {
  return (campaigns ?? []).map((campaign) => `<option value="${esc(campaign.id)}" ${campaign.id === selectedId ? "selected" : ""}>${esc(campaign.id)} (${esc(campaign.status)})</option>`).join("");
}

/** @param {Record<string, any>|null|undefined} detail @returns {string} */
function logSectionHtml(detail) {
  const lines = detail?.log?.lines ?? [];
  return `<section class="detailblock"><h4>Worker transcript</h4>${lines.length ? `<pre>${esc(lines.join("\n"))}</pre>` : '<p class="empty">no log yet</p>'}</section>`;
}

/** @param {Record<string, any>|null|undefined} detail @returns {string} */
function verificationSectionHtml(detail) {
  const commands = detail?.verification?.commands ?? [];
  if (!commands.length) return `<section class="detailblock"><h4>Verification</h4><p class="empty">no verification recorded</p></section>`;
  const body = commands.map((/** @type {any} */ command) => `<div class="finding"><span class="pill ${command.passed ? "ok" : "fail"}">${command.passed ? "pass" : "fail"}</span> <span class="mono">${esc(command.command)}</span>${command.durationMs ? ` <span class="dim">${esc(command.durationMs)}ms</span>` : ""}<pre>${esc(command.outputTail || "(no output)")}</pre></div>`).join("");
  return `<section class="detailblock"><h4>Verification</h4>${body}</section>`;
}

/** @param {Record<string, any>|null|undefined} detail @returns {string} */
function diffSectionHtml(detail) {
  const diff = detail?.diff;
  if (!diff) return `<section class="detailblock"><h4>Scope</h4><p class="empty">no scope recorded</p></section>`;
  const files = diff.files.map((/** @type {string} */ path) => `<div class="mono">${esc(path)}</div>`).join("") || `<p class="empty">no files changed</p>`;
  const unexpected = diff.unexpected.length ? `<p class="dim">unexpected: ${diff.unexpected.map(esc).join(", ")}</p>` : "";
  return `<section class="detailblock"><h4>Scope</h4><p>${esc(diff.stat)}</p>${unexpected}${files}</section>`;
}

/** @param {Record<string, any>|null|undefined} detail @returns {string} */
function findingsSectionHtml(detail) {
  const findings = detail?.findings;
  if (!findings) return `<section class="detailblock"><h4>Gate findings</h4><p class="empty">no gate ran</p></section>`;
  const list = findings.findings.map((/** @type {any} */ finding) => `<div class="finding"><span class="pill ${finding.severity === "major" || finding.severity === "critical" ? "fail" : "warn"}">${esc(finding.severity)}</span> ${esc(finding.description)}<div class="dim">${esc(finding.evidence)}</div></div>`).join("") || `<p class="empty">no findings</p>`;
  return `<section class="detailblock"><h4>Gate findings</h4><p>${esc(findings.verdict ?? "")} ${esc(findings.summary ?? "")}</p>${list}</section>`;
}

/** @param {Record<string, any>|null|undefined} detail @returns {string} */
function promptSectionHtml(detail) {
  return `<section class="detailblock"><h4>Prompt</h4>${detail?.prompt ? `<pre>${esc(detail.prompt)}</pre>` : '<p class="empty">no prompt recorded</p>'}</section>`;
}

/** @param {Record<string, any>|null|undefined} detail @returns {string} */
function judgeRoundsHtml(detail) {
  const rounds = detail?.judgeRounds ?? [];
  if (!rounds.length) return `<section class="detailblock"><h4>Judge rounds</h4><p class="empty">no judge round yet</p></section>`;
  const rows = rounds.map((/** @type {any} */ round, /** @type {number} */ index) => `<div class="finding"><span class="mono">round ${index + 1}</span> · ${esc(round.harness ?? "–")}/${esc(round.model ?? "–")} · <span class="pill ${round.status === "closed" ? "ok" : "progress"}">${esc(round.status ?? "–")}</span>${round.stdoutPath ? ` · <span class="mono dim">${esc(round.stdoutPath)}</span>` : ""}</div>`).join("");
  return `<section class="detailblock"><h4>Judge rounds</h4>${rows}</section>`;
}

/**
 * The drill-down panel for one selected node: the roll-up's own fields
 * (state, attempt, elapsed, cost, on-disk links) plus the async detail fetch
 * (transcript, verification, scope, findings, prompt, revisions, error). The
 * journal timeline is filled in later, by `fetchTimeline`, into the
 * `#timelineBody` placeholder this returns.
 *
 * @param {Record<string, any>|null} node
 * @param {Record<string, any>|null} detail
 * @param {string|null} contractPath
 * @returns {string}
 */
export function renderDrilldownHtml(node, detail, contractPath) {
  if (!node) return `<p class="empty">select a node above</p>`;
  const hasInvocation = Boolean(detail?.workerRuntime) || Boolean(detail?.judgeRounds?.length);
  const costDisplay = node.costUsd != null ? fmtUsd(node.costUsd) : (hasInvocation ? "unpriced" : "–");
  const drow = (/** @type {string} */ label, /** @type {string} */ value) => `<div class="drow"><div class="dlabel">${esc(label)}</div><div class="dvalue">${value}</div></div>`;
  // An error and a note are two different things: `errorCode` is set only
  // when the node actually failed (`buildNodeDetail`'s own read of the raw
  // snapshot's `error`), so the compact metric-width cell reads empty rather
  // than carrying a gate summary or review note that never was an error.
  const hasError = Boolean(detail?.errorCode);
  const rows = [
    drow("attempt", esc(node.attempt != null ? String(node.attempt) : "–")),
    drow("revisions", esc(detail?.revisions != null ? String(detail.revisions) : "–")),
    drow("worker runtime", esc(node.workerRuntime ?? "–")),
    drow("judge runtime", esc(node.judgeRuntime ?? "–")),
    drow("elapsed", esc(node.elapsedSpan ?? "–")),
    drow("cost", esc(costDisplay)),
    drow("error", hasError ? `${esc(detail?.errorCode)}${detail?.errorMessage ? ` · ${esc(detail.errorMessage)}` : ""}` : "–"),
  ];
  // The note (a gate summary, a review outcome, a blocked reason -- whatever
  // `statusNote` in render.mjs composed) reads as prose, in its own
  // full-width row: the `.drows` grid's metric-width columns are for short
  // facts, and wrapping a sentence into one truncates it mid-word.
  const noteHtml = detail?.errorMessage
    ? `<section class="detailblock"><h4>Note</h4><p>${esc(detail.errorMessage)}</p></section>`
    : "";
  const links = [
    node.workerLogPath ? `<div class="link mono">worker transcript: ${esc(node.workerLogPath)}</div>` : null,
    ...(node.judgeLogPaths ?? []).map((/** @type {string} */ path, /** @type {number} */ index) => `<div class="link mono">judge round ${index + 1}: ${esc(path)}</div>`),
    node.verificationRecordPath ? `<div class="link mono">verification record: ${esc(node.verificationRecordPath)}</div>` : null,
    node.attemptBranch ? `<div class="link mono">attempt branch: ${esc(node.attemptBranch)}</div>` : null,
    node.sealCommit ? `<div class="link mono">seal commit: ${esc(node.sealCommit)}</div>` : null,
    contractPath ? `<div class="link mono">contract: ${esc(contractPath)}</div>` : null,
  ].filter(Boolean).join("");
  return `<div class="drilldown-head"><h3 class="mono">${esc(node.id)}</h3><span class="pill ${esc(statusRole(node.status))}">${esc(statusLabel(node.status))}</span></div>
    <div class="drows">${rows.join("")}</div>
    ${noteHtml}
    <section class="detailblock"><h4>On disk</h4>${links || '<p class="empty">nothing recorded yet</p>'}</section>
    ${judgeRoundsHtml(detail)}
    ${logSectionHtml(detail)}
    ${verificationSectionHtml(detail)}
    ${diffSectionHtml(detail)}
    ${findingsSectionHtml(detail)}
    ${promptSectionHtml(detail)}
    <section class="detailblock timeline"><h4>Journal timeline</h4><div id="timelineBody"><p class="empty">loading…</p></div></section>`;
}

/** Whether a campaign journal entry names this node or its phase's contract, by substring — the timeline's own filter, not a traceability claim. @param {Record<string, unknown>} entry @param {string} nodeId @param {string} contractId @returns {boolean} */
export function entryMentionsNode(entry, nodeId, contractId) {
  const text = JSON.stringify(entry);
  return text.includes(nodeId) || text.includes(contractId);
}

/** @param {Record<string, any>[]} entries @returns {string} */
export function renderTimelineHtml(entries) {
  if (!entries.length) return `<p class="empty">no journal entries mention this node yet</p>`;
  const sorted = entries.slice().sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const rows = sorted.map((entry) => `<div class="trow"><div class="tat mono">${esc(fmtWhen(entry.at))}</div><div class="ttype">${esc(entry.type)}</div><div class="ttext">${esc(entry.text ?? entry.summary ?? entry.message ?? "")}</div></div>`).join("");
  return `<div class="timelinelist">${rows}</div>`;
}

// --- Browser bootstrap. Guarded so importing this module under plain Node
// (as the tests do, to reach the pure functions above) never touches a DOM
// global that does not exist there. ---

const state = {
  campaignId: /** @type {string|null} */ (null),
  phaseContractId: /** @type {string|null} */ (null),
  nodeId: /** @type {string|null} */ (null),
  contractPaths: /** @type {string[]} */ ([]),
  source: /** @type {any} */ (null),
  pollTimer: /** @type {any} */ (null),
  transport: "none",
};

function streamUrl() {
  const params = new (G().URLSearchParams)();
  if (state.campaignId) params.set("campaign", state.campaignId);
  if (state.phaseContractId) params.set("run", state.phaseContractId);
  if (state.nodeId) params.set("node", state.nodeId);
  const query = params.toString();
  return `/api/stream${query ? `?${query}` : ""}`;
}

/** @param {string} transport @param {string} at */
function setConnection(transport, at) {
  const doc = G().document;
  const dot = doc.getElementById("conn").querySelector(".dot");
  dot.className = `dot ${transport === "stream" || transport === "poll" ? "live" : "lost"}`;
  doc.getElementById("conntext").textContent = transport === "none" ? "connection lost — reconnecting" : `updated ${new Date(Date.parse(at ?? "")).toISOString()}`;
}

/** @param {string} campaignId @param {string} nodeId @param {string} contractId */
async function fetchTimeline(campaignId, nodeId, contractId) {
  const doc = G().document;
  const body = doc.getElementById("timelineBody");
  if (!body) return;
  try {
    const entries = [];
    let after = 0;
    for (let guard = 0; guard < EVENT_PAGE_GUARD; guard += 1) {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/events?after=${after}`);
      if (!response.ok) break;
      const page = /** @type {any} */ (await response.json());
      entries.push(...page.entries.filter((/** @type {any} */ entry) => entryMentionsNode(entry, nodeId, contractId)));
      if (page.complete || page.entries.length === 0) break;
      after = page.next;
    }
    body.innerHTML = renderTimelineHtml(entries);
  } catch {
    body.innerHTML = `<p class="empty">journal unavailable</p>`;
  }
}

/** The chain band's own heading: the campaign id and its one-line goal — never the id alone. @param {{campaignId: string, goal?: string|null}} progress @returns {string} */
export function campaignHeadingText(progress) {
  return `${progress.campaignId} · ${progress.goal ?? ""}`;
}

/** @param {Record<string, any>} snapshot @returns {string|null} */
function campaignStatusOf(snapshot) {
  const found = (snapshot.campaigns ?? []).find((/** @type {any} */ campaign) => campaign.id === snapshot.selectedCampaignId);
  return found?.status ?? null;
}

/** @param {Record<string, any>} snapshot */
function renderAll(snapshot) {
  const doc = G().document;
  const bandIds = ["specMap", "chain", "phaseGraph", "drilldown"];
  const empty = doc.getElementById("emptyState");
  if (!snapshot.selectedCampaignId || !snapshot.progress) {
    empty.hidden = false;
    empty.textContent = "no campaign found under .runs; initialize one with: faberun campaign init";
    for (const id of bandIds) doc.getElementById(id).hidden = true;
    return;
  }
  empty.hidden = true;
  for (const id of bandIds) doc.getElementById(id).hidden = false;
  const progress = snapshot.progress;
  doc.getElementById("specMapBody").innerHTML = buildSpecMapHtml(progress.phases);
  const stages = chainStages(progress, campaignStatusOf(snapshot));
  doc.getElementById("chainGoal").textContent = campaignHeadingText(progress);
  doc.getElementById("chainBody").innerHTML = renderChainSvg(stages);
  if (!state.phaseContractId || !progress.phases.some((/** @type {any} */ phase) => phase.contractId === state.phaseContractId)) {
    const current = stages.find((stage) => stage.current);
    state.phaseContractId = (current && progress.phases.some((/** @type {any} */ phase) => phase.contractId === current.id)) ? current.id : progress.phases[0]?.contractId ?? null;
  }
  const phase = progress.phases.find((/** @type {any} */ candidate) => candidate.contractId === state.phaseContractId) ?? null;
  doc.getElementById("phaseGraphHead").innerHTML = phase
    ? `<span class="phasename">${esc(phase.name ?? phase.contractId)}</span> <span class="mono dim">${esc(phase.contractId)}</span><p class="dim">${esc(phase.goal ?? "")}</p>`
    : "";
  doc.getElementById("phaseGraphBody").innerHTML = phase ? renderPhaseGraphSvg(phase) : `<p class="empty">no phase selected</p>`;
  if (state.nodeId && !(phase?.nodes ?? []).some((/** @type {any} */ node) => node.id === state.nodeId)) state.nodeId = null;
  const node = phase?.nodes.find((/** @type {any} */ candidate) => candidate.id === state.nodeId) ?? null;
  const contractIndex = progress.phases.findIndex((/** @type {any} */ candidate) => candidate.contractId === state.phaseContractId);
  const contractPath = contractIndex >= 0 ? state.contractPaths[contractIndex] ?? null : null;
  doc.getElementById("drilldownBody").innerHTML = renderDrilldownHtml(node, snapshot.detail, contractPath);
  if (node && phase) fetchTimeline(progress.campaignId, node.id, phase.contractId);
}

/** @param {Record<string, any>} snapshot */
function applySnapshot(snapshot) {
  state.contractPaths = Array.isArray(snapshot.contractPaths) ? snapshot.contractPaths : [];
  const doc = G().document;
  doc.getElementById("campaignSelect").innerHTML = campaignOptionsHtml(snapshot.campaigns, snapshot.selectedCampaignId);
  renderAll(snapshot);
  setConnection(state.transport, snapshot.generatedAt);
}

function connect() {
  const g = G();
  if (state.source) { state.source.close(); state.source = null; }
  if (typeof g.EventSource !== "function") { startPolling(); return; }
  const source = new g.EventSource(streamUrl());
  state.source = source;
  source.addEventListener("update", (/** @type {any} */ event) => {
    state.transport = "stream";
    stopPolling();
    try { applySnapshot(JSON.parse(event.data)); } catch (error) { console.error(error); }
  });
  source.addEventListener("error", () => { state.transport = "none"; setConnection("none", ""); startPolling(); });
}

async function pollOnce() {
  try {
    const response = await fetch(`/api/snapshot${streamUrl().slice("/api/stream".length)}`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (state.transport !== "stream") state.transport = "poll";
    applySnapshot(/** @type {any} */ (await response.json()));
  } catch {
    state.transport = "none";
    setConnection("none", "");
  }
}
function startPolling() {
  const doc = G().document;
  if (state.pollTimer) return;
  pollOnce();
  state.pollTimer = setInterval(() => { if (!doc.hidden) pollOnce(); }, POLL_FALLBACK_MS);
}
function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

/** @param {string} id */
function selectCampaign(id) {
  if (id === state.campaignId) return;
  state.campaignId = id;
  state.phaseContractId = null;
  state.nodeId = null;
  connect();
}
/** @param {string} contractId */
function selectPhase(contractId) {
  if (contractId === state.phaseContractId) return;
  state.phaseContractId = contractId;
  state.nodeId = null;
  connect();
}
/** @param {string} id */
function selectNode(id) {
  state.nodeId = id === state.nodeId ? null : id;
  connect();
}

const doc0 = G().document;
if (typeof doc0 !== "undefined") {
  doc0.getElementById("main").addEventListener("click", (/** @type {any} */ event) => {
    const stage = event.target.closest("[data-phase]");
    if (stage) return selectPhase(stage.dataset.phase);
    const node = event.target.closest("[data-node]");
    if (node) return selectNode(node.dataset.node);
  });
  doc0.getElementById("campaignSelect").addEventListener("change", (/** @type {any} */ event) => selectCampaign(event.target.value));
  connect();
}
