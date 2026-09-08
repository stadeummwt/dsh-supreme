#!/usr/bin/env bash
# Memory-batched official host/client build for the pinned DSH upstream.
# Rationale: sandbox has 3.9GiB RAM; one tsc -b over 217 host refs OOMs (exit 134).
# Runs the SAME tsconfig graph in per-project batches so each invocation gets a
# fresh heap. Incremental tsbuildinfo makes re-runs cheap. No upstream file modified.
# Usage: DSH_REPO=<upstream checkout> dsh-build-batched.sh <host|client> <tsconfig.json>
set -u
REPO="${DSH_REPO:?set DSH_REPO to the upstream checkout}"
cd "$REPO" || exit 1
TSC=./node_modules/typescript/bin/tsc
LOG=/tmp/dsh-batched-build.log
: > "$LOG"

refs() {
  node -e '
    const fs = require("fs");
    const s = fs.readFileSync(process.argv[1], "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const j = JSON.parse(s);
    for (const r of (j.references || [])) console.log(r.path);
  ' "$1"
}

MODE="$1"
ROOT="$2"

fail=0
total=0
while IFS= read -r ref; do
  total=$((total+1))
  if ! node --max-old-space-size=2048 "$TSC" -b "$ref" --pretty false >> "$LOG" 2>&1; then
    echo "RETRY once: $ref" >> "$LOG"
    if ! node --max-old-space-size=2048 "$TSC" -b "$ref" --pretty false >> "$LOG" 2>&1; then
      echo "FAIL: $ref" >> "$LOG"
      fail=$((fail+1))
    fi
  fi
done < <(refs "$ROOT")

echo "== $MODE batched build: $((total-fail))/$total refs OK, $fail failed =="
exit $((fail > 0 ? 1 : 0))
