# grammY message_reaction event handling

grammY supports reaction events via bot.on("message_reaction") and the shorthand bot.reaction(). Key findings:

1. MessageReactionUpdated does NOT include message_thread_id - this is a Telegram Bot API limitation, not grammY-specific. Fields: chat, message_id, user?, actor_chat?, date, old_reaction, new_reaction. This means forum topic isolation is not possible for reaction events - you must track message-to-thread mappings yourself.

2. message_reaction is NOT in DEFAULT_UPDATE_TYPES. Must explicitly add to allowed_updates. Options: bot.start({ allowed_updates: [...DEFAULT_UPDATE_TYPES, "message_reaction"] }) or use ALL_UPDATE_TYPES. Both constants exported from "grammy".

3. ctx.reactions() returns: { emoji, emojiAdded, emojiKept, emojiRemoved, customEmoji, customEmojiAdded, customEmojiKept, customEmojiRemoved, paid, paidAdded }.

4. bot.reaction() auto-registers "message_reaction" in observedUpdateTypes (validates against allowed_updates on start).

5. Bot must be admin in group chats to receive reaction updates.

**Related files:** src/telegram-client.ts