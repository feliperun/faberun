/**
 * The language of a notification, and the labels it is written in.
 *
 * The controller never sees the operator's conversation with a harness; it
 * sees what the operator wrote for faberun: the campaign goal, the journal
 * notes and the objectives the plan gave each node. Those are the operator's
 * prompts to this product, and a message that answers them in the same
 * language reads as a reply rather than a log line. Detection is a count of
 * function words in the two languages this product's operators write in;
 * anything else, or nothing to read, is English. Quoted content -- the
 * worker's own words, a judge finding -- keeps the language it was written
 * in, because translating a quotation would make it stop being one.
 *
 * It is a module apart from `message.mjs` so the layout and the wording can
 * change independently: a new label is one line here, a new line is one
 * function there.
 */

/** @typedef {"en"|"pt"} Language */

// `a`, `do` and `no` are left out on purpose: each is also an English word,
// and one article in an English sentence must not read as Portuguese.
const PORTUGUESE = new Set(["o", "e", "de", "da", "na", "que", "não", "nao", "para", "com", "uma", "um", "em", "os", "as", "dos", "das", "é", "se", "por", "mais", "como", "mas", "ao", "ou", "quando", "já", "também", "ser", "sem", "até", "cada", "nunca", "está", "são", "foi", "pelo", "pela", "nos", "nas", "seu", "sua", "isso", "esse", "essa", "ele", "ela"]);
const ENGLISH = new Set(["the", "and", "of", "to", "in", "is", "for", "with", "that", "on", "as", "are", "this", "it", "be", "by", "from", "or", "an", "not", "at", "when", "every", "never", "before", "after", "its", "into", "than", "which", "while", "each", "was", "has", "have"]);

/**
 * The language of the first group of samples that carries any function word
 * at all, English when none does. Groups are passed in order of authorship:
 * the campaign goal is the operator's own sentence, the journal notes are the
 * orchestrating session's, the node objectives are the planner's -- and a
 * plan written by a model in English must not outvote the person who typed
 * the goal in Portuguese (measured 2026-09-21: two node objectives held 40
 * English function words against a Portuguese goal's 19).
 *
 * @param {...readonly (string|null|undefined)[]} groups
 * @returns {Language}
 */
export function detectLanguage(...groups) {
  for (const samples of groups) {
    let portuguese = 0;
    let english = 0;
    for (const sample of samples) {
      if (typeof sample !== "string") continue;
      for (const word of sample.toLowerCase().split(/[^\p{L}]+/u)) {
        if (PORTUGUESE.has(word)) portuguese += 1;
        else if (ENGLISH.has(word)) english += 1;
      }
    }
    if (portuguese + english > 0) return portuguese > english ? "pt" : "en";
  }
  return "en";
}

/**
 * Every phrase the message renders, per language. Node ids, run ids, model
 * names and quoted text are never here: they are data, not wording.
 *
 * @type {Record<Language, Record<string, string>>}
 */
const LABELS = {
  en: {
    doneIn: "done in",
    "no-op": "no-op after",
    failedAfter: "failed after",
    blockedAfter: "blocked after",
    exhaustedAfter: "exhausted after",
    stalledAfter: "stalled after",
    canceledAfter: "canceled after",
    needsYou: "needs you",
    attempt: "attempt",
    run: "run",
    done: "done",
    asked: "asked",
    did: "done",
    proof: "proof",
    delivered: "delivered",
    why: "why",
    do: "do",
    judge: "judge",
    missing: "missing",
    error: "error",
    checksGreen: "checks green",
    checksOf: "checks passed",
    judgePass: "judge pass",
    judgePasses: "judge passes",
    judgeRejected: "judge rejected",
    noJudge: "no judge",
    revisions: "revisions",
    nodes: "nodes",
    next: "next",
    waitingOnYou: "waiting on you",
    phases: "phases",
    cache: "cache",
    in: "in",
    out: "out",
    nextCommand: "next",
    available: "available",
    runUpdate: "run",
    noSummary: "(no summary recorded)",
    noObjective: "(no objective recorded)",
    more: "more",
    complete: "complete",
  },
  pt: {
    doneIn: "concluído em",
    "no-op": "sem mudança após",
    failedAfter: "falhou após",
    blockedAfter: "bloqueado após",
    exhaustedAfter: "esgotado após",
    stalledAfter: "travou após",
    canceledAfter: "cancelado após",
    needsYou: "precisa de você",
    attempt: "tentativa",
    run: "run",
    done: "concluídos",
    asked: "pedido",
    did: "feito",
    proof: "prova",
    delivered: "entregue",
    why: "motivo",
    do: "ação",
    judge: "juiz",
    missing: "faltou",
    error: "erro",
    checksGreen: "checagens verdes",
    checksOf: "checagens passaram",
    judgePass: "juiz aprovou",
    judgePasses: "aprovações do juiz",
    judgeRejected: "juiz rejeitou",
    noJudge: "sem juiz",
    revisions: "revisões",
    nodes: "nós",
    next: "próximo",
    waitingOnYou: "esperando você",
    phases: "fases",
    cache: "cache",
    in: "entrada",
    out: "saída",
    nextCommand: "próximo passo",
    available: "disponível",
    runUpdate: "rode",
    noSummary: "(sem resumo registrado)",
    noObjective: "(sem objetivo registrado)",
    more: "mais",
    complete: "completa",
  },
};

/**
 * @param {Language} language
 * @returns {(key: string) => string}
 */
export function labelsFor(language) {
  const table = LABELS[language];
  return (key) => table[key] ?? LABELS.en[key] ?? key;
}
