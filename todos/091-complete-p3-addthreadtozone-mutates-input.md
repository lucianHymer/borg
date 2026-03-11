---
status: complete
priority: p3
issue_id: "091"
tags: [code-review, type-safety, api-contract]
dependencies: []
---

# addThreadToZone() mutates input while returning it

## Problem Statement

`addThreadToZone()` in zone-config.ts:107-119 mutates the input `config` object directly (adds to `config.zones[zoneName].threads` array) while also returning it. This is misleading — it looks like a pure transform but mutates in place. Callers in mcp-tools.ts defensively use `structuredClone()` before passing, which papers over the issue. A future caller forgetting `structuredClone` would corrupt the module-level cache.

## Findings

- `addThreadToZone()` pushes to `config.zones[zoneName].threads` in place, then returns the same mutated object
- The function signature and name suggest a pure transform (takes config, returns new config)
- Callers in mcp-tools.ts use `structuredClone()` defensively before passing the config — this is a workaround, not a fix
- The module-level cache holds a reference to the config object; if any caller passes the cached object without cloning, the mutation would corrupt the cache

## Proposed Solutions

Option A (pure): Make the function truly pure — deep-clone internally at the start, return a new object. Update callers to use the return value and remove their defensive `structuredClone()` calls.

Option B (explicit mutation): Drop the return value, rename to `mutateAddThread()` or `addThreadToZoneMut()` to make the mutation contract explicit in the name.

Option A is preferred as it removes the footgun entirely.

## Acceptance Criteria

- [x] `addThreadToZone()` either clones internally (pure) or is renamed to signal mutation
- [x] No caller needs a defensive `structuredClone()` before passing config to this function
- [x] Module-level cache cannot be corrupted by calling the function

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Mutation disguised as pure transform is a common footgun in caching scenarios |
| 2026-03-11 | Fixed: both functions now clone internally with structuredClone; callers in mcp-tools.ts simplified to use return value directly | Option A implemented — pure functions, no defensive clones at call sites |
