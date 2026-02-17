---
status: complete
priority: p2
issue_id: "043"
tags: [code-review, typescript, data-integrity]
---
# loadHeartbeatState Does Not Reset Cache on Zod Validation Failure

## Problem Statement
When `HeartbeatStateSchema.safeParse()` fails in `loadHeartbeatState()`, the function returns `{}` but does NOT reset `heartbeatStateCache` or `heartbeatStateMtime`. This means the stale cache and its mtime remain set. On the next call, if the file mtime has not changed, the stale cached value will be returned instead of re-parsing — creating an inconsistent state where consecutive calls for the same file return different data.

## Findings
- **Source:** TypeScript Reviewer (Issue #2), Performance Oracle (Item 7 — confirmed intentional for catch path but flagged parse-failure path)
- **Location:** `src/queue-processor.ts:264-265`

```typescript
const parsed = HeartbeatStateSchema.safeParse(raw);
if (!parsed.success) return {};  // BUG: cache not reset
```

Compare to the catch block which correctly resets:
```typescript
} catch {
    heartbeatStateCache = null;    // ✓ reset
    heartbeatStateMtime = 0;       // ✓ reset
    return {};
}
```

## Proposed Solutions

### Option A: Reset cache on parse failure (Recommended)
- **Effort:** Small (3-line change)
- **Pros:** Consistent with catch path; prevents stale cache serving after corruption
- **Cons:** None
- **Risk:** None

```typescript
if (!parsed.success) {
    heartbeatStateCache = null;
    heartbeatStateMtime = 0;
    return {};
}
```

### Option B: Add a comment explaining asymmetry
- **Effort:** Trivial
- **Pros:** Documents the behavior
- **Cons:** Leaves the inconsistency in place
- **Risk:** Low — the old cached data is valid, just stale

## Acceptance Criteria
- [ ] `loadHeartbeatState()` resets `heartbeatStateCache` and `heartbeatStateMtime` when Zod parse fails
- [ ] Behavior matches the catch-block reset pattern
