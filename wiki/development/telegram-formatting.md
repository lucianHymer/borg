# Telegram Formatting

MarkdownV2 conversion for Telegram output.

## Why MarkdownV2

Legacy Markdown v1 has limited formatting and frequently rejects messages with special characters (parentheses, dots, exclamation marks), causing fallback to plain text. MarkdownV2 supports all formatting Claude uses but requires escaping 18 special characters in plain text segments.

## Conversion Strategy

`toTelegramMarkdownV2()` in `src/markdown-v2.ts`:

1. Parse GFM into segments (code blocks, inline code, bold, italic, strikethrough, links, plain text)
2. Escape special characters only in plain text
3. Preserve formatting markers
4. Convert headers (`## Foo`) to bold (Telegram has no header support)

## All sendMessage Paths Must Use MarkdownV2

- Standard bot responses (edit-in-place + sendInThread)
- Cross-thread messages
- Fallback responses (no pending message)
- Voice transcript/summary buttons
- Team command responses
- `sendInThread` accepts optional `parseMode` parameter

## Cross-Thread Indicators

Built directly in MarkdownV2 format. Dynamic parts (sender name, thread name) escaped via `escapeMarkdownV2()` to handle underscores and special chars.

## Plain Text Fallback

If MarkdownV2 parsing fails (Telegram returns "can't parse entities"), message retried without `parse_mode`. Failures logged to `.borg/markdown-parse-failures.jsonl` for converter improvement.

See: `src/markdown-v2.ts`, `src/telegram-client.ts`
