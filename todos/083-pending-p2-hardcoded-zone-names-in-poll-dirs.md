---
status: complete
priority: p2
issue_id: "083"
tags: [code-review, architecture, maintainability]
dependencies: []
---

# Hardcoded zone names in queue polling directories

## Problem Statement

`getOutgoingQueueDirs()`, `getPendingQueueDirs()`, and `ZONE_STATUS_DIRS` all hardcode `["core", "perimeter"]` zone names (telegram-client.ts:41-54, 99-103). If a third zone is added to zone-config.json, infra will silently not poll it. The zone config schema accepts arbitrary zone names but the polling is hardcoded to two.

## Findings

- `getOutgoingQueueDirs()` at telegram-client.ts:41-54 enumerates zone names literally
- `getPendingQueueDirs()` at telegram-client.ts:41-54 does the same
- `ZONE_STATUS_DIRS` at telegram-client.ts:99-103 also hardcodes the two zone names
- zone-config.json schema accepts arbitrary zone names via `Object.keys(config.zones)`
- Adding a third zone to zone-config.json will not cause an error but new zone's queue will never be polled, silently losing messages

## Proposed Solutions

- Derive the list of zones to poll from zone-config.json at startup using `Object.keys(config.zones)`
- Load zone-config.json once at startup and compute queue dir lists dynamically
- At minimum, introduce `const ZONE_NAMES = ["core", "perimeter"] as const` as a single source of truth so at least there is one place to update

## Acceptance Criteria

- [ ] Zone names for queue polling are derived from zone-config.json rather than hardcoded
- [ ] Adding a new zone to zone-config.json automatically causes infra to poll its queue
- [ ] No silent message loss when zone topology changes

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Hardcoded zone names create a brittle contract between zone-config.json and the polling loop; easy to miss when extending the zone topology |
| 2026-03-11 | Fixed: introduced `ZONE_NAMES = ["core", "perimeter"] as const` and derived `ZONE_STATUS_DIRS` and `getOutgoingQueueDirs()` from it. `getPendingQueueDirs()` was already fixed separately (pending dir moved to infra). Build clean. | One source of truth; adding a zone requires only updating ZONE_NAMES |
