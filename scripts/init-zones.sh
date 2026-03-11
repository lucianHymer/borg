#!/usr/bin/env bash
# Initialize per-zone storage directories and migrate from single-container .borg/ if needed.
# Called automatically by the Docker init service — no manual run required.
# Can also be run directly: bash scripts/init-zones.sh [BASE_DIR]

set -euo pipefail

BASE_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$BASE_DIR"

ZONE_DIRS=(
    queue/incoming queue/outgoing queue/processing queue/dead-letter
    queue/commands queue/cancel sessions status
    audio audio/incoming images images/incoming
    logs persistent
)

INFRA_DIRS=(queue/pending queue/outgoing logs)

# ── Create zone directory structures ──

for zone in core perimeter; do
    for dir in "${ZONE_DIRS[@]}"; do
        mkdir -p ".borg-${zone}/${dir}"
    done
    touch ".borg-${zone}/message-history.jsonl"
done

for dir in "${INFRA_DIRS[@]}"; do
    mkdir -p ".borg-infra/${dir}"
done
[ -f ".borg-infra/message-models.json" ] || echo '{}' > ".borg-infra/message-models.json"

echo "[init-zones] Zone directories ready"

# ── Create config files if missing ──

# Handle Docker's "create directory for missing file mount" quirk:
# If threads.json or zone-config.json are empty directories, remove them first.
for f in threads.json zone-config.json; do
    if [ -d "$f" ] && [ -z "$(ls -A "$f" 2>/dev/null)" ]; then
        rmdir "$f"
        echo "[init-zones] Removed empty directory $f (Docker mount artifact)"
    fi
done

if [ ! -f zone-config.json ]; then
    if [ -f zone-config.example.json ]; then
        cp zone-config.example.json zone-config.json
        echo "[init-zones] Created zone-config.json from example"
    else
        cat > zone-config.json << 'ZEOF'
{
  "zones": {
    "core": { "threads": [] },
    "perimeter": { "threads": [] }
  },
  "defaults": { "newThread": "core" }
}
ZEOF
        echo "[init-zones] Created default zone-config.json"
    fi
fi

if [ ! -f threads.json ]; then
    echo "{}" > threads.json
    echo "[init-zones] Created empty threads.json"
fi

# ── Migrate from single-container .borg/ if present ──

if [ -d .borg ] && [ -f .borg/settings.json ] && [ ! -f .borg-core/settings.json ]; then
    echo "[init-zones] Detected old .borg/ directory — migrating to zones..."

    # Core gets the main data (most threads are typically core)
    for f in message-history.jsonl settings.json heartbeat-state.json \
             markdown-parse-failures.jsonl voice-transcripts.json \
             task-lists.json task-pins.json; do
        [ -f ".borg/$f" ] && cp ".borg/$f" ".borg-core/$f"
    done

    # Sessions
    if [ -d .borg/sessions ] && [ -n "$(ls -A .borg/sessions/ 2>/dev/null)" ]; then
        cp .borg/sessions/* .borg-core/sessions/
    fi

    # Persistent data
    if [ -d .borg/persistent ] && [ -n "$(ls -A .borg/persistent/ 2>/dev/null)" ]; then
        cp -r .borg/persistent/* .borg-core/persistent/
    fi

    # Infra gets message-models and settings (needed for bot token)
    [ -f .borg/message-models.json ] && cp .borg/message-models.json .borg-infra/
    [ -f .borg/settings.json ] && cp .borg/settings.json .borg-infra/

    # Perimeter gets a copy of settings (needed for bot token etc)
    [ -f .borg/settings.json ] && cp .borg/settings.json .borg-perimeter/

    # Copy threads.json to root if not already there from .borg
    if [ -f .borg/threads.json ] && [ "$(cat threads.json 2>/dev/null)" = "{}" ]; then
        cp .borg/threads.json ./threads.json
    fi

    echo "[init-zones] Migration complete. Old .borg/ preserved (remove manually when satisfied)."
fi

# ── Set ownership for Docker containers (uid 1000 = node user) ──

chown -R 1000:1000 .borg-core .borg-perimeter .borg-infra threads.json zone-config.json 2>/dev/null || true

echo "[init-zones] Done"
