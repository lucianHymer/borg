---
status: complete
priority: p1
issue_id: "056"
tags: [code-review, security, docker, voice]
dependencies: []
---

# Speaches port exposed on all interfaces

## Problem Statement

In `docker-compose.yml`, the speaches service binds port 8000 to all interfaces (`"8000:8000"`), exposing the unauthenticated Speaches API (STT and TTS) to the entire network. Compare with the dashboard which correctly binds to localhost only (`"127.0.0.1:3100:3100"`).

The bot accesses speaches via the Docker internal network (`http://speaches:8000`), so the host port binding is unnecessary.

## Findings

- Found by Security Sentinel and Architecture Strategist
- Anyone on the network can submit audio for transcription or generate speech
- Resource exhaustion possible by external actors

## Proposed Solutions

### Option A: Bind to localhost only (Recommended)
Change `"8000:8000"` to `"127.0.0.1:8000:8000"`.
- Effort: Trivial (one-line fix)
- Risk: None

### Option B: Remove port mapping entirely
Remove the `ports:` section since the bot uses the internal Docker network.
- Effort: Trivial
- Risk: Loses ability to debug speaches from host

## Technical Details

- **Affected files:** `docker-compose.yml` line 115-116

## Acceptance Criteria

- [ ] Port 8000 is not accessible from external network interfaces
- [ ] Bot can still reach speaches via internal Docker network
