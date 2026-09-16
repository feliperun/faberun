#!/bin/sh
# Orchestrator landing edits for register-skill-and-harden. Idempotent.
set -eu
cd "$(git rev-parse --show-toplevel)"
L=.runs/control/register-skill-and-harden/landing
cp "$L/rules.md" skills/faberun/references/rules.md
cp "$L/engineering.md" skills/faberun/references/engineering.md
# Notifier fixtures resolve node through the asdf shim (#!/usr/bin/env node); under the
# parallel suite the shim took >5 s to start and the delivery timed out (measured
# 2026-09-16, receipt "notification timed out after 5000ms"). Point them at the binary.
node - <<'JS'
const fs = require("node:fs");
const p = "test/cli/cli.test.mjs";
let t = fs.readFileSync(p, "utf8");
const before = t;
t = t.replace('writeFileSync(notifier, "#!/usr/bin/env node\\n', 'writeFileSync(notifier, `#!${process.execPath}\\n');
t = t.replace("process.exit(0));\\n\");", "process.exit(0));\\n`);");
t = t.replace("writeFileSync(notifier, `#!/usr/bin/env node\\n", "writeFileSync(notifier, `#!${process.execPath}\\n");
if (t === before) console.log("cli.test.mjs: nothing to change");
else { fs.writeFileSync(p, t); console.log("cli.test.mjs: notifier fixtures now use process.execPath"); }
JS
wc -c skills/faberun/references/rules.md skills/faberun/references/engineering.md
grep -n 'notifier, ' test/cli/cli.test.mjs | cut -c1-120
