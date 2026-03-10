# Telegram MarkdownV2 conversion pattern

Borg converts Claude's GitHub-Flavored Markdown output to Telegram MarkdownV2 before sending. This is handled by `toTelegramMarkdownV2()` in `src/markdown-v2.ts`.

**Why MarkdownV2 over Markdown v1:** Telegram's legacy Markdown (v1) has limited formatting support and frequently rejects messages with special characters (parentheses, dots, exclamation marks, etc.), causing fallback to plain text. MarkdownV2 supports all formatting Claude uses (code blocks, bold, italic, strikethrough, links) but requires escaping 18 special characters in plain text segments.

**Conversion strategy:** Parse GFM into segments (code blocks, inline code, bold, italic, strikethrough, links, plain text), then escape special characters only in plain text while preserving formatting markers. Headers (`## Foo`) are converted to bold since Telegram has no header support.

**All sendMessage paths must use MarkdownV2:**
- Standard bot responses (edit-in-place + sendInThread)
- Cross-thread messages
- Fallback responses (no pending message)
- Voice transcript/summary buttons
- Team command responses
- The `sendInThread` helper accepts an optional `parseMode` parameter

**Plain text fallback:** If MarkdownV2 parsing fails (Telegram returns "can't parse entities"), the message is retried without parse_mode. Failures are logged to `.borg/markdown-parse-failures.jsonl` for converter improvement.

**Cross-thread indicators:** Built directly in MarkdownV2 format — dynamic parts (sender name, thread name) are escaped via `escapeMarkdownV2()` to handle underscores and special chars in names.

**Related files:** src/markdown-v2.ts, src/telegram-client.ts, src/audio.ts (distillForReading markdown instruction)
