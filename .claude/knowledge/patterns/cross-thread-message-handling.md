# Cross-thread message handling

## Overview

Cross-thread messages are automatically labeled with a visible indicator in Telegram and include system prompt guidance so Claude knows to reply via the send_message tool.

## User-Visible Indicator

When a cross-thread message is sent, the recipient sees:

```
📨 _From {sender} in {source_thread_name}_

[actual message text]
```

Example:
```
📨 _From borg in issue-14-planner_

Ready to start implementing the router tests?
```

This makes it immediately clear to humans which thread the message originated from.

## Bot Behavior

The system prompt includes explicit guidance:

> When you receive a message prefixed with "📨 _From {sender} in {thread}_", this is a cross-thread message from another thread. To reply:
> - Use the MCP send_message tool to send your response back to the source thread
> - Do NOT respond in the current thread — the sender is in a different thread and won't see it
> - The visible indicator shows both the sender's name and their thread name for context

This prevents the common mistake of replying in the recipient's own thread instead of sending a message back to the source.

## Implementation Details

### Data Flow

1. **Sending thread** calls `send_message(targetThreadId, message)` MCP tool
2. **mcp-tools.ts** creates two queue entries:
   - Incoming message for queue-processor: `{source: "cross-thread", threadId: target, sourceThreadId: sender}`
   - Outgoing message for telegram-client: `{targetThreadId: target, sourceThreadId: sender, message: "..."}`
3. **telegram-client.ts** detects `sourceThreadId` field
4. **telegram-client.ts** prepends visible indicator: `📨 _From {sender} in {sourceThread.name}_\n\n{message}`
5. Message sent to Telegram with Markdown formatting
6. **queue-processor.ts** injects incoming message into recipient's session with sourceThreadId metadata

### Files Modified

- `src/types.ts` — Added `sourceThreadId?: number` to `OutgoingMessage` interface
- `src/mcp-tools.ts` — Populate `sourceThreadId` when creating outgoing queue message
- `src/telegram-client.ts` — Detect `sourceThreadId` and prepend formatted indicator with thread name
- `src/session-manager.ts` — Add "Cross-Thread Message Pattern" section to system prompt (both master and worker)

### Thread Name Resolution

The source thread name is looked up from `threads.json` using `sourceThreadId`. If not found, falls back to `"thread {sourceThreadId}"`.

## Examples

### Correct Pattern

User in thread 43 sees:
```
📨 _From borg in issue-15-worker_

I've finished implementing the cross-thread labeling feature. PR is ready for review!
```

Claude in thread 43 correctly replies:
```typescript
send_message(482, "Great! I'll review it now.")
```

### Anti-Pattern (Before This Feature)

User in thread 43 sees:
```
I've finished implementing the cross-thread labeling feature. PR is ready for review!
```

Claude in thread 43 incorrectly responds directly in thread 43:
```
Great! I'll review it now.
```

**Problem:** The sender (in thread 482) never sees the reply.

## Related

- Issue #15: "Improve labelling/context for cross-thread messages"
- See `src/mcp-tools.ts` send_message tool implementation
- See `.claude/knowledge/architecture/cross-thread-pending-message-registration-pattern.md` for related message tracking details
