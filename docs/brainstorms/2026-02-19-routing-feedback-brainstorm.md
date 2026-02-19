# Routing Feedback via Emoji Reactions

**Date:** 2026-02-19
**Status:** Brainstorm (Reviewed)

## What We're Building

A feedback loop for the model routing system. When the bot responds with a model emoji (⚡ haiku, ✍ sonnet, 🔥 opus), the user can react to that response with a different model emoji to indicate "I would have preferred this model." That correction gets stored alongside the routing decision data and is available for analysis to improve routing heuristics over time.

Additionally, the routing log is enriched with full message text (currently only stores a SHA-256 hash) so the routing tab in the dashboard shows the actual prompt alongside each decision.

## Why This Approach

- **Silence = agreement.** No need to capture positive feedback. If you don't react, the routing was fine. Every feedback entry is a correction.
- **Capture only, no auto-adjustment.** Feedback is stored for human + LLM analysis. Weight changes are reviewed as commits, not applied automatically. This avoids drift and keeps the human in the loop.
- **Full prompt text, no privacy concerns.** This is an internal tool. All conversations are already visible in the dashboard. The SHA-256 hash was unnecessary — replace it with the actual message for richer analysis.
- **Flat data model.** Each routing decision is one record with all fields including an optional `userCorrection`. When you export or point an LLM at the data, it's a self-contained dataset — no joins needed.

## Key Decisions

1. **Disagreements only** — Only reactions with a *different* model emoji than the bot used are logged as corrections. Same emoji = no-op.
2. **Full prompt in routing log** — Replace `promptHash` with `prompt` (full message text) in routing log entries. This also fixes the routing tab in the dashboard, which currently can't show what was actually asked.
3. **Single `userCorrection` field** — Added to the routing log entry schema. Empty/null for accepted routing, model name string (e.g., `"sonnet"`) for corrections.
4. **JSONL append for corrections** — Corrections are appended as linked entries (referencing the original by `messageId`). Dashboard and export tools merge them into a flat view.
5. **Reaction handler in telegram-client** — Listen for `message_reaction` events. Check if reaction is a model emoji, look up original model via `message-models.json`, log correction if different.
6. **Dashboard routing tab enhanced** — Shows full prompts and correction status. Correction emoji visible inline.
7. **Analysis workflow** — Point an LLM at the routing data, ask it to identify patterns in corrections and suggest weight adjustments. Review suggestions as a PR.
8. **Log after sending** — Routing log entry is written AFTER the Telegram response is sent, when the Telegram `messageId` is known. This solves the sequencing problem where the routing decision was previously logged before the messageId existed.
9. **Only process `emojiAdded`** — Ignore reaction removals. If user changes their correction, the new one is appended as a fresh entry. Dashboard uses the latest correction per `messageId`. No retraction mechanism needed.
10. **`allowed_updates` must include `message_reaction`** — grammY won't deliver reaction events without this. First implementation step.
11. **Raw user message, not enriched prompt** — Store the original user message text (shorter, readable). The enriched prompt with history context can be reconstructed from message-history.jsonl if needed.

## Scope

### In scope
- Add `message_reaction` event handler to telegram-client
- Add `allowed_updates: ["message", "message_reaction"]` to `bot.start()`
- Enrich routing log entries with full `prompt` text (raw user message)
- Move routing log write to after Telegram response is sent (to capture `messageId`)
- Store `userCorrection` when user reacts with different model emoji
- Add `messageId` (Telegram) and `threadId` to routing log entries
- Update dashboard routing tab to display prompts and corrections
- Expose correction data via existing dashboard API (merged into `/api/routing/recent`)
- Add reverse emoji→model lookup map
- Validate chat ID on reaction events (security)

### Out of scope
- Automated weight adjustment / retraining
- "Prompt" tab cleanup in dashboard (adjacent concern)
- Model override commands (e.g., `/use opus`)
- Per-thread model pinning
- Analytics scripts (LLM generates these ad-hoc when asked)
- Reaction removal/retraction handling (latest correction wins)

## Resolved Questions (from review)

1. **messageId linkage** — Routing log entry is written after sending, so Telegram messageId is available. No two-phase write or timestamp matching needed.
2. **Reaction removal/change** — Only `emojiAdded` is processed. Latest correction per messageId wins on dashboard merge. No retraction entries.
3. **Prompt content** — Raw user message, not enriched prompt. Shorter, more readable, reconstructable.
4. **Non-model emoji reactions** — Silently ignored (thumbs up, hearts, etc. are not model emojis).
5. **Reactions on non-bot messages** — `lookupMessageModel()` returns undefined → handler exits early, no action.
6. **Pruned messages** — If message is pruned from `message-models.json` (>1000 entries), correction is silently dropped. Acceptable for an internal tool.
7. **Chat validation** — Reaction handler checks `ctx.chat.id === settings.telegram_chat_id` before processing.
8. **Schema migration** — Dashboard handles both old (`promptHash`) and new (`prompt`) entries. Old entries show "[hashed]" label.

## Open Questions

1. **Routing log growth** — Full prompts will make entries larger. Current rotation is 10MB. May need to increase rotation threshold. Corrections referencing rotated-away entries become orphaned — acceptable for internal use.
2. **Dashboard "prompt" tab** — User noted this tab is confusing / redundant. May want to merge or remove it as a follow-up.
3. **Multi-chunk responses** — When responses are split across multiple Telegram messages, model emoji only appears on the first chunk (in the status-message-edit path). User might react to a later chunk that doesn't show the model emoji. Correction still works (messageId is stored for all chunks) but UX is slightly confusing.

## Data Model

Enhanced routing log entry:
```typescript
type LogEntry = {
    ts: number;
    prompt: string;           // full user message text (replaces promptHash)
    messageId: number;        // Telegram message ID (set after sending)
    threadId: number;         // which forum thread this came from
    tier: Tier;
    model: string;
    tokens: number;
    confidence: number;
    signals: string[];
};

type CorrectionEntry = {
    ts: number;
    type: "correction";
    messageId: number;        // links to the original LogEntry
    threadId: number;         // for dashboard filtering
    originalModel: string;    // what the router chose
    correctedModel: string;   // what the user preferred
};
```

Dashboard merges these into a flat view where each decision row optionally shows the user's correction.

## Emoji → Model Mapping (Reference)

| Emoji | Model | Tier |
|-------|-------|------|
| ⚡ | haiku | SIMPLE |
| ✍ | sonnet | MEDIUM |
| 🔥 | opus | COMPLEX |

Reverse lookup needed in telegram-client: emoji reaction → model name.

## Files That Will Need Changes

| File | Change |
|---|---|
| `src/telegram-client.ts` | Add `message_reaction` handler, `allowed_updates`, reverse emoji→model map |
| `src/routing-logger.ts` | Update `LogEntry` type (prompt replaces promptHash, add messageId/threadId), add `logCorrection()` |
| `src/queue-processor.ts` | Move `logDecision()` call to after Telegram response, pass messageId/threadId |
| `src/dashboard.ts` | Update `/api/routing/recent` to handle+merge corrections, serve prompts |
| `static/dashboard.html` | Add Prompt and Correction columns to routing table, handle mixed schema |
