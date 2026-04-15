# Message History

Deduplication and storage for `.borg/message-history.jsonl`.

## Dedup by messageId

`appendHistory()` deduplicates by messageId:

1. Normalizes messageId by stripping `_tg` (cross-thread outgoing display) and `_retry\d+` (filename retry) suffixes
2. Scans last ~50 entries via `getRecentHistory()` tail-read
3. Matches by normalized messageId if both entries have it AND same direction
4. Fallback for outgoing messages without messageId: matches by threadId+direction+timestamp within 5-second window

The messageId field is optional in `MessageHistoryEntry` for backward compatibility.

## Gotcha: Direction Check Required

Incoming and outgoing messages share the same messageId (queue-processor reuses the incoming message's messageId for the outgoing response).

**The bug:** Without a direction check, every outgoing message was silently deduplicated against its corresponding incoming message. ALL outgoing messages dropped from history for 3 days undetected (appendHistory silently returns on dedup).

**The fix:** Add `entry.direction === existing.direction` to messageId-based matching.

**Lesson:** When dedup operates on shared identifiers, include enough dimensions to distinguish legitimately different entries. Silent dedup failures are especially dangerous.

## Timestamp Fallback

Must check both messages lack messageId (`!entry.messageId && !existing.messageId`). Without this, it would incorrectly dedup an outgoing message without messageId against one with messageId if within 5s on same thread.

## Suffix Handling

- `_tg`: added in mcp-tools.ts for cross-thread outgoing messages (display copy for telegram-client)
- `_retry\d+`: only on queue filenames not messageIds (checked defensively)
- Both normalized for matching

See: `src/message-history.ts`, `src/queue-processor.ts`, `src/mcp-tools.ts`
