#!/bin/sh
# Claude Code statusLine renderer for faberun ambient liveness. Reads
# the session JSON on stdin, resolves that repo's runs pointer (rewritten
# every controller tick), and prints one line:
#   <run-id> · <state> · <node> <elapsed> · $<usd> · needs you: <n>
# elapsedSec, costUsd and needsYou are precomputed by the controller, so this
# never touches a clock or a node process, only formats. No pointer, an
# unreadable file, or one over the 1 KiB cap prints an empty line, exit 0.
# jq is used when present; otherwise sed/grep pull the flat top-level fields.
#
# This file is a hand-maintained seam: the repository's source-shape guard
# walks .mjs files only, so no test fails when this script and the resolver
# drift -- test/integrations/statusline.test.mjs is the only pin here.
#
# Allowance guard. The same session JSON carries rate_limits.five_hour
# (used_percentage plus a reset instant); the script otherwise reads stdin only
# for cwd. At ALLOWANCE_WARN_PCT or above, the line appends the warning and the
# command to switch the seat, so the operator moves harness before the credit
# is gone rather than after. jq reads the nested field directly, and the
# grep/sed fallback reaches it as well by flattening the JSON to one line
# first, so the warning is not silently jq-only. Operator harnesses other than
# claude carry no ambient rate signal at all: their exhaustion arrives as an
# invocation failure the engine classifies as quota_exhausted, and this script
# adds no second classifier for them.

set -u

# Percent of the five-hour allowance at which the line warns. A named number,
# not a policy: the threshold is also printed in the line the operator reads.
ALLOWANCE_WARN_PCT=85

session=$(cat)
repo=$(printf '%s' "$session" | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p;s/.*"current_dir":"\([^"]*\)".*/\1/p' | head -n 1)
# A Windows session names its cwd with backslashes, and JSON doubles them.
# Three forms of one path, because three readers want different ones:
#   repo_json  as it appears in the file -- what a fixed-string grep matches
#   repo       the path itself           -- what jq compares a parsed key to
#   repo_path  with forward slashes      -- what a POSIX shell can stat
# On a host with no backslashes in its paths all three are the same string.
repo_json=$repo
repo=$(printf '%s' "$repo_json" | sed 's|\\\\|\\|g')
repo_path=$(printf '%s' "$repo" | tr '\\' '/')
# The pointer follows the state (R2): the project registry under the faberun
# home maps the repository's resolved path to an opaque id, and the pointer
# sits in that project's runs directory. A repository whose runs never moved
# still answers in-tree -- R7 keeps the reading side dual-layout until
# `faberun migrate` runs -- so the legacy path stays the fallback, and the
# home side wins when both exist, exactly like the resolver. Two fixed paths:
# no glob, no newest-by-mtime. That is the half of R6 already true and to
# keep; the one machine-wide pointer is a later phase, not this lookup.
home=${FABERUN_HOME:-$HOME/.faberun}
home=$(printf '%s' "$home" | tr '\\' '/')
index="$home/projects/index.json"
id=
if [ -n "$repo" ] && [ -f "$index" ]; then
  if command -v jq >/dev/null 2>&1; then
    id=$(jq -r --arg p "$repo" '.[$p] // empty' "$index" 2>/dev/null) || id=
  else
    # The index is pretty-printed, one `"path": "id"` pair per line, so a
    # fixed-string grep for the quoted key picks exactly that one line and
    # the id follows its colon. Fixed-string on purpose: a repo path is
    # data, not a regex.
    id=$(grep -F "\"$repo_json\"" "$index" 2>/dev/null | sed -n 's/^.*:[[:space:]]*"\([^"]*\)".*/\1/p')
  fi
fi
pointer="$repo_path/.runs/status.json"
if [ -n "$id" ] && [ -d "$home/projects/$id/runs" ]; then
  pointer="$home/projects/$id/runs/status.json"
fi

# The nested five_hour.used_percentage. jq when present; otherwise flatten the
# session JSON and pull the field out of the five_hour object with sed. The
# fallback matches a compact nested object, which is what the harness emits.
used_pct=
if command -v jq >/dev/null 2>&1; then
  used_pct=$(printf '%s' "$session" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null) || used_pct=
else
  flat=$(printf '%s' "$session" | tr -d '\n')
  used_pct=$(printf '%s' "$flat" | sed -n 's/.*"five_hour"[[:space:]]*:[[:space:]]*{[^}]*"used_percentage"[[:space:]]*:[[:space:]]*\([0-9][0-9.]*\).*/\1/p')
fi
# Integer compare: a fraction never decides crossing a whole threshold.
whole_pct=${used_pct%%.*}
warning=
if [ -n "$used_pct" ] && [ -n "$whole_pct" ] && [ "$whole_pct" -ge "$ALLOWANCE_WARN_PCT" ] 2>/dev/null; then
  warning="[warn] claude 5h ${used_pct}% >=${ALLOWANCE_WARN_PCT}% · faberun seat switch --harness <id>"
fi

line=
if [ -n "$repo" ] && [ -f "$pointer" ] && [ "$(wc -c <"$pointer" | tr -d ' ')" -le 1024 ]; then
  if command -v jq >/dev/null 2>&1; then
    out=$(jq -r '[.runId,.state,(.activeNode//"-"),(.elapsedSec//"-"),(.costUsd//"-"),(.needsYou//0)]|@tsv' "$pointer" 2>/dev/null) || out=
    set -f; IFS='	'; set -- $out; IFS=' '; set +f
    runId=${1:-}; state=${2:-}; node=${3:-}; elapsedSec=${4:-}; costUsd=${5:-}; needsYou=${6:-}
  else
    field() { grep -o "\"$1\":\"[^\"]*\"\|\"$1\":[0-9.null-]*" "$pointer" | head -n 1 | sed "s/.*://;s/\"//g"; }
    runId=$(field runId); state=$(field state); node=$(field activeNode)
    elapsedSec=$(field elapsedSec); costUsd=$(field costUsd); needsYou=$(field needsYou)
  fi
  if [ -n "$runId" ] && [ -n "$state" ]; then
    [ -n "$node" ] && [ "$node" != "null" ] || node=-
    [ -n "$needsYou" ] && [ "$needsYou" != "null" ] || needsYou=0
    elapsed=-
    if [ -n "${elapsedSec:-}" ] && [ "$elapsedSec" != "null" ] && [ "$elapsedSec" != "-" ]; then
      h=$((elapsedSec / 3600)); m=$(((elapsedSec % 3600) / 60)); s=$((elapsedSec % 60))
      if [ "$h" -gt 0 ]; then elapsed="${h}h$(printf '%02d' "$m")m"
      elif [ "$m" -gt 0 ]; then elapsed="${m}m$(printf '%02d' "$s")s"
      else elapsed="${s}s"
      fi
    fi
    usd=-
    [ -n "${costUsd:-}" ] && [ "$costUsd" != "null" ] && [ "$costUsd" != "-" ] && usd="\$$costUsd"
    line="$runId · $state · $node $elapsed · $usd · needs you: $needsYou"
  fi
fi

if [ -n "$warning" ]; then
  if [ -n "$line" ]; then line="$line · $warning"; else line="$warning"; fi
fi
printf '%s\n' "$line"
