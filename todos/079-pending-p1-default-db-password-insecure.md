---
status: complete
priority: p1
issue_id: "079"
tags: [code-review, security, docker, sidecar-services]
dependencies: []
---

# Default database password allows silent deployment with trivial credentials

## Problem Statement

`docker-compose.services.yml` uses `${CLAIRVOYANT_DB_PASSWORD:-clairvoyant}` which defaults to the trivial password `clairvoyant` if the env var is unset. Since `.env.example` ships the variable commented out, the default path for anyone who enables sidecar services without setting the password is a database with username=password=dbname all equal to `clairvoyant`. Every container on the `internal` network can reach this database.

## Findings

- **Location:** `docker-compose.services.yml` lines 21, 46
- **Source:** Security sentinel (Critical), Deployment verification (confirmed)
- **Risk:** Any compromised container on the internal network gets full DB access with a guessable password

## Proposed Solutions

### Option A: Fail fast with required variable (Recommended)
Use Docker Compose's required variable syntax:
```yaml
POSTGRES_PASSWORD=${CLAIRVOYANT_DB_PASSWORD:?CLAIRVOYANT_DB_PASSWORD must be set}
```
- **Pros:** Impossible to deploy with weak default; clear error message
- **Cons:** Slightly more friction for local dev
- **Effort:** Small
- **Risk:** Low

### Option B: Generate random password at init time
Have `init-zones.sh` generate a random password and write to a file, use Docker secrets.
- **Pros:** Zero-config secure setup
- **Cons:** More complex, needs secret file management
- **Effort:** Medium
- **Risk:** Low

## Acceptance Criteria

- [ ] Cannot start sidecar services without explicitly setting `CLAIRVOYANT_DB_PASSWORD`
- [ ] Clear error message if variable is missing
- [ ] `.env.example` documents the requirement

## Work Log

| Date | Action |
|------|--------|
| 2026-03-30 | Created from code review of sidecar services commit |
