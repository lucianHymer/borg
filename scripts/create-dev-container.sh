#!/bin/bash
# scripts/create-dev-container.sh
# Provisions a new dev container with Claude Code CLI, sshd, and credential broker access.
# Usage: ./create-dev-container.sh <name> <port> <ssh-pubkey-file> [memory-limit]
# Example: ./create-dev-container.sh alice 2201 ~/.ssh/alice.pub 2g

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if [ $# -lt 3 ]; then
    echo "Usage: $0 <name> <port> <ssh-pubkey-file> [memory-limit]"
    echo "Example: $0 alice 2201 ~/.ssh/alice.pub 2g"
    exit 1
fi

DEV_NAME="$1"
SSH_PORT="$2"
SSH_KEY_FILE="$3"
MEMORY_LIMIT="${4:-2g}"  # Default 2GB (not 3GB — supports 10+ containers on 32GB)

# Compute swap limit at 1.25x memory for kernel overhead headroom
compute_swap_limit() {
    local mem="$1"
    local num="${mem%[gGmM]*}"
    local unit="${mem##*[0-9.]}"
    echo "$(awk "BEGIN {printf \"%.0f\", $num * 1.25}")${unit}"
}
SWAP_LIMIT="$(compute_swap_limit "$MEMORY_LIMIT")"

if [ ! -f "$SSH_KEY_FILE" ]; then
    log "ERROR: SSH public key file not found: $SSH_KEY_FILE"
    exit 1
fi

# Preflight: check /secrets/ files exist (Docker silently creates directories for missing bind-mount sources)
if [ ! -f /secrets/broker-env.sh ]; then
    log "ERROR: /secrets/broker-env.sh not found. Create it with:"
    log '  printf "export CREDENTIAL_BROKER_URL=http://broker:3000\nexport BROKER_SECRET=<secret>\n" | sudo tee /secrets/broker-env.sh'
    exit 1
fi

if [ ! -f /secrets/github-installations.json ] || [ ! -s /secrets/github-installations.json ]; then
    log "ERROR: /secrets/github-installations.json is missing or empty."
    log "  Run ./borg.sh start first (it symlinks the project's secrets/ to /secrets/),"
    log "  or create the file manually:"
    log "  sudo ln -sf $PROJECT_DIR/secrets/github-installations.json /secrets/github-installations.json"
    exit 1
fi

# Discover the dev network (separate from internal — dev containers can't reach dashboard/docker-proxy)
NETWORK=$(docker network ls --filter "label=com.docker.compose.project=borg" \
    --format '{{.Name}}' | grep dev || true)
if [ -z "$NETWORK" ]; then
    log "ERROR: Could not find borg dev network. Is docker-compose running?"
    exit 1
fi

# Build image if not exists
log "Building dev container image..."
docker build -t borg-dev -f "$PROJECT_DIR/Dockerfile.dev-container" "$PROJECT_DIR"

# Create and start container
log "Creating container dev-${DEV_NAME} on port ${SSH_PORT} with ${MEMORY_LIMIT} memory"
docker run -d \
    --name "dev-${DEV_NAME}" \
    --network "${NETWORK}" \
    --hostname "dev-${DEV_NAME}" \
    --label "borg.type=dev-container" \
    -p "${SSH_PORT}:22" \
    --memory "${MEMORY_LIMIT}" \
    --memory-swap "${SWAP_LIMIT}" \
    --cpus 2 \
    --cap-drop NET_RAW \
    -e CREDENTIAL_BROKER_URL=http://broker:3000 \
    -v "/secrets/broker-env.sh:/etc/profile.d/broker-env.sh:ro" \
    -v "/secrets/github-installations.json:/secrets/github-installations.json:ro" \
    --restart unless-stopped \
    borg-dev

# Inject SSH key
docker exec "dev-${DEV_NAME}" bash -c \
    "cat >> /home/dev/.ssh/authorized_keys" < "${SSH_KEY_FILE}"
docker exec "dev-${DEV_NAME}" chown dev:dev /home/dev/.ssh/authorized_keys
docker exec "dev-${DEV_NAME}" chmod 600 /home/dev/.ssh/authorized_keys

log "Container dev-${DEV_NAME} ready on port ${SSH_PORT}"
log "SSH: ssh -p ${SSH_PORT} dev@<host>"
