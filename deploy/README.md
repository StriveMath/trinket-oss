# Deploying this fork to DigitalOcean

End-to-end deploy of trinket-oss (with the Piston-backed Python 3 / Java / R sandbox) to a DigitalOcean droplet, fronted by Caddy with automatic Let's Encrypt TLS. Everything in this folder ships with the fork — no separate deploy repo to maintain.

## What gets stood up

```
                  Internet (443)
                       │
                  ┌────▼─────┐
                  │  Caddy   │  ← TLS via Let's Encrypt
                  └────┬─────┘
        ┌──────────────┼─────────────────┐
        │              │                 │
   /python3/socket.io* │  everything else
        ▼              ▼
   ┌─────────┐    ┌─────────┐
   │ sandbox │    │   app   │   (trinket Hapi, port 3000)
   │ (8080)  │    └────┬────┘
   └────┬────┘         │
        │              ▼
        ▼         ┌──────────┐  ┌───────┐
   ┌─────────┐    │ mongodb  │  │ redis │
   │ piston  │    └──────────┘  └───────┘
   │ (2000)  │
   └─────────┘
```

All on one droplet. No public ports except 22/80/443.

## Prereqs

- DigitalOcean account + API token (one-time)
- `doctl` installed and authed:
  ```bash
  brew install doctl
  doctl auth init
  ```
- Your SSH public key uploaded to DO:
  ```bash
  doctl compute ssh-key import my-laptop --public-key-file ~/.ssh/id_ed25519.pub
  doctl compute ssh-key list
  ```
  Note the `ID` or `FingerPrint`.
- A domain you control. (Example throughout: `freetrinket.io`.)

## First deploy

From this directory:

```bash
cd deploy

export DOMAIN=freetrinket.io
export ACME_EMAIL=you@strivemath.com
export SSH_KEY=<id-or-fingerprint>

# Optional overrides:
# export REPO_URL=https://github.com/StriveMath/trinket-oss.git
# export REPO_BRANCH=main
# export SIZE=s-2vcpu-4gb   # default; smaller is risky because Piston pulls Python/Java/R packages

./provision.sh
```

`provision.sh` will:

1. Generate a 48-char session secret locally.
2. Render `cloud-init.yaml` with your domain, email, secret, and fork URL.
3. Create the droplet via `doctl compute droplet create`.
4. Print the public IP.

Then, on the printed IP:

1. **Add a DNS A record** pointing your domain at the IP. (Caddy can't issue a cert without this.)
2. **Watch cloud-init**:
   ```bash
   ssh root@<ip> 'tail -f /var/log/trinket-setup.log'
   ```
   Expect ~5–10 minutes for first boot (Docker install + image build + Piston package install).
3. Open `https://freetrinket.io`.

## Updating later

### When you push new commits to your fork

```bash
ssh root@<ip>
cd /opt/trinket/repo
git pull
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.prod.yml build
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.prod.yml up -d
```

### When trinket-oss upstream releases a new version

```bash
# on your laptop
cd ~/Projects/trinket-oss
git remote add upstream https://github.com/trinketapp/trinket-oss.git    # one-time
git fetch upstream
git merge upstream/main
# resolve any conflicts (usually only the Dockerfile if upstream changed npm install)
git push origin main

# then run the "When you push new commits" workflow above
```

### When you just want to tweak config (no code change)

```bash
ssh root@<ip>
vim /opt/trinket/repo/config/local.yaml
docker compose restart app
```

(Config is bind-mounted, so no rebuild needed.)

## File layout on the droplet

| Path | Purpose | In git? |
| --- | --- | --- |
| `/opt/trinket/repo/` | your fork checkout | tracked |
| `/opt/trinket/repo/config/local.yaml` | per-environment config + secrets | **not** committed |
| `/opt/trinket/repo/.env` | DOMAIN + ACME_EMAIL for Caddy | not committed |
| `/opt/trinket/.env` | source-of-truth copy of above | not committed |
| `/opt/trinket/local.yaml.tpl` | template cloud-init wrote on first boot | not committed |

## Useful droplet commands

```bash
cd /opt/trinket/repo

# Full prod compose alias (use this instead of bare `docker compose`):
alias dcp='docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.prod.yml'

dcp ps                      # status
dcp logs -f app             # trinket logs
dcp logs -f caddy           # TLS / reverse proxy
dcp logs -f sandbox         # Python/Java/R run logs
dcp logs -f piston          # raw sandbox

dcp restart app             # apply config edits
systemctl restart trinket   # full stack restart
```

## Tear down

```bash
doctl compute droplet delete trinket
```

(Deletes the droplet; your fork on GitHub is untouched.)

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Browser shows TLS warning | DNS not propagated yet | wait 1–2 min, `dig +short ${DOMAIN}` |
| `502 Bad Gateway` | app/sandbox container not ready | `dcp ps`, `dcp logs app` |
| Python 3 "Run" hangs forever | Caddy not routing `/python3/socket.io/*` | `dcp logs caddy`, check `deploy/Caddyfile` is mounted |
| "Interactive console not supported" | by design — Piston is one-shot | hit Run instead, REPL not implemented |
| First Run is slow | Piston cold-starts the language container | normal, second run is fast |
| Build fails on first deploy with OOM | droplet too small | `SIZE=s-2vcpu-4gb ./provision.sh` (default) or larger |

## Why this single-repo layout?

The deploy artifacts live next to the app code so:
- A single `git pull` updates both the app and the deploy config.
- The `Caddyfile` and the `docker-compose.prod.yml` it references can't drift out of sync.
- Anyone forking from you gets a one-command deploy with no second checkout.
