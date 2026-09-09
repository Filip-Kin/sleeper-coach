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

echo "== sleeper token =="
AUTH=$(docker exec "$COACH" bash -lc 'cd /app && timeout 30 bun run src/act/cli.ts token check 2>&1' | head -1 || true)
case "$AUTH" in
  *"token: ok"*) ok "$AUTH" ;;
  *)             bad "${AUTH:-no response}. Import a fresh token: act token import - (see README, The Sleeper token)." ;;
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
# bun, not python: the image no longer ships python3.
docker exec "$COACH" bun -e '
const f = "'"$STATE"'/news.json";
let d;
try { d = await Bun.file(f).json(); } catch (e) { console.log(`  FAIL  news.json unreadable (${e}); the engine would draft on numbers alone`); process.exit(0); }
const n = Object.keys(d.players ?? {}).length;
const up = d.updatedAt ?? "unknown";
console.log(`  OK    ${n} entries, updated ${up}`);
const age = (Date.now() - Date.parse(up)) / 3600000;
if (Number.isFinite(age) && age > 8) console.log(`  WARN  dossier is ${age.toFixed(1)}h old; re-sweep the news before launch`);
'


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

echo "== the coach's face =="
FACE_PORT=${FACE_PORT:-8773}
FH=$(curl -s --max-time 5 "http://127.0.0.1:${FACE_PORT}/health" || true)
case "$FH" in
  *'"ok":true'*) ok "face server up on :${FACE_PORT} ($FH)" ;;
  *)             note "face server not answering on :${FACE_PORT}; the draft still runs, just nothing to look at" ;;
esac
if [ -n "$FH" ]; then
  FSIZE=$(curl -s --max-time 5 -o /dev/null -w '%{size_download}' "http://127.0.0.1:${FACE_PORT}/" || echo 0)
  [ "${FSIZE:-0}" -gt 5000 ] && ok "face page serves (${FSIZE} bytes)" || note "face page looks truncated (${FSIZE} bytes)"
  for ip in 192.168.1.2 $(tailscale ip -4 2>/dev/null | head -1); do
    C=$(curl -s --max-time 4 -o /dev/null -w '%{http_code}' "http://${ip}:${FACE_PORT}/health" || echo 000)
    [ "$C" = "200" ] && ok "reachable at http://${ip}:${FACE_PORT}/" || note "not reachable at http://${ip}:${FACE_PORT}/ (got $C)"
  done
fi
VOICE=$(docker logs "$ANN" 2>&1 | grep -E 'joined voice channel|could not join voice' | tail -1)
case "$VOICE" in
  *"joined voice channel"*) ok "announcer is in the voice channel" ;;
  *"could not join"*)       note "announcer could NOT join voice: ${VOICE#*: }. The face still works (speech is published before Discord playback), and the poll loop retries every ${DRAFT_POLL_SECONDS:-10}s once the draft lock appears." ;;
  *)                        note "no voice join line in the announcer log yet" ;;
esac

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
