# Queue message coalescing per thread

When queue-processor picks up a message for processing, it scans remaining queued files for the same threadId and concatenates them into a single prompt (double newline separated). This prevents rapid-fire user messages from spawning separate SDK queries.

**Rules:** (1) Only the first message's metadata (sender, source, messageId) is used. (2) Command messages (starting with `/`) are never coalesced — neither as primary nor as additional. (3) The primary queue file is rewritten with the combined text (atomic: tmp+rename). (4) Coalesced files are deleted (best-effort).

**Location:** `processQueue()` in queue-processor.ts, after slot availability checks but before claiming the processing slot. The coalesce scan reads and parses each candidate file inline — acceptable cost since the queue is typically small.

**Related files:** src/queue-processor.ts
