---
status: complete
priority: p2
issue_id: "050"
tags: [code-review, maintenance, grammy]
dependencies: []
---

# Replace hardcoded ALLOWED_UPDATES with grammY's API_CONSTANTS

## Problem Statement

`src/telegram-client.ts` hardcodes a 20-entry `ALLOWED_UPDATES` array with a comment claiming "grammy doesn't re-export DEFAULT_UPDATE_TYPES from public API." This is incorrect — the simplicity reviewer confirmed grammY exports `API_CONSTANTS.DEFAULT_UPDATE_TYPES` and `API_CONSTANTS.ALL_UPDATE_TYPES` from its public API. The hardcoded array will silently go stale when grammY adds new update types.

## Findings

**Location:** `src/telegram-client.ts` lines 312-322

The plan explicitly said to use: `import { DEFAULT_UPDATE_TYPES } from "grammy"` and `[...DEFAULT_UPDATE_TYPES, "message_reaction"]`.

grammY exports via `API_CONSTANTS`:
- `API_CONSTANTS.DEFAULT_UPDATE_TYPES` — excludes message_reaction
- `API_CONSTANTS.ALL_UPDATE_TYPES` — includes message_reaction

**Flagged by:** TypeScript reviewer, Architecture strategist, Code simplicity reviewer

## Proposed Solutions

### Solution A: Use API_CONSTANTS from grammY (Recommended)
```typescript
import { API_CONSTANTS } from "grammy";
// Remove ALLOWED_UPDATES constant entirely
bot.start({
    allowed_updates: [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, "message_reaction"],
    // ...
});
```

- **Effort:** Small
- **Risk:** Low — verify types work without `as any` cast

## Acceptance Criteria

- [ ] Hardcoded ALLOWED_UPDATES array removed
- [ ] Using grammY's exported constants
- [ ] Build passes
- [ ] `as any` cast eliminated or minimized

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-19 | Created from code review | |
