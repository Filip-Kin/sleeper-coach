#!/usr/bin/env bash
# Rebuild the announcer image and recreate ONLY the announcer container.
#
# WHY THIS EXISTS. The announcer and the coach are two services in one Coolify
# compose project, so a Coolify deploy recreates BOTH. That would kill the headed
# browser holding the Sleeper session and any running draft, which is
# unacceptable on a draft day. This rebuilds and swaps the announcer alone and
# never touches the coach.
#
#   ./scripts/announcer-recreate.sh [env KEY=VALUE ...]
#
# Env overrides are applied on top of whatever the current container already has,
# so secrets never have to be retyped or stored anywhere.
#
# The container keeps its Coolify name and labels on purpose: Coolify's status
# check then sees a healthy announcer under the name it expects and leaves it
# alone. A later real Coolify deploy overwrites this container, which is fine
# because the compose files carry the same port and env.

set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=rl3nyhykcsaixibjci6xbqif
FACE_PORT=${FACE_PORT:-8773}
LAN_IP=${LAN_IP:-192.168.1.2}
TS_IP=${TS_IP:-$(tailscale ip -4 2>/dev/null | head -1)}

ANN=$(docker ps -a --format '{{.Names}}' | grep '^announcer' | head -1)
[ -n "$ANN" ] || { echo "no announcer container found; nothing to base the env on" >&2; exit 1; }
echo "== basing on $ANN =="

ENVFILE=$(mktemp); LBLFILE=$(mktemp)
chmod 600 "$ENVFILE" "$LBLFILE"
trap 'shred -u "$ENVFILE" "$LBLFILE" 2>/dev/null || rm -f "$ENVFILE" "$LBLFILE"' EXIT

# Carry the whole environment across (bot token, Claude token, Discord ids), then
# let the caller override individual keys.
docker inspect "$ANN" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^$' > "$ENVFILE"
for kv in "$@"; do
  key=${kv%%=*}
  grep -v "^${key}=" "$ENVFILE" > "${ENVFILE}.tmp" && mv "${ENVFILE}.tmp" "$ENVFILE"
  echo "$kv" >> "$ENVFILE"
  echo "   override: ${key}"
done
grep -q '^FACE_PORT=' "$ENVFILE" || echo "FACE_PORT=${FACE_PORT}" >> "$ENVFILE"

docker inspect "$ANN" --format '{{json .Config.Labels}}' \
  | python3 -c 'import json,sys
for k,v in (json.load(sys.stdin) or {}).items():
    if k.startswith(("coolify.","com.docker.compose.")): print(f"{k}={v}")' > "$LBLFILE"
echo "   labels carried: $(wc -l < "$LBLFILE")"

echo "== building =="
docker build -q -f Dockerfile.announcer -t sleeper-announcer:face .

mapfile -t LARGS < <(while IFS= read -r l; do [ -n "$l" ] && { echo "--label"; echo "$l"; }; done < "$LBLFILE")
PORTS=(-p "127.0.0.1:${FACE_PORT}:${FACE_PORT}" -p "${LAN_IP}:${FACE_PORT}:${FACE_PORT}")
[ -n "${TS_IP:-}" ] && PORTS+=(-p "${TS_IP}:${FACE_PORT}:${FACE_PORT}")

echo "== swapping container =="
docker rm -f "$ANN" >/dev/null
docker run -d --name "$ANN" \
  --network "$NETWORK" \
  -v /data/sleeper-coach:/data/sleeper-coach:ro \
  "${PORTS[@]}" \
  --restart on-failure \
  --env-file "$ENVFILE" \
  "${LARGS[@]}" \
  sleeper-announcer:face >/dev/null

sleep 8
docker logs --tail 12 "$ANN" 2>&1 | sed 's/^/   /'
echo
echo "face:  http://${LAN_IP}:${FACE_PORT}/${TS_IP:+   or  http://${TS_IP}:${FACE_PORT}/}"
