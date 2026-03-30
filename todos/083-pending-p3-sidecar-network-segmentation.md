---
status: pending
priority: p3
issue_id: "083"
tags: [code-review, security, architecture, sidecar-services]
dependencies: []
---

# No network segmentation between sidecar DB and Borg services

## Problem Statement

Both `clairvoyant-db` and `clairvoyant` join the `internal` network, making the postgres database reachable from every Borg container. Only the `clairvoyant` service needs DB access. A dedicated sidecar network would limit blast radius.

## Findings

- **Location:** `docker-compose.services.yml`
- **Source:** Security sentinel (Low), Deployment verification (noted)
- **Note:** Consistent with existing architecture where all services share `internal`

## Proposed Solutions

### Option A: Add a dedicated sidecar network
```yaml
networks:
  sidecar:
    internal: true

# clairvoyant-db on sidecar only
# clairvoyant on both sidecar and internal
```
- **Pros:** DB only reachable by clairvoyant; reduced blast radius
- **Cons:** Adds network complexity; diverges from current flat architecture
- **Effort:** Small
- **Risk:** Low

### Option B: Accept current flat architecture
Keep everything on `internal`. Rely on DB password strength (todo 079) as the control.
- **Pros:** Simple; consistent with existing pattern
- **Cons:** Larger blast radius
- **Effort:** None
- **Risk:** Low (if password is strong)

## Acceptance Criteria

- [ ] Decision made: segment or accept flat architecture
- [ ] If segmented: clairvoyant-db only reachable from clairvoyant container

## Work Log

| Date | Action |
|------|--------|
| 2026-03-30 | Created from code review of sidecar services commit |
