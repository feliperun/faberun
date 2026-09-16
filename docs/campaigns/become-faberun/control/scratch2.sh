#!/bin/sh
# Validates contracts against the landing-branch tip plus placeholders for the files later phases create.
set -e
cd /Users/frb/dev/frb/skills
S=/tmp/faberun-scratch; rm -rf $S; git worktree prune; git worktree add --detach -q $S "${REF:-campaign/become-faberun}"
( cd $S
  for f in src/cli/brand.mjs src/cli/update.mjs src/cli/skills.mjs src/cli/setup.mjs src/cli/init.mjs src/host/home.mjs src/host/package.mjs src/host/config.mjs src/campaign/unpark.mjs; do [ -f $f ] || printf '// placeholder\n' > $f; done
  [ -f install.sh ] || printf '#!/bin/sh\n' > install.sh
  mkdir -p docs/adr
  for f in docs/COMMANDS.md docs/VISION.md docs/CONCEPTS.md docs/GETTING-STARTED.md docs/ARCHITECTURE.md docs/README.md docs/adr/README.md; do [ -f $f ] || printf '# placeholder\n' > $f; done
  ln -s /Users/frb/dev/frb/skills/node_modules node_modules )
mkdir -p /tmp/faberun-scratch-contracts
for c in "$@"; do
  n=$(basename $c .contract.json)
  sed "s#\"cwd\": \"/Users/frb/dev/frb/skills\"#\"cwd\": \"$S\"#" $c > /tmp/faberun-scratch-contracts/$n.contract.json
  printf '=== %s === ' "$n"; node .runs/control/become-faberun/controller/skills/mine/intent-factory/src/cli.mjs contract validate /tmp/faberun-scratch-contracts/$n.contract.json 2>&1 | head -3
done
git worktree remove --force $S; git worktree prune; rm -rf /tmp/faberun-scratch-contracts
