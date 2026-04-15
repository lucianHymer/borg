# Cross-Thread Messaging

Full flow for inter-thread communication via `send_message` MCP tool.

## Flow

1. Sending thread calls `send_message(targetThreadId, message)`
2. mcp-tools.ts creates two queue entries:
   - Incoming message for queue-processor: `{source: "cross-thread", threadId: target, sourceThreadId: sender}`
   - Outgoing message for telegram-client: `{targetThreadId: target, sourceThreadId: sender, message: "..."}` with `_tg` suffix on messageId
3. telegram-client detects `sourceThreadId`, prepends visible indicator:
   ```
   📨 _From {sender} in {sourceThread.name}_
   
   {message}
   ```
4. queue-processor injects incoming message into recipient's session with sourceThreadId metadata

## Pending Message Registration

telegram-client strips `_tg` suffix to recover the base ID, then registers a PendingMessage so status updates and final responses are tracked.

The `_tg` suffix convention is an implicit contract between mcp-tools.ts and telegram-client.ts -- not codified in a shared constant.

**Leak:** `cleanupPendingMessages` cannot parse timestamps from `cross_*` IDs (`parts[0]` is "cross" not a timestamp), causing these entries to leak.

## Thread Name Resolution

Source thread name looked up from `threads.json` using `sourceThreadId`. Falls back to `"thread {sourceThreadId}"` if not found.

## Gotcha: Narrating Is Not Sending

If a workflow step says to send a cross-thread message, send it in the same response. Do not describe it as a future intention.

**Bad:** "I will send this to the Planner" (narrative, no tool call)
**Good:** Actually calling `send_message` in the same response

This applies to all tool-based actions: if the step says "send", "message", "notify", or "ask" -- do it now.

See: `src/mcp-tools.ts`, `src/telegram-client.ts`, `src/session-manager.ts`, `src/types.ts`
