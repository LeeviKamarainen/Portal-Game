# Deploying to a Hetzner VPS (game + Caddy, https without a domain)

What runs: two containers from `deploy/docker-compose.yml` - the game server (the repo's
`Dockerfile`) and Caddy, which gets the https certificate and proxies the page, `/api` and
`/ws`. Players use `https://<SITE_HOST>`; only ports 80 and 443 are open.

No domain needed: `203.0.113.7` becomes `203-0-113-7.sslip.io` (a public DNS service that
answers with the IP in the name), and Caddy gets a real Let's Encrypt certificate for it.

Checked locally 2026-10-11 with `SITE_HOST=localhost`: image builds, the container is healthy,
http redirects to https, bundles are gzipped (511 -> 182 kB), `wss://` works through Caddy,
a foreign origin gets 403, the cookie is `Secure`, the login rate limit sees client addresses.
Not checked: the certificate issuance itself (needs a public server).

## 0. On your PC, once

1. Commit and push what should be deployed (`git status` - the build uses what is in git).
2. Make an SSH key if you have none: `ssh-keygen -t ed25519` (PowerShell); the public key is
   `~/.ssh/id_ed25519.pub`.

## 1. Hetzner Cloud console

1. New project -> **Add server**: location nearest your players, image **Ubuntu 24.04**,
   type **CX22** (2 vCPU, 4 GB; shared x86), your SSH key, IPv4 on. Optional: tick *Backups*.
2. **Firewalls** -> create one with inbound rules: TCP 22, TCP 80, TCP 443 (and ICMP if you
   like); apply it to the server. Nothing else needs to be reachable (no UDP, not 8080).
3. Note the server's IPv4 address, e.g. `203.0.113.7`. Your hostname is that with dashes:
   `203-0-113-7.sslip.io`.

## 2. On the server

```bash
ssh root@203.0.113.7

apt-get update && apt-get -y upgrade
curl -fsSL https://get.docker.com | sh          # Docker + the compose plugin
git clone https://github.com/LeeviKamarainen/Portal-Game.git
cd Portal-Game/deploy
cp .env.example .env
nano .env                                       # set SITE_HOST (and ANTHROPIC_API_KEY if wanted)
docker compose up -d --build                    # first build takes a few minutes
docker compose ps                               # game should say (healthy)
docker compose logs -f caddy                    # wait for "certificate obtained successfully"
```

If the repo is private, `git clone` needs credentials: a GitHub deploy key
(Settings -> Deploy keys, read-only) or a fine-grained personal access token.

## 3. First run

1. Open `https://203-0-113-7.sslip.io` - the menu loads, `/healthz` answers.
2. Register an account in the game, then on the server:
   ```bash
   docker compose exec game node dist-server/admin.js grant <name> generate-maps   # AI generator
   docker compose exec game node dist-server/admin.js role <name> admin            # admin page
   ```
3. **Play from two networks** (your PC and a phone on mobile data): create a room, share the
   invite link, play a match. `?net=1` shows delay, corrections and bandwidth. This is the
   open item of milestone 6.
4. Set a monthly spend limit in the Anthropic Console before putting an API key in `.env`.

## Updating

```bash
cd ~/Portal-Game && git pull && cd deploy && docker compose up -d --build
```

Rooms and running generation jobs live in memory, so an update ends them: do it when
nobody is playing. Accounts and maps are on the `game-data` volume and survive.

## Operating

| What | Command (in `deploy/`) |
|---|---|
| Logs | `docker compose logs -f game` / `caddy` |
| Memory / CPU | `docker stats` |
| Restart | `docker compose restart game` |
| Player admin | `docker compose exec game node dist-server/admin.js list` |

Backing up the database (SQLite in WAL mode: copying only `game.db` can lose recent writes, so
make a consistent copy first, then pull it to your PC). Hetzner's *Backups* option and
snapshots also cover it.

```bash
docker compose exec game rm -f /data/backup.db
docker compose exec game node -e "new (require('node:sqlite').DatabaseSync)('/data/game.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp game:/data/backup.db ./backup-$(date +%F).db
```

## Later: a real domain

Point an A record at the server, change `SITE_HOST` in `.env`, `docker compose up -d`.
Caddy fetches the new certificate; `ALLOWED_ORIGINS` follows from `SITE_HOST`. Accounts and
maps stay (the database does not know the hostname), but players log in again (the cookie
belongs to the old address).

## If something is wrong

- **No certificate / browser warning**: `docker compose logs caddy`. Usually port 80 or 443
  is closed in the Hetzner firewall, or `SITE_HOST` does not match the IP.
- **Menu loads but Online fails**: the page's address is not `https://<SITE_HOST>` (a
  different hostname or `http://`), so the origin check refuses the WebSocket.
- **Container restarts**: `docker compose logs game`; a map-generation worker out of memory
  falls back by itself, but check `docker stats` on a 2 GB server.
