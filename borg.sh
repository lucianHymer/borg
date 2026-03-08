#!/bin/bash
# Borg - Docker Compose Wrapper
# Manages the Borg stack: bot, broker, dashboard, cloudflared

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

# One-time migration from .tinyclaw/ to .borg/
if [ -d "$SCRIPT_DIR/.tinyclaw" ] && [ ! -d "$SCRIPT_DIR/.borg" ]; then
    echo "Migrating .tinyclaw/ to .borg/..."
    mv -T "$SCRIPT_DIR/.tinyclaw" "$SCRIPT_DIR/.borg" 2>/dev/null || true
    echo "Migration complete."
fi

SETTINGS_FILE="$SCRIPT_DIR/.borg/settings.json"
LOG_DIR="$SCRIPT_DIR/.borg/logs"

# Compose project name is derived from the directory name
COMPOSE_PROJECT="borg"
VOLUME_NAME="${COMPOSE_PROJECT}_borg-data"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/daemon.log"
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

# Run docker compose with the correct project directory
dc() {
    docker compose -f "$COMPOSE_FILE" --project-directory "$SCRIPT_DIR" -p "$COMPOSE_PROJECT" "$@"
}

# Get the host mount point of the borg-data volume
volume_mountpoint() {
    docker volume inspect "$VOLUME_NAME" --format '{{ .Mountpoint }}' 2>/dev/null
}

# Read a setting from settings.json (checks volume first, then local)
read_settings_file() {
    local mp
    mp=$(volume_mountpoint 2>/dev/null || true)

    if [ -n "$mp" ] && sudo test -f "$mp/settings.json"; then
        sudo cat "$mp/settings.json"
    elif [ -f "$SETTINGS_FILE" ]; then
        cat "$SETTINGS_FILE"
    else
        return 1
    fi
}

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_start() {
    # Preflight: ensure github-installations.json exists and is populated
    local installations="$SCRIPT_DIR/secrets/github-installations.json"
    if [ ! -f "$installations" ] || [ ! -s "$installations" ]; then
        echo -e "${RED}Missing: secrets/github-installations.json${NC}"
        echo "  Run the setup wizard for guided configuration:"
        echo "    Open Claude Code in this repo and say 'run the setup wizard'"
        echo ""
        echo "  Or manually copy the example and fill in your org + installation ID:"
        echo "    cp secrets/github-installations.json.example secrets/github-installations.json"
        echo "    vim secrets/github-installations.json"
        exit 1
    fi

    # Symlink project secrets to /secrets/ so dev containers can bind-mount them.
    # (Compose mounts ./secrets/ for the bot; dev containers mount /secrets/ on the host.)
    sudo mkdir -p /secrets
    sudo ln -sf "$installations" /secrets/github-installations.json

    log "Starting Borg stack..."

    # Install global skills
    if [ -d "$SCRIPT_DIR/skills/global" ]; then
        mkdir -p "$HOME/.claude/skills"
        cp "$SCRIPT_DIR/skills/global/"* "$HOME/.claude/skills/" 2>/dev/null || true
        log "Installed global skills to ~/.claude/skills/"
    fi

    dc up -d
    echo -e "${GREEN}Borg stack started${NC}"
    echo "  Services: bot, broker, dashboard, cloudflared"
    echo "  Logs:     ./borg.sh logs"
    log "Borg stack started"
}

cmd_stop() {
    log "Stopping Borg stack..."
    dc down
    echo -e "${GREEN}Borg stack stopped${NC}"
    log "Borg stack stopped"
}

cmd_restart() {
    if [ -n "${2:-}" ]; then
        log "Restarting service: $2"
        dc restart "$2"
        echo -e "${GREEN}Restarted: $2${NC}"
    else
        log "Restarting Borg stack..."
        dc restart
        echo -e "${GREEN}Borg stack restarted${NC}"
    fi
    log "Borg restart complete"
}

cmd_status() {
    echo -e "${BLUE}Borg Status${NC}"
    echo "==============="
    echo ""

    echo -e "${BLUE}Docker Compose Services:${NC}"
    dc ps
    echo ""

    # Show resource usage for running containers
    local containers
    containers=$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format '{{.Names}}' 2>/dev/null || true)
    if [ -n "$containers" ]; then
        echo -e "${BLUE}Resource Usage:${NC}"
        docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" $containers
    fi
}

cmd_logs() {
    local service="${2:-}"

    case "$service" in
        bot|broker|dashboard|cloudflared)
            dc logs -f "$service"
            ;;
        ""|all)
            dc logs -f
            ;;
        *)
            echo -e "${RED}Unknown service: $service${NC}"
            echo "Available services: bot, broker, dashboard, cloudflared, all"
            exit 1
            ;;
    esac
}

cmd_send() {
    local message="${2:-}"
    if [ -z "$message" ]; then
        echo "Usage: $0 send <message>"
        exit 1
    fi

    local MESSAGE_ID="cli_$(date +%s)_$$"
    local json
    json=$(jq -n \
        --arg channel "telegram" \
        --arg source "cli" \
        --argjson threadId 1 \
        --arg sender "CLI" \
        --arg senderId "cli" \
        --arg message "$message" \
        --argjson isReply false \
        --argjson timestamp "$(date +%s)000" \
        --arg messageId "$MESSAGE_ID" \
        '{channel: $channel, source: $source, threadId: $threadId, sender: $sender, senderId: $senderId, message: $message, isReply: $isReply, timestamp: $timestamp, messageId: $messageId}')

    # Check if bot container is running
    if dc ps --status running --format '{{.Service}}' 2>/dev/null | grep -q '^bot$'; then
        echo "$json" | dc exec -T bot sh -c "cat > /app/.borg/queue/incoming/${MESSAGE_ID}.json"
        echo -e "${GREEN}Message queued via container: $MESSAGE_ID${NC}"
    elif [ -d "$SCRIPT_DIR/.borg/queue/incoming" ]; then
        # Fallback: write to local filesystem (migration compat)
        echo "$json" > "$SCRIPT_DIR/.borg/queue/incoming/${MESSAGE_ID}.json"
        echo -e "${GREEN}Message queued to local filesystem: $MESSAGE_ID${NC}"
        echo -e "${YELLOW}Note: bot container is not running${NC}"
    else
        echo -e "${RED}Bot container is not running and no local queue directory exists${NC}"
        echo "Start the stack first: ./borg.sh start"
        exit 1
    fi

    log "[cli] Queued: ${message:0:50}..."
}

cmd_migrate() {
    echo -e "${BLUE}Migrating local .borg/ data into Docker volume...${NC}"

    local src_dir="$SCRIPT_DIR/.borg"
    if [ ! -d "$src_dir" ]; then
        echo -e "${RED}No local .borg/ directory found${NC}"
        exit 1
    fi

    # Ensure the stack is up so we can copy into the volume
    if ! dc ps --status running --format '{{.Service}}' 2>/dev/null | grep -q '^bot$'; then
        echo -e "${YELLOW}Starting bot container for migration...${NC}"
        dc up -d bot
        sleep 3
    fi

    # Files to migrate
    local files=("threads.json" "message-history.jsonl" "settings.json" "message-models.json")

    for f in "${files[@]}"; do
        if [ -f "$src_dir/$f" ]; then
            echo "  Copying $f..."
            dc cp "$src_dir/$f" "bot:/app/.borg/$f"
        else
            echo -e "  ${YELLOW}Skipping $f (not found)${NC}"
        fi
    done

    # Copy queue directory contents if any
    if [ -d "$src_dir/queue" ]; then
        echo "  Copying queue directory..."
        dc exec -T bot sh -c "mkdir -p /app/.borg/queue/incoming /app/.borg/queue/outgoing"
        for qfile in "$src_dir/queue/incoming/"*.json; do
            [ -f "$qfile" ] && dc cp "$qfile" "bot:/app/.borg/queue/incoming/$(basename "$qfile")"
        done 2>/dev/null || true
    fi

    # Clear sessionId from migrated threads.json (sessions don't survive container boundary)
    echo "  Clearing sessionId from threads.json..."
    dc exec -T bot sh -c '
        if [ -f /app/.borg/threads.json ]; then
            tmp=$(mktemp)
            jq "walk(if type == \"object\" and has(\"sessionId\") then del(.sessionId) else . end)" \
                /app/.borg/threads.json > "$tmp" && mv "$tmp" /app/.borg/threads.json
        fi
    '

    echo -e "${GREEN}Migration complete${NC}"
    echo "  Cleared sessionId values (sessions are not portable across boundaries)"
    echo "  Restart the stack to pick up migrated data: ./borg.sh restart"
}

cmd_build() {
    echo -e "${BLUE}Building Borg Docker images...${NC}"
    dc build "$@"
    echo -e "${GREEN}Build complete${NC}"
}

cmd_model() {
    local new_model="${2:-}"

    if [ -z "$new_model" ]; then
        # Show current model
        local settings
        settings=$(read_settings_file 2>/dev/null) || {
            echo -e "${RED}No settings file found${NC}"
            exit 1
        }
        local current_model
        current_model=$(echo "$settings" | grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
        echo -e "${BLUE}Current model: ${GREEN}$current_model${NC}"
    else
        case "$new_model" in
            sonnet|opus)
                # Update settings.json inside the volume via the bot container
                if dc ps --status running --format '{{.Service}}' 2>/dev/null | grep -q '^bot$'; then
                    dc exec -T bot sh -c "
                        if [ -f /app/.borg/settings.json ]; then
                            tmp=\$(mktemp)
                            sed 's/\"model\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"model\": \"$new_model\"/' \
                                /app/.borg/settings.json > \"\$tmp\" && mv \"\$tmp\" /app/.borg/settings.json
                        else
                            echo 'settings.json not found' >&2
                            exit 1
                        fi
                    "
                    echo -e "${GREEN}Model switched to: $new_model${NC}"
                    echo "Note: Changes take effect on next message."
                elif [ -f "$SETTINGS_FILE" ]; then
                    # Fallback: edit local file
                    sed -i "s/\"model\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"model\": \"$new_model\"/" "$SETTINGS_FILE"
                    echo -e "${GREEN}Model switched to: $new_model (local settings)${NC}"
                    echo -e "${YELLOW}Note: Bot container is not running. Change applies to local file only.${NC}"
                else
                    echo -e "${RED}No settings file found and bot container is not running${NC}"
                    exit 1
                fi
                ;;
            *)
                echo "Usage: $0 model {sonnet|opus}"
                exit 1
                ;;
        esac
    fi
}

cmd_help() {
    echo -e "${BLUE}Borg - Docker Compose Wrapper${NC}"
    echo ""
    echo "Usage: $0 <command> [args]"
    echo ""
    echo "Commands:"
    echo "  start                  Start the full stack (bot, broker, dashboard, cloudflared)"
    echo "  stop                   Stop and remove all containers"
    echo "  restart [service]      Restart all services, or a specific service"
    echo "  status                 Show container status and resource usage"
    echo "  logs [service]         Follow logs (bot|broker|dashboard|cloudflared|all)"
    echo "  build                  Build Docker images"
    echo "  send <msg>             Send a CLI message to the queue (thread 1)"
    echo "  migrate                Copy local .borg/ data into Docker volume"
    echo "  model [sonnet|opus]    Show or switch the Claude model"
    echo "  help                   Show this help message"
    echo ""
    echo "Services: bot, broker, dashboard, cloudflared"
    echo ""
}

# ─── Main ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
    start)      cmd_start ;;
    stop)       cmd_stop ;;
    restart)    cmd_restart "$@" ;;
    status)     cmd_status ;;
    logs)       cmd_logs "$@" ;;
    build)      shift; cmd_build "$@" ;;
    send)       cmd_send "$@" ;;
    migrate)    cmd_migrate ;;
    model)      cmd_model "$@" ;;
    help|--help|-h)
                cmd_help ;;
    *)          cmd_help; exit 1 ;;
esac
