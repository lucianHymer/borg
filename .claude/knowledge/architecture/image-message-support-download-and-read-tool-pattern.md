# Image message support: download and Read tool pattern

Borg supports receiving photo messages from Telegram. Since the Agent SDK doesn't support image content arrays directly, images are downloaded to disk and Claude is instructed to use the Read tool to view them (Claude Code's Read tool supports images natively).

**Flow:** (1) telegram-client downloads the largest photo size to `.borg/images/incoming/` with atomic write (tmp+rename), (2) queue message includes `imagePath` field and optional caption, (3) queue-processor validates imagePath is within allowed directory, builds instruction `[Image received: /path/to/image.jpg]\n\nPlease analyze this image using the Read tool.`, (4) Claude receives instruction and uses Read tool to view the image, (5) image file cleaned up after processing (success and error paths).

**Size limit:** 5MB (Claude Read tool limit). Telegram allows up to 20MB photos but we reject anything over 5MB with user feedback.

**Deduplication:** Uses Telegram's `file_unique_id` with `photo_` prefix, same pattern as voice messages (`voice_` prefix).

**Cleanup:** `cleanupImageFile()` deletes individual files after processing. `startPeriodicCleanup()` sweeps `.borg/images/` and `.borg/images/incoming/` every 15 minutes, removing files older than 1 hour (orphan safety net).

**Caption support:** If the Telegram photo has a caption, it's included in the instruction as `Caption: {text}` after the Read tool instruction.

**Related files:** src/images.ts, src/telegram-client.ts, src/queue-processor.ts, src/types.ts
