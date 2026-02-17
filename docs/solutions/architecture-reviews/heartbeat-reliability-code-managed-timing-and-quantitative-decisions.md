---
title: Reliable heartbeat with code-managed timing and MCP time tools
date: 2026-02-17
category: architecture-reviews
tags: [heartbeat, state-management, timestamp-handling, deterministic-routing, mcp-tools, temporal-logic, assumption-dependent-simplification]
severity: high
components: [heartbeat-system, queue-processor, session-manager, mcp-tools]
related_plans:
  - docs/plans/2026-02-17-feat-reliable-heartbeat-code-managed-timing-plan.md
  - docs/plans/2026-02-11-feat-per-repo-heartbeat-self-management-plan.md
---

# Reliable Heartbeat with Code-Managed Timing

## Problem Statement

LLMs (haiku-class) fail at timestamp math approximately 30-40% of the time during heartbeat operations. The initial heartbeat system relied on agents to:

1. Read HEARTBEAT.md and parse timestamps
2. Perform date arithmetic to determine tier eligibility
3. Select the appropriate task tier (quick/hourly/daily)
4. Execute tasks and update timestamps

Each step was vulnerable to LLM arithmetic failure, leading to unreliable heartbeat execution. Tiers were skipped or ran at wrong cadences with no code-level fallback.

### Root Cause

The prior architectural decision ("all intelligence in the prompt") was applied too broadly. It worked for qualitative decisions but failed for quantitative operations like timestamp comparison. The original plan's simplification #2 — "Removed `determineHeartbeatTier()` from TypeScript — agent self-determines" — was an **assumption-dependent simplification** that bet on haiku's arithmetic capabilities. Operational data proved the assumption false.

## Solution

Four changes moved timestamp management from prompt-based to code-based while preserving agent autonomy over task lists.

### 1. Code-Managed Heartbeat State (`heartbeat-state.json`)

Per-thread epoch timestamps for each tier, managed atomically by TypeScript:

```json
{
  "3": { "quick": 1708185600000, "hourly": 1708182000000, "daily": 1708099200000 },
  "5": { "quick": 1708185900000, "hourly": 1708182000000, "daily": 1708099200000 }
}
```

Zod schema validates on read — corrupted files auto-heal to `{}`:

```typescript
const HeartbeatTimestampsSchema = z.object({
    quick: z.number().nonnegative(),
    hourly: z.number().nonnegative(),
    daily: z.number().nonnegative(),
});
const HeartbeatStateSchema = z.record(z.string(), HeartbeatTimestampsSchema);
```

Load with mtime cache + validation (cache resets on parse failure):

```typescript
function loadHeartbeatState(): HeartbeatState {
    try {
        const mtime = fs.statSync(HEARTBEAT_STATE_FILE).mtimeMs;
        if (heartbeatStateCache && mtime === heartbeatStateMtime) return heartbeatStateCache;
        const raw: unknown = JSON.parse(fs.readFileSync(HEARTBEAT_STATE_FILE, "utf8"));
        const parsed = HeartbeatStateSchema.safeParse(raw);
        if (!parsed.success) {
            heartbeatStateCache = null;
            heartbeatStateMtime = 0;
            return {};
        }
        heartbeatStateCache = parsed.data;
        heartbeatStateMtime = mtime;
        return heartbeatStateCache;
    } catch {
        heartbeatStateCache = null;
        heartbeatStateMtime = 0;
        return {};
    }
}
```

### 2. Code-Side Tier Selection

The queue processor deterministically picks which tier is due:

```typescript
const DEFAULT_TIMESTAMPS: Readonly<HeartbeatTimestamps> = { quick: 0, hourly: 0, daily: 0 };
const HOURLY_INTERVAL_MS = 60 * 60 * 1000;
const DAILY_INTERVAL_MS = 24 * HOURLY_INTERVAL_MS;

function getDueTier(threadId: string): HeartbeatTier {
    const state = loadHeartbeatState();
    const ts = state[threadId] || DEFAULT_TIMESTAMPS;
    const now = Date.now();
    if (now - ts.daily > DAILY_INTERVAL_MS) return "daily";
    if (now - ts.hourly > HOURLY_INTERVAL_MS) return "hourly";
    return "quick";
}
```

Tiers are cumulative — daily resets all three timestamps:

```typescript
function updateHeartbeatState(threadId: string, tier: HeartbeatTier): void {
    const state = loadHeartbeatState();
    const threads = loadThreads();
    const now = Date.now();

    for (const key of Object.keys(state)) {
        if (!threads[key]) delete state[key]; // prune stale entries
    }

    if (!state[threadId]) state[threadId] = { ...DEFAULT_TIMESTAMPS };
    state[threadId].quick = now;
    if (tier === "hourly" || tier === "daily") state[threadId].hourly = now;
    if (tier === "daily") state[threadId].daily = now;

    saveHeartbeatState(state);
}
```

### 3. Simplified HEARTBEAT.md

Removed `## Timestamps` section entirely. HEARTBEAT.md is now a pure task registry that agents evolve over time. Agents add/remove/reorder tasks but never manage timestamps. The prompt includes a migration instruction: "If your HEARTBEAT.md has a `## Timestamps` section, remove it."

### 4. MCP Time Tools

Two tools for non-heartbeat time reasoning, available to all threads:

- **`get_current_time`** — Returns ISO, human-readable, epoch_ms, and timezone. Handles invalid timezone with try/catch + `toErrorMessage()`.
- **`get_elapsed_time`** — Accepts ISO or epoch, returns elapsed in multiple formats. Includes `isFinite()` guard against Infinity from large numeric strings.

Shared `formatHumanTime()` utility eliminates 4x duplication of `toLocaleString()` options.

### Hardening (from code review)

Seven improvements in the second commit:

1. Reset cache on Zod validation failure (prevents stale data)
2. Master self-send guardrail in daily heartbeat prompt
3. Export `HeartbeatTier` from session-manager (single source of truth)
4. `Readonly` on `DEFAULT_TIMESTAMPS` (prevent accidental mutation)
5. `nonnegative()` on Zod schema (reject negative timestamps)
6. try/catch with UTC fallback on `formatCurrentTime()`
7. Prune stale entries in `updateHeartbeatState()` (removes deleted threads)

## Key Patterns Applied

| Pattern | Application |
|---------|-------------|
| Zod at I/O boundaries | Validate heartbeat-state.json; auto-heal with empty object |
| Atomic writes | `.tmp` + `renameSync` for heartbeat-state.json |
| mtime cache | Cheap `statSync()` before `readFileSync()` |
| try/catch with toErrorMessage() | Both MCP tools handle errors gracefully |
| isFinite() guard | Prevent Infinity from large numeric strings |
| Cumulative tier updates | Daily resets all three timestamps |
| Readonly constants | Prevent accidental mutation of DEFAULT_TIMESTAMPS |
| Stale entry pruning | Remove timestamps for deleted threads |
| Composable prompt builders | Tier directive assembled from parts |

## Architectural Decision: Qualitative vs. Quantitative Boundary

This plan intentionally reverses the "all intelligence in the prompt" principle established in the [prior heartbeat architecture](per-repo-heartbeat-self-management-and-cross-pollination.md). The reversal is principled:

- **Qualitative decisions** (what tasks to run, urgency, whether something needs attention) → Stay in the prompt. LLMs excel at context, priorities, judgment calls.
- **Quantitative operations** (date math, threshold comparisons, duration calculations) → Belong in code. Must be deterministic; LLM failure rate compounds.

**Boundary test:** If the operation must produce identical output given identical input, is numeric/threshold-based, or failure impacts multiple downstream decisions — it belongs in code.

## Prevention & Lessons Learned

### 1. The Assumption-Dependent Simplification Pattern

The prior plan's simplification #2 removed code-side tier selection, assuming haiku could do timestamp math. This was not a scope-reduction simplification (removing unneeded features) but an assumption-dependent simplification (betting on model capability).

**Prevention:** Tag all future simplifications at plan time:
- **Scope-reduction** — Feature removed because problem scope shrank. Safe.
- **Assumption-dependent** — Feature removed because model is assumed capable. Add: "Assumption: Model can reliably [X]. Re-evaluate if error rate > [Y]%."

### 2. Deepen Stage Catches What Code Review Cannot

The deepen stage (18 research agents) caught 4+ issues invisible to code review:

- `isFinite()` guard — 1000-digit string of 9s returns Infinity from `Number()`
- Zod v4 `.optional()` wipes `.describe()` — framework quirk requiring docs lookup
- `RangeError` on invalid timezone — requires testing against `toLocaleString()` spec
- Cache reset on Zod failure — defensive pattern requiring cross-reference with existing loaders

**When to allocate deepen:** Always for new external I/O, new dependencies, quantitative operations, or untrusted input parsing. Optional for pure logic refactoring.

### 3. Code Review's Hardening Role

The second commit added 7 defensive improvements. Pattern: after feature implementation, ask "What breaks if [X happens]?"

- X = heartbeat-state.json gets corrupted → Zod validation + cache reset
- X = timezone is garbage → try/catch with UTC fallback
- X = thread is deleted → stale entry pruning
- X = master sends daily summary to itself → self-send guardrail

### 4. Single Source of Truth for State

The original system had timestamps in HEARTBEAT.md (agent-visible), logic in prompts (agent-opaque), and no code-side validation. Three parallel sources of truth caused silent failures.

**Fixed:** Code owns timing (queue-processor.ts), agents own task lists (HEARTBEAT.md), state is observable (heartbeat-state.json, read-only for agents).

### 5. Numeric Edge Case Checklist

For any code involving `Number()` parsing:
- [ ] `isNaN()` and `isFinite()` checks present?
- [ ] `new Date()` calls in try/catch?
- [ ] Regex validation followed by defensive type coercion?

## Related Documentation

- **[Per-Repo Heartbeat Self-Management & Cross-Pollination](per-repo-heartbeat-self-management-and-cross-pollination.md)** — Direct predecessor. Established tier architecture and "all intelligence in the prompt" principle now refined with qualitative/quantitative boundary.
- **[Full Pipeline: Onboarding, Heartbeat, and Infrastructure](multi-agent-review-onboarding-heartbeat-infra.md)** — Original implementation review. Documents simplification #2 decision and stagger pattern preserved in this work.
- **[Code Review Cycle 2: Systemic Patterns](code-review-cycle-2-systemic-patterns-and-prevention.md)** — Mtime cache pattern, atomic writes, Zod validation at boundaries, prompt injection defense patterns reused here.
- **[Borg v2 Evolution: From Fork to Forum Agent](../integration-issues/borg-v2-evolution-from-fork-to-forum-agent.md)** — Canonical patterns document establishing conventions followed here.
- **[SDK v2 MCPServers Silent Ignore](../integration-issues/sdk-v2-mcpservers-silent-ignore.md)** — MCP tool definition patterns relevant to the new time tools.
- **[Prior Plan: Per-Repo Heartbeat Self-Management](../../plans/2026-02-11-feat-per-repo-heartbeat-self-management-plan.md)** — Contains the simplification #2 that this work reverses.
- **[Current Plan: Reliable Heartbeat with Code-Managed Timing](../../plans/2026-02-17-feat-reliable-heartbeat-code-managed-timing-plan.md)** — Full plan with deepened research insights.

## Files Changed

| File | Change |
|------|--------|
| `src/queue-processor.ts` | HeartbeatTier types, Zod-validated state file, getDueTier(), updateHeartbeatState(), modified processHeartbeat() |
| `src/session-manager.ts` | Simplified buildHeartbeatPrompt() with tier directive, formatHumanTime() shared utility, updated buildMcpToolsBlock() |
| `src/mcp-tools.ts` | Added get_current_time and get_elapsed_time tools |
