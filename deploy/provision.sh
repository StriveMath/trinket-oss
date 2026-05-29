#!/usr/bin/env bash
# Provision a DigitalOcean droplet running trinket-oss (your fork) with
# Caddy + Let's Encrypt + the Piston-backed sandbox.
#
# Prereqs:
#   brew install doctl
#   doctl auth init
#   doctl compute ssh-key list   # note the ID / fingerprint
#
# Required env vars:
#   DOMAIN        e.g. freetrinket.io
#   ACME_EMAIL    e.g. you@strivemath.com
#   SSH_KEY       SSH key id or fingerprint (from `doctl compute ssh-key list`)
#
# Optional env vars:
#   REPO_URL      default: https://github.com/StriveMath/trinket-oss.git
#   REPO_BRANCH   default: main
#   DROPLET_NAME  default: trinket
#   REGION        default: nyc3
#   SIZE          default: s-2vcpu-4gb   (sandbox + piston + mongo wants more RAM than the 2GB)
#   IMAGE         default: ubuntu-24-04-x64
set -euo pipefail

: "${DOMAIN:?Set DOMAIN, e.g. export DOMAIN=freetrinket.io}"
: "${ACME_EMAIL:?Set ACME_EMAIL, e.g. export ACME_EMAIL=you@strivemath.com}"
: "${SSH_KEY:?Set SSH_KEY (id or fingerprint from: doctl compute ssh-key list)}"

REPO_URL="${REPO_URL:-https://github.com/StriveMath/trinket-oss.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
DROPLET_NAME="${DROPLET_NAME:-trinket}"
REGION="${REGION:-nyc3}"
SIZE="${SIZE:-s-2vcpu-4gb}"
IMAGE="${IMAGE:-ubuntu-24-04-x64}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/cloud-init.yaml"
RENDERED="$(mktemp -t trinket-cloud-init.XXXXXX.yaml)"
trap 'rm -f "$RENDERED"' EXIT

SESSION_SECRET="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)"

# Escape the URL for sed (slashes in https://...)
REPO_URL_ESC="${REPO_URL//\//\\/}"

sed \
  -e "s|__DOMAIN__|${DOMAIN}|g" \
  -e "s|__ACME_EMAIL__|${ACME_EMAIL}|g" \
  -e "s|__SESSION_SECRET__|${SESSION_SECRET}|g" \
  -e "s|__REPO_URL__|${REPO_URL}|g" \
  -e "s|__REPO_BRANCH__|${REPO_BRANCH}|g" \
  "$TEMPLATE" > "$RENDERED"

echo "==> Creating droplet '$DROPLET_NAME' in $REGION ($SIZE, $IMAGE)..."
echo "    Fork:   $REPO_URL ($REPO_BRANCH)"
echo "    Domain: $DOMAIN"

doctl compute droplet create "$DROPLET_NAME" \
  --region "$REGION" \
  --size "$SIZE" \
  --image "$IMAGE" \
  --ssh-keys "$SSH_KEY" \
  --user-data-file "$RENDERED" \
  --enable-monitoring \
  --enable-ipv6 \
  --wait \
  --format ID,Name,PublicIPv4,Region,Status

DROPLET_IP="$(doctl compute droplet get "$DROPLET_NAME" --format PublicIPv4 --no-header | tr -d '[:space:]')"

cat <<EOF

==========================================================================
  Droplet created. Public IPv4: $DROPLET_IP
==========================================================================

NEXT STEPS:

  1) Point DNS at the droplet (required before Caddy can issue a cert):

         A   ${DOMAIN}   ${DROPLET_IP}

     If you also want www:
         A   www.${DOMAIN}   ${DROPLET_IP}
         (then add it to the Caddyfile too)

  2) Watch cloud-init finish (~5-10 min on first boot; Piston takes a while
     to download Python/Java/R packages):

         ssh root@${DROPLET_IP} 'tail -f /var/log/trinket-setup.log'

  3) Once DNS resolves and setup is complete:

         https://${DOMAIN}

DROPLET LAYOUT:

  /opt/trinket/repo                    your fork (git pull to update)
  /opt/trinket/repo/config/local.yaml  per-environment config + secrets
  /opt/trinket/repo/deploy/Caddyfile   reverse-proxy config
  /opt/trinket/.env                    DOMAIN + ACME_EMAIL for Caddy
  systemctl status trinket             restarts on reboot

UPDATING LATER:

  ssh root@${DROPLET_IP}
  cd /opt/trinket/repo
  git pull
  docker compose -f docker-compose.yml -f docker-compose.override.yml \\
                 -f docker-compose.prod.yml build
  docker compose -f docker-compose.yml -f docker-compose.override.yml \\
                 -f docker-compose.prod.yml up -d

The session secret was generated locally, baked into cloud-init user-data,
and is not stored on your machine after this script exits.
EOF
