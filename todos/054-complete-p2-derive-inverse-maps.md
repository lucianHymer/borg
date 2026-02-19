---
status: complete
priority: p2
issue_id: "054"
tags: [code-review, maintenance]
dependencies: []
---

# Derive EMOJI_TO_MODEL from MODEL_REACTIONS and hoist VALID_MODELS

## Problem Statement

`EMOJI_TO_MODEL` and `MODEL_REACTIONS` in `src/telegram-client.ts` are exact inverses maintained independently. `VALID_MODELS` is created as a new Set on every reaction event inside the handler.

## Proposed Solutions

```typescript
const MODEL_REACTIONS: Record<string, string> = { haiku: "⚡", sonnet: "✍", opus: "🔥" };
const EMOJI_TO_MODEL = Object.fromEntries(
    Object.entries(MODEL_REACTIONS).map(([model, emoji]) => [emoji, model]),
);
const VALID_MODELS = new Set(Object.keys(MODEL_REACTIONS));
```

- **Effort:** Trivial
- **Risk:** None

## Acceptance Criteria

- [ ] One source of truth for emoji↔model mapping
- [ ] VALID_MODELS hoisted to module scope, derived from mapping
- [ ] Build passes

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-19 | Created from code review | |
