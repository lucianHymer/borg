---
title: "feat: Routing feedback via emoji reactions"
type: feat
date: 2026-02-19
brainstorm: docs/brainstorms/2026-02-19-routing-feedback-brainstorm.md
deepened: 2026-02-19
---

# Routing Feedback via Emoji Reactions

## Enhancement Summary

**Deepened on:** 2026-02-19
**Research agents used:** 12 (security-sentinel, kieran-typescript-reviewer, code-simplicity-reviewer, pattern-recognition-specialist, performance-oracle, agent-native-reviewer, architecture-strategist, julik-frontend-races-reviewer, data-integrity-guardian, data-migration-expert, grammY-docs-researcher, telegram-api-researcher)

### Critical Fixes from Review

1. **`RoutingMetadata` missing `model` field** — LogEntry needs `model` but RoutingMetadata didn't carry it. Added `model: string` to RoutingMetadata. Without this, every logged entry would have `model: undefined`.
2. **`replyToModel` serialization breakage** — `lookupMessageModel()` return type change from `string` to `{model, threadId}` breaks the existing caller at telegram-client.ts:243 which passes result as `replyToModel` to the queue. Queue-processor validates with `z.string().optional()` and would REJECT all reply-to-bot messages. Fix: extract `.model` at call site.
3. **LogEntry lacks type discriminator** — Added `type: "decision"` for proper discriminated union. Old entries without `type` treated as decisions for backwards compat.
4. **Bot self-reaction filter unnecessary** — Telegram Bot API confirmed: bots do NOT receive `message_reaction` updates for reactions set by bots. Remove the self-reaction check.
5. **Log only on successful send** — Logging routing decisions for responses the user never saw creates noise. Changed from try/finally to only-on-success.
6. **Growth estimate corrected** — Raw user messages average ~500B, not multi-KB. Growth is ~3-5x (not 120x). Rotation at 10MB every ~250 days, not 8 days.

### New Considerations Discovered

- **Agent-native parity gap**: Dashboard gets routing data but agents have zero MCP tools for it. Must add `get_routing_decisions` and `log_routing_correction` MCP tools.
- **Dashboard correction ordering bug**: Reversed array means latest correction loses to oldest. Must compare timestamps when building corrections map.
- **Prompt sanitization needed**: Raw user text in JSONL — truncate to 4096 chars, strip control characters.
- **escapeHtml doesn't escape quotes**: Need `escapeAttr()` for HTML attribute contexts (title tooltip).
- **Tier summary percentages wrong**: `entries.length` includes corrections, diluting denominators.
- **Bot must be admin in group** to receive reaction events (Telegram Bot API requirement).
- **Server-side correction merge** preferred over client-side to keep dashboard HTML simple.

---

## Overview

Users can react to bot responses with model emojis (⚡ haiku, ✍ sonnet, 🔥 opus) to correct routing decisions. Corrections are stored in the routing JSONL log alongside enriched routing entries (now with full prompt text and Telegram messageId). The dashboard routing tab displays prompts and corrections for analysis. MCP tools provide programmatic access for LLM analysis.

## Problem Statement / Motivation

The 14-dimension router makes model selection decisions, but there's no feedback loop to know when it gets it wrong. Users see the model emoji on each response but have no way to signal "this should have been sonnet, not haiku." Without feedback data, weight tuning is guesswork.

Additionally, the routing log stores only a SHA-256 hash of the prompt, making the dashboard routing tab useless for understanding what was actually asked.

## Proposed Solution

Four connected changes:

1. **Enrich routing log** — Replace `promptHash` with the raw user message text. Add Telegram `messageId` and `threadId` to each entry. Move the log write to after Telegram send (when messageId is known).

2. **Capture corrections** — Add a `message_reaction` handler. When a user reacts to a bot response with a different model emoji, append a `CorrectionEntry` to the same routing JSONL.

3. **Display in dashboard** — Add Prompt and Correction columns to the routing table. Server-side merge of corrections onto decisions before serving the API.

4. **Agent access** — Add MCP tools for querying routing decisions and logging corrections programmatically.

## Technical Approach

### Architecture Decisions

1. **Nested `routingMetadata` on OutgoingMessage** — Routing decision data flows through the queue as an optional nested object. Provides a natural guard: cross-thread and heartbeat messages lack this field, so logging is skipped for them. This is the first nested object on OutgoingMessage (all existing fields are flat scalars), justified because it groups related optional data and serves as a structural guard.

2. **Extend `message-models.json` values to `{model, threadId}`** — The `MessageReactionUpdated` Telegram event lacks `message_thread_id` (confirmed: not in the Telegram Bot API spec). To include `threadId` in CorrectionEntries, store it alongside the model at `storeMessageModel()` time. Normalize on load: old string values converted to `{model: value, threadId: 0}` immediately, file rewritten on first startup.

3. **`[...DEFAULT_UPDATE_TYPES, "message_reaction"]`** — Defensive approach for `allowed_updates`. `DEFAULT_UPDATE_TYPES` is exported from `"grammy"` and explicitly excludes `message_reaction`. Appends to defaults rather than replacing them, avoiding regressions.

4. **Log only on successful send** — If the Telegram send throws, the user never sees the response, so there is no message to react to. Logging a routing decision for an invisible response creates noise with zero analytical value. Only log when `sent.message_id` is available.

5. **First chunk only for messageId** — Multi-chunk responses log the first chunk's Telegram messageId. Corrections on later chunks are accepted (lookupMessageModel works for all chunks) but cannot be linked back to the LogEntry. Acceptable trade-off.

6. **ROUTING_LOG as shared constant** — Export from routing-logger.ts so both processes use the same path. Add a comment: "Single-writer: only telegram-client.ts should write to this path." The `appendFileSync` concurrency model is safe for single-writer on ext4 (O_APPEND atomic for writes < 4096 bytes).

7. **Server-side correction merge** — The `/api/routing/recent` endpoint in dashboard.ts merges corrections onto decisions before serving. The API always returns flat objects with an optional `userCorrection` field. Dashboard HTML never knows corrections are separate entries — simpler client code.

8. **Bot self-reaction filtering not needed** — Telegram Bot API confirmed: "Updates are not received for reactions set by bots." The bot's own `setMessageReaction` calls (model indicator emojis) will never trigger the reaction handler. No filter needed.

### Data Flow

```
queue-processor.ts                    telegram-client.ts
─────────────────                    ────────────────────
routeMessage()
  ├── route() → RoutingDecision
  ├── [NO logDecision() here anymore]
  └── return {effectiveModel, decision}
           │
processMessage()
  ├── SDK query → response
  └── write OutgoingMessage {
        ...existing fields,
        routingMetadata: {          ◄── NEW
          tier, model, confidence,
          signals, tokens, prompt
        }
      }
                                     pollOutgoingQueue()
                                       ├── read OutgoingMessage
                                       ├── sendMessage() → sent.message_id
                                       ├── storeMessageModel(id, model, threadId)
                                       ├── reactWithModel()
                                       └── if (data.routingMetadata && firstSentId) {
                                             logDecision(...)  ◄── NEW location
                                           }

                                     bot.on("message_reaction")
                                       ├── filter: chat ID matches
                                       ├── find model emoji in emojiAdded
                                       ├── lookupMessageModel(msg_id)
                                       ├── filter: different model
                                       └── logCorrection(...)  ◄── NEW
```

### Research Insights: grammY Reactions API

**Confirmed via grammY source and Telegram Bot API docs:**

- `MessageReactionUpdated` has exactly 7 fields: `chat`, `message_id`, `user?`, `actor_chat?`, `date`, `old_reaction[]`, `new_reaction[]`. **No `message_thread_id`** — this is a Telegram API limitation, not a grammY omission.
- `DEFAULT_UPDATE_TYPES` is exported from `"grammy"` (confirmed in `grammy/out/bot.js`). It explicitly excludes `message_reaction` and `message_reaction_count`.
- `ctx.reactions()` helper provides: `emoji`, `emojiAdded`, `emojiKept`, `emojiRemoved`, `customEmoji*`, `paid*`.
- `bot.reaction(["⚡", "✍", "🔥"], handler)` is more idiomatic than `bot.on("message_reaction")` + manual filtering. It internally calls `this.observedUpdateTypes.add("message_reaction")`.
- **Bot must be admin in group** to receive reaction events. Private chats work without admin.
- Users can change multiple reactions at once — `emojiAdded` can be multi-element array.
- 79 valid Telegram reaction emoji. ⚡, ✍, 🔥 are all in the valid set.
- Anonymous reactions: `user` is undefined, `actor_chat` is populated. Handle both.

**References:**
- [grammY Reactions Guide](https://grammy.dev/guide/reactions)
- [Telegram Bot API - MessageReactionUpdated](https://core.telegram.org/bots/api#messagereactionupdated)
- [Telegram Bot API - setMessageReaction](https://core.telegram.org/bots/api#setmessagereaction)

## Implementation Plan

### Phase 1: Data Model Changes

**`src/routing-logger.ts`**

- Update `LogEntry` type: add `type: "decision"` discriminator, replace `promptHash: string` with `prompt: string`, add `messageId?: number`, add `threadId?: number`
- Add `CorrectionEntry` type: `{ts, type: "correction", messageId, threadId?, originalModel, correctedModel}`
- Add Zod schemas for both types (I/O boundary validation)
- Add `logCorrection(correction: CorrectionEntry, logPath: string): void` — appends to same JSONL
- Update `logDecision()` signature to accept `RoutingMetadata`, `messageId`, `threadId`, `model`, and `logPath`
- Sanitize prompt before logging: strip control characters (U+0000-U+001F excluding tab), truncate to 4096 chars
- Export `ROUTING_LOG` path constant (currently private in queue-processor.ts)
- Remove `import { createHash } from "crypto"` (dead code after removing promptHash)
- Keep rotation at 10MB (corrected growth: ~40KB/day at 50 msgs/day, rotates every ~250 days)

```typescript
// routing-logger.ts — updated types
export type LogEntry = {
    type: "decision";             // discriminator (old entries without type treated as decisions)
    ts: number;
    prompt: string;               // raw user message, sanitized+truncated (was promptHash)
    messageId?: number;           // Telegram message ID (undefined if send failed)
    threadId?: number;            // forum thread ID
    tier: Tier;
    model: string;
    tokens: number;
    confidence: number;
    signals: string[];
};

export type CorrectionEntry = {
    type: "correction";
    ts: number;
    messageId: number;
    threadId?: number;            // optional (0 for old message-models entries)
    originalModel: string;
    correctedModel: string;
};

export type RoutingLogEntry = LogEntry | CorrectionEntry;

// Zod schemas for validation
export const LogEntrySchema = z.object({
    type: z.literal("decision").optional(),  // optional for backwards compat
    ts: z.number(),
    prompt: z.string().optional(),           // optional for old entries with promptHash
    promptHash: z.string().optional(),       // backwards compat
    messageId: z.number().optional(),
    threadId: z.number().optional(),
    tier: z.string(),
    model: z.string(),
    tokens: z.number(),
    confidence: z.number(),
    signals: z.array(z.string()),
});

export const CorrectionEntrySchema = z.object({
    type: z.literal("correction"),
    ts: z.number(),
    messageId: z.number(),
    threadId: z.number().optional(),
    originalModel: z.string(),
    correctedModel: z.string(),
});

// Prompt sanitization
function sanitizePrompt(prompt: string): string {
    return prompt
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')  // strip control chars except tab/newline
        .substring(0, 4096);  // Telegram max message length
}
```

#### Research Insights: Data Model

- **Discriminated union on `type`**: Adding `type: "decision"` to LogEntry enables proper TypeScript narrowing via `entry.type` check. Old JSONL entries without `type` are treated as decisions for backwards compat (dashboard checks `e.type === 'correction'`, everything else is a decision).
- **CorrectionEntry.threadId should be optional**: `threadId: 0` from backwards-compat message-models entries is semantically "unknown thread." Use `threadId?: number` (optional) instead of required, matching LogEntry's pattern.
- **Zod at I/O boundaries**: Per project convention, all data read from files should be validated. `readRecentJsonl()` in dashboard.ts currently does bare `JSON.parse(line) as T`. The Zod schemas enable validation at the API endpoint before serving to clients.
- **Prompt sanitization is load-bearing**: `JSON.stringify` escapes newlines correctly, but raw control characters could cause issues. Truncation to 4096 (Telegram's max message length) bounds worst-case entry size at ~4.3KB, well under the 256KB tail window in `readRecentJsonl()`.

**`src/types.ts`**

- Add `RoutingMetadata` type (with `model` field — critical fix)
- Add optional `routingMetadata?: RoutingMetadata` to `OutgoingMessage`
- Add Zod schema for RoutingMetadata (validated in telegram-client on read)

```typescript
// types.ts additions
import type { Tier } from "./router/types.js";

export interface RoutingMetadata {
    tier: Tier;                   // Tier union, not string (preserves type safety)
    model: string;                // effective model after reply-upgrade logic (CRITICAL: was missing)
    confidence: number;
    signals: string[];
    tokens: number;
    prompt: string;               // raw user message text
}

// Zod schema for validation in telegram-client
export const RoutingMetadataSchema = z.object({
    tier: z.enum(["SIMPLE", "MEDIUM", "COMPLEX"]),
    model: z.string(),
    confidence: z.number().min(0).max(1),
    signals: z.array(z.string()).max(50),
    tokens: z.number().nonneg(),
    prompt: z.string().max(8192),
});

// OutgoingMessage — add:
routingMetadata?: RoutingMetadata;
```

#### Research Insights: Type Safety

- **`tier: Tier` not `string`**: Import and use the `Tier` union from `./router/types.js`. Since RoutingMetadata crosses a JSON serialization boundary, the Zod schema re-narrows `string` back to `Tier` on the receiving side.
- **`model` field is critical**: The original plan omitted `model` from RoutingMetadata. The effective model (after reply-upgrade logic in `routeMessage()`) is needed for LogEntry. Without it, `model: undefined` in every logged entry.
- **Zod validation on RoutingMetadata**: Validate in telegram-client before passing to `logDecision()`. Catches malformed queue files from corrupted writes or misbehaving agent threads.

**`src/telegram-client.ts` — message-models schema change**

- Change `storeMessageModel(messageId, model)` → `storeMessageModel(messageId, model, threadId)`
- Change stored value from `string` to `{model: string, threadId: number}`
- Change `lookupMessageModel()` return from `string | undefined` to `{model: string, threadId: number} | undefined`
- **Normalize on load** (not on read): `loadMessageModels()` converts all string values to `{model, threadId: 0}` on first read and rewrites the file. Eliminates permanent mixed-type state.
- **CRITICAL: Update `replyToModel` call site** at line 243 — extract `.model` from the returned object:

```typescript
// telegram-client.ts line 243 — MUST extract .model
const stored = isReplyToBot && ctx.msg.reply_to_message
    ? lookupMessageModel(ctx.msg.reply_to_message.message_id)
    : undefined;
const replyToModel = stored?.model;  // string | undefined (for queue Zod validation)
```

Without this fix, `replyToModel` would be an object `{model, threadId}`, failing the `z.string().optional()` validation in queue-processor.ts and breaking ALL reply-to-bot messages.

- Update all callers (5 call sites for store, 2 for lookup including the new reaction handler)

#### Research Insights: message-models Migration

- **Normalize on load, not on read**: Option A from data integrity review. `loadMessageModels()` converts all string values to `{model, threadId: 0}` in memory and rewrites the file. Every consumer sees a uniform type. No permanent mixed-type state.
- **Pruning at 1000 entries**: Old string entries age out in ~20 days (50 msgs/day). With normalize-on-load, they are cleaned up on first startup after deploy.
- **Cache type change**: `Record<string, string>` → `Record<string, {model: string, threadId: number}>` for the in-memory cache. No polymorphic cache needed if normalizing on load.
- **Rollback concern**: If rollback is needed, old code expects `Record<string, string>` but file now contains objects. Old code would read `[object Object]` as the model string, breaking reply-model-upgrade. **Rollback requires deleting message-models.json** (safe — it's a transient cache that rebuilds naturally).

### Phase 2: Routing Log Relocation

**`src/queue-processor.ts`**

- Remove `logDecision()` call from `routeMessage()` (line 639)
- Remove `ROUTING_LOG` constant (moved to routing-logger.ts)
- Add routing metadata to `OutgoingMessage` construction in `processMessage()`:

```typescript
// queue-processor.ts — in processMessage(), OutgoingMessage construction
const responseData: OutgoingMessage = {
    // ...existing fields...
    routingMetadata: {
        tier: decision.tier,
        model: effectiveModel,        // CRITICAL: include effective model
        confidence: decision.confidence,
        signals: decision.signals,
        tokens: decision.estimatedTokens,
        prompt: message,  // raw user message, NOT enrichedPrompt
    },
};
```

**`src/telegram-client.ts`**

- Import `logDecision`, `logCorrection`, and `ROUTING_LOG` from routing-logger.ts
- After sending response and getting `sent.message_id`, call `logDecision()` with full data:

```typescript
// telegram-client.ts — in pollOutgoingQueue(), after sending first chunk successfully
if (data.routingMetadata && firstSentId) {
    const parsed = RoutingMetadataSchema.safeParse(data.routingMetadata);
    if (parsed.success) {
        try {
            logDecision(parsed.data, firstSentId, data.threadId, ROUTING_LOG);
        } catch (err) {
            log("ERROR", `Failed to log routing decision: ${err}`);
        }
    }
}
```

- Log once per OutgoingMessage (on first chunk), not per chunk
- Guard with `data.routingMetadata && firstSentId` — cross-thread messages and heartbeats lack this field, failed sends lack firstSentId
- Place the logDecision call at the end of the OutgoingMessage processing block, after all send paths resolve, rather than duplicating inside each send branch

#### Research Insights: Log Relocation

- **Architecture boundary relaxation**: Moving logDecision from queue-processor to telegram-client changes telegram-client from "I/O only" to "I/O + thin routing log finalization." This is a pragmatic compromise to capture the Telegram messageId. Update CLAUDE.md architecture comment.
- **Zod validation before logging**: Validate `routingMetadata` with `RoutingMetadataSchema.safeParse()` before passing to `logDecision()`. Catches malformed queue files at the I/O boundary. Per project convention: "Zod at I/O boundaries."
- **Single log call, not per-path**: Place `logDecision` at the end of the OutgoingMessage processing block rather than duplicating inside each send path (status-edit, fresh-message, fallback). Track `firstSentId` across all paths and log once at the end.
- **Cross-process JSONL safety**: Both processes use `appendFileSync` (O_APPEND atomic on ext4 for writes < 4096 bytes). Rotation race is extremely narrow (~once per 250 days) and benign (one entry lost, caught by try/catch). Add comment documenting this.

### Phase 3: Reaction Handler

**`src/telegram-client.ts`**

- Add `allowed_updates` to `bot.start()`:

```typescript
import { DEFAULT_UPDATE_TYPES } from "grammy";

bot.start({
    allowed_updates: [...DEFAULT_UPDATE_TYPES, "message_reaction"],
    onStart: async () => { /* existing */ },
});
```

- Add reverse emoji→model map:

```typescript
const EMOJI_TO_MODEL: Record<string, string> = {
    "⚡": "haiku",
    "✍": "sonnet",
    "🔥": "opus",
};
```

- Add reaction handler:

```typescript
bot.on("message_reaction", async (ctx) => {
    // Filter: correct chat
    if (!ctx.chat || String(ctx.chat.id) !== settings.telegram_chat_id) return;

    // Note: bot self-reactions do NOT trigger this handler (Telegram API guarantee)

    const messageId = ctx.messageReaction.message_id;
    const reactions = ctx.reactions();

    // Find model emoji in newly added reactions
    let correctedModel: string | undefined;
    for (const emoji of reactions.emojiAdded) {
        if (EMOJI_TO_MODEL[emoji]) {
            correctedModel = EMOJI_TO_MODEL[emoji];
            break;
        }
    }
    if (!correctedModel) return; // non-model emoji, ignore

    // Look up original model
    const stored = lookupMessageModel(messageId);
    if (!stored) {
        log("DEBUG", `Reaction on message ${messageId} — model entry not found (pruned or non-bot)`);
        return;
    }

    // Filter: must be different model (same model = not a correction)
    if (correctedModel === stored.model) return;

    // Validate model values before logging
    const VALID_MODELS = new Set(["haiku", "sonnet", "opus"]);
    if (!VALID_MODELS.has(stored.model)) return;

    // Log correction
    logCorrection({
        ts: Date.now(),
        type: "correction",
        messageId,
        threadId: stored.threadId || undefined,  // omit if 0 (unknown)
        originalModel: stored.model,
        correctedModel,
    }, ROUTING_LOG);

    log("INFO", `Routing correction: ${stored.model} → ${correctedModel} (msg ${messageId})`);
});
```

#### Research Insights: Reaction Handler

- **No self-reaction filter needed**: Telegram Bot API confirmed: "Updates are not received for reactions set by bots." The bot's `setMessageReaction` calls (model indicators, acknowledgment eyes) will never trigger this handler. Removed the `ctx.from?.id === bot.botInfo.id` check.
- **Defensive null guard on ctx.chat**: Added `!ctx.chat ||` guard. While grammY guarantees `ctx.chat` for `message_reaction` updates, defensive check costs nothing and prevents edge-case crashes.
- **Debug log for pruned lookups**: When `lookupMessageModel` returns undefined, log at DEBUG level. Makes data loss from message-models pruning observable.
- **Validate originalModel**: Check `stored.model` against known model set before logging. Prevents data pollution from tampered message-models entries.
- **threadId: omit if 0**: Use `stored.threadId || undefined` to avoid storing meaningless `threadId: 0` from backwards-compat entries.
- **Bot must be admin**: Reaction updates only delivered if bot is admin in the group. Document in deployment checklist.
- **Anonymous reactions**: `user` may be undefined for anonymous group admins. Handler doesn't depend on `user` field, so this is safe.
- **Multiple simultaneous reactions**: `emojiAdded` can be multi-element. The `for` loop with `break` takes the first model emoji, which is correct.

### Phase 4: Dashboard

**`src/dashboard.ts`**

- Update `/api/routing/recent` to perform server-side merge: read `RoutingLogEntry[]`, build corrections map by messageId, attach `userCorrection` to matching decisions, return flat objects.

```typescript
// dashboard.ts — server-side merge in /api/routing/recent handler
const raw = readRecentJsonl<RoutingLogEntry>(ROUTING_LOG, n);
const decisions: any[] = [];
const corrections: Record<number, { correctedModel: string; ts: number }> = {};

for (const entry of raw) {
    if ((entry as any).type === "correction") {
        const corr = entry as CorrectionEntry;
        const existing = corrections[corr.messageId];
        if (!existing || corr.ts > existing.ts) {  // latest correction wins
            corrections[corr.messageId] = { correctedModel: corr.correctedModel, ts: corr.ts };
        }
    } else {
        decisions.push(entry);
    }
}

// Merge corrections onto decisions
for (const d of decisions) {
    if (d.messageId && corrections[d.messageId]) {
        d.userCorrection = corrections[d.messageId].correctedModel;
    }
}

res.json(decisions);
```

- SSE feed handler: differentiate CorrectionEntry in the SSE stream. When a correction arrives, send it as `{type: "correction_update", messageId, correctedModel}` so the client can patch the existing row without full re-render.

#### Research Insights: Server-Side Merge

- **Brainstorm alignment**: The brainstorm explicitly said "flat data model" with optional `userCorrection` field. Server-side merge means the API returns exactly this — `LogEntry` objects with optional `userCorrection: string`. Dashboard HTML never knows corrections are separate entries.
- **Correction ordering**: Process JSONL in file order. When array is reversed (newest first), oldest correction for a messageId would win without the `ts` comparison. Always compare timestamps: `if (!existing || corr.ts > existing.ts)`.
- **Tier summary fix**: Use `decisions.length` (not `entries.length`) as the denominator for tier percentages. Corrections inflate the total otherwise.

**`static/dashboard.html`**

- Add two columns to the routing table header: **Prompt** (truncated, with tooltip) and **Correction** (model badge or empty)
- Update table header colspan for empty state (6 → 8)
- Add `escapeAttr()` utility for HTML attribute contexts
- Update `renderRoutingTable()`:
  1. No more client-side correction merge — API returns flat objects with `userCorrection`
  2. Handle old schema: if `entry.prompt` is undefined, show `entry.promptHash ? "[hashed]" : "—"`
- Prompt column: `truncate(entry.prompt, 80)` with a title attribute using `escapeAttr` for hover
- Correction column: if `entry.userCorrection`, show `modelBadge(entry.userCorrection)`
- SSE handler: when a `correction_update` event arrives, find the matching entry in `state.routingEntries` by messageId, set `userCorrection`, patch the DOM row instead of full re-render

```javascript
// dashboard.html — escapeAttr utility
function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// dashboard.html — simplified renderRoutingTable() (no client-side merge needed)
function renderRoutingTable() {
    var entries = state.routingEntries;

    // Tier summary uses only decision entries (entries from API are pre-merged)
    var counts = { SIMPLE: 0, MEDIUM: 0, COMPLEX: 0 };
    entries.forEach(function(e) { if (counts[e.tier] !== undefined) counts[e.tier]++; });
    var total = entries.length || 1;

    // Render rows
    var html = '';
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        html += '<tr data-msg-id="' + (e.messageId || '') + '">' +
            '<td>' + formatTimestamp(e.ts) + '</td>' +
            '<td>' + tierBadge(e.tier) + '</td>' +
            '<td>' + modelBadge(e.model) + '</td>' +
            '<td>' + ((e.confidence || 0) * 100).toFixed(0) + '%</td>' +
            '<td>' + (e.tokens || '?') + '</td>' +
            '<td title="' + escapeAttr(e.prompt || '') + '">' +
                escapeHtml(truncate(e.prompt || e.promptHash || '\u2014', 80)) + '</td>' +
            '<td class="correction-cell">' +
                (e.userCorrection ? modelBadge(e.userCorrection) : '') + '</td>' +
            '<td style="...">' + escapeHtml((e.signals || []).join(', ')) + '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
}

// SSE handler — patch correction without full re-render
state.eventSources.routing = createSSE('/api/routing/feed', function(evt) {
    var entry = JSON.parse(evt.data);
    if (entry.type === 'correction') {
        // Patch existing row
        for (var i = 0; i < state.routingEntries.length; i++) {
            if (state.routingEntries[i].messageId === entry.messageId) {
                state.routingEntries[i].userCorrection = entry.correctedModel;
                var row = document.querySelector('[data-msg-id="' + entry.messageId + '"]');
                if (row) {
                    var cell = row.querySelector('.correction-cell');
                    if (cell) cell.innerHTML = modelBadge(entry.correctedModel);
                }
                break;
            }
        }
    } else {
        state.routingEntries.unshift(entry);
        if (state.routingEntries.length > 200) state.routingEntries.pop();
        renderRoutingTable();
    }
});
```

#### Research Insights: Dashboard

- **escapeAttr for title attributes**: The existing `escapeHtml()` (using `textContent`/`innerHTML`) does NOT escape double quotes. A prompt containing `"` would break out of the `title="..."` attribute. Added `escapeAttr()` that chains `escapeHtml` + explicit quote escaping.
- **Incremental SSE updates**: Full `innerHTML` replacement on every SSE event destroys scroll position and tooltips. For corrections, patch the existing row's correction cell via DOM query (`data-msg-id` attribute). Only do full re-render for new decision entries.
- **Orphaned corrections**: A CorrectionEntry whose parent LogEntry is outside the API's 200-entry window won't match any row. With server-side merge, orphaned corrections are silently dropped from the API response (acceptable — they would show as standalone rows with no prompt/tier context anyway).
- **Old schema handling**: Entries with `promptHash` but no `prompt` show "[hashed]". Entries with neither show "—" (em dash).

### Phase 5: Agent Access (MCP Tools)

**`src/mcp-tools.ts`**

Add two new MCP tools to close the agent-native parity gap:

1. **`get_routing_decisions`** — Read-only, available to all threads. Returns recent routing log entries with optional filters.

```typescript
const getRoutingDecisions = tool(
    "get_routing_decisions",
    "Get recent routing decisions from the routing log. Returns tier, model, confidence, signals, prompt text, and any user corrections.",
    {
        n: z.number().optional().describe("Number of entries (default 50, max 200)"),
        threadId: z.number().optional().describe("Filter by thread ID"),
        correctionsOnly: z.boolean().optional().describe("Only return entries with corrections"),
    },
    async ({ n = 50, threadId, correctionsOnly }) => {
        const entries = readRecentJsonl(ROUTING_LOG, Math.min(n, 200));
        // Apply server-side merge (same logic as dashboard API)
        // Filter by threadId if specified
        // Filter to corrections-only if specified
        return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
    },
);
```

2. **`log_routing_correction`** — Master-only (mutation). Accepts messageId + correctedModel.

```typescript
const logRoutingCorrection = tool(
    "log_routing_correction",
    "Log a routing correction for a message that was routed to the wrong model.",
    {
        messageId: z.number().describe("Telegram message ID of the misrouted response"),
        correctedModel: z.enum(["haiku", "sonnet", "opus"]).describe("The model that should have handled this"),
    },
    async ({ messageId, correctedModel }) => {
        const stored = lookupMessageModel(messageId);
        if (!stored) return { content: [{ type: "text", text: "Message not found in model cache (may be pruned)" }] };
        if (correctedModel === stored.model) return { content: [{ type: "text", text: "Same model — not a correction" }] };
        logCorrection({
            ts: Date.now(), type: "correction", messageId,
            threadId: stored.threadId || undefined,
            originalModel: stored.model, correctedModel,
        }, ROUTING_LOG);
        return { content: [{ type: "text", text: `Correction logged: ${stored.model} → ${correctedModel}` }] };
    },
);
```

**`src/session-manager.ts`**

- Add both tools to `buildMcpToolsBlock()`:
  - `get_routing_decisions` in the all-threads section (read-only)
  - `log_routing_correction` in the master-only section (mutation)

#### Research Insights: Agent-Native Parity

- **Project principle violated**: "Every dashboard endpoint needs MCP tool counterpart at design time." The dashboard gains routing data, corrections, and prompt text — agents had zero access. The `get_routing_decisions` tool closes this gap.
- **Programmatic correction enables analysis workflow**: The plan envisions "manual/LLM analysis" of corrections but the original plan provided no programmatic correction path. The `log_routing_correction` tool enables agents to flag misrouting patterns discovered during analysis.
- **Read-only for all, mutations for master**: Following the established MCP tool tiering pattern. `get_routing_decisions` available to all threads. `log_routing_correction` gated behind `sourceThreadId === 1`.
- **Shares readRecentJsonl + merge logic**: Import the same merge function used by the dashboard API. No code duplication.

## Acceptance Criteria

- [ ] User reacts to bot response with different model emoji → CorrectionEntry appears in routing.jsonl
- [ ] User reacts with same model emoji → no correction logged
- [ ] User reacts with non-model emoji (thumbs up, heart) → ignored
- [ ] User reacts to non-bot message → ignored (lookupMessageModel returns undefined)
- [ ] Bot's own `setMessageReaction` calls do not trigger the handler (Telegram API guarantee)
- [ ] Routing log entries include `type: "decision"` discriminator
- [ ] Routing log entries include full user message text (not hash), sanitized and truncated
- [ ] Routing log entries include `model`, Telegram `messageId`, and `threadId`
- [ ] Dashboard routing tab shows Prompt column with truncated text and tooltip
- [ ] Dashboard routing tab shows Correction column when feedback exists
- [ ] Old routing log entries (with promptHash) render gracefully in dashboard
- [ ] Cross-thread messages do not produce routing log entries
- [ ] Only successful Telegram sends produce routing log entries
- [ ] `message-models.json` stores `{model, threadId}`, normalized on load
- [ ] `replyToModel` call site extracts `.model` string (not object)
- [ ] `escapeAttr()` used for HTML attribute contexts
- [ ] Tier summary percentages exclude correction entries from denominator
- [ ] `get_routing_decisions` MCP tool returns merged routing data
- [ ] `log_routing_correction` MCP tool enables programmatic corrections (master-only)
- [ ] Bot is admin in group (deployment prerequisite)

## Dependencies & Risks

**Dependencies:**
- grammY must support `message_reaction` in `allowed_updates` (confirmed: exported from "grammy")
- Telegram Bot API must deliver reaction updates for the group (bot must be admin, reactions enabled in group settings)

**Risks:**
- **Routing log growth** — Full prompts increase entry size ~3-5x (not 120x as originally estimated). Raw user messages average ~500 bytes. At 50 msgs/day, growth is ~40KB/day. 10MB rotation triggers every ~250 days. No threshold change needed.
- **Multi-chunk correction orphaning** — Corrections on chunks 2+ cannot link to the LogEntry. Low impact: users typically react to the first/only message.
- **Rotation boundary orphaning** — If a CorrectionEntry triggers file rotation, its parent LogEntry is in the rotated file. Dashboard merge fails. Low impact: corrections typically arrive shortly after the decision.
- **message-models.json rollback** — If rollback is needed, old code expects `Record<string, string>` but file now contains objects. **Rollback requires deleting message-models.json** (safe — transient cache, rebuilds naturally).
- **Privacy regression** — Raw prompts now in plaintext JSONL served via unauthenticated dashboard API. Acceptable for internal tool on trusted network. Document in deployment notes.
- **Cross-process rotation race** — Both telegram-client processes could theoretically race on rotation. Window is extremely narrow (~once per 250 days), at most one entry lost. Caught by try/catch. Documented with comment.

## Simplifications Applied

1. **No automated weight adjustment** — Feedback is for manual/LLM analysis only (scope-reduction: safe)
2. **No reaction removal handling** — Latest correction per messageId wins; no retraction entries (scope-reduction: safe)
3. **First chunk messageId only** — Multi-chunk responses log one messageId (scope-reduction: safe, low-impact)
4. **No dedicated corrections API endpoint** — Corrections are merged server-side and served via existing `/api/routing/recent` and SSE feed (scope-reduction: safe)
5. **Prompt stored as raw user message, not enriched** — Enriched prompt (with 5 history messages) can be 24KB; raw message is typically <1KB. Enriched prompt is in prompts.jsonl if needed (assumption-dependent: assumes raw message provides enough context for analysis. Re-evaluate if LLM analysis frequently needs conversation history to judge routing.)

## Files Changed

| File | Changes |
|---|---|
| `src/types.ts` | Add `RoutingMetadata` interface (with `model` field), add `RoutingMetadataSchema`, add `routingMetadata?` to `OutgoingMessage` |
| `src/routing-logger.ts` | Add `type: "decision"` to `LogEntry`, replace `promptHash` with `prompt`, add `messageId/threadId`, add `CorrectionEntry` type, add Zod schemas, add `logCorrection()`, add prompt sanitization, export `ROUTING_LOG` constant, update `logDecision()` signature, remove `createHash` import |
| `src/queue-processor.ts` | Remove `logDecision()` call from `routeMessage()`, remove `ROUTING_LOG` constant, add `routingMetadata` (with `model`) to OutgoingMessage construction |
| `src/telegram-client.ts` | Extend `storeMessageModel()`/`lookupMessageModel()` for `{model, threadId}` with normalize-on-load, **fix `replyToModel` call site** to extract `.model`, add `EMOJI_TO_MODEL` reverse map, add `message_reaction` handler (no self-filter needed), add `allowed_updates`, import+call `logDecision()` after successful send with Zod validation, import `logCorrection` and `ROUTING_LOG` |
| `src/dashboard.ts` | Server-side merge of corrections in `/api/routing/recent`, SSE sends correction updates as typed events |
| `src/mcp-tools.ts` | Add `get_routing_decisions` (read-only, all threads) and `log_routing_correction` (master-only) MCP tools |
| `src/session-manager.ts` | Add new MCP tools to `buildMcpToolsBlock()` |
| `static/dashboard.html` | Add `escapeAttr()`, add Prompt and Correction columns (colspan 6→8), simplified `renderRoutingTable()` (API returns pre-merged data), incremental SSE correction patching via `data-msg-id` |
| `CLAUDE.md` | Update telegram-client description: "I/O and routing log finalization" |

## References

- Brainstorm: `docs/brainstorms/2026-02-19-routing-feedback-brainstorm.md`
- Router config: `src/router/config.ts` (14-dimension weights)
- grammY reactions: [grammy.dev/guide/reactions](https://grammy.dev/guide/reactions) — `bot.reaction()` API, `ctx.reactions().emojiAdded`
- Telegram Bot API: [core.telegram.org/bots/api#messagereactionupdated](https://core.telegram.org/bots/api#messagereactionupdated) — 7 fields, no `message_thread_id`
- Telegram valid emoji: 79 valid reaction emoji, ⚡/✍/🔥 all confirmed valid
- Existing patterns: JSONL append (`appendFileSync`), mtime cache, SSE broadcast, Zod at I/O boundaries
- Institutional learnings:
  - `docs/solutions/integration-issues/borg-v2-first-live-run-fixes.md` — Issue 4: emoji reaction setup, REACTION_INVALID gotcha
  - `docs/solutions/architecture-reviews/code-review-cycle-2-systemic-patterns-and-prevention.md` — SSE broadcast, mtime cache, Zod validation, code duplication prevention
  - `docs/solutions/architecture-reviews/heartbeat-reliability-code-managed-timing-and-quantitative-decisions.md` — Zod at boundaries, mtime cache, assumption-dependent simplification tagging
  - `docs/solutions/integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md` — topicName queue propagation pattern (exact precedent for routingMetadata)
