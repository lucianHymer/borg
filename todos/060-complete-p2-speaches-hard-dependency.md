---
status: complete
priority: p2
issue_id: "060"
tags: [code-review, architecture, docker, voice]
dependencies: []
---

# Hard Speaches dependency blocks bot startup

## Problem Statement

In `docker-compose.yml`, the bot has `depends_on: speaches: condition: service_healthy`. The speaches healthcheck (30s interval, 3 retries) means up to 90s before the bot can start. If speaches fails (model download issues, OOM with 4G limit), the entire bot is blocked — including all text-based functionality.

## Findings

- Found by Code Simplicity Reviewer and Architecture Strategist
- Voice is supplementary; shouldn't block core text bot
- The STT path already handles speaches unavailability gracefully (error message to user)
- `isAvailable()` health check exists in audio.ts for runtime degradation

## Proposed Solutions

### Option A: Change to service_started (Recommended)
Use `condition: service_started` instead of `service_healthy`. Runtime code already degrades gracefully.
- Effort: Trivial
- Risk: Low — first voice message after startup may fail if speaches isn't ready yet

### Option B: Remove dependency entirely
Remove speaches from depends_on. Bot starts independently.
- Effort: Trivial
- Risk: Low

## Technical Details

- **Affected files:** `docker-compose.yml` lines 32-33

## Acceptance Criteria

- [ ] Bot starts even if speaches is unhealthy
- [ ] Text messaging works without speaches
- [ ] Voice features degrade gracefully when speaches is unavailable
