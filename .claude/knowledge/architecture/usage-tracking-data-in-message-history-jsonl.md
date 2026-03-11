# Usage tracking data lives in message-history.jsonl, not a separate file

Token usage and cost data is stored as optional fields on `MessageHistoryEntry` in `.borg/message-history.jsonl`, NOT in a separate file.

**Why:** Usage is naturally tied to outgoing messages — same entity, same lifecycle. Extending MessageHistoryEntry with optional fields reuses all existing infrastructure: JSONL append, rotation, tail-read, SSE feeds, deduplication. No new file management, no new readers, no new rotation logic. Tradeoff: ~200-400 extra bytes per outgoing entry — well under the 4096-byte O_APPEND atomicity guarantee.

**Flow:** `collectQueryResponse()` returns `{ text, usage }` → `processMessage()` spreads usage into `appendHistory()` call. Heartbeats return `{ text, usage }` too.

**Suppressed heartbeats:** Heartbeats that return `[NO_UPDATES]` still consume haiku tokens. These are logged as `[heartbeat:suppressed]` outgoing entries with full usage fields so the dashboard shows true cost of heartbeat frequency — previously these costs were invisible.

**Field names:** Use `cacheCreationInputTokens` (matches SDK's `ModelUsage` type exactly), NOT `cacheWriteTokens`. A naming mismatch here causes silent data loss.

**Dashboard:** The `/api/usage` endpoint runs in infra and reads from all zone dirs. Infra has read-only mounts for all zone `.borg-{zone}/` directories in docker-compose.yml — this is intentional design, not a zone isolation breach.

**Related files:** src/message-history.ts, src/queue-processor.ts, src/dashboard.ts
