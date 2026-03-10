# Message history dedup must check direction when matching by messageId

The isDuplicate function in message-history.ts matches entries by normalized messageId. It MUST also check that the `direction` field matches, because incoming and outgoing messages share the same messageId (the queue-processor reuses the incoming message's messageId when logging the outgoing response at line ~1168).

**The bug:** Without a direction check, every outgoing message was silently deduplicated against its corresponding incoming message, causing ALL outgoing messages to be dropped from message-history.jsonl. This went undetected for 3 days because appendHistory silently returns on dedup (no error, no log).

**The fix:** Add `entry.direction === existing.direction` to the messageId-based matching condition.

**Lesson:** When dedup logic operates on shared identifiers (messageId used by both request and response), always include enough dimensions to distinguish legitimately different entries. Silent dedup failures are especially dangerous — consider adding debug logging when entries are skipped.

**Related files:** src/message-history.ts, src/queue-processor.ts (lines ~964 and ~1159 both call appendHistory with same messageId)
