# Message history deduplication by messageId

Message history (`.borg/message-history.jsonl`) uses messageId-based deduplication to prevent duplicate entries when queue-processor retries after crashes/errors. Implementation in `appendHistory()` (message-history.ts): (1) normalizes messageId by stripping `_tg` (cross-thread outgoing display) and `_retry\d+` (filename retry) suffixes, (2) scans last ~50 entries via efficient tail-read using existing `getRecentHistory()` function, (3) matches by normalized messageId if both entries have it AND same direction (incoming/outgoing share messageId — see gotchas/message-history-dedup-must-check-direction.md), (4) fallback for outgoing messages without messageId: matches by threadId+direction+timestamp within 5-second window. The messageId field is optional in MessageHistoryEntry interface for backward compatibility. Performance impact is minimal (tail read of ~50 entries is trivial). Resolved issue #5.

**Critical gotcha:** Timestamp fallback MUST check both messages lack messageId (`!entry.messageId && !existing.messageId`). Without this, it would incorrectly deduplicate an outgoing message without messageId against one with messageId if within 5s on same thread. Bug caught during manual testing.

**Suffix handling:** `_tg` added in mcp-tools.ts for cross-thread outgoing messages (display copy for telegram-client), `_retry\d+` only on queue filenames not messageIds (checked defensively). Both normalized for matching.

**Related files:** src/message-history.ts, src/queue-processor.ts, src/mcp-tools.ts
