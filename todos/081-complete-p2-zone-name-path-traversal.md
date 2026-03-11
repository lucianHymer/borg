---
status: complete
priority: p2
issue_id: "081"
tags: [code-review, security, path-traversal]
dependencies: []
---

# Zone Name and pendingId Used in Path Construction Without Validation

## Problem Statement

`resolveZoneIncoming(targetZone)` and `resolveZoneOutgoing(targetZone)` use zone names directly in `path.join` without validation (telegram-client.ts:71-80). `targetZone` comes from pending files deserialized from disk. An attacker with write access to any pending queue directory can set `targetZone: "../../../etc"` to write files anywhere on the filesystem. Similarly, `pendingId` from Telegram callback data (telegram-client.ts:1668) is used in path construction without validation against a safe character set.

## Findings

**Source**: code review of PR #58 "feat(zones): make zones the only deployment mode"

- `telegram-client.ts:71-80`: `resolveZoneIncoming(targetZone)` and `resolveZoneOutgoing(targetZone)` use `targetZone` directly in `path.join` — no allowlist, no character validation
- `targetZone` is read from a pending file on disk; the pending queue dirs are writable by zone containers
- A malicious or compromised container writes `{ targetZone: "../../../etc/cron.d" }` — `resolveZoneIncoming` resolves to an arbitrary filesystem path
- `telegram-client.ts:1668`: `pendingId` is extracted from Telegram callback_data and used directly in a file path — a crafted callback_data with `../` sequences could escape the pending directory
- `src/zone-config.ts` ZoneConfigSchema: zone name field has no regex constraint

## Proposed Solutions

### Option 1: Validate at schema + point of use (Recommended)
1. Add `z.string().regex(/^[a-z0-9-]+$/)` to the zone name field in `ZoneConfigSchema` — rejects malformed zone names at parse time.
2. Add the same validation in `resolveZoneIncoming`/`resolveZoneOutgoing` before `path.join` — defense in depth for values sourced from pending files.
3. Validate `pendingId` against `/^[a-zA-Z0-9_-]+$/` immediately after extracting from callback_data, before any path construction.

### Option 2: Re-derive zone from threadId
Instead of trusting the stored `targetZone` string, re-derive the zone from the threadId using `getThreadZone()` (server-side authoritative lookup). Eliminates the attacker-controlled input entirely for zone path resolution.
- Pros: Removes the attack surface at the source
- Cons: Requires `getThreadZone()` to be available at the approval handling callsite; `pendingId` still needs independent validation

## Acceptance Criteria
- [ ] `ZoneConfigSchema` rejects zone names that do not match `/^[a-z0-9-]+$/`
- [ ] `resolveZoneIncoming` and `resolveZoneOutgoing` validate the zone name before path construction and throw on invalid input
- [ ] `pendingId` from callback_data is validated against a safe character set before use in any path operation
- [ ] Unit tests cover path traversal attempts (`../`, absolute paths, null bytes) for all three inputs
- [ ] No regression in normal zone routing behavior

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Zone name and callback pendingId were treated as trusted strings despite coming from partially attacker-controlled sources |
