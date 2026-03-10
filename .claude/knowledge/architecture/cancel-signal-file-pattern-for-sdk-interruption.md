# Cancel signal file pattern for SDK interruption

Borg supports cancelling in-flight SDK queries via a filesystem signal pattern between telegram-client and queue-processor (separate processes).

**Flow:** (1) Status messages include an inline "✕ Cancel" button (`InlineKeyboard`) with callback data `cancel:{messageId}`. (2) On tap, telegram-client writes a signal file to `queue/cancel/{messageId}.json` (atomic: tmp+rename). (3) queue-processor's status interval (every 2s) checks for the cancel file. If found, it sets `cancelled = true`, updates status to "Cancelled", deletes the signal file, and calls `q.interrupt()` on the SDK query. (4) The query's try/catch handles both normal completion and error paths — if `cancelled` is true, it sends "🚫 Processing was cancelled." instead of retrying or throwing.

**Key design decisions:**
- Filesystem signals (not IPC) because telegram-client and queue-processor are separate processes
- The cancel button is omitted from the status message once status is "Cancelled"
- Session is still persisted on cancel so resume works in future messages
- `sessionId` is NOT cleared on cancel (unlike query errors), since the session state is valid

**Related files:** src/telegram-client.ts (cancel button + callback handler), src/queue-processor.ts (cancel check in statusInterval + cancelled flag handling)
