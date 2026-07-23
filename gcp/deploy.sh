#!/bin/bash
# Copies the DroidStream project onto the VM created by setup.sh, fetches
# the pinned scrcpy server, and brings the stack up with docker compose.
#
# Usage: ./deploy.sh [PROJECT_ID] [ZONE]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "${SCRIPT_DIR}/.last-instance" ]; then
  source "${SCRIPT_DIR}/.last-instance"
fi
PROJECT="${1:-${PROJECT:-droidstream-svc}}"
ZONE="${2:-${ZONE:-us-east1-c}}"
INSTANCE_NAME="${INSTANCE_NAME:-droidstream}"

echo "Packing project (excluding node_modules, vendor, .git)..."
TARBALL="$(mktemp -t droidstream-XXXX).tar.gz"
# gcp/ IS included -- docker-compose.yml references gcp/nginx-tls.conf and
# gcp/tls/ (the TLS-terminating reverse proxy; see nginx-tls.conf for why
# it exists). Only the local-machine-only bits of gcp/ are excluded.
tar -czf "$TARBALL" -C "$REPO_ROOT" \
  --exclude='.git' --exclude='node_modules' --exclude='vendor' \
  --exclude='gcp/.last-instance' --exclude='gcp/tls' \
  .

echo "Copying to $INSTANCE_NAME ($ZONE)..."
gcloud compute scp "$TARBALL" "${INSTANCE_NAME}:/tmp/droidstream.tar.gz" --zone="$ZONE" --project="$PROJECT"
rm -f "$TARBALL"

echo "Extracting, fetching scrcpy, and starting the stack on the VM..."
gcloud compute ssh "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT" --command='
  set -e
  sudo mkdir -p /opt/droidstream
  sudo tar -xzf /tmp/droidstream.tar.gz -C /opt/droidstream
  sudo chown -R "$USER":"$USER" /opt/droidstream
  cd /opt/droidstream
  # sudo: this SSH session may not have docker-group membership yet (its
  # timing versus cloud-init is unreliable on GCE OS Login), and this is
  # informational anyway -- `|| true` because its exit code just reports
  # which backend is available, not a hard failure we should abort on.
  sudo ./scripts/preflight.sh || true
  ./scripts/fetch-scrcpy.sh

  # Self-signed TLS cert for the reverse proxy -- generated fresh on the VM
  # each time it does not already exist, so the private key never has to
  # travel over scp. See gcp/nginx-tls.conf for why this exists at all
  # (WebCodecs needs a secure context; the control plane only speaks HTTP).
  mkdir -p gcp/tls
  if [ ! -f gcp/tls/cert.pem ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout gcp/tls/key.pem -out gcp/tls/cert.pem \
      -subj "/CN=droidstream"
  fi

  # Admin token (opt-in "see/attach to every session" mode -- see
  # control-plane/src/index.js isAdmin() and web/app.js). Generated once and
  # kept in a .env file docker compose loads automatically from this same
  # directory; never in the repo (gitignored) and never hardcoded in
  # docker-compose.yml (this repo is public).
  if [ ! -f .env ] || ! grep -q "^ADMIN_TOKEN=" .env; then
    echo "ADMIN_TOKEN=$(openssl rand -hex 24)" >> .env
  fi
  echo ""
  echo "Admin token (paste into the web console'"'"'s \"admin token\" field to see/attach to every session):"
  grep "^ADMIN_TOKEN=" .env

  sudo docker compose up --build -d
  sleep 5
  sudo docker compose ps
'

EXTERNAL_IP=$(gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT" \
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)")

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " DroidStream running: http://${EXTERNAL_IP}:8080"
echo "═══════════════════════════════════════════════════════════"
