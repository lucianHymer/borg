---
status: complete
priority: p2
issue_id: "072"
tags: [code-review, duplication, quality]
dependencies: ["071"]
---

# Deduplicate /clear_team and /compact_team handlers

## Problem Statement

The `/clear_team` (lines 323-349) and `/compact_team` (lines 352-378) command handlers are structurally identical (~55 lines total) with only the command name, message ID prefix, and reply text differing. This violates DRY and creates maintenance risk if one is updated but not the other.

## Findings

- **Location:** `src/telegram-client.ts:323-378`
- **Differences:** command text (`/clear` vs `/compact`), prefix (`clear_` vs `compact_`), reply text
- **Also missing:** `senderId` field (present in standard message handler at line 429) and `message_thread_id` in replies (see todo 071)

## Proposed Solutions

### Option A: Extract helper function (Recommended)
```typescript
async function queueTeamCommand(ctx: Context, command: string): Promise<void> {
    // shared implementation
}
bot.command("clear_team", (ctx) => queueTeamCommand(ctx, "clear"));
bot.command("compact_team", (ctx) => queueTeamCommand(ctx, "compact"));
```
- **Effort:** Small (~25 LOC reduction)
- **Risk:** None

## Acceptance Criteria

- [ ] Single shared implementation for both commands
- [ ] Both commands still work correctly
- [ ] Replies include `message_thread_id`

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-06 | Created from code review of commit 8117970 | Extract helpers when two handlers differ by only 1-2 parameters |
