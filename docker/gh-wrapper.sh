#!/bin/bash
set -euo pipefail
# gh CLI wrapper — authenticates via credential broker before each call
# Installed as /usr/local/bin/gh-authenticated, or can replace /usr/bin/gh

# Resolve org (= installation) for this invocation. Order:
#   1. Explicit owner sniffed from args (--repo, -R, github.com URL,
#      /repos/OWNER/REPO api path, or repo:OWNER/REPO query). Without this,
#      cross-org calls like `gh pr view --repo OTHER/REPO` from a cwd in a
#      different org silently 404 with the wrong installation token.
#   2. cwd git remote.
#   3. $GH_DEFAULT_ORG.
#   4. First org in installations.json.
ORG=""
for ((i=1; i<=$#; i++)); do
    arg="${!i}"
    if [[ ( "$arg" == "--repo" || "$arg" == "-R" ) && $((i+1)) -le $# ]]; then
        next="${@:$((i+1)):1}"
        [[ "$next" =~ ^([^/]+)/[^/]+$ ]] && ORG="${BASH_REMATCH[1]}" && break
    elif [[ "$arg" =~ ^(--repo|-R)=([^/]+)/[^/]+$ ]]; then
        ORG="${BASH_REMATCH[2]}"; break
    elif [[ "$arg" =~ ^https?://github\.com/([^/]+)/ ]]; then
        ORG="${BASH_REMATCH[1]}"; break
    elif [[ "$arg" =~ ^/?repos/([^/]+)/[^/]+ ]]; then
        ORG="${BASH_REMATCH[1]}"; break
    elif [[ "$arg" =~ repo:([^/[:space:]]+)/[^/[:space:]]+ ]]; then
        ORG="${BASH_REMATCH[1]}"; break
    fi
done
# Only honor a parsed org if it has an installation; otherwise fall through.
if [ -n "$ORG" ] && ! jq -e --arg org "$ORG" '.[$org]' /secrets/github-installations.json >/dev/null 2>&1; then
    ORG=""
fi

if [ -z "$ORG" ] && command -v git &>/dev/null && git rev-parse --git-dir &>/dev/null; then
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
