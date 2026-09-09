# Deploy runbook (NAS)

The coach runs as one Docker container on the NAS, fronted by host nginx +
Authelia. State lives on a bind mount at `/data/sleeper-coach`.

## One-time setup

1. **State dir**: `sudo mkdir -p /data/sleeper-coach/config && sudo chown -R filip:filip /data/sleeper-coach`
2. **Env**: copy `env.example` to `/data/sleeper-coach/env` (chmod 600). Needs
   `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) and later
   `HA_NOTIFY_URL` / `HA_TOKEN`. `WEB_PASS` only ever fed the VNC view and is
   unused now.
3. **Sleeper token**: import it once, see README, "The Sleeper token".
4. **DNS** (Cloudflare, DNS-only, mirroring `claude`): CNAME `coach` →
   `n.filipkin.com`, not proxied.
5. **Proxy**: Zoraxy route `coach.filipkin.com` → `127.0.0.1:8770`, Authelia
   forward-auth on. (`deploy/nginx/coach.conf` is the retired nginx vhost.)
6. **Authelia**: add the domain to the `group:admins` block in
   `/home/filip/authelia/configuration.yml`, then
   `docker exec authelia authelia validate-config && docker restart authelia`.

## Run

```sh
cd /media/nas/filip/ncdata/filip/files/Projects/sleeper-coach
docker compose build && docker compose up -d --force-recreate   # ALWAYS build via compose
docker logs -f sleeper-coach
```

Note: the compose service builds its own image (`sleeper-coach-sleeper-coach`).
A separate `docker build -t sleeper-coach` is ignored by compose — always use
`docker compose build`.

## Sleeper token (the one human step)

Every write is a GraphQL request with the account's session token. Import it
once with `act token import -` (README, "The Sleeper token"); the daemon alerts
a day at a time when it is missing, rejected, or inside 14 days of expiry.

## Ports

- `127.0.0.1:8770` → dashboard (Zoraxy: coach.filipkin.com)
