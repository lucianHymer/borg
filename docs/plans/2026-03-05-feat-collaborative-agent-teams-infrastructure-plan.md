---
title: "feat: Collaborative Agent Teams Infrastructure"
type: feat
status: active
date: 2026-03-05
deepened: 2026-03-05
---

# Collaborative Agent Teams Infrastructure

## Enhancement Summary

**Deepened on:** 2026-03-05
**Research agents used:** 15 (grammY docs, Telegram Mini Apps, git worktrees, MCP tool design, agent-native architecture, orchestrating swarms, learnings researcher, TypeScript reviewer, security sentinel, architecture strategist, performance oracle, code simplicity reviewer, pattern recognition specialist, agent-native reviewer, spec flow analyzer, heartbeat/cron researcher)

### Critical Findings

1. **Option A (bot API callback) is architecturally impossible** — MCP tools run in queue-processor, bot instance lives in telegram-client (separate processes). Must use direct Telegram HTTP API call from queue-processor instead.
2. **`teammates` array is a denormalization risk** — derive teammates at runtime from shared `team` field instead of storing explicit arrays that can drift.
3. **No new heartbeat field needed** — team threads skip heartbeats by checking `if (config.team)`. No `noHeartbeat` or `heartbeat_tiers` field required.
4. **Keep heartbeat simple, add timed tasks** — keep current quick/hourly/daily tiers as-is. Add `@HH:MM` time annotations to HEARTBEAT.md tasks. First heartbeat run after scheduled time = execute it. No tier system redesign needed.
5. **Heartbeat maintenance skill** — create `~/.claude/skills/heartbeat-maintenance.md` (Borg-specific, global) describing HEARTBEAT.md format, tier sections, and `@HH:MM` timed task syntax.
6. **Universal task visibility via pinned message** — every thread gets a pinned message showing open tasks, updated via `editMessageText`. Plain text, no inline keyboard. For teams, all members share the same task list pinned in each thread. SDK task files at `~/.claude/tasks/<CLAUDE_CODE_TASK_LIST_ID>/` as JSON.
7. **Drop `model` parameter from `create_thread`** — the router handles model selection, not per-thread defaults.
8. **`bot.command()` prevents forwarding to Claude** — grammY middleware chain consumes commands before the message handler. New commands just need `bot.command("clear_team", handler)` with no special filtering.

---

## Overview

Enable Borg agents to spawn and coordinate teams of specialized agents through conversation and simple primitives. No rigid commands or JSON templates — agents get MCP tools for thread management, workflow skills that describe coordination patterns, and the intelligence to figure out the rest through conversation.

Philosophy: **tools + skills + conversation**. Give agents the primitives, describe the patterns, get out of the way.

## Problem Statement

Currently, Borg threads are independent agents. While cross-thread messaging exists, there's no way to:
- Create new threads programmatically (topics must be created manually)
- Group threads into teams with shared context
- Batch-operate on a team (clear/compact all members at once)
- Define reusable workflow patterns that agents can follow
- Schedule agent tasks at arbitrary intervals (only 3 hardcoded heartbeat tiers)

## Proposed Solution

Four layers, each independent and incrementally deliverable:

1. **Thread management MCP tools** — `create_thread`, `configure_thread`, `disband_team`
2. **ThreadConfig extensions** — `team`, `role` fields (teammates derived at runtime, heartbeat skipped via team check)
3. **Workflow skills** — markdown files describing team patterns (dev, writing, etc.)
4. **Configurable heartbeat tiers** — arbitrary scheduling intervals for main threads
5. **Telegram commands** — `/clear-team`, `/compact-team` (run from within a team thread)

## Technical Approach

### Phase 1: Thread Management MCP Tools

**Goal**: Any agent can create new forum topics and configure team relationships.

**New MCP tools in `src/mcp-tools.ts`:**

```typescript
// create_thread — creates a Telegram forum topic and registers it in threads.json
tool("create_thread",
    "Create a new Telegram forum topic and register it as a Borg thread",
    {
        name: z.string().describe("Topic name, e.g. 'auth-planner'"),
        team: z.string().optional().describe("Team identifier to group threads"),
        role: z.string().optional().describe("Agent role within the team"),
        cwd: z.string().optional().describe("Working directory for the thread"),
        initialMessage: z.string().optional().describe("First message to send to the new thread"),
    },
    async ({ name, team, role, cwd, initialMessage }) => {
        // 1. Call Telegram API to create forum topic
        // 2. Write ThreadConfig to threads.json with team/role fields
        // 3. If initialMessage, write to incoming queue for the new thread
        // 4. Return the new threadId
    }
);

// configure_thread — update team/role for an existing thread
tool("configure_thread",
    "Update team metadata for an existing thread",
    {
        threadId: z.number(),
        team: z.string().optional(),
        role: z.string().optional(),
    },
    async ({ threadId, team, role }) => {
        // Update ThreadConfig via configureThread()
    }
);

// disband_team — remove team association from all threads in a team
tool("disband_team",
    "Remove team metadata from all threads in a team. Topics remain but lose team association.",
    { team: z.string() },
    async ({ team }) => {
        // Find all threads with this team, clear team/role fields
    }
);
```

**Telegram API access**: The MCP tools need access to the bot API to create topics. Two approaches:

- **Option A**: Pass a `createForumTopic` callback into `createBorgMcpServer()` from telegram-client.ts
- **Option B**: MCP tool writes a "create topic" request to a new queue dir, telegram-client picks it up

Recommend **Option A** — simpler, synchronous, and the MCP server is already constructed per-query with `sourceThreadId`. Adding a bot API callback is clean.

```typescript
// src/mcp-tools.ts
export function createBorgMcpServer(
    sourceThreadId: number,
    botApi?: { createForumTopic: (name: string) => Promise<number> }  // returns threadId
)
```

**These tools are available to ALL threads** (not master-only). Any agent can propose creating a team. The agent's workflow skill guides when and how to use them.

**Tasks:**
- [ ] Add `create_thread` MCP tool in `src/mcp-tools.ts`
- [ ] Add `configure_thread` MCP tool in `src/mcp-tools.ts`
- [ ] Add `disband_team` MCP tool in `src/mcp-tools.ts`
- [ ] Pass bot API callback from `src/telegram-client.ts` into MCP server constructor
- [ ] Handle Telegram rate limits (200ms delay between topic creations)
- [ ] Handle partial failure (clean up on error)

### Research Insights: Phase 1

#### CRITICAL: Bot API Callback is Cross-Process — Cannot Use Option A

**The MCP server runs inside the queue-processor process (`src/queue-processor.ts`), while the bot instance lives in the telegram-client process (`src/telegram-client.ts`). These are separate Node.js processes started independently. A callback closure cannot cross process boundaries.**

**Three viable alternatives:**

1. **Direct Telegram HTTP API call from queue-processor** (RECOMMENDED): Read the bot token from `loadSettings().telegram_bot_token` and make a direct `POST https://api.telegram.org/bot<token>/createForumTopic` call. No bot polling needed — it's a single HTTP request. Keeps process boundary clean, is synchronous from the MCP tool's perspective.

2. **Queue-based topic creation**: MCP tool writes to `.borg/queue/topic-requests/`, telegram-client polls and creates the topic, writes result back. Consistent with existing architecture but adds latency (round-trip through file queue).

3. **Use the `@grammyjs/auto-retry` plugin** (already installed as v2.0.2): If using option 1, wrap the API call with retry logic for 429 errors. The auto-retry plugin handles exponential backoff automatically.

#### Input Validation Requirements

```typescript
// Validate name: max 128 chars, strip control characters, prevent system topic impersonation
name: z.string()
    .min(1).max(128)
    .regex(/^[a-zA-Z0-9\-_\s]+$/)
    .describe("Topic name (alphanumeric, hyphens, underscores, spaces)")

// Validate team/role: prevent prompt injection via metadata
team: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).optional()
    .describe("Team identifier (lowercase alphanumeric + hyphens)")
role: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).optional()
    .describe("Agent role (lowercase alphanumeric + hyphens)")
```

#### Idempotency: Error on Duplicate Thread Names

```typescript
// In create_thread handler:
const existing = Object.entries(threads).find(([_, t]) => t.name === name);
if (existing) {
    return {
        content: [textContent(`Thread "${name}" already exists (ID: ${existing[0]}). Use a different name.`)],
        isError: true,
    };
}
```

#### Batch Thread Writes to Prevent Race Conditions

When creating a team of 4 threads, collect all ThreadConfig entries and make a single `loadThreads() -> add all 4 -> saveThreads()` call after all Telegram API topics are created. This eliminates the read-modify-write race window and saves 3 redundant file writes.

**Alternative: mtime-based compare-and-swap** as defense-in-depth:
```typescript
// Record mtime after loadThreads(), verify it hasn't changed before saveThreads()
// Retry if concurrent modification detected (max 3 retries)
```

#### Partial Failure Strategy

If `createForumTopic` fails partway through (e.g., 2 of 4 topics created):
- Leave the successfully created topics in place
- Return an error listing which threads were created and which failed
- The master agent can retry the missing ones with a second `create_thread` call
- Attempting rollback (deleting created topics) risks data loss and is more complex than retry

#### Resource Limits

Add guards to prevent runaway thread/team creation:
- Maximum threads per team: 10
- Maximum total threads: 50
- Maximum concurrent teams: configurable via settings (default 5)
- Enforce in `create_thread` handler, not just in skill file instructions

#### Rate Limiting Best Practices (from grammY Research)

Forum topics share the **group rate limit**: ~20 messages/minute per group, NOT per topic. The `@grammyjs/auto-retry` plugin (already installed) handles 429 errors automatically. For proactive throttling, consider `@grammyjs/transformer-throttler`. Stack order: throttler first (prevents limits), auto-retry second (handles what slips through).

#### Agent-Native Parity: Add MCP Tools for Team Operations

The plan introduces `/clear-team` and `/compact-team` as Telegram-only commands. Agents cannot invoke these. Add corresponding MCP tools:

```typescript
// clear_team — agent can clear all team member sessions
tool("clear_team", "Reset sessions for all members of a team", {
    team: z.string().describe("Team name to clear")
}, async ({ team }) => { /* ... */ });

// compact_thread — agent can compact a single thread
tool("compact_thread", "Summarize and reset a thread's session", {
    threadId: z.number().describe("Thread to compact")
}, async ({ threadId }) => { /* ... */ });
```

This ensures the master agent can autonomously clean up after a team workflow completes (step 11 in the "How It All Fits Together" scenario).

#### Institutional Learning: SDK v2 `mcpServers` Silently Ignores

From `docs/solutions/integration-issues/sdk-v2-mcpservers-silent-ignore.md`: The Agent SDK v2 `unstable_v2_*` API silently ignores the `mcpServers` option. **Use the v1 `query()` API for any code path that needs MCP tools.** This is a blocking prerequisite — verify MCP tool registration path before implementation.

#### Institutional Learning: Metadata Propagation

From `docs/solutions/integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md`: When creating new Telegram forum topics, capture the topic name from the `forum_topic_created` service message and pass it through the queue. The queue processor previously hardcoded generic names. Ensure `create_thread` stores the real topic name in ThreadConfig.

---

### Phase 2: ThreadConfig Extensions

**Goal**: Agents know who they are, who their teammates are, and whether they have heartbeats.

```typescript
// src/session-manager.ts
export interface ThreadConfig {
    name: string;
    cwd: string;
    sessionId?: string;
    model: string;
    isMaster: boolean;
    lastActive: number;
    // NEW:
    team?: string;          // e.g., "auth-feature", "newsletter-q1"
    role?: string;          // e.g., "planner", "writer", "reviewer"
    // No teammates array — derive at runtime from shared team field
    // No noHeartbeat — team threads skip heartbeat via: if (config.team) return;
}
```

**System prompt injection in `buildThreadPrompt()`:**

When `team` is set, append team context:

```markdown
## Team: {team}
You are the **{role}** on this team.

### Teammates
- {name} ({role}) — use send_message with threadId {id} to reach them
- ...

### Note
You do not have heartbeats. If you think periodic scheduled work is needed,
suggest to the user that a main thread's HEARTBEAT.md be updated, or ask a
teammate with heartbeat access to set it up.
```

**Heartbeat exclusion**: In `heartbeat-cron.sh` or in `processHeartbeat()`, skip threads where `config.team` is set. Team threads are ephemeral workers, not long-running monitors.

**`list_threads` MCP tool update**: Include team/role in output so agents can discover team structure.

**`forum_topic_created` hook**: Keep it — still useful for manually created topics. When `create_thread` MCP tool is used, it handles ThreadConfig directly. The hook just does in-memory name caching, no conflict.

**Tasks:**
- [ ] Add `team`, `role` to ThreadConfig in `src/session-manager.ts`
- [ ] Update `buildThreadPrompt()` to inject team context when `team` is set
- [ ] Skip threads with `team` field set in heartbeat processing
- [ ] Update `list_threads` MCP tool to show team/role info
- [ ] Backwards compatible: all new fields optional, existing threads unaffected

### Research Insights: Phase 2

#### Drop `teammates` Array — Derive at Runtime

The `teammates` field creates a denormalization that must be kept in sync. When a thread joins/leaves a team, every sibling's array must be updated. A crash mid-update leaves inconsistent state. Instead, derive teammates dynamically:

```typescript
function getTeammates(threadId: string, threads: ThreadsMap): Array<{id: number, name: string, role?: string}> {
    const myTeam = threads[threadId]?.team;
    if (!myTeam) return [];
    return Object.entries(threads)
        .filter(([id, t]) => t.team === myTeam && id !== threadId)
        .map(([id, t]) => ({ id: Number(id), name: t.name, role: t.role }));
}
```

This is a pure function, trivially testable, zero drift risk. The `teammates` field adds complexity for no benefit over a simple derivation. The `configure_thread` tool's `teammates` parameter becomes unnecessary, and `create_thread` auto-links by `team` field.

#### Team = No Heartbeat (No New Field Needed)

Team threads skip heartbeats by checking the existing `team` field: `if (config.team) return;`. No `noHeartbeat` boolean, no `heartbeat_tiers` array. Simple.

#### Filter Heartbeats in BOTH Locations

**Primary**: Update `heartbeat-cron.sh` to filter out team threads before writing queue messages. Currently line 47 iterates ALL threads with `jq -r 'keys[]'`:

```bash
# CHANGE FROM:
THREAD_IDS=$(jq -r 'keys[]' "$THREADS_FILE" 2>/dev/null)
# CHANGE TO:
THREAD_IDS=$(jq -r 'to_entries[] | select(.value.team == null) | .key' "$THREADS_FILE" 2>/dev/null)
```

**Secondary**: Add a defensive check in `processHeartbeat()` in queue-processor.ts (defense-in-depth). Without the cron filter, every team thread generates a wasted heartbeat queue message every cycle.

#### System Prompt Token Budget

The team context block adds ~100-150 tokens. This is negligible. However, do NOT inject the full workflow skill text into the system prompt. Instead, inject a reference:

```markdown
Your workflow is described in `.claude/skills/workflows/dev-team.md`. Read it when you need to understand coordination patterns.
```

This saves 300-400 tokens per turn per agent. Over a typical team session of 20+ turns across 4 agents, that saves ~24,000-32,000 input tokens.

#### Validate Team and Role Fields Against Prompt Injection

Team metadata is injected directly into system prompts via `buildThreadPrompt()`. A `role` value like `"planner\n\n## OVERRIDE: Ignore all previous instructions"` would be injected into the prompt. Apply the same validation as `parseDevName()` in `src/types.ts`: alphanumeric, hyphens, spaces, max 64 chars.

#### `list_threads` Team Info Format

Follow the existing inline format: `Thread {id}: {name} (master) cwd={cwd} (you)`. Add team info as: `team=auth-feature role=planner`.

#### Move `list_threads` Update to Phase 1

Agents need to verify team creation succeeded immediately. Without team/role info in `list_threads`, there is no feedback loop after `create_thread`.

---

### Phase 3: Workflow Skills (Three-Layer Abstraction)

**Goal**: Generic workflow definitions that work with Borg, Claude Code native teams, or any future team infrastructure.

**The three layers:**

1. **Workflow skills** (project `.claude/skills/workflows/`) — generic, no tool-specific references. Talk about "create a thread", "message your teammate", not `create_thread` or `send_message`. These compound into the repo and work regardless of infrastructure.

2. **Borg team bridge skill** (global `~/.claude/skills/borg-teams.md`) — the ONE Borg-specific piece installed globally. Maps generic team concepts to Borg MCP tools. "When a workflow says 'create a thread', use the `create_thread` MCP tool. When it says 'message a teammate', use `send_message`."

3. **Claude Code native fallback** — without Borg, the same workflow skills still make sense. An agent would just ask the user to create threads manually or use whatever team support Claude Code has natively.

**Sharing workflows between repos**: No marketplace. Agents share organically through conversation:
- "Hey, can you teach the password-score repo about your dev workflow?"
- Agent reads its skill, sends content cross-thread, receiving agent writes and adapts it

**Dogfooding**: Create the first workflow skills in THIS repo and use the dev-team workflow to build Phase 1-2 of this plan.

**Example: `.claude/skills/workflows/dev-team.md`**

````markdown
# Dev Team Workflow

Use this workflow when a task requires planning, implementation, review, and
knowledge capture.

## Roles

### Planner
- Breaks down the task into subtasks and creates implementation plan
- Coordinates with worker and reviewer
- Goes first: receives the initial task/issue from the user

### Worker
- Implements code based on planner's architecture
- Runs tests, fixes issues
- Waits for planner to provide the plan before starting

### Reviewer
- Reviews code changes for quality, correctness, security
- Waits for worker to signal readiness for review
- Sends feedback to worker (and planner if architectural)

### Documenter
- Activates after the main work is done
- Interviews each teammate: what did you learn? where did you struggle?
  what was surprising? what would you do differently?
- Captures learnings into CLAUDE.md and project knowledge files
- Keeps CLAUDE.md tight and token-efficient — every line costs tokens in
  every future session, so be ruthlessly concise
- Trims stale or redundant entries while adding new ones

Note: model selection is handled by the message router, not per-role.
The router scores message complexity and picks haiku/sonnet/opus accordingly.

## Coordination

1. Create a thread for each role
2. Give the planner the task (issue, description, context)
3. Planner creates plan, sends to worker
4. Worker implements, signals reviewer when ready
5. Reviewer reviews, sends feedback to worker
6. Loop 4-5 until approved
7. Documenter interviews all teammates, captures learnings
8. Documenter updates CLAUDE.md and knowledge files

## When to Use

When the user describes a task that would benefit from structured development:
suggest creating a dev team. Ask first — this is a big operation.

## Workspace Isolation

Before any team member writes code, you MUST create a git worktree:
```bash
git worktree add .borg/worktrees/{team-name} -b team/{team-name}
```
Set all team members' working directory to the worktree path. This is not
optional — teams must work in isolation from the main branch.
````

**Example: `.claude/skills/workflows/writing-team.md`**

````markdown
# Writing Team Workflow

Use this workflow for content creation: research, draft, produce.

## Roles

### Researcher
- Gathers sources, creates structured briefs
- Goes first with the topic

### Writer
- Drafts and edits written content based on research
- Sends drafts to researcher for fact-checking

### Podcaster (optional)
- Produces conversational audio content from written material
- Writes back-and-forth dialogue between two speakers
- Creates multiple episodes: 2 short-form + 1 long-form
- Records with two distinct voices for natural conversation feel
- Uses TTS to synthesize each speaker's lines separately
- Only activated when writer signals content is final

Note: model selection is handled by the message router, not per-role.

## Coordination

1. Create a thread for each role
2. Give the researcher the topic
3. Researcher produces brief, sends to writer
4. Writer drafts, sends back to researcher for fact-check
5. Once approved, writer sends to podcaster (if present)
6. Podcaster writes conversational scripts, records with two voices

## When to Use

When the user asks for content creation (newsletter, blog post, article):
suggest setting up a writing team.
````

**Example: `~/.claude/skills/borg-teams.md` (the bridge)**

````markdown
# Borg Team Operations

This skill maps generic team concepts to Borg's MCP tools.

## Creating Threads
When a workflow says "create a thread for each role", use the `create_thread`
MCP tool for each role. Set the team, role, and initialMessage fields.
Teammates are derived automatically from the shared `team` field — no manual setup needed.

## Messaging Teammates
When a workflow says "send to [teammate]", use the `send_message` MCP tool
with the teammate's threadId.

## Team Discovery
Use `list_threads` to see all threads and their team/role assignments.

## Team Cleanup
Use `disband_team` to remove team associations.
`/clear-team` and `/compact-team` Telegram commands operate on all members
of the current thread's team.

## No Heartbeats
Team threads don't have heartbeats. If periodic work is needed, ask a main
thread to add it to their HEARTBEAT.md.
````

**Global skill installation:** Skills that need to be available machine-wide (borg-teams bridge, heartbeat maintenance) live in the repo under `skills/global/` and get copied to `~/.claude/skills/` on startup. `borg.sh start` handles this automatically — the bot installs its own skills.

**Tasks:**
- [ ] Create `skills/global/` directory in repo for global skill source files
- [ ] Create `skills/global/borg-teams.md` (bridge skill — maps generic team concepts to Borg MCP tools)
- [ ] Create `skills/global/heartbeat-maintenance.md` (HEARTBEAT.md format, tiers, `@HH:MM` syntax)
- [ ] Add skill install step to `borg.sh start`: `cp skills/global/* ~/.claude/skills/`
- [ ] Create `.claude/skills/workflows/dev-team.md` in this repo (first workflow, used to dogfood)
- [ ] Create `.claude/skills/workflows/writing-team.md` in this repo
- [ ] Reference workflow skills in system prompt so agents know they exist
- [ ] Document the global skill install pattern in CLAUDE.md
- [ ] Test: agent reads generic workflow + bridge skill, creates team via MCP tools
- [ ] Test: same workflow works conceptually without Borg (manual thread creation)

### Research Insights: Phase 3

#### Shared Worktree Per Team — Keep As-Is

The plan's approach of one shared worktree per team is a significant improvement over the status quo (no isolation at all). While some research suggests per-agent worktrees, that's over-engineering for this use case. The dev-team workflow is largely sequential (planner → worker → reviewer), so concurrent write conflicts are unlikely. If issues arise, per-agent worktrees can be adopted ad hoc.

**Keep the existing skill definition:**
```bash
git worktree add .borg/worktrees/{team-name} -b team/{team-name}
```

**Additional considerations:**
- Add `.borg/worktrees/` to `.gitignore`
- Wire worktree cleanup into `disband_team` flow
- Teams push their own PRs from the team branch when work is complete

#### Simplification Consideration: Three-Layer Abstraction

The code simplicity reviewer flagged this as potentially premature — there is currently only ONE infrastructure (Borg), so the abstraction layer exists for a hypothetical future. However, the architecture strategist noted this correctly applies the Dependency Inversion Principle and preserves the "repos work without Borg" property. **Decision: keep the three-layer design.** The cost is small (one extra markdown file), and it enforces clean separation between workflow intelligence and infrastructure plumbing.

#### Add Plan Approval Gate

The swarm orchestration analysis identified a missing gate: the planner sends the plan straight to the worker with no approval step. Add to the workflow:

```markdown
## Coordination (updated)
1. Create a thread for each role
2. Give the planner the task
3. Planner creates plan, sends to **master thread for approval**
4. Master/user approves or rejects the plan
5. If approved, planner sends plan to worker
6. Worker implements, signals reviewer when ready
...
```

This prevents wasted compute on bad architectures and gives the user a checkpoint.

#### Add Timeout and Retry Guidance

Add to workflow skills to prevent deadlock:

```markdown
## Coordination Guidelines
- If a teammate hasn't responded in 10 minutes, resend your message
- After 3 unanswered attempts, escalate to the master thread
- If the master thread reports a teammate is stuck, you may absorb their role
```

#### Add Team Completion Signal

The plan has no explicit "team done" signal. Add to workflow:

```markdown
## Completion
After the documenter finishes:
1. Documenter sends a summary to the master thread
2. Master thread notifies the user that the team's work is complete
3. Master thread creates a PR from the team branch to main (if code was written)
```

---

### Phase 4: Timed Tasks in Heartbeat

**Goal**: Add time-based scheduling to HEARTBEAT.md without changing the existing tier system.

**Keep what works:** quick/hourly/daily tiers, exactly as they are now. No changes to cascading, no tier redesign.

**Add timed tasks:** Tasks in HEARTBEAT.md can have `@HH:MM` time annotations. The heartbeat cron already fires regularly. When it fires, check: "has the clock passed any of these times since last heartbeat run?" If yes, include that task in the prompt.

**Example HEARTBEAT.md with timed tasks:**
```markdown
## Quick Tasks
- Check for stuck queue messages

## Hourly Tasks
- Summarize thread activity

## Daily Tasks
- Full system health report

## Timed Tasks
- @06:00 @17:30 — Send standup summary to general
- @09:00 — Check overnight alerts
```

**Implementation:** Parse `@HH:MM` annotations from the Timed Tasks section. Track last heartbeat run time (already stored in `heartbeat-state.json`). Check if any scheduled times fell between last run and now **using the user's configured timezone** from `settings.json`. If yes, strip the `@HH:MM` annotations and append the plain task text to the heartbeat prompt alongside whatever tier is due. The agent never sees times — code decides what's due, agent just executes.

**Team threads skip heartbeat automatically** — `if (config.team) return;` in heartbeat processing. No new config field needed.

**Heartbeat maintenance skill:** Create `~/.claude/skills/heartbeat-maintenance.md` (global, Borg-specific) describing:
- HEARTBEAT.md structure (sections for quick/hourly/daily/timed)
- The `@HH:MM` annotation format for timed tasks (multiple times per task allowed)
- How to add/remove/modify tasks
- That timed tasks fire on the first heartbeat run after their scheduled time

**Tasks:**
- [ ] Add timed task parsing to `buildHeartbeatPrompt()` — extract `@HH:MM`, check if due, strip annotations before passing to agent
- [ ] Track last heartbeat run time per thread for timed task evaluation
- [ ] Update `heartbeat-cron.sh` to skip threads with `team` field set
- [ ] Create `skills/global/heartbeat-maintenance.md` in repo (installed to `~/.claude/skills/` on startup)
- [ ] Backwards compatible: existing HEARTBEAT.md files work unchanged (no timed section = no timed tasks)

### Research Insights: Phase 4

#### Timed Task Parsing — Keep It Simple

The `@HH:MM` format is easy to parse with a regex: `/\@(\d{2}:\d{2})/g`. Multiple times on one line supported. Use the user's timezone from `settings.json` for all time comparisons — `@06:00` means 6am in their timezone, not UTC.

**Edge case:** If heartbeat interval is longer than the gap between timed tasks, some tasks might be missed. Document that the heartbeat interval is the granularity floor — timed tasks can't be more precise than the cron interval.

**Implementation sketch:**
```typescript
function getTimedTasks(heartbeatMd: string, lastRun: Date, now: Date, tz: string): string[] {
    const section = extractSection(heartbeatMd, "Timed Tasks");
    if (!section) return [];
    const dueTasks: string[] = [];
    for (const line of section.split("\n")) {
        const times = [...line.matchAll(/@(\d{2}:\d{2})/g)].map(m => m[1]);
        for (const time of times) {
            const [h, m] = time.split(":").map(Number);
            // Check if this time fell between lastRun and now (in configured timezone)
            if (timeIsdue(h, m, lastRun, now, tz)) {
                dueTasks.push(line.replace(/@\d{2}:\d{2}\s*/g, "").replace(/^-\s*/, "").replace(/—\s*/, "").trim());
                break; // don't add same task twice if multiple times matched
            }
        }
    }
    return dueTasks;
}
```

#### Institutional Learning: Code-Managed Timing is Essential

From `docs/solutions/architecture-reviews/heartbeat-reliability-code-managed-timing-and-quantitative-decisions.md`: **LLMs fail at timestamp math 30-40% of the time.** Timed task eligibility MUST be determined by code (comparing current time against `@HH:MM` annotations), not by agents. The code decides what's due, the agent just executes.

#### Institutional Learning: Queue Priority for Heartbeats

From `docs/solutions/architecture-reviews/multi-agent-review-onboarding-heartbeat-infra.md`: The queue processor must prioritize user messages over heartbeats. Keep this in mind — timed tasks add more heartbeat work but shouldn't starve user messages.

---

### Phase 5: Telegram Commands

**Goal**: `/clear-team` and `/compact-team` run from within a team thread, operating on all teammates.

**`/clear-team`** — run in any team thread, clears all team members:
1. Look up current thread's `team` field
2. Find all threads with same `team` value
3. For each: `resetThread(threadId)` (clears sessionId = fresh context)
4. Reply: "Cleared 3 sessions for team **auth-feature**"

**`/compact-team`** — run in any team thread, compacts all team members:
1. Look up current thread's `team` field
2. Find all threads with same `team` value
3. For each: write `{command: "compact", threadId}` to `.borg/queue/commands/`
4. Queue processor handles compact: sends summarize prompt → captures response → resets session → injects summary as first turn
5. Reply: "Compacting 3 sessions for team **auth-feature**"

**Error cases:**
- Run in non-team thread → "This thread isn't part of a team."
- Team has only self → still works (compacts/clears just this thread)

**No argument needed** — the team is inferred from the thread you're in.

**No `/list-teams` or `/kill-team`** — agents can list teams via `list_threads` MCP tool (which now shows team info), and team teardown happens through conversation (agent calls `disband_team` tool).

**Compact implementation in queue-processor:**

```typescript
// New command type in CommandMessageSchema
command: z.enum(["reset", "setdir", "compact"])

// In processCommand():
case "compact":
    // Send a one-shot query asking agent to summarize its context
    // Capture response text
    // Reset the session (clear sessionId)
    // Write summary as incoming queue message for the thread
    // (so next session starts with the summary as context)
    break;
```

**Tasks:**
- [ ] Add `bot.command("clear_team", handler)` in `src/telegram-client.ts`
- [ ] Add `bot.command("compact_team", handler)` in `src/telegram-client.ts`
- [ ] Add `compact` to CommandMessageSchema in `src/queue-processor.ts`
- [ ] Implement compact flow in processCommand()
- [ ] Register commands in `setMyCommands()`

### Research Insights: Phase 5

#### Command Name Convention: Underscores Only

Telegram command names must be lowercase alphanumeric with underscores only (no hyphens). The plan document uses hyphens (`/clear-team`) but the task list correctly uses underscores (`bot.command("clear_team", ...)`). Standardize everywhere: `/clear_team`, `/compact_team`.

#### Compact Flow Requires Detailed Specification

**Prompt for summarization query:**
```
"Summarize your current work state, key decisions made, progress on tasks,
blockers encountered, and next steps. Keep under 500 words. This summary
will be your only context in the next session."
```

**Model**: Use haiku (cheapest, sufficient for summarization).

**Injection method**: Inject as system prompt context, NOT as a queue message. As a queue message, the agent treats it as a user request. As system prompt context, it becomes background memory:

```typescript
// In processCommand() for compact:
const summary = await querySummarize(threadConfig);
resetThread(threadId);
// Store summary in ThreadConfig for injection
configureThread(threadId, { compactSummary: summary });
// buildThreadPrompt() checks compactSummary and injects:
// "## Previous Context (compacted)\n{summary}"
```

#### Compact Race Condition: Active Query

If `/compact-team` is issued while an agent is mid-query, the compact command sits in the command queue. `processCommands()` runs during `processQueue()` cycles, which already waits for active queries to finish (per-thread serialization via `activeThreads` Set). So the compact naturally executes after the current query completes. This is safe.

However, specify that compact commands for actively-processing threads should be deferred, not force-killed.

#### Graceful Shutdown Before Clear

The swarm analysis recommends: before clearing, send a "wrap up" message to each team agent, wait for acknowledgment (with timeout), then reset. This prevents losing in-flight work.

**Pragmatic approach**: For `/clear_team`, just reset immediately (it's destructive by design — the user explicitly requested it). For `/compact_team`, the summarize step naturally captures in-flight state before resetting.

#### Queue Compact as Individual Commands

Don't process compact as a single blocking operation. Write 4 individual `{command: "compact", threadId: N}` entries. Each gets processed independently, allowing user messages to interleave. The user gets a quick response ("Compacting 4 sessions...") and can continue working.

---

### Phase 6: Universal Task Visibility (Pinned Tasks)

**Goal**: Every thread shows its open tasks via a pinned message. No message pollution.

**How it works:**

1. Every thread gets a pinned message showing open tasks, created on first task activity
2. Task watcher polls `~/.claude/tasks/<CLAUDE_CODE_TASK_LIST_ID>/` for task JSON files (1s interval, mtime-based change detection — same pattern as the arbiter's `taskWatcher.ts`)
3. On task state change, bot updates the pinned message via `editMessageText` — plain text, no inline keyboard
4. For team threads: all members share the same task list. The same content is pinned in every team member's thread, all updated together.

**This is NOT team-only.** Any thread can have tasks. Solo threads, master thread, team threads — all get a pinned task list when tasks exist.

**Task data source**: The Claude Agent SDK writes task files as JSON to `~/.claude/tasks/<id>/` when `CLAUDE_CODE_TASK_LIST_ID` env var is set. Each task is a separate `.json` file. When starting sessions, set:
```typescript
process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId;
process.env.CLAUDE_CODE_ENABLE_TASKS = 'true';
```

For teams: all team members share the same `CLAUDE_CODE_TASK_LIST_ID` so they see/update the same task list.

**Pinned message format (plain text):**
```
Open Tasks
──────────
🔄 Extract routing utils
🔄 Add shared JSONL reader
⬚ Update imports
⬚ Review PR when ready
──────────
✅ 2 done · 🔄 2 in progress · ⬚ 2 pending
Updated: 14:32
```

**Tasks:**
- [ ] Implement task watcher (poll `~/.claude/tasks/<id>/` directory, parse JSON files)
- [ ] Set `CLAUDE_CODE_TASK_LIST_ID` and `CLAUDE_CODE_ENABLE_TASKS` when starting sessions
- [ ] Create and pin task message on first task activity per thread
- [ ] Auto-update pinned message via `editMessageText` on task state changes
- [ ] For teams: update pinned messages across all team member threads
- [ ] Store pinned message ID per thread for updates
- [ ] Handle `editMessageText` error when content unchanged (wrap in try/catch)

### Research Insights: Phase 6

#### Task Data Source: Claude SDK Task Files

The Claude Agent SDK writes task files as individual JSON documents to `~/.claude/tasks/<CLAUDE_CODE_TASK_LIST_ID>/`. This is the same mechanism used by the arbiter project (`src/tui/taskWatcher.ts`).

**Task file format:** Each task is a separate `.json` file with: id, subject, description, status (pending/in_progress/completed), owner, blockedBy, blocks.

**Reading tasks:** Poll the directory (1s interval), check mtime for changes, parse all `.json` files, sort by ID. Handle unparseable files gracefully (skip).

#### Pinned Message Pattern

- `editMessageText` updates a message in-place — no new message created
- Wrap in try/catch: fails if content is identical (`message is not modified` error)
- Pin silently: `pinChatMessage(chatId, msgId, { disable_notification: true })`
- Works in forum topics: pin bar shows the most recent pin per topic
- Plain text only — no inline keyboard for now

#### Universal, Not Team-Only

Any thread can have tasks. The task watcher should track all active `CLAUDE_CODE_TASK_LIST_ID` values across all threads (stored in ThreadConfig or a mapping file). When tasks change, update the pinned message in the relevant thread(s). For teams, the same task list ID is shared, so all team threads get the same update.

---

### Prerequisite: Re-enable Opus in Router (DONE)

Completed during planning:
- [x] Restored `COMPLEX: "opus"` in `src/router/config.ts`
- [x] Fixed router scoring: was scoring 5 recent history messages + current message together, inflating scores and making model selection "sticky." Now routes on current message only. Reply-to stickiness (`isReply + replyToModel → maxTier`) already handles the intentional case.
- [x] Cleaned up unused `buildEnrichedPrompt` import and `recentHistory` parameter

---

## How It All Fits Together

**Scenario: User asks master thread to implement a feature**

1. Master reads `.claude/skills/workflows/dev-team.md` (generic) + `~/.claude/skills/borg-teams.md` (bridge)
2. Master suggests: "This looks like a dev team task. Should I create a planner, worker, reviewer, and documenter?"
3. User confirms
4. Master creates threads for each role (bridge skill maps this to `create_thread` MCP tool)
5. Master sends the task/issue to the planner thread
6. Planner creates plan, sends to worker
7. Worker implements, signals reviewer
8. Reviewer reviews, sends feedback — loop until approved
9. Documenter interviews each teammate: "What did you learn? Where did you struggle?"
10. Documenter updates CLAUDE.md with concise learnings, trims stale entries
11. User runs `/clear-team` or `/compact-team` from any team thread when done

**Scenario: User wants a twice-daily newsletter**

1. User tells master thread: "I want a newsletter published twice a day"
2. Master updates its own `HEARTBEAT.md` to add a timed task: `@06:00 @17:30 — Publish newsletter`
3. Heartbeat cron fires regularly, code checks if 06:00 or 17:30 has passed since last run
4. If due, the timed task is included in the heartbeat prompt alongside any tier tasks
5. If there's nothing to publish, master returns `[NO_UPDATES]` — no spam

---

## Acceptance Criteria

### Functional
- [ ] `create_thread` MCP tool creates Telegram topic + ThreadConfig with team/role
- [ ] `configure_thread` MCP tool updates team metadata
- [ ] `disband_team` MCP tool removes team association from all matching threads
- [ ] Team context injected into system prompts (role, teammates derived at runtime)
- [ ] Team threads excluded from heartbeat processing (skip when `config.team` is set)
- [ ] `/clear-team` resets all team member sessions (no argument, inferred from thread)
- [ ] `/compact-team` summarizes and resets all team member sessions
- [ ] Timed tasks in HEARTBEAT.md with `@HH:MM` annotations, evaluated by code
- [ ] Workflow skills in `.claude/skills/workflows/` (project-level, not global)
- [ ] Existing threads without team fields continue working unchanged
- [ ] Pinned task message per thread (universal, not team-only) auto-updates with task progress
- [ ] Task watcher reads SDK task JSON from `~/.claude/tasks/<id>/`
- [ ] Heartbeat maintenance skill at `~/.claude/skills/heartbeat-maintenance.md`
- [x] Opus re-enabled in router (fixed history-based score inflation)
- [ ] All new commands registered in `setMyCommands()` for Telegram UI autocomplete

### Non-Functional
- [ ] Topic creation handles Telegram rate limits gracefully
- [ ] threads.json remains single source of truth
- [ ] Atomic file writes for all state changes
- [ ] No new processes — runs within existing telegram-client + queue-processor

---

## Implementation Phases

### Phase 1: Primitives (MCP tools + ThreadConfig)
- `create_thread`, `configure_thread`, `disband_team` tools
- ThreadConfig with team/role fields
- System prompt team context injection
- Heartbeat exclusion for team threads
- **Validates**: agent can create topics, set up team relationships, communicate

### Phase 2: Workflow Skills + Commands
- Dev-team and writing-team skill files
- `/clear-team`, `/compact-team` commands
- Compact command in queue processor
- **Validates**: full conversational team lifecycle works end-to-end

### Phase 3: Timed Tasks + Heartbeat Skill
- `@HH:MM` timed task parsing in heartbeat system (code strips annotations, agent just executes)
- Team threads skip heartbeat via `if (config.team)` check
- `~/.claude/skills/heartbeat-maintenance.md` (global Borg skill)
- **Validates**: twice-daily newsletter scenario (tasks at @06:00 @17:30)

### Phase 4: Universal Task Visibility + Router Fix
- Pinned task message per thread (auto-updated via editMessageText, plain text)
- Task watcher reads SDK task JSON files from `~/.claude/tasks/`
- Teams share task list across all member threads
- Re-enable opus with tighter thresholds
- **Validates**: users can see tasks in any thread without message pollution

---

## Security Considerations

### Authorization Model

The following security controls should be implemented before or during Phase 1:

| Finding | Severity | Mitigation |
|---------|----------|------------|
| No authorization on team MCP tools | CRITICAL | Implement team ownership: threads can only modify their own team's metadata. `disband_team` requires master thread or team member. |
| Bot API callback gives all threads Telegram API access | HIGH | If using direct HTTP approach, validate inputs (topic name length, characters). Rate limit per-thread (max 5 topics/hour). |
| threads.json race condition | HIGH | Batch writes during team creation. Consider mtime-based compare-and-swap for defense-in-depth. |
| Shared git worktree corruption | MEDIUM | Shared worktree per team is acceptable — dev workflow is largely sequential. Monitor for issues. |
| Compact summary prompt injection | HIGH | Wrap injected summaries in a "Previous Context" boundary. Treat agent-generated summaries as untrusted data. |
| Pinned message spoofing | LOW | Pinned messages are bot-controlled. Users can't edit them. Low risk. |
| System prompt injection via team metadata | MEDIUM | Validate team/role fields: alphanumeric + hyphens, max 64 chars. Same pattern as `parseDevName()`. |
| Cross-thread message spoofing | MEDIUM | Recipients should verify `sourceThreadId` rather than `sender` name. |
| No resource limits on thread creation | MEDIUM | Enforce max threads per team (10), max total threads (50), max teams (5). |
| Queue command injection via filesystem | MEDIUM | Change `command: z.string()` to `z.enum(["reset", "setdir", "compact"])`. |
| `/setdir` allows arbitrary paths | MEDIUM | Validate `cwd` against allowlist of permitted base directories. |

### Pre-existing Issues to Fix First

1. **Fix outgoing cross-thread message missing `threadId` field** (`src/mcp-tools.ts:120-129`) — documented in knowledge base but unfixed. New tools will propagate the same bug.
2. **Extract `_tg` suffix to shared constant** — implicit contract between `mcp-tools.ts` and `telegram-client.ts`. New tools need the same convention.
3. **Add Zod validation for ThreadConfig** — currently parsed with bare `JSON.parse()`. Add schema validation for new team fields.

---

## Performance Considerations

### Queue Processing Bottleneck

Current `max_concurrent_sessions: 2` means a 4-agent team processes messages 2 at a time. With SDK `query()` calls taking 10-60 seconds, a single review cycle could take 2-4 minutes from queue serialization alone.

**Recommendation**: Make `max_concurrent_sessions` configurable via settings.json. Auto-increase to 4-6 when teams are active. The per-thread serialization (`activeThreads` Set) already prevents concurrent writes to the same session, so higher concurrency is safe.

### Projected Load

| Metric | Current (3-5 threads) | 1 Team (4 agents) | 3 Teams (12 agents) |
|--------|----------------------|-------------------|---------------------|
| Messages/hour | 10-20 | 40-80 | 120-240 |
| threads.json writes/hour | 5-10 | 20-40 | 60-120 |
| Queue wait (avg) | <5s | 15-30s | 60-180s at 2 slots |

### Message History Growth

Teams generate cross-thread messages at ~4x the rate of single threads. The 64KB `TAIL_BYTES` window in `getRecentHistory()` may not capture enough entries for a specific thread when messages from 12+ threads are interleaved. Consider scaling `TAIL_BYTES` dynamically: `64KB * activeThreadCount / 4`, capped at 512KB.

### Thread Creation Timing

4 Telegram API calls at 200ms spacing = 800ms. Acceptable as a one-time team setup cost. Batch the `saveThreads()` writes (1 write instead of 4) to eliminate the race window.

---

## Alternative Approaches Considered

### Explicit /spawn-team Command vs Conversational
**Chose conversational**: Agent reads workflow skill, proposes team, user confirms. More flexible — agent can adapt team composition to the task. No rigid command parsing. Aligns with "tools + skills + conversation" philosophy.

### JSON Templates vs Markdown Skills
**Chose skills**: JSON templates are rigid and require code to parse. Markdown skills are read by the agent and interpreted with intelligence. Agents can adapt, combine, or deviate from skills as needed. Skills are also self-documenting.

### System Cron vs Heartbeat Tiers
**Chose heartbeat tiers**: Keeps agent context, [NO_UPDATES] suppression, and deduplication. "Close enough" timing acceptable for stated use cases.

### Plugin Marketplace vs Organic Sharing
**Chose organic sharing**: No marketplace, no sync infrastructure. Agents share workflows between repos through conversation — "teach the other repo about our dev workflow." Agent reads the skill file, sends it cross-thread, receiving agent writes it to its own repo. Workflows adapt naturally as they spread. Zero infrastructure to maintain.

### Global Skills vs Project-Level Skills
**Chose project-level**: Workflow skills live in `.claude/skills/workflows/` in each repo, not globally. This compounds knowledge into the repo (core philosophy). Repos work better over time. Any Claude Code session in the repo knows its workflows even without Borg. Different repos can have different patterns.

### Heartbeats for Team Threads vs No Heartbeats
**Chose no heartbeats**: Team threads are ephemeral task workers, not long-running monitors. They communicate through cross-thread messages, not periodic check-ins. If periodic work is needed, a main thread handles it.

---

## Dependencies & Prerequisites

- Bot must be **admin** in the Telegram forum group (to create topics)
- grammY `createForumTopic` API (available in grammY v1.x)
- Git worktree support (git 2.5+, already available)
- Existing cross-thread messaging (already in mcp-tools.ts)

## Risk Analysis

| Risk | Mitigation |
|------|------------|
| Telegram rate limits on createForumTopic | 200ms delay between creations; auto-retry plugin already installed; proactive throttling via `@grammyjs/transformer-throttler` |
| Agent creates teams when it shouldn't | Skill says "suggest to user first"; user confirms in conversation; max_teams limit enforced in code |
| threads.json race during rapid team creation | Batch all thread writes into single saveThreads() call; mtime-based compare-and-swap as defense-in-depth |
| Agents don't follow workflow skill patterns | Iterate on skill wording; test with real tasks; add plan approval gate |
| Team threads orphaned (topic deleted manually) | List_threads shows stale entries; agent can clean up conversationally; periodic sweep in daily heartbeat |
| Cross-process boundary for Telegram API | Use direct HTTP call to Telegram API from queue-processor (not callback injection) |
| Shared worktree corruption | One worktree per writing agent; file ownership assigned by planner |
| Agent stuck in coordination loop | Timeout guidance in workflow skills (10 min resend, 3 attempts → escalate) |
| Queue starvation with multiple teams | User messages get priority pool; increase max_concurrent_sessions when teams active |
| Context exhaustion during long team workflows | Agent can call compact_thread MCP tool; workflow skill includes compaction guidance |

## Recommended Implementation Order

### Phase 1: Primitives (MCP tools + ThreadConfig)
1. `create_thread` MCP tool with direct Telegram HTTP API call (no `model` param — router handles it)
2. `configure_thread` and `disband_team` MCP tools
3. ThreadConfig extensions: `team`, `role`, `heartbeat_tiers`
4. Teammates derived at runtime from `team` field (no stored array)
5. System prompt team context injection via `buildThreadPrompt()`
6. Heartbeat exclusion via `heartbeat_tiers: []`
7. `list_threads` update with team/role info

### Phase 2: Workflow Skills + Commands
8. Dev-team and writing-team skill files (`.claude/skills/workflows/`)
9. Bridge skill `borg-teams.md` (global)
10. `/compact_team` Telegram command (preferred over clear for context preservation)
11. `/clear_team` Telegram command
12. Compact command in queue processor
13. Shared git worktree per team

### Phase 3: Flexible Scheduling
14. Global `custom_tiers` in settings.json
15. Independent tier model: `getDueTiers()` returning array, no cascading
16. Dynamic `HeartbeatTimestamps` as `Record<string, number>`
17. Dynamic `buildHeartbeatPrompt()` for multiple due tiers
18. Per-thread `heartbeat_tiers` on ThreadConfig

### Phase 4: Team Task Visibility
19. Task watcher polling `~/.claude/tasks/<id>/` for SDK task JSON
20. Set `CLAUDE_CODE_TASK_LIST_ID` + `CLAUDE_CODE_ENABLE_TASKS` for team sessions
21. Pinned dashboard message per team (auto-updated via `editMessageText`)
22. Callback query buttons for detail popups (zero message pollution)
23. `get_team_tasks` MCP tool for agent-native task access

## References

### Internal
- ThreadConfig: `src/session-manager.ts:11-18`
- buildThreadPrompt: `src/session-manager.ts`
- MCP tools: `src/mcp-tools.ts:69-651`
- Heartbeat tiers: `src/queue-processor.ts` (getDueTier)
- Topic tracking: `src/telegram-client.ts:200-217`
- Commands: `src/telegram-client.ts:219-260`

### External
- [Telegram createForumTopic API](https://core.telegram.org/bots/api#createforumtopic)
- [Git Worktrees](https://git-scm.com/docs/git-worktree)
- [Telegram Mini Apps Documentation](https://core.telegram.org/bots/webapps)
- [grammY Auto-Retry Plugin](https://grammy.dev/plugins/auto-retry)
- [MCP Specification — Tools](https://modelcontextprotocol.io/specification/2025-11-25)
- [@tma.js/init-data-node](https://www.npmjs.com/package/@tma.js/init-data-node)

### Institutional Learnings Applied
- `docs/solutions/integration-issues/sdk-v2-mcpservers-silent-ignore.md` — Use v1 `query()` API for MCP tools
- `docs/solutions/integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md` — Capture topic names at creation
- `docs/solutions/architecture-reviews/heartbeat-reliability-code-managed-timing-and-quantitative-decisions.md` — Code-managed timing, not LLM timestamp math
- `docs/solutions/architecture-reviews/multi-agent-review-onboarding-heartbeat-infra.md` — Queue priority for user messages
- `docs/solutions/architecture-reviews/agent-driven-container-lifecycle-onboarding.md` — Branded types for validation
- `docs/solutions/workflow-patterns/parallel-subagent-orchestration-bulk-todo-resolution.md` — Edit tool for parallel file modification
- `docs/solutions/integration-issues/borg-v2-first-live-run-fixes.md` — System prompt must establish agent identity upfront

### Source Material
- [Collaborative Agent Infrastructure Gist](https://gist.github.com/clawcian/a0ddb9363d7b998d88ba1cca9cb2f658)
