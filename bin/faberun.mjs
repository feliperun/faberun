#!/usr/bin/env node
/**
 * The faberun executable.
 *
 * It calls `runCli()` and nothing else. A bin wrapper that parses, validates or
 * decides is a second CLI with no tests. The call has to be explicit because
 * `src/cli.mjs` guards its own dispatch on `process.argv[1]` being itself --
 * which, invoked through here, it is not.
 *
 * Usage, from a repository with a `.runs/` directory:
 *   faberun preflight <contract.json>
 *   faberun run <contract.json> [--detach]
 *   faberun resume <run-dir> [--node <id>] [--detach]
 *   faberun status|report|findings <run-dir> [--json]
 *   faberun doctor [--cwd <dir>] [--discover] [--json]
 *   faberun models [--probe] [--json]
 *   faberun campaign <subcommand> ...
 *   faberun metrics <campaign-id> [--json]
 *
 * `src/web/server.mjs` is the browser surface and is launched directly, not
 * through here.
 */
import { runCli } from "../src/cli.mjs";

await runCli();
