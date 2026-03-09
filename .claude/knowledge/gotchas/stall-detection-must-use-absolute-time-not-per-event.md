# Stall detection must use absolute time, not per-event timeout

The end_turn stall detection in collectQueryResponse() must use absolute elapsed time since end_turn was first seen, NOT a per-event timeout that resets each time an event arrives.

**The bug:** When background bash tasks (run_in_background) keep running after the model emits end_turn, the SDK continues emitting tool_progress events for those background processes. The original implementation raced each iterator.next() against a 90-second timeout — but every tool_progress event that arrived would "win" the race, consume the timeout, and start a fresh 90-second timer. This meant the stall was never detected as long as the background task kept emitting progress.

**The fix:** Record `endTurnSeenAt = Date.now()` when end_turn is first seen. On each loop iteration, check `Date.now() - endTurnSeenAt >= 90_000`. Use short 5-second poll intervals so we re-check the absolute deadline frequently, even when tool_progress events keep arriving.

**Related files:** src/queue-processor.ts (collectQueryResponse function)
