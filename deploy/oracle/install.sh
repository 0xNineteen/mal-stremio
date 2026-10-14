#!/usr/bin/env bash
# One-click Oracle Cloud deploy for mal-stremio.
#
# Usage (on a fresh Ubuntu VM):
#   curl -fsSL https://raw.githubusercontent.com/0xNineteen/mal-stremio/main/deploy/oracle/install.sh | sudo bash
#
# With options:
#   sudo bash install.sh --domain mydomain.com --username your_mal_name
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/0xNineteen/mal-stremio.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/mal-stremio}"
MAL_USERNAMES="${MAL_USERNAMES:-}"
DOMAIN="${DOMAIN:-}"
SKIP_CLONE=0
LOG_FILE="/var/log/mal-stremio-install.log"

usage() {
  cat <<'EOF'
mal-stremio Oracle installer

Options:
  --domain HOST       Custom domain (default: auto sslip.io from public IP)
  --username NAMES    Comma-separated MAL usernames to preload (MAL_USERNAMES)
  --repo URL          Git repo URL (default: 0xNineteen/mal-stremio)
  --dir PATH          Install directory (default: /opt/mal-stremio)
  --skip-clone        Use existing files in --dir (cloud-init mode)
  -h, --help          Show this help

Oracle Cloud: after the VM boots, open ports 80 and 443 in your
VCN Security List / Network Security Group ingress rules.
EOF
}

log() {
  echo "[mal-stremio] $*" | tee -a "$LOG_FILE"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --username) MAL_USERNAMES="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --skip-clone) SKIP_CLONE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Re-run with sudo." >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

log "Starting install"

if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  log "Installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git
fi

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

if ! docker compose version >/dev/null 2>&1; then
  log "Installing Docker Compose plugin"
  apt-get update -qq
  apt-get install -y -qq docker-compose-plugin
fi

if [[ "$SKIP_CLONE" -eq 1 ]]; then
  if [[ ! -f "$INSTALL_DIR/docker-compose.yml" ]]; then
    log "ERROR: --skip-clone set but $INSTALL_DIR/docker-compose.yml not found"
    exit 1
  fi
  log "Using existing checkout at $INSTALL_DIR"
else
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "Updating existing repo at $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    log "Cloning $REPO_URL into $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
fi

cd "$INSTALL_DIR"

if [[ -z "$DOMAIN" ]]; then
  PUBLIC_IP="$(curl -fsSL --max-time 15 https://api.ipify.org || curl -fsSL --max-time 15 https://ifconfig.me)"
  DOMAIN="${PUBLIC_IP}.sslip.io"
  log "No domain provided — using auto HTTPS host: $DOMAIN"
fi

cat > .env <<EOF
PORT=3001
NODE_ENV=production
MAL_USERNAMES=${MAL_USERNAMES}
MAL_REQUEST_INTERVAL_MS=350
MAL_RESOLVE_CONCURRENCY=5
DOMAIN=${DOMAIN}
EOF

log "Building and starting containers"
docker compose pull caddy 2>/dev/null || true
docker compose up -d --build

log "Waiting for app health check"
for _ in $(seq 1 60); do
  if docker compose ps --status running app 2>/dev/null | grep -q healthy || \
     docker compose exec -T app node -e "require('http').get('http://127.0.0.1:3001/configure',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

CONFIGURE_URL="https://${DOMAIN}/configure"
MANIFEST_URL="https://${DOMAIN}/manifest.json"

cat <<EOF

╔══════════════════════════════════════════════════════════════╗
║  mal-stremio is running on Oracle Cloud                      ║
╚══════════════════════════════════════════════════════════════╝

  Configure page : ${CONFIGURE_URL}
  Seasonal addon : ${MANIFEST_URL}
  Stremio install: stremio://${DOMAIN}/manifest.json

If HTTPS is not reachable yet:
  1. Oracle Console → Networking → Security List
  2. Add ingress: TCP 80, 443 from 0.0.0.0/0
  3. Wait ~2 minutes for Let's Encrypt

Manage:
  cd ${INSTALL_DIR}
  docker compose logs -f app
  docker compose restart
  docker compose pull && docker compose up -d --build   # update

Install log: ${LOG_FILE}
EOF