# Model Selection

Sticky per-thread model config. No smart routing -- model is purely `threadConfig.model`.

## Per-Thread Model

Each thread uses its configured model for all messages. Default: `sonnet[1m]`. Change via `/model <haiku|sonnet|opus>` (also resets the session to maximize prompt cache hits).

The `[1m]` suffix enables 1M context window. Effort defaults to `medium`; include "ultrathink" in a message for `max` (opus) or `high` (sonnet).

Heartbeats are always haiku one-shot sessions (no resume, no cache sharing with the main thread).

## Usage Extraction from SDK

`SDKResultMessage` is a union of success and error subtypes, but both carry usage fields. Extract usage after checking `msg.type === "result"` without branching on `subtype`:

```typescript
if (msg.type === "result") {
  const usage = msg.usage; // works for both "success" and "error"
}
```

Easy to miss if you only handle `subtype === "success"` -- silently drops usage from error responses.

SDK `ModelUsage` field names map to `QueryUsageData` with camelCase rename: `total_cost_usd` -> `totalCostUSD`, `cache_creation_input_tokens` -> `cacheCreationInputTokens`.

## Usage Storage

Usage data lives as optional fields on `MessageHistoryEntry` in `.borg/message-history.jsonl`, not a separate file.

**Why:** Usage is naturally tied to outgoing messages. Extending MessageHistoryEntry reuses all existing infrastructure (JSONL append, rotation, tail-read, SSE feeds, dedup). Extra ~200-400 bytes per outgoing entry, well under 4096-byte O_APPEND atomicity guarantee.

**Flow:** `collectQueryResponse()` returns `{ text, usage }` -> `processMessage()` spreads usage into `appendHistory()`.

**Suppressed heartbeats:** `[heartbeat:suppressed]` outgoing entries with full usage fields so dashboard shows true cost of heartbeat frequency.

**Field names:** Use `cacheCreationInputTokens` (matches SDK's `ModelUsage` exactly), NOT `cacheWriteTokens`.

**Dashboard:** `/api/usage` runs in infra, reads from all zone dirs. Infra has read-only mounts for all `.borg-{zone}/` directories.

## Emoji Reactions

Bot responses get Telegram emoji reactions showing which model handled the request:
- haiku: `⚡`
- sonnet: `✍`
- opus: `🔥`

Reactions added via `setMessageReaction` API after `sendMessage`. Not all emoji are valid Telegram reactions. Wrap in try/catch since reactions may not be available in all group types.

See: `src/queue-processor.ts`, `src/message-history.ts`, `src/telegram-client.ts`, `src/types.ts`
