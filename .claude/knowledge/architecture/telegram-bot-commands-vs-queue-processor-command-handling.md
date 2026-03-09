# Telegram bot commands vs queue-processor command handling

Telegram slash commands (/clear, /compact, /setdir, etc.) are handled directly by bot.command() handlers in telegram-client.ts — they never flow through the incoming message queue. Don't add redundant intercepts in queue-processor.ts. The queue processor only handles commands from the command queue (queue/commands/ directory), used by cross-thread/system sources.

**Related files:** src/telegram-client.ts, src/queue-processor.ts