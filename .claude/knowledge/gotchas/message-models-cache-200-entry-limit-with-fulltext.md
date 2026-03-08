# message-models cache: 200-entry limit due to fullText storage

The `.borg/message-models.json` cache is pruned to 200 entries (LRU), reduced from the original 1000. This is because multi-segment messages now store `fullText` (the complete unsplit response) in `MessageModelEntry`, which can be several KB per entry. At 200 entries with large fullText values, the file can still grow significantly. Single-segment messages don't store fullText (optimization). The `MessageModelEntry` interface lives in `src/types.ts` with fields: `model`, `threadId`, `fullText?`. When a Listen button is pressed on a message whose cache entry has been pruned, the user sees a warning alert and hears only the first segment's text — graceful degradation, not an error.

**Related files:** src/telegram-client.ts, src/types.ts
