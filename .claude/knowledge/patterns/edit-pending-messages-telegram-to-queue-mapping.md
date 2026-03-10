# Edit pending messages: Telegram message_id to queue messageId mapping

telegram-client maintains a `telegramToQueueId` map (Telegram `message_id` → queue `messageId`) to support editing and deleting queued messages before they're processed.

**Three cases on `edited_message:text`:**
1. **Queued** (file in `queue/incoming/`): Rewrite queue file with new text (atomic: tmp+rename). Empty edit = delete the file (cancel). Reactions used for feedback: ✍ on edit, 👌 on delete.
2. **Processing** (file in `queue/processing/`): Send warning reply with original text from the processing file. Cannot modify in-flight work.
3. **Already done** (no file found): Silently ignored.

**Cleanup:** `telegramToQueueId` entries are cleaned up alongside `pendingMessages` in `cleanupPendingMessages()`.

**Related files:** src/telegram-client.ts
