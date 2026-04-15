# Telegram API Notes

Reaction API details and grammY event handling.

## Reaction API

- `setMessageReaction` accepts: chat_id, message_id, reaction (array of ReactionType), is_big (bool)
- Non-premium bots limited to 1 reaction per message
- 79 valid emoji reactions as of Bot API 9.0. Not all emoji work (e.g. `🎵` returns REACTION_INVALID).
- Bots do NOT receive updates for reactions set by bots (including self)
- Service messages can't be reacted to

## MessageReactionUpdated

7 fields: chat, message_id, date, old_reaction, new_reaction, user (optional), actor_chat (optional).

**Does NOT include `message_thread_id`** -- to determine which thread a reaction belongs to, look up message_id in your own message history. Forum topic isolation is not possible for reaction events.

## grammY Event Handling

- `bot.on("message_reaction")` and shorthand `bot.reaction()`
- `message_reaction` is NOT in `DEFAULT_UPDATE_TYPES`. Must add explicitly:
  ```typescript
  bot.start({ allowed_updates: [...DEFAULT_UPDATE_TYPES, "message_reaction"] })
  ```
- `bot.reaction()` auto-registers `message_reaction` in `observedUpdateTypes`
- `ctx.reactions()` returns: `{ emoji, emojiAdded, emojiKept, emojiRemoved, customEmoji, customEmojiAdded, customEmojiKept, customEmojiRemoved, paid, paidAdded }`
- Bot must be admin in group chats to receive reaction updates

See: `src/telegram-client.ts`
