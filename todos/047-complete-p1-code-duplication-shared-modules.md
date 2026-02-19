---
status: complete
priority: p1
issue_id: "047"
tags: [code-review, architecture, duplication]
dependencies: []
---

# Extract duplicated code into shared modules

## Problem Statement

Four pieces of code are duplicated across process boundaries, directly violating the project's #1 recurring risk ("Code duplication is #1 recurring risk — Any shared integration MUST live in `src/<name>-client.ts` from day 1") and the plan's binding commitment ("Shares readRecentJsonl + merge logic: Import the same merge function used by the dashboard API. No code duplication.").

## Findings

### 1. `readRecentJsonl` duplicated (28 lines, character-for-character identical)
- `src/dashboard.ts` lines 41-69
- `src/mcp-tools.ts` lines 44-71
- The mcp-tools.ts copy even admits it: `// ─── JSONL Reader (shared logic with dashboard) ───`

### 2. Server-side corrections merge logic duplicated (~20 lines each)
- `src/dashboard.ts` lines 267-291 (`/api/routing/recent` handler)
- `src/mcp-tools.ts` lines 534-563 (`get_routing_decisions` tool)
- Same `as unknown as CorrectionEntry` unsafe casts in both

### 3. `lookupMessageModel` duplicated with different strategies
- `src/telegram-client.ts` lines 104-107 (cached, full lifecycle)
- `src/mcp-tools.ts` lines 77-90 (uncached, read-only, separate process)

### 4. `RoutingMetadataInput` duplicates `RoutingMetadata`
- `src/types.ts` lines 42-49 (`RoutingMetadata`)
- `src/routing-logger.ts` lines 100-107 (`RoutingMetadataInput`)
- Field-for-field identical interfaces

**Flagged by:** 8 of 9 review agents (TypeScript, Architecture, Pattern, Performance, Agent-native, Simplicity, Data Integrity, Security)

## Proposed Solutions

### Solution A: Extract to shared modules (Recommended)
1. Create `src/jsonl-reader.ts` with `readRecentJsonl<T>()` — imported by dashboard.ts and mcp-tools.ts
2. Add `mergeCorrectionsOntoDecisions()` to `routing-logger.ts` — imported by dashboard.ts and mcp-tools.ts
3. Delete `RoutingMetadataInput`, import `RoutingMetadata` from `types.ts` in routing-logger.ts
4. Keep `lookupMessageModel` duplication (different processes, different caching needs) but share the format contract

- **Pros:** Eliminates ~78 net LOC, single source of truth, fixes unsafe casts as side effect
- **Cons:** Adds one new file
- **Effort:** Small
- **Risk:** Low

## Recommended Action

(To be filled during triage)

## Technical Details

**Affected files:**
- `src/mcp-tools.ts` — Remove readRecentJsonl, merge logic, import from shared modules
- `src/dashboard.ts` — Remove readRecentJsonl, merge logic, import from shared modules
- `src/routing-logger.ts` — Delete RoutingMetadataInput, add mergeCorrectionsOntoDecisions(), import RoutingMetadata
- New: `src/jsonl-reader.ts` — readRecentJsonl extracted here

## Acceptance Criteria

- [ ] `readRecentJsonl` exists in exactly one place, imported by both consumers
- [ ] Correction merge logic exists in exactly one place, imported by both consumers
- [ ] `RoutingMetadataInput` deleted, `RoutingMetadata` imported instead
- [ ] No `as unknown as CorrectionEntry` casts remain (Zod validation used instead)
- [ ] Build passes

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-19 | Created from code review | 8/9 agents flagged duplication |

## Resources

- Plan commitment: docs/plans/2026-02-19-feat-routing-feedback-emoji-reactions-plan.md §Phase 5 "Shares readRecentJsonl + merge logic"
- Project memory: "Code duplication is #1 recurring risk"
