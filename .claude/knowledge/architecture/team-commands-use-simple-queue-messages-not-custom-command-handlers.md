# Team commands use simple queue messages, not custom command handlers

/clear_team and /compact_team Telegram commands work by writing standard incoming queue messages (with /clear or /compact as the message text) to each team member's thread. They do NOT use custom command handlers in queue-processor or custom MCP tools. The existing queue pipeline processes them like any other message — the Claude session handles /clear and /compact natively. No compactSummary field in ThreadConfig, no compact command in CommandMessageSchema, no clear_team or compact_thread MCP tools. Keep it simple: queue a message, let the existing pipeline handle it.

**Related files:** src/telegram-client.ts, src/queue-processor.ts, src/mcp-tools.ts