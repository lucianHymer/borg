---
status: complete
priority: p3
issue_id: "046"
tags: [code-review, typescript, security, quality]
---
# Heartbeat Implementation Minor Hardening

## Problem Statement
Several minor improvements identified across all review agents. None are blocking but collectively improve robustness.

## Findings

### 1. DEFAULT_TIMESTAMPS should be Readonly
- **Source:** TypeScript Reviewer (Issue #3)
- **Location:** `src/queue-processor.ts:243`
- `getDueTier()` holds a direct reference to DEFAULT_TIMESTAMPS (read-only in practice). Adding `Readonly<HeartbeatTimestamps>` prevents accidental future mutation.

### 2. HeartbeatTier type duplicated across files
- **Source:** TypeScript Reviewer (Issue #4), Pattern Recognition (Finding #8), Architecture Strategist (Section 2.4)
- **Location:** `src/queue-processor.ts:233` (named type) vs `src/session-manager.ts:365` (inline literal)
- The `"quick" | "hourly" | "daily"` union is defined in two places. Export from one and import in the other.

### 3. formatCurrentTime() is a dead-weight wrapper
- **Source:** Code Simplicity Reviewer (Finding #1)
- **Location:** `src/queue-processor.ts:396-399`
- After refactor, it's a 2-line function wrapping `formatHumanTime(loadSettings().timezone)` with exactly 1 callsite. Inline it.

### 4. Timestamp values not range-validated by Zod
- **Source:** Security Sentinel (Finding 2 — Low)
- **Location:** `src/queue-processor.ts:249-254`
- `z.number()` accepts negatives and numbers beyond MAX_SAFE_INTEGER. A future-dated timestamp permanently suppresses a tier; a negative forces daily on every heartbeat. Add `z.number().nonnegative()`.

### 5. formatCurrentTime() missing try/catch for RangeError
- **Source:** Security Sentinel (Finding 3 — Low)
- **Location:** `src/queue-processor.ts:396-399`
- If `settings.timezone` is invalid, `formatHumanTime()` throws RangeError. The MCP tool wraps this in try/catch; `formatCurrentTime()` does not. Add a UTC fallback. (Moot if #3 inlines the function — add try/catch at the inline callsite.)

### 6. No stale entry pruning in heartbeat-state.json
- **Source:** Data Integrity Guardian (Section 6)
- **Location:** `src/queue-processor.ts:298-308`
- Deleted threads leave stale entries. Growth is bounded (~80 bytes/thread) so not urgent, but adding a pruning step in `updateHeartbeatState` that removes keys not in `threads.json` would be hygienic.

### 7. get_elapsed_time redundant response fields
- **Source:** Code Simplicity Reviewer (Finding #2 — non-blocking)
- **Location:** `src/mcp-tools.ts:526-533`
- Returns `total_minutes`, `total_hours`, `total_days` which are trivially derivable from `elapsed_ms`. Inflates agent context with extra tokens. Could return only `{ elapsed_ms, human, is_future }`.

## Proposed Solutions

Apply as a single cleanup commit:

```typescript
// 1. Readonly DEFAULT_TIMESTAMPS
const DEFAULT_TIMESTAMPS: Readonly<HeartbeatTimestamps> = { quick: 0, hourly: 0, daily: 0 };

// 2. Export HeartbeatTier from queue-processor, import in session-manager
// (or extract to types.ts if needed by a third module)

// 3. Inline formatCurrentTime at its callsite
const now = formatHumanTime(loadSettings().timezone);
// Delete formatCurrentTime()

// 4. Add nonnegative to Zod schema
const HeartbeatTimestampsSchema = z.object({
    quick: z.number().nonnegative(),
    hourly: z.number().nonnegative(),
    daily: z.number().nonnegative(),
});

// 5. Add try/catch with UTC fallback at the inline callsite
let now: string;
try { now = formatHumanTime(loadSettings().timezone); }
catch { now = formatHumanTime("UTC"); }

// 6. Optional: prune stale entries
const threads = loadThreads();
for (const key of Object.keys(state)) {
    if (!threads[key]) delete state[key];
}
```

## Acceptance Criteria
- [ ] DEFAULT_TIMESTAMPS uses `Readonly<HeartbeatTimestamps>`
- [ ] HeartbeatTier type is defined in one place and referenced in both files
- [ ] formatCurrentTime() removed, callsite inlined with try/catch
- [ ] Zod schema uses `z.number().nonnegative()`
- [ ] Stale heartbeat state entries pruned on update (optional)
