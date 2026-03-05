---
status: complete
priority: p3
issue_id: "067"
tags: [code-review, type-safety, voice]
dependencies: []
---

# Non-null assertions on optional fields in TTS callback handler

## Problem Statement

In `telegram-client.ts` lines 836-837, `ctx.callbackQuery.message!.chat.id` and `ctx.callbackQuery.message!.message_thread_id` use `!` assertions after async work has happened. The `callbackQuery.message` field is genuinely optional in grammY types. Extract `chatId` and `threadOpt` right after the `originalText` guard, before any async calls.

## Technical Details

- **Affected files:** `src/telegram-client.ts` lines 836-837

## Acceptance Criteria

- [ ] No `!` assertions after async gaps
- [ ] Values extracted early in the handler
