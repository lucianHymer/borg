# Broadcast system: cross-repo knowledge sharing

Borg has a broadcast system that lets repo bots share knowledge (patterns, gotchas, workflow changes) with all other repos across multiple Borg instances. A shared Telegram group serves as the transport layer.

**Outgoing:** The `broadcast` MCP tool posts structured messages to the broadcast group via direct Telegram HTTP API (same pattern as create_thread/delete_thread — MCP tools run in queue-processor, not telegram-client). The tool enforces a message template with source repo, type, content, and self-dedup footer.

**Incoming:** telegram-client has a second `bot.on("message:text")` handler filtering by `broadcast_chat_id`. It does dumb fan-out: writes one incoming queue message per `mainThread: true` thread with `[use opus]` prefix. Zero intelligence in the fan-out — opus sessions handle semantic evaluation of applicability.

**Key design decisions:**
- `mainThread` flag on ThreadConfig is explicit opt-in — new threads don't receive broadcasts by default (correct for team workers that spin up and down)
- Semantic dedup, not mechanical — the broadcast template states its source repo, and the receiving opus session skips if it's from the same repo. No bot name tracking or message ID filtering needed.
- `[use opus]` prefix reuses the existing router override mechanism — no router changes required
- The broadcast handler in telegram-client must be registered between the main text handler and voice handler (grammY processes handlers in registration order)
- `broadcast_chat_id` must be set in settings.json — tool fails gracefully with a clear error if missing

**Related files:** src/mcp-tools.ts (broadcast tool), src/telegram-client.ts (listener + fan-out), src/session-manager.ts (mainThread on ThreadConfig, broadcast_chat_id on Settings), src/queue-processor.ts (broadcast source), skills/global/broadcasting.md (skill)
