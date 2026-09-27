import "../scoped-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeCodex, fixture, writeContract } from "../helpers.mjs";
import { environmentListings, isSecretEnvName, runtimeEnvironmentReport } from "../../src/host/environment-report.mjs";

const runner = fileURLToPath(new URL("../../src/cli.mjs", import.meta.url));

/**
 * R3: `faberun doctor --env [<contract.json>]` is a listing, not a gate. It
 * names, per runtime, the controller variables that would pass and the ones
 * that would be kept out, and marks every excluded credential-shaped name
 * retained. The one thing it must never do is print a value.
 */

test("doctor lists the environment each runtime would see without values", () => {
  const directory = mkdtempSync(join(tmpdir(), "doctor-env-"));
  const contractPath = writeContract(directory, fixture());
  const secretValue = "sk-doctor-env-secret-value";
  const result = spawnSync(process.execPath, [runner, "doctor", "--env", "--json", "--cwd", directory, contractPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      FABERUN_CODEX_BIN: fakeCodex(directory),
      MY_SERVICE_TOKEN: secretValue,
      GITHUB_TOKEN: secretValue,
      ORDINARY_VARIABLE: "ordinary-value",
    },
  });
  const payload = /** @type {{environment: {runtime: string, harness: string, passed: string[], excluded: string[], retained: string[]}[]}} */ (JSON.parse(result.stdout));
  assert.ok(Array.isArray(payload.environment), "doctor --env reports a structured environment listing");
  assert.ok(payload.environment.length > 0, "at least one runtime is listed");
  for (const listing of payload.environment) {
    assert.ok(listing.passed.includes("PATH"), "an operating-system base name passes");
  }
  const secret = payload.environment.find((listing) => listing.excluded.includes("MY_SERVICE_TOKEN"));
  assert.ok(secret, "an excluded controller variable is named");
  assert.ok(!secret.passed.includes("MY_SERVICE_TOKEN"), "the excluded variable is not also reported as passing");
  assert.ok(secret.retained.includes("MY_SERVICE_TOKEN"), "a *_TOKEN exclusion is retained");
  assert.ok(secret.retained.includes("GITHUB_TOKEN"), "a GITHUB_* exclusion is retained");
  assert.ok(!result.stdout.includes(secretValue), "doctor never prints an environment value");
  assert.ok(!result.stdout.includes("ordinary-value"), "doctor never prints an environment value");
});

test("the environment listing splits allowed names from excluded ones and retains secrets", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/operator",
    DEEPSEEK_API_KEY: "controller-secret",
    MY_TOKEN: "another-secret",
    DATABASE_URL: "postgres://user:password@host/db",
    ORDINARY_VARIABLE: "ordinary",
  };
  const runtime = {
    id: "dsh-deepseek",
    harness: "dsh",
    config: { provider: "deepseek-official", "api_key.env_key": "DEEPSEEK_API_KEY" },
  };
  const report = runtimeEnvironmentReport(runtime, undefined, source);
  assert.equal(report.runtime, "dsh-deepseek");
  assert.equal(report.harness, "dsh");
  assert.ok(report.passed.includes("PATH"), "a base name passes");
  assert.ok(report.passed.includes("DEEPSEEK_API_KEY"), "an env_key the runtime declares passes");
  assert.ok(report.excluded.includes("MY_TOKEN"));
  assert.ok(report.excluded.includes("DATABASE_URL"));
  assert.deepEqual(report.retained, ["MY_TOKEN"], "only excluded credential-shaped names are retained");
  assert.ok(!JSON.stringify(report).includes("controller-secret"), "values never enter a report");
  assert.ok(!JSON.stringify(report).includes("postgres://"), "values never enter a report");

  assert.equal(isSecretEnvName("AWS_SECRET_ACCESS_KEY"), true);
  assert.equal(isSecretEnvName("GITHUB_TOKEN"), true);
  assert.equal(isSecretEnvName("SERVICE_PASSWORD"), true);
  assert.equal(isSecretEnvName("DATABASE_URL"), false);
});

test("without a contract the listing covers the discovery catalogue", () => {
  const listings = environmentListings(new Map(), undefined, { PATH: "/usr/bin" });
  assert.ok(listings.length > 0, "the catalogue runtimes are listed when no contract routes any");
  assert.ok(listings.every((listing) => listing.passed.includes("PATH")));
});
