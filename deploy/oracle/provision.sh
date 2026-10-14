#!/usr/bin/env bash
# Provision Oracle Cloud VM + open ports 80/443 for mal-stremio.
# Requires: oci CLI configured (run: oci setup config)
#
# Usage:
#   bash deploy/oracle/provision.sh --username your_mal_name
#   bash deploy/oracle/provision.sh --username luismonteir0 --ssh-key ~/.ssh/id_ed25519.pub
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLOUD_INIT="$SCRIPT_DIR/cloud-init.yaml"

MAL_USERNAMES="${MAL_USERNAMES:-}"
SSH_KEY_FILE="${SSH_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
INSTANCE_NAME="${INSTANCE_NAME:-mal-stremio}"
SHAPE="${SHAPE:-VM.Standard.A1.Flex}"
OCPUS="${OCPUS:-1}"
MEMORY_GB="${MEMORY_GB:-6}"
COMPARTMENT_ID="${COMPARTMENT_ID:-}"
SUBNET_ID="${SUBNET_ID:-}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Provision mal-stremio on Oracle Cloud (steps 1 + 2 automated)

Prerequisites:
  1. Oracle Always Free account
  2. oci CLI configured:  oci setup config
  3. SSH public key (default: ~/.ssh/id_ed25519.pub)

Options:
  --username NAMES     MAL usernames to preload (comma-separated)
  --ssh-key PATH       SSH public key file
  --name NAME          Instance display name (default: mal-stremio)
  --compartment ID     OCI compartment OCID (default: tenancy root)
  --subnet ID          Subnet OCID (default: first public subnet found)
  --shape SHAPE        VM shape (default: VM.Standard.A1.Flex)
  --ocpus N            OCPUs for flex shape (default: 1)
  --memory GB          Memory GB for flex shape (default: 6)
  --dry-run            Print planned actions only
  -h, --help           Show help
EOF
}

log() { echo "[provision] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --username) MAL_USERNAMES="$2"; shift 2 ;;
    --ssh-key) SSH_KEY_FILE="$2"; shift 2 ;;
    --name) INSTANCE_NAME="$2"; shift 2 ;;
    --compartment) COMPARTMENT_ID="$2"; shift 2 ;;
    --subnet) SUBNET_ID="$2"; shift 2 ;;
    --shape) SHAPE="$2"; shift 2 ;;
    --ocpus) OCPUS="$2"; shift 2 ;;
    --memory) MEMORY_GB="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if ! command -v oci >/dev/null 2>&1; then
  echo "oci CLI not found. Install: brew install oci-cli" >&2
  exit 1
fi

if ! oci iam region list --limit 1 >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Oracle CLI is not configured.

Run once (interactive — opens browser for API key setup):
  oci setup config

Then re-run this script.
EOF
  exit 1
fi

if [[ ! -f "$SSH_KEY_FILE" ]]; then
  echo "SSH public key not found: $SSH_KEY_FILE" >&2
  echo "Generate one: ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519" >&2
  exit 1
fi

TENANCY_ID="$(grep -E '^tenancy=' "$HOME/.oci/config" | head -1 | cut -d= -f2 | tr -d ' ')"
REGION="$(grep -E '^region=' "$HOME/.oci/config" | head -1 | cut -d= -f2 | tr -d ' ')"

if [[ -z "$COMPARTMENT_ID" ]]; then
  COMPARTMENT_ID="$TENANCY_ID"
fi

if [[ -z "$SUBNET_ID" ]]; then
  log "Finding default VCN / public subnet..."
  VCN_ID="$(oci network vcn list --compartment-id "$COMPARTMENT_ID" --all --raw-output --query 'data[0].id' 2>/dev/null || echo "")"
  if [[ -z "$VCN_ID" || "$VCN_ID" == "null" ]]; then
    cat >&2 <<'EOF'
No VCN found. Create a default VCN first in Oracle Console:
  Networking → Virtual Cloud Networks → Start VCN Wizard → Create VCN with Internet Connectivity
EOF
    exit 1
  fi
  SUBNET_ID="$(oci network subnet list --compartment-id "$COMPARTMENT_ID" --vcn-id "$VCN_ID" --raw-output --query 'data[?contains("display-name", `ublic`) || "prohibit-public-ip-on-vnic" == `false`][0].id' 2>/dev/null || oci network subnet list --compartment-id "$COMPARTMENT_ID" --vcn-id "$VCN_ID" --raw-output --query 'data[0].id')"
  SECURITY_LIST_ID="$(oci network subnet get --subnet-id "$SUBNET_ID" --raw-output --query 'data."security-list-ids"[0]')"
fi

if [[ -z "$SUBNET_ID" || "$SUBNET_ID" == "null" ]]; then
  echo "Could not find a subnet. Pass --subnet <OCID>" >&2
  exit 1
fi

if [[ -z "${SECURITY_LIST_ID:-}" ]]; then
  SECURITY_LIST_ID="$(oci network subnet get --subnet-id "$SUBNET_ID" --raw-output --query 'data."security-list-ids"[0]')"
fi

log "Tenancy:  $TENANCY_ID"
log "Region:   $REGION"
log "Subnet:   $SUBNET_ID"
log "Shape:    $SHAPE (${OCPUS} OCPU, ${MEMORY_GB} GB)"

AD_NAME="$(oci iam availability-domain list --raw-output --query 'data[0].name' --compartment-id "$COMPARTMENT_ID")"

# Ubuntu 22.04 aarch64 for Ampere; fall back to x86
IMAGE_ID="$(oci compute image list \
  --compartment-id "$COMPARTMENT_ID" \
  --operating-system "Canonical Ubuntu" \
  --operating-system-version "22.04" \
  --shape "$SHAPE" \
  --sort-by TIMECREATED \
  --sort-order DESC \
  --limit 1 \
  --raw-output \
  --query 'data[0].id' 2>/dev/null || echo "")"

if [[ -z "$IMAGE_ID" || "$IMAGE_ID" == "null" ]]; then
  IMAGE_ID="$(oci compute image list \
    --compartment-id "$COMPARTMENT_ID" \
    --operating-system "Canonical Ubuntu" \
    --sort-by TIMECREATED \
    --sort-order DESC \
    --limit 1 \
    --raw-output \
    --query 'data[0].id')"
fi

log "Image:    $IMAGE_ID"
log "AD:       $AD_NAME"

# Patch cloud-init with MAL_USERNAMES
CLOUD_INIT_RUNTIME="$(mktemp)"
if [[ -n "$MAL_USERNAMES" ]]; then
  sed "s/^      MAL_USERNAMES=$/      MAL_USERNAMES=${MAL_USERNAMES}/" "$CLOUD_INIT" > "$CLOUD_INIT_RUNTIME"
else
  cp "$CLOUD_INIT" "$CLOUD_INIT_RUNTIME"
fi

open_firewall_ports() {
  log "Opening ingress ports 80 and 443 on security list $SECURITY_LIST_ID"

  local rules_file egress_file ingress_file
  rules_file="$(mktemp)"
  egress_file="$(mktemp)"
  ingress_file="$(mktemp)"

  oci network security-list get --security-list-id "$SECURITY_LIST_ID" --raw-output > "$rules_file"

  local changed
  changed="$(python3 - "$rules_file" "$egress_file" "$ingress_file" <<'PY'
import json, sys
src, egress_dst, ingress_dst = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(src))["data"]
rules = data["ingress-security-rules"]
changed = False

def has_port(port):
    for r in rules:
        tcp = r.get("tcp-options") or {}
        pr = tcp.get("destination-port-range") or {}
        if pr.get("min") == port and pr.get("max") == port:
            return True
    return False

def add_tcp(port, desc):
    global changed
    rules.append({
        "protocol": "6",
        "source": "0.0.0.0/0",
        "is-stateless": False,
        "tcp-options": {"destination-port-range": {"min": port, "max": port}},
        "description": desc,
    })
    changed = True

if not has_port(80):
    add_tcp(80, "mal-stremio HTTP")
if not has_port(443):
    add_tcp(443, "mal-stremio HTTPS")

json.dump(data["egress-security-rules"], open(egress_dst, "w"))
json.dump(rules, open(ingress_dst, "w"))
print("yes" if changed else "no")
PY
)"

  if [[ "$changed" == "no" ]]; then
    log "Ports 80/443 already open"
    rm -f "$rules_file" "$egress_file" "$ingress_file"
    return
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] Would add TCP 80 and 443 ingress rules"
    rm -f "$rules_file" "$egress_file" "$ingress_file"
    return
  fi

  oci network security-list update \
    --security-list-id "$SECURITY_LIST_ID" \
    --ingress-security-rules "file://$ingress_file" \
    --egress-security-rules "file://$egress_file" \
    --force >/dev/null

  rm -f "$rules_file" "$egress_file" "$ingress_file"
  log "Firewall updated"
}

launch_instance() {
  local shape_config=""
  if [[ "$SHAPE" == *".Flex" ]]; then
    shape_config="{\"ocpus\": ${OCPUS}, \"memoryInGBs\": ${MEMORY_GB}}"
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] Would launch instance $INSTANCE_NAME"
    return
  fi

  log "Launching instance (takes 2-5 minutes)..."

  local launch_args=(
    --compartment-id "$COMPARTMENT_ID"
    --availability-domain "$AD_NAME"
    --display-name "$INSTANCE_NAME"
    --image-id "$IMAGE_ID"
    --subnet-id "$SUBNET_ID"
    --assign-public-ip true
    --user-data-file "$CLOUD_INIT_RUNTIME"
    --ssh-authorized-keys-file "$SSH_KEY_FILE"
  )

  if [[ -n "$shape_config" ]]; then
    launch_args+=(--shape "$SHAPE" --shape-config "$shape_config")
  else
    launch_args+=(--shape "$SHAPE")
  fi

  INSTANCE_ID="$(oci compute instance launch "${launch_args[@]}" --raw-output --query 'data.id')"
  log "Instance ID: $INSTANCE_ID"

  log "Waiting for instance to be RUNNING..."
  oci compute instance wait-for-state --instance-id "$INSTANCE_ID" --wait-for-state RUNNING >/dev/null

  PUBLIC_IP="$(oci compute instance list-vnics --instance-id "$INSTANCE_ID" --raw-output --query 'data[0]."public-ip"')"
  log "Public IP: $PUBLIC_IP"

  cat <<EOF

╔══════════════════════════════════════════════════════════════╗
║  Oracle VM provisioned — mal-stremio installing via cloud-init ║
╚══════════════════════════════════════════════════════════════╝

  Public IP : ${PUBLIC_IP}
  SSH       : ssh ubuntu@${PUBLIC_IP}
  URL (~5m) : https://${PUBLIC_IP}.sslip.io/configure
  Stremio   : stremio://${PUBLIC_IP}.sslip.io/manifest.json

Check install progress:
  ssh ubuntu@${PUBLIC_IP} 'cat ~/mal-stremio-ready.txt'

EOF
}

trap 'rm -f "${CLOUD_INIT_RUNTIME:-}"' EXIT

open_firewall_ports
launch_instance