---
status: pending
priority: p2
issue_id: "086"
tags: [code-review, docs, operator-experience]
dependencies: []
---

# init-zones.sh references deleted docker-compose.zones.yml

## Problem Statement

`scripts/init-zones.sh` lines 3 and 44 both reference `docker-compose.zones.yml` which was deleted by this PR (merged into docker-compose.yml). The comment on line 3 and the echo on line 44 both give operators wrong instructions for first-time setup.

## Findings

- scripts/init-zones.sh:3 contains a comment or instruction referencing `docker-compose.zones.yml`
- scripts/init-zones.sh:44 contains an echo statement referencing `docker-compose.zones.yml`
- PR #58 deleted `docker-compose.zones.yml` and merged its content into `docker-compose.yml`
- Operators following the init-zones.sh output will run a command that fails with "no such file"
- This is a first-time setup script, so the error hits new operators on their very first run

## Proposed Solutions

- Change both references to use `docker compose up` (no `-f docker-compose.zones.yml` flag)
- Review the rest of init-zones.sh for any other references to the deleted file

## Acceptance Criteria

- [ ] scripts/init-zones.sh contains no references to `docker-compose.zones.yml`
- [ ] The startup instructions printed by init-zones.sh correctly reflect current compose file structure
- [ ] `docker compose up` (default compose file) is the correct command after init

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Script was not updated when the compose file consolidation happened; stale references in operator-facing scripts are high-impact because they block first-time setup |
