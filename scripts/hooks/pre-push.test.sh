#!/usr/bin/env bash
# Exercises scripts/hooks/pre-push through real `git push` calls into a bare
# repo in a temp dir, with COACH_HOOK_CHECKS standing in for the gate. Prints
# one line per case and "hook: N passed, M failed" at the end; exits non-zero
# on any failure. Wired into scripts/run-tests.sh.
set -u
HOOK=$(cd "$(dirname "$0")" && pwd)/pre-push
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()   { echo "  ok    $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1: $2"; fail=$((fail+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q --bare "$T/remote.git"
git init -q -b main "$T/repo"
cd "$T/repo"
git remote add origin "$T/remote.git"
mkdir -p hooks && cp "$HOOK" hooks/pre-push && chmod +x hooks/pre-push
git config core.hooksPath hooks
echo a > a && git add a && git commit -qm one
COACH_HOOK_CHECKS="true" git push -q origin main 2>/dev/null   # seed the remote
remote_main() { git --git-dir="$T/remote.git" rev-parse main 2>/dev/null; }

# 1. failing gate blocks main
echo b > a && git commit -qam two
before=$(remote_main)
if COACH_HOOK_CHECKS="false" git push -q origin main 2>/dev/null; then bad "failing gate blocks main" "push succeeded"; else
  [ "$(remote_main)" = "$before" ] && ok "failing gate blocks main" || bad "failing gate blocks main" "remote moved"; fi

# 2. passing gate allows main
if COACH_HOOK_CHECKS="true" git push -q origin main 2>/dev/null && [ "$(remote_main)" = "$(git rev-parse HEAD)" ]; then ok "passing gate allows main"; else bad "passing gate allows main" "push refused"; fi

# 3. feature branch never runs the gate
git checkout -qb feature && echo c > a && git commit -qam three
if COACH_HOOK_CHECKS="false" git push -q origin feature 2>/dev/null; then ok "feature branch skips the gate"; else bad "feature branch skips the gate" "push refused"; fi
git checkout -q main

# 4. empty override refused
echo d > a && git commit -qam four
if COACH_PUSH_OVERRIDE="  " COACH_HOOK_CHECKS="false" git push -q origin main 2>/dev/null; then bad "empty override refused" "push succeeded"; else ok "empty override refused"; fi

# 5. override with a reason pushes and is recorded
if COACH_PUSH_OVERRIDE='hotfix "quoted"' COACH_HOOK_CHECKS="false" git push -q origin main 2>/dev/null \
   && grep -q "\"sha\":\"$(git rev-parse HEAD)\"" .git/pushes.jsonl && grep -q 'hotfix \\"quoted\\"' .git/pushes.jsonl; then
  ok "override with reason pushes and is recorded"; else bad "override with reason pushes and is recorded" "$(cat .git/pushes.jsonl 2>/dev/null)"; fi

# 6. a worktree may not push main even with a passing gate
git worktree add -q "$T/wt" -b wt-branch >/dev/null 2>&1
( cd "$T/wt" && git config core.hooksPath "$T/repo/hooks" && echo e > a && git commit -qam five
  if COACH_HOOK_CHECKS="true" git push -q origin HEAD:main 2>/dev/null; then exit 1; else exit 0; fi )
[ $? = 0 ] && ok "worktree cannot push main" || bad "worktree cannot push main" "push succeeded"

# 7. multi-step gate stops at the first failure and reports it
echo f > a && git commit -qam six
out=$(COACH_HOOK_CHECKS=$'true\nfalse\necho never' git push origin main 2>&1)
if printf '%s' "$out" | grep -q "BLOCKED, 'false' failed" && ! printf '%s' "$out" | grep -q never; then ok "gate stops at the first failing check"; else bad "gate stops at the first failing check" "$out"; fi

echo "hook: $pass passed, $fail failed"
[ "$fail" = 0 ]
