---
title: "feat: Reliable heartbeat with code-managed timing and MCP time tools"
type: feat
date: 2026-02-17
deepened: 2026-02-17
---

# Reliable Heartbeat with Code-Managed Timing

## Enhancement Summary

**Deepened on:** 2026-02-17
**Sections enhanced:** 8
**Research agents used:** 18 (security-sentinel, kieran-typescript-reviewer, code-simplicity-reviewer, performance-oracle, agent-native-reviewer x2, architecture-strategist, pattern-recognition-specialist, best-practices-researcher, framework-docs-researcher, learnings-researcher x5, agent-native-architecture skill, create-agent-skills skill)

### Key Improvements

1. **Zod validation at I/O boundary** — `loadHeartbeatState()` must validate parsed JSON with a Zod schema, not raw `JSON.parse() as T`. Corrupted file auto-heals to `{}`.
2. **try/catch on both MCP tools** — `get_current_time` throws `RangeError` on invalid timezone; `get_elapsed_time` needs `isFinite()` guard. Both need `toErrorMessage()` wrapper for consistency.
3. **Extract shared time formatting** — `toLocaleString` options object duplicated 4x across codebase. Extract `formatHumanTime()` utility.
4. **Rename for pattern consistency** — `time_elapsed` → `get_elapsed_time` (verb_noun convention); `computeDueTier` → `getDueTier`; extract `HeartbeatTier` and `HeartbeatTimestamps` named types.
5. **Master thread extras must be explicit** — The `// ...` placeholder for master daily extras risks regression. Show skeleton with cross-pollination trigger on `dueTier === "daily"`.
6. **Heartbeat state observability** — Add one line to heartbeat prompt: agents can read `.borg/heartbeat-state.json` (read-only) for self-debugging.

### New Considerations Discovered

- Plan intentionally reverses the prior "all intelligence in the prompt" principle for timestamp math. This is correct — qualitative decisions stay in prompts, quantitative operations (date math) belong in code.
- Prior simplification #2 (removing `determineHeartbeatTier()` from code) proved wrong at ~30-40% error rate. Lesson: simplifications that assume model capabilities should be flagged as "assumption-dependent."
- SDK v0.2.27+ supports `tool()` annotations (`readOnly: true`) — consider adding to read-only tools.
- Node.js 22 supports `writeFileSync({ flush: true })` for crash-safe writes — consider for state files.
- Zod v4 `.optional()` wipes `.describe()` — always call `.describe()` last.
- Existing stagger pattern (sleep between thread heartbeats) must be preserved in refactored flow.

---

## Overview

The heartbeat system is unreliable because LLMs consistently fail at timestamp comparison. The agent reads "Last hourly: Feb 17, 2:15 PM" and "Current time: 4:30 PM" but gets the math wrong, skipping tiers or running them at the wrong cadence.

**Fix:** Move all timestamp math into TypeScript code. The agent never sees or compares timestamps — it receives a directive ("run your hourly tasks") and executes it. Two MCP time tools give agents reliable time reasoning for non-heartbeat use cases (PR age, stale branch detection, etc.).

### Research Insights: Design Context

This plan intentionally reverses the prior architectural principle of "all intelligence in the prompt" (documented in `docs/solutions/architecture-reviews/per-repo-heartbeat-self-management-and-cross-pollination.md` as "the most important architectural decision in the branch"). The reversal is principled: **qualitative** decisions (what tasks to run, whether something is urgent) stay in prompts, but **quantitative** operations (date math, threshold comparisons) belong in code where they are deterministic.

The prior plan's simplification #2 ("Removed `determineHeartbeatTier()` from TypeScript — agent self-determines") was based on the assumption that haiku could reliably do timestamp math. Operational data shows ~30-40% failure rate. Future simplifications that depend on model capabilities (rather than scope reduction) should be tagged as "assumption-dependent" for easier re-evaluation.

**References:**
- [Writing Effective Tools for AI Agents — Anthropic Engineering](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Less is More: MCP Design Patterns — Klavis](https://www.klavis.ai/blog/less-is-more-mcp-design-patterns-for-ai-agents)
- [Agent Design Patterns — Lance Martin](https://rlancemartin.github.io/2026/01/09/agent_design/)

## Problem Statement

1. **LLMs can't do date math** — well-documented across all providers. Asking haiku to compare "Last daily: Feb 16, 9:00 AM" vs "Current time: Feb 17, 4:30 PM" and conclude "31.5 hours elapsed, daily is due" fails ~30-40% of the time.
2. **Too many decisions per heartbeat** — The agent must: read HEARTBEAT.md, parse timestamps, do date math, pick the right tier, execute tasks, AND update timestamps. Each step can go wrong in a one-shot haiku query.
3. **No fallback when time reasoning fails** — If the agent miscalculates, a tier just doesn't run. There's no code-level guarantee that daily tasks actually run daily.

## Proposed Solution

Four changes, ordered by impact:

### 1. Code-managed heartbeat state (`heartbeat-state.json`)

New file: `.borg/heartbeat-state.json` (already gitignored)

```json
{
  "3": { "quick": 1708185600000, "hourly": 1708182000000, "daily": 1708099200000 },
  "5": { "quick": 1708185900000, "hourly": 1708182000000, "daily": 1708099200000 }
}
```

- Keys are thread IDs (strings, matching `threads.json` convention)
- Values are epoch milliseconds per tier
- Read/written by `processHeartbeat()` in queue-processor.ts — never by the agent
- Uses mtime cache pattern (consistent with `loadThreads()`, `loadSettings()`)
- Atomic writes: `.tmp` + `renameSync`
- **Validated with Zod schema on read** — corrupted file auto-heals to `{}`

#### Research Insights: State File

**Zod at I/O boundary (from cycle 2 learnings):** The existing codebase convention (MEMORY.md) mandates `IncomingMessageSchema.safeParse()` not `JSON.parse() as T`. While `loadThreads()` and `loadSettings()` currently use raw casts, this plan should follow the documented convention. A corrupted or agent-tampered `heartbeat-state.json` must not crash the queue processor.

**Atomic writes confirmed correct:** The `.tmp` + `renameSync` pattern is the canonical Node.js approach. `rename(2)` is atomic within a single filesystem (ext4). The `.tmp` file must be in the same directory as the target (never `/tmp`) to avoid `EXDEV` errors. Node.js 22 also supports `writeFileSync({ flush: true })` for crash-safe writes — consider using for durability.

**Agent tampering risk (security review):** Agents run with `bypassPermissions` and could potentially write to `.borg/heartbeat-state.json` directly. Zod validation on read auto-heals this (invalid structure → `{}` → daily fires immediately). The prompt should state the file is read-only for agents.

**Performance (at heartbeat cadence):** JSON parse/stringify on this file is <0.05ms even at 50 threads (~5KB). The mtime cache adds one `statSync` (~0.01ms) per call. Both are negligible at the ~500s heartbeat interval. Keep the mtime cache for pattern consistency even though it's technically unnecessary at this cadence.

### 2. Code-side tier selection in `processHeartbeat()`

Before calling the SDK, the queue processor computes which tier is due:

```typescript
function getDueTier(threadId: string): HeartbeatTier {
    const state = loadHeartbeatState();
    const ts = state[threadId] || DEFAULT_TIMESTAMPS;
    const now = Date.now();

    if (now - ts.daily > DAILY_INTERVAL_MS) return "daily";
    if (now - ts.hourly > HOURLY_INTERVAL_MS) return "hourly";
    return "quick";
}
```

After the agent responds (any response, including `[NO_UPDATES]`), code updates the state:

```typescript
function updateHeartbeatState(threadId: string, tier: HeartbeatTier): void {
    const state = loadHeartbeatState();
    const now = Date.now();
    if (!state[threadId]) state[threadId] = { ...DEFAULT_TIMESTAMPS };

    // Tiers are cumulative: daily includes hourly includes quick
    state[threadId].quick = now;
    if (tier === "hourly" || tier === "daily") state[threadId].hourly = now;
    if (tier === "daily") state[threadId].daily = now;

    saveHeartbeatState(state); // atomic .tmp + renameSync
}
```

**Timestamp update policy:** Always update after the agent returns a response. `[NO_UPDATES]` means "I checked and nothing needs attention" — that's a successful execution. Only skip the update if the query itself throws/times out (the `catch` block in `processHeartbeat`).

**Tier directive passed to prompt:** `buildHeartbeatPrompt(config, dueTier)` receives the tier as a parameter and generates a focused directive:

| Tier | Directive in prompt |
|------|-------------------|
| `"quick"` | "Execute ONLY your **Quick Tasks**." |
| `"hourly"` | "Execute your **Quick Tasks** AND **Hourly Tasks**." |
| `"daily"` | "Execute ALL tasks: **Quick**, **Hourly**, AND **Daily Tasks**." |

#### Research Insights: Tier Selection

**Naming consistency (pattern review):** The codebase uses `get*` for derived-value accessors (`getRetryCount`, `getRecentHistory`). Renamed from `computeDueTier` → `getDueTier` for consistency.

**Named constants (TypeScript review):** Extract tier interval magic numbers:
```typescript
const HOURLY_INTERVAL_MS = 60 * 60 * 1000;
const DAILY_INTERVAL_MS = 24 * HOURLY_INTERVAL_MS;
```

**Named types (TypeScript review):** Extract the tier union and timestamps interface:
```typescript
type HeartbeatTier = "quick" | "hourly" | "daily";
interface HeartbeatTimestamps { quick: number; hourly: number; daily: number; }
type HeartbeatState = Record<string, HeartbeatTimestamps>;
const DEFAULT_TIMESTAMPS: HeartbeatTimestamps = { quick: 0, hourly: 0, daily: 0 };
```

**Cumulative tier update is correct (simplicity review):** Running daily tasks "includes" hourly and quick. After a daily run, all three timestamps update, preventing hourly from re-firing on the very next heartbeat. The implementation is 3 lines — minimal and elegant.

**Stagger pattern must be preserved (from prior learning):** The existing heartbeat flow sleeps `INTERVAL / THREAD_COUNT` between each thread's heartbeat injection. The refactored `processHeartbeat()` must not break this stagger timing.

### 3. Simplified HEARTBEAT.md (task registry only)

Remove the `## Timestamps` section entirely. HEARTBEAT.md becomes a pure task list that the agent evolves over time:

```markdown
# Heartbeat Tasks

## Quick Tasks (every heartbeat)
- [ ] Run `git status`
- [ ] Check Urgent Flags section below

## Hourly Tasks
- [ ] Run `git fetch origin`
- [ ] Run `git log HEAD..origin/main --oneline`
- [ ] Run `gh pr list --state open` and `gh pr checks`
- [ ] Check for merge conflicts with main

## Daily Tasks
- [ ] Summarize day's work
- [ ] Check PR status and aging review requests
- [ ] Flag stale branches
- [ ] Send daily summary to master thread

## Urgent Flags
(none)

## Notes
(Agent notes about patterns observed, things to watch)
```

The agent still owns this file — it adds/removes/reorders tasks based on what it learns about the repo. But it never manages timestamps.

**Migration:** The prompt includes: "If your HEARTBEAT.md has a `## Timestamps` section, remove it — timing is now managed automatically." This handles threads that already have the old format.

#### Research Insights: Agent Self-Management

**Preserve system prompt self-management section (from heartbeat learning):** The prior implementation added a dedicated `## Heartbeat Self-Management` section to both master and worker system prompts (in `buildThreadPrompt()`). This section teaches agents how to evolve their task lists. The change to `buildHeartbeatPrompt()` (the heartbeat query prompt) must NOT accidentally remove or weaken the self-management teaching in the system prompt.

**Agent observability (agent-native review):** Add one line to the heartbeat prompt: "Your heartbeat timing state is in `.borg/heartbeat-state.json` (read-only — timing is managed automatically)." This lets agents self-debug ("when did my last daily run?") by reading the file and calling `get_elapsed_time` with the epoch timestamp.

### 4. MCP time tools

Two new tools in `src/mcp-tools.ts`, available to all threads (read-only, no tiering needed):

**`get_current_time`**
```typescript
const getCurrentTime = tool(
    "get_current_time",
    "Get the current date and time. Use this instead of guessing the time.",
    {
        timezone: z.string().optional()
            .describe("IANA timezone (e.g., 'America/New_York'). Defaults to bot timezone."),
    },
    async ({ timezone }) => {
        try {
            const settings = loadSettings();
            const tz = timezone || settings.timezone;
            const now = new Date();
            const human = formatHumanTime(tz, now);
            return {
                content: [textContent(JSON.stringify({
                    iso: now.toISOString(),
                    human,
                    timezone: tz,
                    epoch_ms: now.getTime(),
                }))],
            };
        } catch (err) {
            return {
                content: [textContent(`Failed to get current time: ${toErrorMessage(err)}`)],
                isError: true,
            };
        }
    },
);
```

**`get_elapsed_time`** (renamed from `time_elapsed` for verb_noun consistency)
```typescript
const getElapsedTime = tool(
    "get_elapsed_time",
    "Calculate how much time has passed since a timestamp. Use this instead of doing date math yourself.",
    {
        since: z.string()
            .describe("ISO 8601 timestamp (e.g., '2026-02-17T14:30:00Z') or epoch milliseconds as string (e.g., '1708185600000')"),
    },
    async ({ since }) => {
        try {
            const parsed = /^\d+$/.test(since) ? Number(since) : new Date(since).getTime();
            if (isNaN(parsed) || !isFinite(parsed)) {
                return { content: [textContent("Invalid timestamp format. Use ISO 8601 or epoch milliseconds.")], isError: true };
            }
            const now = Date.now();
            const diffMs = now - parsed;
            const absMinutes = Math.floor(Math.abs(diffMs) / 60000);
            const totalHours = Math.floor(absMinutes / 60);
            const totalDays = Math.floor(totalHours / 24);

            const parts: string[] = [];
            if (totalDays > 0) parts.push(`${totalDays}d`);
            if (totalHours % 24 > 0) parts.push(`${totalHours % 24}h`);
            if (absMinutes % 60 > 0 || parts.length === 0) parts.push(`${absMinutes % 60}m`);
            const human = (diffMs < 0 ? "in " : "") + parts.join(" ") + (diffMs >= 0 ? " ago" : "");

            return {
                content: [textContent(JSON.stringify({
                    elapsed_ms: Math.abs(diffMs),
                    total_minutes: absMinutes,
                    total_hours: totalHours,
                    total_days: totalDays,
                    human,
                    is_future: diffMs < 0,
                }))],
            };
        } catch (err) {
            return {
                content: [textContent(`Failed to calculate elapsed time: ${toErrorMessage(err)}`)],
                isError: true,
            };
        }
    },
);
```

These are useful for non-heartbeat time reasoning: "is this PR older than 3 days?", "how long since the last deploy?", "when was this branch last updated?"

#### Research Insights: MCP Tool Design

**try/catch is mandatory (4 agents agree):** `get_current_time` throws `RangeError` on invalid timezone strings (e.g., `"Mars/Olympus"`). Every existing tool in `mcp-tools.ts` wraps handlers in try/catch with `toErrorMessage()`. Both new tools must follow this pattern.

**`isFinite()` guard on `get_elapsed_time` (security review):** A 1000-digit string of `9`s matches `/^\d+$/` and `Number()` returns `Infinity`. `Math.floor(Infinity / 60000)` produces `Infinity`. Add `!isFinite(parsed)` to the validation check.

**Rename for pattern consistency (pattern review):** Every existing read-only tool starts with `get_` or `query_` or `list_` (`get_container_stats`, `get_system_status`, `get_host_memory`). Renamed `time_elapsed` → `get_elapsed_time`.

**Rename output fields for clarity (TypeScript review):** The `hours` and `days` fields were ambiguous (total vs remaining). Renamed to `total_hours` and `total_days` to match `total_minutes`.

**Add examples to parameter descriptions (skills review):** The `since` parameter description now includes format examples: `'2026-02-17T14:30:00Z'` and `'1708185600000'`. This helps haiku-class models provide correct input.

**Extract shared time formatting (3 agents, #1 duplication risk):** The `toLocaleString("en-US", { ... })` options block is currently duplicated in `formatCurrentTime()` (queue-processor.ts), `buildHeartbeatPrompt()` (session-manager.ts), and the `get_current_time` tool. Extract to a shared `formatHumanTime(timezone, date?)` utility.

**Zod v4 `.describe()` ordering (framework docs):** In Zod v4, `.optional()` wipes `.describe()`. Always call `.describe()` last: `z.string().optional().describe(...)`. The current plan code is correct.

**Tool annotations available (SDK v0.2.27+):** The `tool()` function accepts an optional 5th argument `_extras` with `annotations`. Consider marking read-only tools with `{ annotations: { readOnly: true } }` in a future pass.

**Update `buildMcpToolsBlock()` (agent-native review):** The system prompt's MCP tools documentation block must list the two new tools so agents know they exist. Add:
```
"- `get_current_time` — Get the current date and time in any timezone",
"- `get_elapsed_time` — Calculate how much time has passed since a timestamp",
```

**References:**
- [Writing Effective Tools for AI Agents — Anthropic Engineering](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [MCP Tools Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP Best Practices Guide](https://modelcontextprotocol.info/docs/best-practices/)
- [Zod v4 .optional() wipes .describe() — Issue #4431](https://github.com/colinhacks/zod/issues/4431)

## Technical Considerations

**Race conditions:** Only 1 heartbeat processes at a time (`activeHeartbeatCount` guard). State file reads/writes happen within a single async function — no concurrent writes possible. User messages don't touch `heartbeat-state.json`. **Note:** If the `activeHeartbeatCount` guard is ever removed, `heartbeat-state.json` would need file locking or `O_EXCL` protection.

**Cold start / missing state:** `getDueTier()` defaults to `DEFAULT_TIMESTAMPS` (`{ quick: 0, hourly: 0, daily: 0 }`) for unknown threads. Epoch 0 means "never ran" → daily tier fires immediately on first heartbeat. This is correct behavior.

**Missing state file:** `loadHeartbeatState()` returns `{}` if the file doesn't exist or fails Zod validation (same pattern as `loadThreads()`). First write creates it.

**Partial failure:** If the agent starts daily tasks but the query times out, the `catch` block in `processHeartbeat` does NOT call `updateHeartbeatState()`. The tier stays overdue and retries next heartbeat cycle.

**Model selection:** Stays haiku for all tiers. Daily tasks that need deeper reasoning (PR reviews, cross-repo analysis) can be upgraded later by adding a `model` override per tier. Not needed now.

**No new dependencies:** Uses native `Date.now()` and `Date.toLocaleString()` — no date libraries needed. The MCP tools use the same patterns already in `formatCurrentTime()`.

**Stagger pattern preserved:** The existing stagger pattern (sleep `INTERVAL / THREAD_COUNT` between each thread's heartbeat injection in `heartbeat-cron.sh`) must not be broken by the refactored `processHeartbeat()` flow. No changes needed to `heartbeat-cron.sh`.

**Cache reset on error (TypeScript review):** The `loadHeartbeatState()` catch path must explicitly null the cache and reset mtime to 0, preventing a stale cache from persisting after a transient read error.

#### Research Insights: Performance at Scale

| Metric | 5 threads (current) | 20 threads | 100 threads |
|--------|---------------------|------------|-------------|
| `heartbeat-state.json` size | ~400B | ~1.6KB | ~8KB |
| JSON parse time | <0.01ms | <0.01ms | ~0.05ms |
| `statSync` calls per heartbeat | 2-3 | 2-3 | 2-3 |
| Total I/O overhead per heartbeat | <0.5ms | <0.5ms | <1ms |

For context, a single agent SDK query takes 5-120 seconds. The I/O overhead is 4-6 orders of magnitude smaller. No performance concerns at any realistic scale.

## Acceptance Criteria

- [ ] `heartbeat-state.json` created/updated atomically by `processHeartbeat()` — never by agent
- [ ] `heartbeat-state.json` validated with Zod schema on read — corrupted file auto-heals to `{}`
- [ ] `getDueTier()` correctly identifies due tier using epoch math (trivially testable)
- [ ] `buildHeartbeatPrompt()` accepts a `dueTier` parameter and generates focused directive
- [ ] HEARTBEAT.md template has no `## Timestamps` section
- [ ] Prompt includes migration instruction to remove existing `## Timestamps` sections
- [ ] Prompt includes heartbeat state observability line (`.borg/heartbeat-state.json` is read-only)
- [ ] `get_current_time` MCP tool returns ISO, human-readable, epoch_ms, and timezone; handles invalid timezone gracefully
- [ ] `get_elapsed_time` MCP tool accepts ISO and epoch input, returns elapsed time in multiple formats; handles invalid/infinite input
- [ ] Both MCP tools wrapped in try/catch with `toErrorMessage()` pattern
- [ ] Both MCP tools available to all threads (not master-only)
- [ ] Both MCP tools documented in `buildMcpToolsBlock()` system prompt section
- [ ] State file uses mtime cache pattern for reads; catch path resets cache
- [ ] Existing `[NO_UPDATES]` suppression continues working unchanged
- [ ] Master thread daily extras (cross-pollination, aggregation) still trigger correctly — explicitly preserved, not `// ...`
- [ ] System prompt self-management section (master and worker) preserved with tier-based evolution guidance
- [ ] Time formatting uses shared `formatHumanTime()` utility — no duplicated `toLocaleString` options
- [ ] `HeartbeatTier`, `HeartbeatTimestamps`, `HeartbeatState` types extracted as named types
- [ ] `saveHeartbeatState()` includes directory existence check (defensive, matching `saveThreads()`)
- [ ] Stagger pattern between thread heartbeats preserved in refactored flow

## Simplifications Applied (Deferred)

- **Per-tier model override** — All tiers use haiku. Can add `{ daily: "sonnet" }` config later.
- **Cron-triggered one-shot sessions** — Not needed now. The heartbeat loop + tier selection covers all current needs.
- **Cron task markdown files** — Deferred. If we need precise scheduling (e.g., "9 AM daily summary"), add later as `.borg/cron.d/*.md` files parsed by the cron script.
- **Time window constraints** — OpenClaw pattern of "only check email 9AM-9PM." Not needed yet.
- **`compare_time` MCP tool** — `get_elapsed_time` covers all current use cases. If agents need to compare two arbitrary timestamps (not just vs now), add later. Note: haiku agents comparing two arbitrary timestamps would need to compose two `get_elapsed_time` calls; if this proves unreliable, promote to a dedicated tool.
- **`get_heartbeat_status` MCP tool** — A read-only tool returning per-thread last-run timestamps and computed due tier. Not needed for MVP since agents can `cat .borg/heartbeat-state.json` + call `get_elapsed_time`. Add if agents need structured heartbeat health checks (e.g., master thread monitoring worker health).
- **Dashboard heartbeat endpoint** — `GET /api/heartbeat-status` to display heartbeat state in the dashboard. Not needed for MVP.
- **Forced tier upgrade** — No mechanism for agents or users to say "run daily tasks now." Cold start behavior (epoch 0 → daily fires immediately) covers the main case. If needed later, add a `trigger_heartbeat` command message with `forceTier` field.
- **Tool annotations** — SDK v0.2.27+ supports `{ annotations: { readOnly: true } }` on `tool()`. Nice to have for all read-only tools, but not blocking.
- **Lesson:** The prior plan's simplification #2 (removing code-side tier selection) was based on the assumption that haiku could reliably do timestamp math. This assumption proved false (~30-40% error rate). Future simplifications that depend on model capabilities rather than scope reduction should be tagged as "assumption-dependent" for easier re-evaluation.

## Files Changed

| File | Change |
|------|--------|
| `src/queue-processor.ts` | Add `HeartbeatTier`, `HeartbeatTimestamps`, `HeartbeatState` types, `HeartbeatStateSchema` Zod validator, `loadHeartbeatState()`, `saveHeartbeatState()`, `getDueTier()`, `updateHeartbeatState()`. Modify `processHeartbeat()` to use them. |
| `src/session-manager.ts` | Modify `buildHeartbeatPrompt(config, dueTier)` to accept tier param, simplify prompt, add state observability line, add migration instruction. Add `formatHumanTime()` export. Update `buildMcpToolsBlock()` to list new time tools. Preserve master thread extras and self-management section. |
| `src/mcp-tools.ts` | Add `get_current_time` and `get_elapsed_time` tools to the base tools array. Import `loadSettings` and `formatHumanTime` from session-manager. |

## MVP

### src/queue-processor.ts — `processHeartbeat()` changes

```typescript
// New: heartbeat types and constants
type HeartbeatTier = "quick" | "hourly" | "daily";

interface HeartbeatTimestamps {
    quick: number;
    hourly: number;
    daily: number;
}

type HeartbeatState = Record<string, HeartbeatTimestamps>;

const DEFAULT_TIMESTAMPS: HeartbeatTimestamps = { quick: 0, hourly: 0, daily: 0 };
const HOURLY_INTERVAL_MS = 60 * 60 * 1000;
const DAILY_INTERVAL_MS = 24 * HOURLY_INTERVAL_MS;

const HEARTBEAT_STATE_FILE = path.join(BORG_DIR, "heartbeat-state.json");

// Zod schema for I/O boundary validation
const HeartbeatTimestampsSchema = z.object({
    quick: z.number(),
    hourly: z.number(),
    daily: z.number(),
});
const HeartbeatStateSchema = z.record(z.string(), HeartbeatTimestampsSchema);

let heartbeatStateCache: HeartbeatState | null = null;
let heartbeatStateMtime = 0;

function loadHeartbeatState(): HeartbeatState {
    try {
        const mtime = fs.statSync(HEARTBEAT_STATE_FILE).mtimeMs;
        if (heartbeatStateCache && mtime === heartbeatStateMtime) return heartbeatStateCache;
        const raw: unknown = JSON.parse(fs.readFileSync(HEARTBEAT_STATE_FILE, "utf8"));
        const parsed = HeartbeatStateSchema.safeParse(raw);
        if (!parsed.success) return {};
        heartbeatStateCache = parsed.data;
        heartbeatStateMtime = mtime;
        return heartbeatStateCache;
    } catch {
        heartbeatStateCache = null;
        heartbeatStateMtime = 0;
        return {};
    }
}

function saveHeartbeatState(state: HeartbeatState): void {
    const dir = path.dirname(HEARTBEAT_STATE_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = HEARTBEAT_STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, HEARTBEAT_STATE_FILE);
    heartbeatStateCache = state;
    heartbeatStateMtime = fs.statSync(HEARTBEAT_STATE_FILE).mtimeMs;
}

function getDueTier(threadId: string): HeartbeatTier {
    const state = loadHeartbeatState();
    const ts = state[threadId] || DEFAULT_TIMESTAMPS;
    const now = Date.now();

    if (now - ts.daily > DAILY_INTERVAL_MS) return "daily";
    if (now - ts.hourly > HOURLY_INTERVAL_MS) return "hourly";
    return "quick";
}

function updateHeartbeatState(threadId: string, tier: HeartbeatTier): void {
    const state = loadHeartbeatState();
    const now = Date.now();
    if (!state[threadId]) state[threadId] = { ...DEFAULT_TIMESTAMPS };

    state[threadId].quick = now;
    if (tier === "hourly" || tier === "daily") state[threadId].hourly = now;
    if (tier === "daily") state[threadId].daily = now;

    saveHeartbeatState(state);
}

// Modified processHeartbeat — add tier selection + state update
async function processHeartbeat(msg: IncomingMessage): Promise<string> {
    const threads = loadThreads();
    const threadKey = String(msg.threadId);
    const threadConfig = threads[threadKey];
    if (!threadConfig) return "[NO_UPDATES]";

    const dueTier = getDueTier(threadKey);
    const heartbeatPrompt = buildHeartbeatPrompt(threadConfig, dueTier);
    // ... existing query logic ...

    const { text } = await collectQueryResponse(q);
    const response = text.trim() || "[NO_UPDATES]";

    // Always update state on successful response
    updateHeartbeatState(threadKey, dueTier);

    return response;
}
```

### src/session-manager.ts — shared utility + simplified `buildHeartbeatPrompt()`

```typescript
// New: shared time formatting utility (replaces duplicated toLocaleString calls)
export function formatHumanTime(timezone: string, date: Date = new Date()): string {
    return date.toLocaleString("en-US", {
        timeZone: timezone,
        weekday: "long", year: "numeric", month: "short",
        day: "numeric", hour: "numeric", minute: "2-digit",
        timeZoneName: "short",
    });
}

export function buildHeartbeatPrompt(
    config: ThreadConfig,
    dueTier: "quick" | "hourly" | "daily" = "quick",
): string {
    const settings = loadSettings();
    const now = formatHumanTime(settings.timezone);

    const tierDirective = {
        quick: "Execute ONLY your **Quick Tasks**.",
        hourly: "Execute your **Quick Tasks** AND **Hourly Tasks**.",
        daily: "Execute ALL tasks: **Quick**, **Hourly**, AND **Daily Tasks**.",
    }[dueTier];

    const parts: string[] = [
        `Current time: ${now}`,
        `Heartbeat tier: **${dueTier.toUpperCase()}**`,
        tierDirective,
        "",
        `Read HEARTBEAT.md from your working directory (${config.cwd}).`,
        `If it doesn't exist, create it with sections: Quick Tasks, Hourly Tasks, Daily Tasks, Urgent Flags, Notes.`,
        "",
        "Your heartbeat timing state is in `.borg/heartbeat-state.json` (read-only — timing is managed automatically).",
        "If your HEARTBEAT.md has a `## Timestamps` section, remove it — timing is now managed automatically.",
        "",
        "After executing your tasks:",
        "- If nothing needs human attention, reply with exactly `[NO_UPDATES]`",
        "- If something is actionable, describe ONLY the actionable items",
        "",
        "You may evolve your HEARTBEAT.md over time — add tasks relevant to this repo, remove irrelevant ones, reorder by priority. But do NOT add any timestamp tracking.",
    ];

    // Master thread daily extras — preserved from existing implementation
    if (config.isMaster && dueTier === "daily") {
        const threads = loadThreads();
        const threadInventory = Object.entries(threads)
            .map(([id, t]) => `threadId=${id} (${t.name}, repo: ${t.cwd})`)
            .join(", ");
        parts.push(
            "",
            "## Master Thread Daily Extras",
            `Active threads: ${threadInventory}`,
            "- Read each worker thread's HEARTBEAT.md (read-only — never edit another agent's files)",
            "- Identify patterns worth sharing across threads",
            "- Send advisory suggestions via `send_message` — workers evaluate independently",
            "- Aggregate thread reports into knowledge base",
            "- Flag threads that have NOT sent a daily report in the last 24 hours",
        );
    }

    return parts.join("\n");
}

// Also update buildMcpToolsBlock() to include:
// "- `get_current_time` — Get the current date and time in any timezone",
// "- `get_elapsed_time` — Calculate how much time has passed since a timestamp",
```

### src/mcp-tools.ts — new time tools

```typescript
// Import additions: loadSettings, formatHumanTime from session-manager.js

// Add to base tools array (available to all threads)
const getCurrentTime = tool(
    "get_current_time",
    "Get the current date and time. Use this instead of guessing the time.",
    {
        timezone: z.string().optional()
            .describe("IANA timezone (e.g., 'America/New_York'). Defaults to bot timezone."),
    },
    async ({ timezone }) => {
        try {
            const settings = loadSettings();
            const tz = timezone || settings.timezone;
            const now = new Date();
            const human = formatHumanTime(tz, now);
            return {
                content: [textContent(JSON.stringify({
                    iso: now.toISOString(),
                    human,
                    timezone: tz,
                    epoch_ms: now.getTime(),
                }))],
            };
        } catch (err) {
            return {
                content: [textContent(`Failed to get current time: ${toErrorMessage(err)}`)],
                isError: true,
            };
        }
    },
);

const getElapsedTime = tool(
    "get_elapsed_time",
    "Calculate how much time has passed since a timestamp. Use this instead of doing date math yourself.",
    {
        since: z.string()
            .describe("ISO 8601 timestamp (e.g., '2026-02-17T14:30:00Z') or epoch milliseconds as string (e.g., '1708185600000')"),
    },
    async ({ since }) => {
        try {
            const parsed = /^\d+$/.test(since) ? Number(since) : new Date(since).getTime();
            if (isNaN(parsed) || !isFinite(parsed)) {
                return { content: [textContent("Invalid timestamp format. Use ISO 8601 or epoch milliseconds.")], isError: true };
            }
            const now = Date.now();
            const diffMs = now - parsed;
            const absMinutes = Math.floor(Math.abs(diffMs) / 60000);
            const totalHours = Math.floor(absMinutes / 60);
            const totalDays = Math.floor(totalHours / 24);

            const parts: string[] = [];
            if (totalDays > 0) parts.push(`${totalDays}d`);
            if (totalHours % 24 > 0) parts.push(`${totalHours % 24}h`);
            if (absMinutes % 60 > 0 || parts.length === 0) parts.push(`${absMinutes % 60}m`);
            const human = (diffMs < 0 ? "in " : "") + parts.join(" ") + (diffMs >= 0 ? " ago" : "");

            return {
                content: [textContent(JSON.stringify({
                    elapsed_ms: Math.abs(diffMs),
                    total_minutes: absMinutes,
                    total_hours: totalHours,
                    total_days: totalDays,
                    human,
                    is_future: diffMs < 0,
                }))],
            };
        } catch (err) {
            return {
                content: [textContent(`Failed to calculate elapsed time: ${toErrorMessage(err)}`)],
                isError: true,
            };
        }
    },
);
```

## References

- Brainstorm: `docs/brainstorms/2026-02-11-onboarding-heartbeat-infra-brainstorm.md`
- Prior plan: `docs/plans/2026-02-11-feat-per-repo-heartbeat-self-management-plan.md`
- Architecture review: `docs/solutions/architecture-reviews/per-repo-heartbeat-self-management-and-cross-pollination.md`
- Cycle 2 systemic patterns: `docs/solutions/architecture-reviews/code-review-cycle-2-systemic-patterns-and-prevention.md`
- Full pipeline review: `docs/solutions/architecture-reviews/multi-agent-review-onboarding-heartbeat-infra.md`
- Agent container lifecycle: `docs/solutions/architecture-reviews/agent-driven-container-lifecycle-onboarding.md`
- MCP SDK limitation: `docs/solutions/integration-issues/sdk-v2-mcpservers-silent-ignore.md` (tools must use v1 `query()` API — already resolved)
- External: OpenClaw heartbeat-state.json pattern, TheoBrigitte/mcp-time compare_time tool, claude-code-scheduler project
- [Writing Effective Tools for AI Agents — Anthropic Engineering](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [MCP Tools Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [Less is More: MCP Design Patterns — Klavis](https://www.klavis.ai/blog/less-is-more-mcp-design-patterns-for-ai-agents)
- [write-file-atomic — npm](https://www.npmjs.com/package/write-file-atomic)
- [mtime comparison considered harmful — apenwarr](https://apenwarr.ca/log/20181113)
- [Zod v4 .optional() wipes .describe() — Issue #4431](https://github.com/colinhacks/zod/issues/4431)
- [Node.js 22 writeFileSync flush option — PR #50009](https://github.com/nodejs/node/pull/50009)
