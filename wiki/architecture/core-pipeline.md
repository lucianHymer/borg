# Core Pipeline

Message flow from Telegram to Claude SDK and back.

## Two-Process Architecture

- **telegram-client** (infra container) -- grammY bot, handles all Telegram I/O, slash commands, routing log finalization
- **queue-processor** (core/perimeter containers) -- SDK v2 sessions, processes incoming queue messages

Telegram slash commands (`/clear`, `/compact`, `/setdir`, etc.) are handled directly by `bot.command()` handlers in telegram-client. They never flow through the incoming message queue. Don't add redundant intercepts in queue-processor.

The queue processor only handles commands from `queue/commands/` directory, used by cross-thread/system sources.

## Message Coalescing

When queue-processor picks up a message, it scans remaining queued files for the same `threadId` and concatenates them (double-newline separated) into a single prompt.

- Only the first message's metadata (sender, source, messageId) is used
- Command messages (starting with `/`) are never coalesced -- neither as primary nor as additional
- Primary queue file is rewritten with combined text (atomic: tmp+rename)
- Coalesced files are deleted (best-effort)

The coalesce scan reads and parses each candidate file inline -- acceptable cost since the queue is typically small.

## Edit/Delete Queued Messages

telegram-client maintains a `telegramToQueueId` map (Telegram `message_id` -> queue `messageId`) to support editing/deleting messages before processing.

Three cases on `edited_message:text`:
1. **Queued** (file in `queue/incoming/`): Rewrite queue file with new text (atomic). Empty edit = delete (cancel). Reactions: `✍` on edit, `👌` on delete.
2. **Processing** (file in `queue/processing/`): Warning reply with original text. Cannot modify in-flight work.
3. **Already done** (no file found): Silently ignored.

Cleanup: `telegramToQueueId` entries cleaned alongside `pendingMessages` in `cleanupPendingMessages()`.

## Preview Truncation

Status preview accumulates text blocks via `onTextContent` callback. When truncating to 500 chars, use `slice(-500)` (tail) not `slice(0, 500)` (head). Users want to see where the response currently is, not the static beginning.

```typescript
currentPreview = accumulated.length > 500 ? "..." + accumulated.slice(-500) : accumulated;
```

See: `src/telegram-client.ts`, `src/queue-processor.ts`
