#!/bin/sh
# Landing steps for campaign become-faberun (run by the orchestrator once run 4 is promoted).
set -eu
cd /Users/frb/dev/frb/skills
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_0 GIT_CONFIG_VALUE_1 2>/dev/null || true
git checkout -q -- AGENTS.md 2>/dev/null || true
git checkout -q main
echo "main $(git rev-parse --short HEAD) -> ff to campaign/become-faberun $(git rev-parse --short campaign/become-faberun)"
git merge --ff-only campaign/become-faberun
git log --oneline -1
echo "--- tree at main:"; ls | tr '\n' ' '; echo
