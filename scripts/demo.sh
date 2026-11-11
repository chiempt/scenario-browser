#!/usr/bin/env bash
# Terminal demo for the README hero.
#   Record:  asciinema rec -c "bash scripts/demo.sh" demo.cast
#   Plain:   bash scripts/demo.sh            (DEMO_FAST=1 skips the typing delay)
set -euo pipefail
cd "$(dirname "$0")/.."
CLI="node src/cli.ts"
DIR="$(mktemp -d)/my-tests"
delay() { [ "${DEMO_FAST:-}" = 1 ] || sleep "$1"; }
type_cmd() {
  printf '\n$ '
  for ((i = 0; i < ${#1}; i++)); do printf '%s' "${1:$i:1}"; delay 0.03; done
  printf '\n'; delay 0.4
}
run() { type_cmd "$1"; eval "${1/scenario-browser/$CLI}"; delay 1; }

run "scenario-browser project init $DIR"
run "cat $DIR/scenarios/smoke.md"
run "scenario-browser project list --dir $DIR"
run "scenario-browser project run --dir $DIR --tag smoke"
echo; echo "HTML report: $DIR/reports/report.html"
