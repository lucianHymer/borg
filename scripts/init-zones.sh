#!/usr/bin/env bash
# Initialize per-zone storage directories for the new .borg-zones/ layout
# (post generic-zones refactor). Called automatically by the Docker init
# service — no manual run required.
# Can also be run directly: bash scripts/init-zones.sh [BASE_DIR]
#
# What this does, in order:
#   1. Migrate old .borg-core / .borg-perimeter siblings into .borg-zones/{core,perimeter}
#      (one-shot, fires only if .borg-zones/ does not yet exist)
#   2. Ensure config files (threads.json, zone-config.json, settings.json,
#      zone-templates.json) exist at the repo root — handling Docker's
#      "mount-missing-file-as-empty-dir" artifact
#   3. For each zone listed in zone-config.json, ensure the per-zone subdir
#      layout exists under .borg-zones/<zone>/, including claude-skills sync
#   4. Ensure .borg-infra/ (the routing layer's own state) has its expected
#      subdirs
#   5. AD7: Ensure ${WORKSPACE_HOST_BASE}/workspace-<zone>/ exists per zone
#      with a loud-fail check if the dir is owned by root (i.e. the user
#      skipped the host-side `mv ~/workspace ~/workspace-core` migration step)
#   6. Migrate single-container .borg/ data (one-shot legacy migration)
#   7. chown -R 1000:1000 the on-disk state so the in-container node user
#      (uid 1000) can read/write it
#
# Idempotent — safe to re-run. All migrations are gated on existence checks.

set -euo pipefail

BASE_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$BASE_DIR"

# Per-zone subdir layout (mirrors pre-refactor ZONE_DIRS exactly)
ZONE_DIRS=(
    queue/incoming queue/outgoing queue/processing queue/dead-letter
    queue/commands queue/cancel queue/tasks queue/task-stop sessions status
    audio audio/incoming images images/incoming
    logs persistent
)

INFRA_DIRS=(queue/pending queue/outgoing logs)

# ── Section 2: Migrate old .borg-core / .borg-perimeter → .borg-zones/ (one-shot) ──

if { [ -d .borg-core ] || [ -d .borg-perimeter ]; } && [ ! -d .borg-zones ]; then
    echo "[init-zones] Detected old .borg-{core,perimeter}/ — migrating to .borg-zones/"
    mkdir -p .borg-zones
    [ -d .borg-core ] && mv .borg-core .borg-zones/core
    [ -d .borg-perimeter ] && mv .borg-perimeter .borg-zones/perimeter
    echo "[init-zones] Migration complete"
fi

# ── Section 3: Ensure shared config files exist ──

# Handle Docker's "create directory for missing file mount" quirk:
# If any of these are empty directories, remove them first so we can create
# the file in their place.
for f in threads.json zone-config.json settings.json zone-templates.json; do
    if [ -d "$f" ] && [ -z "$(ls -A "$f" 2>/dev/null)" ]; then
        rmdir "$f"
        echo "[init-zones] Removed empty directory $f (Docker mount artifact)"
    fi
done

# zone-templates.json is the source-of-truth file — must exist in the repo.
# If missing, something is very wrong (e.g. a partial checkout).
if [ ! -f zone-templates.json ]; then
    echo "FATAL: zone-templates.json is missing." >&2
    echo "This file is the repo's source of truth for zone container templates." >&2
    echo "Restore it from the repo (e.g. git checkout zone-templates.json) and re-run." >&2
    exit 1
fi

if [ ! -f zone-config.json ]; then
    if [ -f zone-config.example.json ]; then
        cp zone-config.example.json zone-config.json
        echo "[init-zones] Created zone-config.json from example"
    else
        cat > zone-config.json << 'ZEOF'
{
  "zones": {
    "core": { "threads": [], "template": "trusted" },
    "perimeter": { "threads": [], "template": "untrusted" }
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

# Create shared settings.json if missing. Try infra zone first (has bot token),
# then core zone, then fall back to empty object.
if [ ! -f settings.json ]; then
    if [ -f .borg-infra/settings.json ]; then
        cp .borg-infra/settings.json settings.json
        echo "[init-zones] Created settings.json from .borg-infra/settings.json"
    elif [ -f .borg-zones/core/settings.json ]; then
        cp .borg-zones/core/settings.json settings.json
        echo "[init-zones] Created settings.json from .borg-zones/core/settings.json"
    else
        echo "{}" > settings.json
        echo "[init-zones] Created empty settings.json"
    fi
fi

# ── Section 4: Ensure per-zone dirs (dynamic, driven by zone-config.json) ──

# Use node (available in the dashboard image) to parse zone names from
# zone-config.json — avoids a jq dependency.
zone_names() {
    node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync("zone-config.json","utf8")); console.log(Object.keys(c.zones).join("\n"))'
}

# Snapshot the list once so we can iterate twice (per-zone dirs + AD7 workspace check)
ZONE_LIST=()
while IFS= read -r z; do
    [ -n "$z" ] && ZONE_LIST+=("$z")
done < <(zone_names)

if [ "${#ZONE_LIST[@]}" -eq 0 ]; then
    echo "[init-zones] WARN: zone-config.json has no zones defined" >&2
fi

mkdir -p .borg-zones

for zone in "${ZONE_LIST[@]}"; do
    zone_root=".borg-zones/${zone}"
    for dir in "${ZONE_DIRS[@]}"; do
        mkdir -p "${zone_root}/${dir}"
    done
    touch "${zone_root}/message-history.jsonl"

    # Claude Code user settings (MCP tools, etc.) — per-zone to isolate secrets.
    # Handle Docker's directory-for-missing-file mount quirk.
    if [ -d "${zone_root}/claude-settings.json" ]; then
        rmdir "${zone_root}/claude-settings.json" 2>/dev/null || true
    fi
    [ -f "${zone_root}/claude-settings.json" ] || echo '{}' > "${zone_root}/claude-settings.json"

    # Claude Code skills — persistent (writable by agents) + refreshed from
    # repo on each startup. NB: this overwrites zone-local skill edits;
    # see AD8 item 8 in the plan for the known-behavior flag.
    mkdir -p "${zone_root}/claude-skills"
    if [ -d skills/global ]; then
        cp -rf skills/global/. "${zone_root}/claude-skills/" 2>/dev/null || true
    fi
done

# Infra (routing layer) is NOT a zone — keep it as a sibling, not under .borg-zones/
for dir in "${INFRA_DIRS[@]}"; do
    mkdir -p ".borg-infra/${dir}"
done
touch ".borg-infra/message-history.jsonl"
[ -f ".borg-infra/message-models.json" ] || echo '{}' > ".borg-infra/message-models.json"

echo "[init-zones] Per-zone directories ready (${#ZONE_LIST[@]} zones)"

# ── Section 5: AD7 — per-zone host workspace dirs with LOUD-FAIL check ──

# Only run when the host workspace base is mounted into this container.
# In production this is /host-workspaces (per docker-compose init service
# mount: ${WORKSPACE_HOST_BASE}:/host-workspaces). If the mount is absent
# (e.g. when invoked manually from a dev box), skip — log a hint so the
# operator knows.
WORKSPACE_MOUNT="${WORKSPACE_MOUNT:-/host-workspaces}"

if [ -d "$WORKSPACE_MOUNT" ]; then
    for zone in "${ZONE_LIST[@]}"; do
        ws_path="${WORKSPACE_MOUNT}/workspace-${zone}"
        if [ ! -d "$ws_path" ]; then
            mkdir -p "$ws_path"
        fi

        # If Docker auto-created the parent dir AS ROOT before we got here, OR
        # if mkdir produced a root-owned dir, the user SKIPPED the host-side
        # mv ~/workspace ~/workspace-core step. Fail loud.
        owner_uid="$(stat -c '%u' "$ws_path")"
        if [ "$owner_uid" -ne 1000 ]; then
            echo "FATAL: $ws_path is owned by uid $owner_uid (expected 1000)." >&2
            echo "This usually means you skipped the host-side migration step:" >&2
            echo "  On the host:  mv ~/workspace ~/workspace-${zone}" >&2
            echo "                sudo chown -R 1000:1000 ~/workspace-${zone}" >&2
            echo "See docs/plans/2026-05-19-feat-generic-zones-plan.md (AD7, Migration Plan)." >&2
            exit 1
        fi

        # Best-effort chown (no-op if already 1000:1000)
        chown 1000:1000 "$ws_path" 2>/dev/null || true
    done
    echo "[init-zones] Per-zone host workspaces verified (${WORKSPACE_MOUNT})"
else
    echo "[init-zones] Skipping AD7 workspace check (no $WORKSPACE_MOUNT mount)"
fi

# ── Section 6: Legacy migration from single-container .borg/ (one-shot) ──

if [ -d .borg ] && [ -f .borg/settings.json ] && [ ! -f .borg-zones/core/settings.json ]; then
    echo "[init-zones] Detected legacy .borg/ directory — migrating to .borg-zones/..."

    mkdir -p .borg-zones/core .borg-zones/perimeter .borg-infra

    # Core gets the main data (most threads are typically core)
    for f in message-history.jsonl settings.json heartbeat-state.json \
             markdown-parse-failures.jsonl voice-transcripts.json \
             task-lists.json task-pins.json; do
        [ -f ".borg/$f" ] && cp ".borg/$f" ".borg-zones/core/$f"
    done

    # Sessions
    if [ -d .borg/sessions ] && [ -n "$(ls -A .borg/sessions/ 2>/dev/null)" ]; then
        mkdir -p .borg-zones/core/sessions
        cp .borg/sessions/* .borg-zones/core/sessions/
    fi

    # Persistent data
    if [ -d .borg/persistent ] && [ -n "$(ls -A .borg/persistent/ 2>/dev/null)" ]; then
        mkdir -p .borg-zones/core/persistent
        cp -r .borg/persistent/* .borg-zones/core/persistent/
    fi

    # Infra gets message-models and settings (needed for bot token)
    [ -f .borg/message-models.json ] && cp .borg/message-models.json .borg-infra/
    [ -f .borg/settings.json ] && cp .borg/settings.json .borg-infra/

    # Perimeter gets a copy of settings (needed for bot token etc)
    [ -f .borg/settings.json ] && cp .borg/settings.json .borg-zones/perimeter/

    # Copy threads.json to root if not already there from .borg
    if [ -f .borg/threads.json ] && [ "$(cat threads.json 2>/dev/null)" = "{}" ]; then
        cp .borg/threads.json ./threads.json
    fi

    echo "[init-zones] Legacy migration complete. Old .borg/ preserved (remove manually when satisfied)."
fi

# ── Section 7: chown final ──

chown -R 1000:1000 .borg-zones .borg-infra threads.json zone-config.json zone-templates.json 2>/dev/null || true

# ── Section 8: Loud OK message ──

if [ "${#ZONE_LIST[@]}" -gt 0 ]; then
    printf '[init-zones] done — zones ensured: %s\n' "$(IFS=,; echo "${ZONE_LIST[*]}")"
else
    echo "[init-zones] done — no zones configured"
fi
