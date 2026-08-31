#!/usr/bin/env bash
# Run EVERY test file, and fail if one exists that we are not running.
#
# Bare `bun test` in this repo discovers only src/analysis/rails.test.ts and
# reports "10 passed, 0 failed" as though that were the whole suite. A green
# result covering a tenth of the tests is worse than a red one, so the runner is
# explicit and the discovery check below makes a forgotten file a failure rather
# than a silent omission.
set -uo pipefail
cd "$(dirname "$0")/.."

FOUND=$(find src -name '*.test.ts' | sort)
fail=0
# Two test styles coexist here and they need different runners. Most files are
# plain scripts that print their own tally and call process.exit (which is also
# why bare `bun test` stops after the first file). Files importing bun:test use
# beforeAll/expect and CANNOT run under `bun run` at all: they abort with
# "Cannot use beforeAll() outside of the test runner". Merging a branch of each
# kind broke this runner, so detect the style instead of assuming one.
for t in $FOUND; do
  if grep -q 'from "bun:test"' "$t"; then
    out=$(bun test "$t" 2>&1)
    line=$(printf '%s' "$out" | grep -E '^[[:space:]]*[0-9]+ (pass|fail)' | tr '\n' ' ')
    case "$out" in
      *" 0 fail"*) printf '  ok    %-38s %s\n' "$t" "$line" ;;
      *) printf '  FAIL  %-38s %s\n' "$t" "$line"; printf '%s\n' "$out" | tail -20; fail=1 ;;
    esac
  else
    out=$(bun run "$t" 2>&1)
    line=$(printf '%s' "$out" | tail -1)
    case "$line" in
      *"0 failed"*|*"ALL PASS"*) printf '  ok    %-38s %s\n' "$t" "$line" ;;
      *) printf '  FAIL  %-38s %s\n' "$t" "$line"; printf '%s\n' "$out" | tail -20; fail=1 ;;
    esac
  fi
done
# The engine selftest is not named *.test.ts but is a real suite.
out=$(bun run src/draft/selftest.ts 2>&1); line=$(printf '%s' "$out" | tail -1)
case "$line" in *"ALL PASS"*) printf '  ok    %-38s %s\n' "src/draft/selftest.ts" "$line" ;;
  *) printf '  FAIL  src/draft/selftest.ts\n'; printf '%s\n' "$out" | tail -20; fail=1 ;; esac

echo
[ "$fail" = 0 ] && echo "all suites pass ($(printf '%s\n' "$FOUND" | wc -l | tr -d ' ') test files + selftest)" || echo "SUITE FAILED"
exit $fail
