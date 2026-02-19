---
status: complete
priority: p1
issue_id: "048"
tags: [code-review, frontend, race-condition]
dependencies: []
---

# Fix fetch/SSE initialization race in routing dashboard

## Problem Statement

In `static/dashboard.html`, `initRouting()` calls `fetchRoutingRecent()` (async, fire-and-forget) and immediately opens the SSE connection. If a correction SSE event arrives before the fetch resolves, `state.routingEntries` is still empty, the correction finds no matching decision, and is silently dropped forever.

## Findings

**Location:** `static/dashboard.html` lines 1504-1531

```javascript
function initRouting() {
    fetchRoutingRecent();          // async — nobody awaits this
    closeSSE('routing');
    state.eventSources.routing = createSSE('/api/routing/feed', ...);
}
```

Timeline of the race:
1. `fetchRoutingRecent()` starts fetch
2. SSE connects, server records tail offset at current EOF
3. User reacts with correction emoji → correction appended to routing.jsonl
4. SSE poll fires, sends correction to client
5. Client searches empty `state.routingEntries` → correction silently dropped
6. Fetch resolves, populates entries, but correction is gone forever

**Flagged by:** Frontend races reviewer

## Proposed Solutions

### Solution A: Await fetch before opening SSE (Recommended)
```javascript
async function initRouting() {
    closeSSE('routing');
    await fetchRoutingRecent();    // wait for table to populate
    state.eventSources.routing = createSSE('/api/routing/feed', function(evt) { ... });
}
```

- **Pros:** Simple, eliminates race completely
- **Cons:** Brief window (~200ms) with no SSE events during fetch
- **Effort:** Small (1 line change)
- **Risk:** None — 2-second server poll interval means the window is negligible

## Technical Details

**Affected files:** `static/dashboard.html`

## Acceptance Criteria

- [ ] SSE connection is only opened after initial fetch resolves
- [ ] Corrections arriving via SSE after initial load are correctly patched onto decisions
- [ ] No regressions in other dashboard views

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-19 | Created from code review | |
