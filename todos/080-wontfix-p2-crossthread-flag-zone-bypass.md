---
status: wontfix
priority: p2
issue_id: "080"
tags: [code-review, security, zones]
dependencies: []
---

# crossThread Flag Controls Security Gate — Attacker-Controlled Zone Bypass

## Problem Statement

The entire cross-zone approval gate (telegram-client.ts:884) only triggers when `data.crossThread === true`. Any compromised zone container can write an outgoing message without `crossThread: true` and the message is delivered immediately to any thread, bypassing the human approval gate entirely. Zone boundary enforcement relies on an attacker-controlled flag in a file the attacker writes.

## Findings

**Source**: code review of PR #58 "feat(zones): make zones the only deployment mode"

- `telegram-client.ts:884`: Cross-zone approval gate is gated on `data.crossThread === true`
- `src/mcp-tools.ts:115`: The `crossThread` field is set by the zone container itself when writing the outgoing message
- A compromised container (or any zone that deliberately omits the flag) writes `{ targetThreadId: X }` without `crossThread: true`
- `pollOutgoingQueue` picks it up and delivers it directly — no approval check, no zone boundary check
- The flag serves dual purpose (display behavior + security), making the security invariant fragile

## Proposed Solutions

### Option 1: Unconditional zone membership check (Recommended)
Perform the zone membership check on any outgoing message with a `targetThreadId`, regardless of the `crossThread` flag. Re-derive whether approval is needed from the source and target zones (server-side knowledge) rather than trusting the flag.
- Pros: Security gate cannot be bypassed by omitting a flag; `crossThread` becomes a display hint only
- Cons: Slightly more logic in `pollOutgoingQueue`

### Option 2: Derive crossThread server-side
Strip `crossThread` from the message format entirely. In `pollOutgoingQueue`, look up source thread zone and target thread zone. If they differ, route through approval. If same zone, deliver directly.
- Pros: Eliminates the attacker-controlled field
- Cons: Larger refactor; requires `getThreadZone()` to be available in the outgoing queue poll loop

## Acceptance Criteria
- [ ] A zone container that omits `crossThread: true` cannot deliver a message to a different zone without approval
- [ ] Zone boundary determination is derived server-side from thread-to-zone mappings, not from the message payload
- [ ] `crossThread` flag (if kept) controls only Telegram display formatting, not the approval gate
- [ ] Existing approval flow continues to work correctly for legitimate cross-zone messages

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Security gate and display hint were conflated into a single flag; zone trust boundary was not enforced at the receiving end |
