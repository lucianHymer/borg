---
status: complete
priority: p1
issue_id: "071"
tags: [code-review, bug, telegram]
dependencies: []
---

# /clear_team and /compact_team replies go to wrong thread

## Problem Statement

The `/clear_team` and `/compact_team` command handlers do not pass `message_thread_id` in their reply calls. In a Telegram forum group, this causes the reply to appear in the General topic instead of the forum topic where the command was issued. The existing `/reset` and `/setdir` commands correctly pass this parameter.

## Findings

- **Location:** `src/telegram-client.ts:329,348,359,377`
- **Pattern violation:** `/reset` (line 298) and `/setdir` (line 317) both use `{ message_thread_id: ctx.msg.message_thread_id }`
- **New commands omit this:** Both the error reply ("This thread isn't part of a team.") and the success reply
- **Impact:** User confusion — replies appear in wrong topic

## Proposed Solutions

### Option A: Add message_thread_id to all reply calls (Recommended)
```typescript
await ctx.reply("...", { message_thread_id: ctx.msg.message_thread_id, parse_mode: "Markdown" });
```
- **Effort:** Small (4 lines to change)
- **Risk:** None

## Acceptance Criteria

- [ ] `/clear_team` reply appears in the same forum topic where command was issued
- [ ] `/compact_team` reply appears in the same forum topic where command was issued
- [ ] Error reply ("not part of a team") appears in correct topic

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-06 | Created from code review of commit 8117970 | Always check existing command patterns when adding new Telegram commands |
