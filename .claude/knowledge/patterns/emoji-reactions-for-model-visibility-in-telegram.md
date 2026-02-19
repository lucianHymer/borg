# Emoji reactions for model visibility in Telegram

Borg uses Telegram's setMessageReaction API to add emoji reactions to bot responses, showing which model handled the request: haiku (⚡), sonnet (✍), opus (🔥). Reactions are added after sendMessage on all paths. Key gotcha: not all emoji are valid Telegram reactions (e.g., 🎵 returns REACTION_INVALID). Wrap in try/catch since reactions may not be available in all group types. Pattern established in borg-v2-first-live-run-fixes.md.

**Related files:** src/telegram-client.ts