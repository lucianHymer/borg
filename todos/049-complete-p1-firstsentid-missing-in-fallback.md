---
status: complete
priority: p1
issue_id: "049"
tags: [code-review, bug, data-loss]
dependencies: []
---

# Fix `firstSentId` not captured when status message edit fails

## Problem Statement

In `src/telegram-client.ts` `pollOutgoingQueue()`, when a pending message's status edit fails and all chunks are sent as new messages (the "else" branch at line 444), `firstSentId` is never set. This means `logDecision()` is silently skipped for these messages, causing routing decisions to be permanently lost from the routing log.

## Findings

**Location:** `src/telegram-client.ts` lines 444-453

```typescript
} else {
    // No status message or edit failed — send all chunks normally
    for (const chunk of chunks) {
        const sent = await sendInThread(pending, chunk);
        if (data.model) {
            storeMessageModel(sent.message_id, data.model, data.threadId);
            await reactWithModel(pending.chatId, sent.message_id, data.model);
        }
    }
}
```

`firstSentId` is declared at line 369 and only set in other branches:
- Cross-thread path: line 380 ✓
- Status edit success: line 424 ✓
- No pending fallback: line 475 ✓
- Status edit fails + fresh send: **NOT SET** ✗

The guard at line 485 `if (data.routingMetadata && firstSentId)` evaluates to false, and the routing decision is never logged.

**Flagged by:** TypeScript reviewer

## Proposed Solutions

### Solution A: Capture firstSentId in the missing branch (Recommended)
```typescript
} else {
    for (const chunk of chunks) {
        const sent = await sendInThread(pending, chunk);
        if (!firstSentId) firstSentId = sent.message_id;  // ADD THIS
        if (data.model) {
            storeMessageModel(sent.message_id, data.model, data.threadId);
            await reactWithModel(pending.chatId, sent.message_id, data.model);
        }
    }
}
```

- **Pros:** One-line fix, matches pattern used in all other send paths
- **Cons:** None
- **Effort:** Trivial
- **Risk:** None

## Technical Details

**Affected files:** `src/telegram-client.ts` line 446 (add `if (!firstSentId) firstSentId = sent.message_id;`)

## Acceptance Criteria

- [ ] `firstSentId` is captured in ALL send paths within pollOutgoingQueue
- [ ] Routing decisions are logged when status message edit fails
- [ ] Build passes

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-19 | Created from code review | |
