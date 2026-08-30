#!/usr/bin/env bash
# Pre-draft preflight. Read-only: checks everything that has bitten us before,
# then prints the exact launch command. Run on the NAS host, not in the container.
#
#   ./scripts/preflight.sh
#
# Container names change on every Coolify rebuild, so they are always looked up.

set -uo pipefail

LEAGUE=1389357604773322752
DRAFT=1389357604773322753
STATE=/data/sleeper-coach

pass=0; warn=0; fail=0
ok()   { echo "  OK    $*"; pass=$((pass+1)); }
note() { echo "  WARN  $*"; warn=$((warn+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }

echo "== containers =="
COACH=$(docker ps --format '{{.Names}}' | grep '^sleeper-coach' || true)
ANN=$(docker ps --format '{{.Names}}' | grep '^announcer' || true)
[ -n "$COACH" ] && ok "coach: $COACH" || bad "no sleeper-coach container running"
[ -n "$ANN" ] && ok "announcer: $ANN" || note "no announcer container (draft still works, just silent)"
[ -n "$COACH" ] || { echo; echo "cannot continue without the coach container"; exit 1; }

echo "== sleeper session =="
AUTH=$(docker exec "$COACH" curl -s --max-time 10 http://127.0.0.1:9223/auth 2>/dev/null || true)
case "$AUTH" in
  *'"ok"'*) ok "browser logged in ($AUTH)" ;;
  *)        bad "browser auth not ok: ${AUTH:-no response}. Re-import a localStorage blob (act import-session)." ;;
esac

echo "== claude token =="
TOK=$(docker exec "$COACH" bash -lc 'HOME='"$STATE"'/config timeout 90 '"$STATE"'/config/.local/bin/claude --model claude-opus-4-8 --print "reply with exactly: OK" 2>&1 | tail -1' || true)
case "$TOK" in
  *OK*) ok "opus reachable (weekly limit not hit)" ;;
  *)    bad "claude call failed: ${TOK:-no output}. Without it the engine drafts off the raw board with no reasoning." ;;
esac

echo "== draft =="
D=$(curl -s --max-time 15 "https://api.sleeper.app/v1/draft/$DRAFT" || true)
python3 - "$D" <<'PY'
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    print("  FAIL  could not read the draft from the Sleeper API"); raise SystemExit
s = d.get("settings", {})
print(f"  OK    status={d.get('status')} rounds={s.get('rounds')} teams={s.get('teams')} timer={s.get('pick_timer')}s cpu_autopick={s.get('cpu_autopick')}")
order = d.get("draft_order")
if order:
    slot = order.get("1267685386142887936")
    print(f"  OK    draft_order IS set; our slot = {slot}")
else:
    print("  WARN  draft_order is null (randomised ~15 min before kickoff). The engine waits up to 30 min for it.")
PY

echo "== news dossier =="
docker exec -i "$COACH" python3 - <<PY
import json, datetime
try:
    d = json.load(open("$STATE/news.json"))
except Exception as e:
    print(f"  FAIL  news.json unreadable ({e}); the engine would draft on numbers alone"); raise SystemExit
n = len(d.get("players", {}))
up = d.get("updatedAt", "unknown")
print(f"  OK    {n} entries, updated {up}")
try:
    age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(up.replace("Z", "+00:00"))).total_seconds() / 3600
    if age > 8:
        print(f"  WARN  dossier is {age:.1f}h old; re-sweep the news before launch")
except Exception:
    pass
PY

echo "== state files =="
if docker exec "$COACH" test -f "$STATE/draft-active"; then
  bad "draft-active lock is PRESENT. A stale lock makes the daemon stand down; rm it before launch."
else
  ok "no stale draft-active lock"
fi
BLOG=$(docker exec "$COACH" bash -lc "wc -l < $STATE/blog.jsonl" 2>/dev/null | tr -d ' ')
[ "${BLOG:-0}" = "0" ] && ok "blog.jsonl empty (recap will be the first post)" || note "blog.jsonl has $BLOG entries; mock samples should be wiped"
RUNNING=$(docker exec "$COACH" bash -lc "ps -eo args | grep 'draft/run.ts' | grep -v grep | wc -l" 2>/dev/null | tr -d ' ')
[ "${RUNNING:-0}" = "0" ] && ok "no draft-run already going" || bad "$RUNNING draft-run process(es) already running; kill before launching"

echo "== board sanity =="
docker exec "$COACH" bash -lc "cd /app && timeout 300 bun run coach board 5 2>&1 | tail -8" || note "board build failed or timed out"

echo
echo "== $pass ok, $warn warn, $fail fail =="
echo
if [ "$fail" -gt 0 ]; then
  echo "Fix the failures above before launching."
else
  echo "Launch (no --rehearse; the real draft is started by the commissioner):"
  echo
  echo "  docker exec -d \$(docker ps --format '{{.Names}}' | grep '^sleeper-coach') \\"
  echo "    bash -lc 'cd /app && bun run draft-run $DRAFT > $STATE/draft-live.log 2>&1'"
  echo
  echo "Then watch:  tail -f $STATE/draft-live.log"
  echo "Revert to fully deterministic picking mid-draft if needed:"
  echo "  kill it, then relaunch with -e VONA_PLAN_MAX_RANK=1"
fi
exit 0
