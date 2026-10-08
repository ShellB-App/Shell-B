#!/usr/bin/env bash
# scripts/check.sh — run before restarting shellb-web or building the UI. Exit status 0 means safe to ship.
#   compile every server module, pyflakes (undefined names), the regression suite, and a TypeScript type check.
# The last result is saved to data/selfmod/last-check.txt, where Shell:B's nightly self-review reads it.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
out=$(mktemp)
status=0
step() { echo "== $1" | tee -a "$out"; shift; if "$@" >>"$out" 2>&1; then echo "   ok" | tee -a "$out"; else echo "   FAILED" | tee -a "$out"; status=1; fi; }
step "py_compile" venv/bin/python -m py_compile server/*.py
step "pyflakes (undefined names)" venv/bin/python -m unittest tests/lint_test.py
step "regression tests" venv/bin/python -m unittest discover -s tests -p '*_test.py'
step "typescript" bash -c "cd ui && npx tsc --noEmit -p tsconfig.app.json"
mkdir -p data/selfmod
{ echo "checked $(date -u +%FT%TZ) at $(git rev-parse --short HEAD 2>/dev/null) — $([ $status = 0 ] && echo PASS || echo FAIL)"; cat "$out"; } > data/selfmod/last-check.txt
[ $status = 0 ] || { echo; echo "Details:"; grep -v '^\s*$' "$out" | tail -60; }
rm -f "$out"
exit $status
