---
status: wontfix
priority: p2
issue_id: "085"
tags: [code-review, architecture, routing]
dependencies: []
---

# create_thread initial message bypasses zone routing, delivered to wrong zone queue

## Problem Statement

`create_thread` in mcp-tools.ts writes `initialMessage` directly to `QUEUE_INCOMING` (the local zone's queue) at line 736, bypassing zone routing entirely. Since new threads default to the `perimeter` zone but core agents call `create_thread`, initial messages to perimeter-zone threads are deposited into core's queue instead. The perimeter thread never receives it.

## Findings

- mcp-tools.ts:724-741: after creating the thread, if `initialMessage` is provided it is written to `QUEUE_INCOMING` which resolves to the calling zone's incoming queue directory
- New threads are assigned to `perimeter` zone by default
- When a core agent calls `create_thread` with an `initialMessage` for a perimeter thread, the message lands in core's queue
- Core's queue-processor picks up the message and routes it to a core session, not the newly created perimeter thread
- The `send_message` tool correctly uses the cross-thread outgoing queue pattern so infra can route across zones; `create_thread`'s initial message does not

## Proposed Solutions

- Write the `initialMessage` using the same `crossThread: true` outgoing queue entry pattern as `send_message`, writing to the outgoing queue with `targetThreadId` set so infra picks it up and delivers it to the correct zone
- Alternatively, after thread creation, call the `send_message` logic internally rather than writing directly to `QUEUE_INCOMING`

## Acceptance Criteria

- [ ] `create_thread` with `initialMessage` delivers the message to the new thread regardless of which zone the new thread is in
- [ ] Initial message delivery goes through zone routing, not the calling zone's local queue
- [ ] No regression for same-zone thread creation

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | The bug only manifests in multi-zone mode; the pre-zones single-queue setup never exposed this because all threads shared one queue |
