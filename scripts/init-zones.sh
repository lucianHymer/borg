#!/usr/bin/env bash
# Initialize per-zone storage directories for security zones.
# Run once before first `docker compose -f docker-compose.yml -f docker-compose.zones.yml up`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "Initializing zone storage directories..."

# Per-zone queue and data directories
for zone in core perimeter; do
    for dir in queue/incoming queue/outgoing queue/processing queue/dead-letter queue/commands sessions status audio images logs; do
        mkdir -p ".borg-${zone}/${dir}"
    done
    # Initialize empty message history if not exists
    touch ".borg-${zone}/message-history.jsonl"
    echo "  Created .borg-${zone}/"
done

# Infra directories
for dir in queue/pending logs; do
    mkdir -p ".borg-infra/${dir}"
done
touch ".borg-infra/message-models.json"
echo "  Created .borg-infra/"

# Create zone-config.json if not exists
if [ ! -f zone-config.json ]; then
    cp zone-config.example.json zone-config.json
    echo "  Created zone-config.json from example"
fi

# Create shared threads.json if not exists (at project root for bind-mount)
if [ ! -f threads.json ]; then
    echo "{}" > threads.json
    echo "  Created threads.json"
fi

# Set ownership to node user (uid 1000) for Docker containers
chown -R 1000:1000 .borg-core .borg-perimeter .borg-infra 2>/dev/null || true

echo "Zone storage initialized. Ready for: docker compose -f docker-compose.yml -f docker-compose.zones.yml up"
