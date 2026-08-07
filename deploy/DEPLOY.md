# Deploy runbook (NAS)

The coach runs as one Docker container on the NAS, fronted by host nginx +
Authelia. State lives on a bind mount at `/data/sleeper-coach`.

## One-time setup

1. **State dir**: `sudo mkdir -p /data/sleeper-coach/{config,profile,shots} && sudo chown -R filip:filip /data/sleeper-coach`
2. **Env**: copy `env.example` to `/data/sleeper-coach/env` (chmod 600). Needs
   `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `WEB_PASS` (VNC), and
   later `HA_NOTIFY_URL` / `HA_TOKEN`.
3. **DNS** (Cloudflare, DNS-only, mirroring `claude`): CNAME `coach` and
   `coach-vnc` → `n.filipkin.com`, not proxied.
4. **Certs**: `sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/cloudflare/credentials.ini -d coach.filipkin.com` (and `coach-vnc.filipkin.com`).
5. **nginx**: install `deploy/nginx/coach.conf` and `coach-vnc.conf` to
   `/etc/nginx/sites-available/{coach,coach-vnc}`, symlink into `sites-enabled`,
   `sudo nginx -t && sudo systemctl reload nginx`.
6. **Authelia**: add both domains to the `group:admins` block in
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

## Sleeper login (the one human step)

The public API is read-only, so acting means a logged-in browser. Log in once;
the session persists in the Brave/Chromium profile on the volume.

```sh
docker exec -d sleeper-coach bash -lc 'cd /app && bun run act login-open'
```

Then open `https://coach.filipkin.com` → Takeover tab (or `coach-vnc.filipkin.com`)
and sign in to Sleeper in the embedded browser. The command detects success and
persists the profile. Re-run if the session ever lapses.

## Ports

- `127.0.0.1:8770` → dashboard (nginx: coach.filipkin.com)
- `127.0.0.1:6081` → noVNC (nginx: coach-vnc.filipkin.com)
