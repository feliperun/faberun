#!/bin/sh
# Manual chain step for campaign become-faberun: launch contract <n-name> (e.g. 2-cli-product)
# with the main checkout detached at the landing branch tip, so validation sees the promoted tree.
set -eu
cd /Users/frb/dev/frb/skills
name="$1"; ref="${2:-campaign/become-faberun}"
set -a; . "$HOME/.config/intent-factory-notify-ford/env"; set +a
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_0 GIT_CONFIG_VALUE_1 2>/dev/null || true
CLI=.runs/control/become-faberun/controller/skills/mine/intent-factory/src/cli.mjs
git checkout -q -- AGENTS.md 2>/dev/null || true
git checkout -q --detach "$ref"
if [ -n "$(git status --short)" ]; then echo "tree not clean at the landing tip:"; git status --short; exit 1; fi
echo "HEAD $(git rev-parse --short HEAD) = $ref $(git rev-parse --short "$ref")"
node "$CLI" contract validate ".runs/control/become-faberun/contracts/$name.contract.json"
node "$CLI" run --detach ".runs/control/become-faberun/contracts/$name.contract.json"
sleep 5
node "$CLI" supervise --detach ".runs/become-faberun-$name" --interval 60
