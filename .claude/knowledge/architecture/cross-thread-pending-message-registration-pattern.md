# Cross-thread pending message registration pattern

Cross-thread messages follow a two-stage pattern: mcp-tools.ts writes ONE outgoing message with `crossThread: true` and `_tg` suffix on the messageId. Infra's telegram-client picks this up in `pollOutgoingQueue()` and handles both routing (writing an incoming message to the target zone's queue) and Telegram display. telegram-client strips "_tg" to recover the base ID and registers a PendingMessage so status updates and final responses are tracked. The _tg suffix convention is an implicit contract between mcp-tools.ts and telegram-client.ts — not codified in a shared constant. cleanupPendingMessages cannot parse timestamps from cross_* IDs (parts[0] is "cross" not a timestamp), causing these entries to leak.

**Related files:** src/mcp-tools.ts, src/telegram-client.ts, src/types.ts
