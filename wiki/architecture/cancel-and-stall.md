# Cancel and Stall Detection

Interrupting in-flight SDK queries and detecting stalled responses.

## Cancel Signal Files

Filesystem signals between telegram-client and queue-processor (separate processes).

1. Status messages include inline "Cancel" button with callback data `cancel:{messageId}`
2. On tap, telegram-client writes signal file to `queue/cancel/{messageId}.json` (atomic: tmp+rename)
3. queue-processor's status interval (every 2s) checks for cancel file
4. If found: sets `cancelled = true`, updates status to "Cancelled", deletes signal file, calls `q.interrupt()`
5. Query try/catch checks `cancelled` flag -- sends cancellation message instead of retrying

**Design decisions:**
- Filesystem signals (not IPC) because separate processes
- Cancel button omitted from status message once cancelled
- Session still persisted on cancel (resume works in future messages)
- `sessionId` NOT cleared on cancel (session state is valid, unlike query errors)

## Stall Detection

The `collectQueryResponse()` end_turn stall detection must use **absolute elapsed time**, not per-event timeout.

**The bug:** Background bash tasks (`run_in_background`) emit `tool_progress` events after `end_turn`. Original implementation raced `iterator.next()` against a 90s timeout. Every tool_progress event would "win" the race and reset the timer. Stall never detected as long as background task kept emitting.

**The fix:**
- Record `endTurnSeenAt = Date.now()` when `end_turn` first seen
- Each loop iteration checks `Date.now() - endTurnSeenAt >= 90_000`
- Short 5-second poll intervals for frequent deadline re-checks, even with constant tool_progress events

See: `src/telegram-client.ts`, `src/queue-processor.ts`
