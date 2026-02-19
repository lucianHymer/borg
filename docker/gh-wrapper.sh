#!/bin/bash
set -euo pipefail
# gh CLI wrapper — authenticates via credential broker before each call
# Installed as /usr/local/bin/gh-authenticated, or can replace /usr/bin/gh

# Auto-detect org from git remote in current directory (same approach as
# github-token-helper.sh uses for git operations). Falls back to
# GH_DEFAULT_ORG or the first org in installations.json.
ORG=""
if command -v git &>/dev/null && git rev-parse --git-dir &>/dev/null; then
    REMOTE_URL=$(git remote get-url origin 2>/dev/null || true)
    if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/ ]]; then
        ORG="${BASH_REMATCH[1]}"
    fi
fi

if [ -z "$ORG" ]; then
    ORG="${GH_DEFAULT_ORG:-}"
fi

if [ -z "$ORG" ]; then
    ORG=$(jq -r 'keys[0] // empty' /secrets/github-installations.json 2>/dev/null || true)
fi

if [ -z "$ORG" ]; then
    echo "Error: No GitHub org configured (no git remote, GH_DEFAULT_ORG, or github-installations.json)" >&2
    exit 1
fi

INSTALL_ID=$(jq -r --arg org "$ORG" '.[$org] // empty' /secrets/github-installations.json 2>/dev/null)
if [ -z "$INSTALL_ID" ]; then
    echo "Error: No installation ID for org '$ORG'" >&2
    exit 1
fi

RESULT=$(curl -sf --connect-timeout 5 --max-time 10 \
    -H "Authorization: Bearer $BROKER_SECRET" \
    "${CREDENTIAL_BROKER_URL:-http://broker:3000}/token?installation_id=$INSTALL_ID")
TOKEN=$(echo "$RESULT" | jq -r '.token // empty')

if [ -z "$TOKEN" ]; then
    echo "Error: Failed to get token from credential broker" >&2
    exit 1
fi

GH_TOKEN="$TOKEN" exec /usr/bin/gh-real "$@"
