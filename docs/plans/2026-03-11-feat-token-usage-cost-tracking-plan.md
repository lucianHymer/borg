---
title: "feat: Add token usage and cost tracking to the Borg dashboard"
type: feat
status: active
date: 2026-03-11
---

# Add Token Usage and Cost Tracking to the Borg Dashboard

## Overview

The Claude Agent SDK returns rich cost and usage data on every query result (`total_cost_usd`, `usage`, `modelUsage`, `duration_ms`, `num_turns`) that Borg currently discards. This feature captures that data, stores it in message-history.jsonl, and adds a "Usage" dashboard tab for visualizing costs and token consumption across threads, models, sources, and time.

## Problem Statement

We have zero visibility into how much each thread, model, or message source costs. Heartbeats fire frequently on haiku but their cumulative cost is unknown. Opus queries are expensive but we can't see per-thread spend. There's no way to answer "how much did this cost today?" without manual API dashboard checking.

## Proposed Solution

### Phase 1: Data Capture (queue-processor.ts)

Extend `collectQueryResponse()` to capture usage data from `SDKResultMessage` (both success and error subtypes carry these fields):

```typescript
// src/queue-processor.ts — new interface
interface QueryUsageData {
    totalCostUSD: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    durationMs: number;
    durationApiMs: number;
    numTurns: number;
    modelUsage: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
        webSearchRequests: number;
    }>;
}
```

**Return type change:**
```typescript
// Before:
{ text: string; sessionId: string | undefined; stallRecovered: boolean }

// After:
{ text: string; sessionId: string | undefined; stallRecovered: boolean; usage?: QueryUsageData }
```

**Capture point:** Inside the `if (msg.type === "result")` block (line ~703), extract usage fields from the `SDKResultMessage` regardless of `subtype` (both `success` and `error` carry them).

**Edge cases:**
- **Stall-recovered queries**: May never receive SDKResultMessage. Record `usage: undefined` — accept data loss for these rare cases.
- **Cancelled queries**: Same — if no result message arrived before interrupt, `usage` is undefined.
- **Error throws**: Query throws before result → no usage data available → outgoing entry has no usage fields.

### Phase 2: Storage (message-history.ts)

Extend `MessageHistoryEntry` with optional usage fields:

```typescript
// src/message-history.ts — additions to MessageHistoryEntry
export interface MessageHistoryEntry {
    // ... existing fields ...

    // Usage data (outgoing entries only, when available)
    costUSD?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    durationMs?: number;
    numTurns?: number;
    modelUsage?: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
    }>;
}
```

**Why extend MessageHistoryEntry instead of a separate file:**
- Reuses existing JSONL infrastructure (append, rotation, tail-read, SSE feed)
- Usage is naturally tied to outgoing messages — same entity, same lifecycle
- Dashboard already reads message-history.jsonl for feeds
- No new file management, rotation logic, or readers needed

**JSONL line size:** Usage fields add ~200-400 bytes per outgoing entry. Still well under the 4096-byte O_APPEND atomicity guarantee for typical messages. Very long messages (3000+ chars) with large modelUsage could theoretically exceed this, but the risk is low and the existing dual-writer safety analysis (see knowledge base) accepts this tradeoff.

**Field names:** Match the SDK's naming (`cacheCreationInputTokens`, not `cacheWriteTokens`) to avoid confusion.

### Phase 3: Capture in Both Query Paths

**Normal messages (processMessage):**

At the `appendHistory()` call for outgoing entries (line ~1211), spread usage fields:

```typescript
appendHistory({
    ts: Date.now(),
    threadId,
    channel,
    sender: "assistant",
    direction: "out",
    message: responseText,
    model: effectiveModel,
    source: source ?? "user",
    messageId,
    // New: spread usage data if available
    ...(usageData ? {
        costUSD: usageData.totalCostUSD,
        inputTokens: usageData.inputTokens,
        outputTokens: usageData.outputTokens,
        cacheReadInputTokens: usageData.cacheReadInputTokens,
        cacheCreationInputTokens: usageData.cacheCreationInputTokens,
        durationMs: usageData.durationMs,
        numTurns: usageData.numTurns,
        modelUsage: usageData.modelUsage,
    } : {}),
});
```

**Heartbeats (processHeartbeat):**

`processHeartbeat()` must return usage data alongside text. Change its return type:

```typescript
// Before:
async function processHeartbeat(msg: IncomingMessage): Promise<string>

// After:
async function processHeartbeat(msg: IncomingMessage): Promise<{ text: string; usage?: QueryUsageData }>
```

**Suppressed heartbeats:** Heartbeats that return `[NO_UPDATES]` currently skip the outgoing `appendHistory()` call and return early. These still consume haiku tokens. To track their costs:
- After `processHeartbeat()` returns, check for usage data BEFORE the suppression check
- If usage exists and response will be suppressed, still call `appendHistory()` with a minimal outgoing entry (e.g., message: "[heartbeat:suppressed]", direction: "out") that carries the usage fields
- This ensures all token costs are tracked, not just visible responses

### Phase 4: Dashboard API (dashboard.ts)

Add one aggregation endpoint:

**`GET /api/usage?days=7`**

Reads message-history.jsonl (and backup .1.jsonl) for outgoing entries with `costUSD` field. Returns:

```typescript
{
    // Summary
    totalCostUSD: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalQueries: number;

    // Per-thread breakdown
    byThread: Array<{
        threadId: number;
        threadName: string;
        costUSD: number;
        inputTokens: number;
        outputTokens: number;
        queries: number;
    }>;

    // Per-model breakdown
    byModel: Array<{
        model: string;       // friendly name: "Haiku", "Sonnet", "Opus"
        costUSD: number;
        inputTokens: number;
        outputTokens: number;
        queries: number;     // queries where this model was primary
    }>;

    // Per-source breakdown
    bySource: Array<{
        source: string;      // "user", "heartbeat", "cross-thread", etc.
        costUSD: number;
        queries: number;
    }>;

    // Daily time series (last N days)
    daily: Array<{
        date: string;        // "2026-03-11"
        costUSD: number;
        queries: number;
        inputTokens: number;
        outputTokens: number;
    }>;
}
```

**Implementation notes:**
- Read both current file and `.1.jsonl` backup to cover the full time range
- Use `readRecentJsonl` for current file, plus a full scan of backup file filtered by `ts` range
- For the backup file, since `readRecentJsonl` only reads 256KB from tail, implement a simple full-file JSONL reader (line-by-line) filtered by timestamp range — the backup is at most 10MB which is fast to scan
- Filter entries: `direction === "out" && costUSD !== undefined && ts >= cutoffTimestamp`
- Thread name resolution: read `threads.json` and build a lookup map
- Model name mapping: extract from `model` field, map to friendly names (haiku/sonnet/opus)

**Multi-zone handling:**
- The infra container mounts `.borg-core/` and `.borg-perimeter/` read-only (verified in docker-compose.yml lines 168-169)
- The usage endpoint reads message-history.jsonl from all mounted zone directories
- Merge and deduplicate across zones (threadId is unique per zone)

### Phase 5: Dashboard UI (dashboard.html)

Add a new "Usage" tab following the existing pattern:

**4 touch points:**
1. Navbar link: `<a href="#usage" data-view="usage">Usage</a>`
2. View div: `<div id="view-usage" class="view">...</div>`
3. `initView()` switch: add `case "usage": initUsage(); break;`
4. `teardownView()` switch: cleanup

**Layout:**

```
┌─────────────────────────────────────────────────┐
│  Period: [Today] [7d] [30d]                     │
├────────┬────────┬──────────┬───────────────────  │
│ Total  │ Total  │ Avg Cost │ Total              │
│ Cost   │ Tokens │ /Query   │ Queries            │
│ $12.45 │ 1.2M   │ $0.034   │ 367                │
├────────┴────────┴──────────┴───────────────────  │
│                                                  │
│  Daily Cost Trend (CSS bar chart)                │
│  ████████████  Mar 11  $2.10                     │
│  ██████        Mar 10  $1.05                     │
│  ████████████████  Mar 9  $2.80                  │
│  ...                                             │
│                                                  │
│  By Thread                    By Model           │
│  ┌──────────────────────┐    ┌──────────────┐   │
│  │ Thread    Cost  Qry  │    │ Model  Cost  │   │
│  │ main      $5.20  120 │    │ Opus   $8.00 │   │
│  │ worker    $3.10   45 │    │ Sonnet $3.50 │   │
│  │ reviewer  $2.15   32 │    │ Haiku  $0.95 │   │
│  └──────────────────────┘    └──────────────┘   │
│                                                  │
│  By Source                                       │
│  ┌────────────────────────────────────────────┐  │
│  │ Source       Cost    Queries   % of Total  │  │
│  │ user         $8.00    200      64%         │  │
│  │ heartbeat    $2.45    150      20%         │  │
│  │ cross-thread $2.00     17      16%         │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**Rendering approach:**
- Summary cards: `.stat-grid` / `.stat-card` (existing pattern)
- Daily trend: horizontal CSS bar chart using `.bar-container` / `.bar-fill` (existing pattern)
- Tables: standard HTML tables (existing pattern)
- Model badges: reuse `.model-haiku`, `.model-sonnet`, `.model-opus` CSS classes
- Period selector: simple buttons that re-fetch with different `days` parameter
- Currency formatting: `$X.XX` for per-query, `$X.XX` for totals, 2 decimal places always
- Token formatting: abbreviated (e.g., "1.2M", "45K") for readability
- No SSE feed for v1 — data updates on tab switch / period change

## Acceptance Criteria

- [ ] `collectQueryResponse()` returns usage data from SDKResultMessage (both success and error)
- [ ] Normal message outgoing entries in message-history.jsonl include costUSD, token counts, modelUsage
- [ ] Heartbeat outgoing entries (including suppressed) include usage data
- [ ] `GET /api/usage?days=N` returns aggregated usage data
- [ ] Dashboard "Usage" tab displays summary cards, daily trend, and breakdown tables
- [ ] Period selector (today/7d/30d) works
- [ ] Old message-history entries without usage fields are handled gracefully (shown as zero cost)
- [ ] Multi-zone: dashboard reads from all zone message-history files
- [ ] TypeScript compiles cleanly (`npm run build`)

## File Changes

| File | Change |
|------|--------|
| `src/queue-processor.ts` | Extend `collectQueryResponse()` return type; capture usage from SDKResultMessage; thread usage through `processHeartbeat()`; pass usage to `appendHistory()` calls; track suppressed heartbeat costs |
| `src/message-history.ts` | Add optional usage fields to `MessageHistoryEntry` interface |
| `src/dashboard.ts` | Add `GET /api/usage` endpoint with multi-zone aggregation |
| `static/dashboard.html` | Add "Usage" tab (navbar, view div, init/teardown, render functions) |

## Implementation Tasks (for Worker)

1. **Add `QueryUsageData` interface and capture in `collectQueryResponse()`** — Define the interface in queue-processor.ts, capture usage from the `result` message type handler, return it alongside text/sessionId/stallRecovered.

2. **Extend `MessageHistoryEntry` with optional usage fields** — Add costUSD, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, durationMs, numTurns, modelUsage to the interface in message-history.ts.

3. **Wire usage data through processMessage()** — Destructure usage from collectQueryResponse(), spread usage fields into the outgoing appendHistory() call. Handle cancelled/error paths (no usage = no fields).

4. **Wire usage data through processHeartbeat()** — Change processHeartbeat() return type to include usage. Pass usage back to processMessage(). Add appendHistory() call for suppressed heartbeats with usage tracking.

5. **Add `/api/usage` dashboard endpoint** — Implement in dashboard.ts: read message-history.jsonl from all zone dirs (core, perimeter), aggregate by thread/model/source/day, accept `days` query param, resolve thread names, map model names.

6. **Add "Usage" dashboard tab** — In dashboard.html: add navbar link, view div, initUsage() with period selector, renderUsage() with stat cards + bar chart + tables. Follow existing patterns (string concat, CSS classes, api() helper).

## References

- SDK types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (lines 624-633, 1956-1973)
- Existing JSONL patterns: `src/message-history.ts`, `src/routing-logger.ts`, `src/jsonl-reader.ts`
- Dashboard patterns: `src/dashboard.ts` (routing view as template), `static/dashboard.html`
- Zone mounts: `docker-compose.yml` (lines 168-169: infra mounts core/perimeter read-only)
- Knowledge: `.claude/knowledge/data-integrity/routing-feedback-feature-dual-writer-jsonl-safety-analysis.md`
