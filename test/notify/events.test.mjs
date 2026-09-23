import "../scoped-home.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "../setup.mjs";
import {
  DEFAULT_NOTIFY_EVENTS,
  NOTIFY_EVENTS_ENV,
  NOTIFY_EVENT_TYPES,
  NOTIFY_LANG_ENV,
  NotifyQueue,
  deliverableEventTypes,
  notifySettingProblems,
} from "../../src/notify/index.mjs";
import { chooseLanguage } from "../../src/report/locale.mjs";
import { notifyTransportCheck } from "../../src/host/preflight.mjs";

// The operator's decision, 2026-09-22, after a run of two nodes woke the
// launching session four times: only a phase settling and a person being
// needed wake anyone; a node settling stays in the log.

/**
 * @param {Record<string, string|undefined>} values
 * @param {() => Promise<void>} body
 */
async function withEnv(values, body) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("by default a phase settling, a person being needed and an advisory leave; a node settling does not", () => {
  assert.deepEqual([...deliverableEventTypes({})], [...DEFAULT_NOTIFY_EVENTS]);
  assert.deepEqual([...DEFAULT_NOTIFY_EVENTS], ["run.terminal", "attention", "advisory"]);
  assert.ok(!deliverableEventTypes({}).has("node.terminal"));
  assert.deepEqual([...deliverableEventTypes({ [NOTIFY_EVENTS_ENV]: " node.terminal , run.terminal " })], ["node.terminal", "run.terminal"], "the list is the operator's, trimmed");
  assert.deepEqual([...deliverableEventTypes({ [NOTIFY_EVENTS_ENV]: "" })], [...DEFAULT_NOTIFY_EVENTS], "an empty value is the default, never nothing");
  assert.deepEqual([...deliverableEventTypes({ [NOTIFY_EVENTS_ENV]: "run.terminal,bogus" })], ["run.terminal"], "an unknown item is left out here and reported by the doctor");
  for (const type of NOTIFY_EVENT_TYPES) assert.ok(deliverableEventTypes({ [NOTIFY_EVENTS_ENV]: NOTIFY_EVENT_TYPES.join(",") }).has(type));
});

test("notifySettingProblems names an unknown event type and an unknown language, and is empty otherwise", () => {
  assert.deepEqual(notifySettingProblems({}), []);
  assert.deepEqual(notifySettingProblems({ [NOTIFY_EVENTS_ENV]: "run.terminal,attention", [NOTIFY_LANG_ENV]: "pt" }), []);
  assert.match(notifySettingProblems({ [NOTIFY_EVENTS_ENV]: "run.terminal,bogus" })[0], /item "bogus" is not one of node\.terminal, run\.terminal, attention, advisory/u);
  assert.match(notifySettingProblems({ [NOTIFY_LANG_ENV]: "fr" })[0], /FABERUN_NOTIFY_LANG=fr is not one of en, pt/u);
  const check = notifyTransportCheck({ [NOTIFY_EVENTS_ENV]: "bogus" });
  assert.equal(check.advisory, true);
  assert.match(check.detail, /item "bogus"/u);
  const ok = notifyTransportCheck({ FABERUN_NOTIFY_BIN: "/x", [NOTIFY_EVENTS_ENV]: "run.terminal,attention" });
  assert.match(ok.detail, /events: run\.terminal,attention$/u, "the doctor says what will leave");
});

test("a filtered event gets a receipt with the rendered summary and no transport, and never reaches the deliver seam", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "notify-events-"));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ usage: { costUsd: 0.5 } }));
  /** @type {{type: string}[]} */
  const handed = [];
  const queue = new NotifyQueue({ runDir, deliver: async (event) => { handed.push(event); return { ok: true, transports: [{ id: "bin", ok: true }] }; }, now: () => 1_700_000_000_000 });
  try {
    await queue.enqueue({ type: "node.terminal", runId: "run-a", nodeId: "build", status: "done", attempt: 1, dedupeKey: "node.terminal:run-a:build:done:1:0" });
    await queue.enqueue({ type: "run.terminal", runId: "run-a", done: 1, total: 1, dedupeKey: "run.terminal:run-a:done" });
    await queue.enqueue({ type: "attention", runId: "run-a", nodeId: "build", errorCode: "context_missing", dedupeKey: "attention:run-a:build" });
    assert.deepEqual(handed.map((event) => event.type), ["run.terminal", "attention"], "the node's settling is never handed to a transport");
    const receipts = readFileSync(join(runDir, "notify.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(receipts.map((receipt) => [receipt.type, receipt.status]), [["node.terminal", "filtered"], ["run.terminal", "delivered"], ["attention", "delivered"]]);
    assert.deepEqual(receipts[0].transports, [], "filtered means no transport was even tried");
    assert.match(receipts[0].summary, /^node build done · run run-a · attempt 1$/u, "the receipt still says what the message would have been");
    assert.equal(receipts[0].error, undefined, "filtered is a decision, not a failure");

    // Widening the list for one controller lets the node's settling out again.
    await withEnv({ [NOTIFY_EVENTS_ENV]: "node.terminal" }, async () => {
      await queue.enqueue({ type: "node.terminal", runId: "run-a", nodeId: "ship", status: "done", attempt: 1, dedupeKey: "node.terminal:run-a:ship:done:1:0" });
    });
    assert.deepEqual(handed.map((event) => event.type), ["run.terminal", "attention", "node.terminal"]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("chooseLanguage honours FABERUN_NOTIFY_LANG when it names a language this product has, and detects otherwise", () => {
  const englishGoal = ["The durable state faberun keeps is complete, reachable and repairable"];
  assert.equal(chooseLanguage({ [NOTIFY_LANG_ENV]: "pt" }, englishGoal), "pt", "an orchestrator wrote the goal in English; the person reads Portuguese");
  assert.equal(chooseLanguage({ [NOTIFY_LANG_ENV]: "en" }, ["Garantir que o cancelamento não perca trabalho"]), "en");
  assert.equal(chooseLanguage({}, englishGoal), "en");
  assert.equal(chooseLanguage({ [NOTIFY_LANG_ENV]: "fr" }, ["Garantir que o cancelamento não perca trabalho já integrado"]), "pt", "an unknown language falls back to detection; the doctor reports it");
});
