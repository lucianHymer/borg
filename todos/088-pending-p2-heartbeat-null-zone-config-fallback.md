---
status: complete
priority: p2
issue_id: "088"
tags: [code-review, correctness, heartbeat]
dependencies: []
---

# Null zone-config fallback causes double heartbeats in zones-only mode

## Problem Statement

In queue-processor.ts:1500-1502, if `zoneConfig` is null (zone-config.json missing), all threads get heartbeated by every zone queue-processor. With two zone processors running, every thread receives double heartbeats silently. In zones-only mode, zone-config.json should always be present. The null fallback masks misconfiguration.

## Findings

- queue-processor.ts:1500-1502 falls back to heartbeating all threads when `zoneConfig` is null
- In zones-only mode, two queue-processor instances run (one per zone)
- If zone-config.json is missing or fails to parse, both instances will fall back to processing all threads
- This results in every thread receiving two heartbeats per interval with no error logged
- Double heartbeats can cause duplicate task execution, confusing agent state, and doubled external API calls
- In zones-only mode, zone-config.json being absent is always a misconfiguration, not a normal operating mode

## Proposed Solutions

- In zones-only mode, throw an error or call `process.exit(1)` when zone-config.json cannot be loaded, rather than silently falling back
- At minimum, emit a loud `console.error` warning with clear instructions when zone-config is null so operators see it in logs
- Add a startup validation step that asserts zone-config.json is present and valid before starting the heartbeat loop

## Acceptance Criteria

- [x] Missing or invalid zone-config.json in zones-only mode produces a visible error, not silent fallback
- [x] Double heartbeat scenario cannot occur due to null zone-config fallback
- [x] Error message clearly states what file is missing and how to fix it

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Silent fallbacks that mask misconfiguration are especially dangerous in multi-process scenarios where the fallback behavior compounds across instances |
| 2026-03-11 | Fixed: replaced silent fallback with early-return + console.error in runHeartbeatCycle() | Added explanatory comment about why null fallback is dangerous in multi-zone mode |
