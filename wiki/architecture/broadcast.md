# Broadcast

Cross-repo knowledge sharing via a shared Telegram group.

## Outgoing

The `broadcast` MCP tool posts structured messages to the broadcast group via direct Telegram HTTP API (same pattern as create_thread/delete_thread). Enforces a message template with source repo, type, content, and self-dedup footer.

Only registered when `BORG_ZONE` is `"core"`.

## Incoming

telegram-client has a second `bot.on("message:text")` handler filtering by `broadcast_chat_id`. Dumb fan-out: writes one incoming queue message per `mainThread: true` thread with `[use opus]` prefix.

Zero intelligence in the fan-out -- opus sessions handle semantic evaluation of applicability.

## Key Design Decisions

- **`mainThread` flag:** Explicit opt-in on ThreadConfig. New threads don't receive broadcasts (correct for ephemeral team workers).
- **Semantic dedup:** Broadcast template states source repo. Receiving opus session skips if from same repo. No bot name tracking needed.
- **`[use opus]` prefix:** Reuses existing router override mechanism. No router changes required.
- **Handler order:** Must be registered between main text handler and voice handler (grammY processes in registration order).
- **Config:** `broadcast_chat_id` must be set in settings.json. Tool fails gracefully if missing.

See: `src/mcp-tools.ts`, `src/telegram-client.ts`, `src/session-manager.ts`, `src/queue-processor.ts`, `skills/global/broadcasting.md`
