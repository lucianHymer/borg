#!/bin/bash
# Initialize the master thread knowledge-base git repo.
# Idempotent — safe to run multiple times.
#
# Usage: ./scripts/init-knowledge-base.sh

set -euo pipefail

KNOWLEDGE_BASE="${KNOWLEDGE_BASE:-/home/$USER/knowledge-base}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# ─── Idempotency check ──────────────────────────────────────────────────────

if [ -d "$KNOWLEDGE_BASE/.git" ]; then
    log "Knowledge base already initialized at $KNOWLEDGE_BASE"
    log "Checking seed files..."

    cd "$KNOWLEDGE_BASE"
    missing=0
    for f in context.md decisions.md active-projects.md; do
        if [ ! -f "$f" ]; then
            log "WARNING: Missing $f — you may want to recreate it"
            missing=1
        fi
    done

    if [ "$missing" -eq 0 ]; then
        log "All seed files present. Nothing to do."
    fi
    exit 0
fi

# ─── Create directory ────────────────────────────────────────────────────────

log "Creating knowledge base at $KNOWLEDGE_BASE"
mkdir -p "$KNOWLEDGE_BASE"
cd "$KNOWLEDGE_BASE"

# ─── Initialize git repo ─────────────────────────────────────────────────────

git init
log "Git repo initialized"

# ─── Seed context.md ──────────────────────────────────────────────────────────

cat > context.md << 'SEED'
# Organizational Context

## Who We Are

(Describe your team here)

## What We're Building

(Describe your project/product here)

## Team Members

| Name | Role | Telegram | Notes |
|------|------|----------|-------|
| | | | |

## Key Links

- Repository:
- Telegram Group:
- Dashboard:
SEED
log "Seeded context.md"

# ─── Seed decisions.md ────────────────────────────────────────────────────────

cat > decisions.md << 'SEED'
# Decisions Log

Append-only log of key decisions. Each entry records when, what, and why.

Format:
```
### YYYY-MM-DD — Decision title
**Decision:** What was decided
**Rationale:** Why this choice was made
```

---

(Append new decisions below this line)
SEED
log "Seeded decisions.md"

# ─── Seed active-projects.md ─────────────────────────────────────────────────

cat > active-projects.md << 'SEED'
# Active Projects

Status of each repo/thread, updated from daily reports.

## Thread Status

| Thread | Repo | Last Update | Status | Notes |
|--------|------|-------------|--------|-------|
| | | | | |

## Recent Activity

(Updated automatically from worker thread daily summaries)
SEED
log "Seeded active-projects.md"

# ─── Initial commit ──────────────────────────────────────────────────────────

git add -A
git commit -m "Initial knowledge base setup"
log "Initial commit created"

# ─── Instructions ─────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  Knowledge base initialized successfully"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Edit $KNOWLEDGE_BASE/context.md with your team info"
echo "  2. Update threads.json to set master thread cwd:"
echo ""
echo "     Set thread 1 cwd to: $KNOWLEDGE_BASE"
echo ""
echo "     Via Telegram: /setdir 1 $KNOWLEDGE_BASE"
echo "     Via CLI:      ./borg.sh send '/setdir 1 $KNOWLEDGE_BASE'"
echo ""
echo "  3. Restart the bot to pick up changes:"
echo "     ./borg.sh restart bot"
echo ""
