#!/bin/bash
# DroidStream on GCE — Setup Script
#
# Deploys a plain (non-nested-virt) GCE VM running DroidStream: Android as a
# container (redroid) streamed to a browser over WebSocket/WebCodecs.
#
# Usage:
#   ./setup.sh [PROJECT_ID] [ZONE] [MACHINE_TYPE]
#
# Example:
#   ./setup.sh droidstream-svc us-east1-c n2-standard-4

set -euo pipefail

PROJECT="${1:-droidstream-svc}"
ZONE="${2:-us-east1-c}"
MACHINE_TYPE="${3:-n2-standard-4}"

INSTANCE_NAME="droidstream"
NETWORK_TAG="droidstream-host"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLOUD_INIT="${SCRIPT_DIR}/cloud-init.yaml"

command -v gcloud >/dev/null 2>&1 || { echo "ERROR: gcloud not found."; exit 1; }
[ -f "$CLOUD_INIT" ] || { echo "ERROR: cloud-init.yaml not found at $CLOUD_INIT"; exit 1; }

echo "═══════════════════════════════════════════════════════════"
echo " DroidStream on GCE"
echo "═══════════════════════════════════════════════════════════"
echo " Project      : $PROJECT"
echo " Zone         : $ZONE"
echo " Machine type : $MACHINE_TYPE"
echo " Instance     : $INSTANCE_NAME"
echo "═══════════════════════════════════════════════════════════"
echo ""

echo "[1/3] Setting up firewall rules..."
if ! gcloud compute firewall-rules describe "allow-${NETWORK_TAG}" --project="$PROJECT" &>/dev/null; then
  gcloud compute firewall-rules create "allow-${NETWORK_TAG}" \
    --project="$PROJECT" \
    --direction=INGRESS \
    --action=ALLOW \
    --rules=tcp:8080,tcp:8443 \
    --source-ranges=0.0.0.0/0 \
    --target-tags="$NETWORK_TAG" \
    --description="DroidStream: web console (8080, plain HTTP) + TLS proxy (8443, required for WebCodecs). ADB stays loopback-only by design."
  echo "  Firewall rule created: allow-${NETWORK_TAG}"
else
  echo "  Firewall rule already exists: allow-${NETWORK_TAG}"
fi

if gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT" &>/dev/null; then
  echo ""
  echo "  Instance '$INSTANCE_NAME' already exists."
  read -r -p "  Delete and recreate it? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    gcloud compute instances delete "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT" --quiet
  else
    echo "  Keeping existing instance."
    EXTERNAL_IP=$(gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT" \
      --format="get(networkInterfaces[0].accessConfigs[0].natIP)")
    echo "  Open: http://${EXTERNAL_IP}:8080"
    exit 0
  fi
fi

echo ""
echo "[2/3] Creating VM (no nested virtualization needed)..."

# NOTE: no --enable-nested-virtualization here — that's the whole point.
# DroidStream's container backend runs on the host kernel directly.
gcloud compute instances create "$INSTANCE_NAME" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --machine-type="$MACHINE_TYPE" \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=40GB \
  --boot-disk-type=pd-ssd \
  --tags="$NETWORK_TAG" \
  --metadata-from-file=user-data="${CLOUD_INIT}"

echo ""
echo "[3/3] Getting instance IP..."
EXTERNAL_IP=$(gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT" \
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)")

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " VM created. External IP: $EXTERNAL_IP"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo " Next: copy the project and start the stack:"
echo "   ./deploy.sh $PROJECT $ZONE"
echo ""

cat > "${SCRIPT_DIR}/.last-instance" <<EOF
PROJECT=$PROJECT
ZONE=$ZONE
INSTANCE_NAME=$INSTANCE_NAME
EXTERNAL_IP=$EXTERNAL_IP
EOF
