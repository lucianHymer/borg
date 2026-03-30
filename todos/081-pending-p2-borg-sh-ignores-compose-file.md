---
status: complete
priority: p2
issue_id: "081"
tags: [code-review, architecture, sidecar-services]
dependencies: []
---

# borg.sh hardcodes COMPOSE_FILE, ignoring .env setting

## Problem Statement

`borg.sh` hardcodes `COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"` at line 8 and passes it to the `dc()` helper. Setting `COMPOSE_FILE` in `.env` (as documented in `.env.example`) has no effect when using `borg.sh start/stop/restart/status/logs`. Users who manage the stack via `borg.sh` will never bring up sidecar services.

## Findings

- **Location:** `borg.sh` line 8
- **Source:** Architecture strategist (Moderate)
- **Impact:** The documented activation path for sidecar services doesn't work through borg.sh

## Proposed Solutions

### Option A: Check environment before defaulting (Recommended)
```bash
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"
```
- **Pros:** Simple one-line fix; respects both env var and .env file
- **Cons:** None
- **Effort:** Small
- **Risk:** Low

### Option B: Source .env file in borg.sh
Add `source "$SCRIPT_DIR/.env" 2>/dev/null` before the COMPOSE_FILE assignment.
- **Pros:** Picks up all .env vars automatically
- **Cons:** Could have side effects from other .env vars
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] `borg.sh start` respects `COMPOSE_FILE` from `.env` or environment
- [ ] Default behavior unchanged when `COMPOSE_FILE` is not set

## Work Log

| Date | Action |
|------|--------|
| 2026-03-30 | Created from code review of sidecar services commit |
