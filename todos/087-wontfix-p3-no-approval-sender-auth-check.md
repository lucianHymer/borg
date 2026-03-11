---
status: wontfix
priority: p3
issue_id: "087"
tags: [code-review, security, authorization]
dependencies: []
---

# Approval callback handler has no admin authorization check

## Problem Statement

The cross-zone approval callback handler (telegram-client.ts:1666-1786) verifies only that the pending file exists. It does NOT check whether the Telegram user who clicked Approve/Reject has admin authority. Any member of the Telegram chat can approve or reject cross-zone messages, defeating the human review control. If the bot is in a group chat, any member can approve messages.

## Findings

- telegram-client.ts:1666-1786 handles inline keyboard callbacks for cross-zone message approval
- The handler checks for the existence of the pending message file but performs no user identity check
- `ctx.callbackQuery.from` contains the Telegram user who clicked the button, but this is not validated
- In a group chat scenario, any chat member can click Approve/Reject on any pending message
- The security model of cross-zone approval assumes human review by a trusted operator; without auth this assumption is broken
- Perimeter-to-core message approval is specifically a security boundary; unauthenticated approval undermines the entire zone isolation model

## Proposed Solutions

- Add an explicit check against a configured `admin_user_id` in settings.json; reject callbacks from users whose `from.id` does not match
- Alternatively, check whether the user is the chat owner using `getChatMember` API and verifying the `status` field
- Respond to unauthorized approval attempts with `ctx.answerCallbackQuery({ text: "Not authorized", show_alert: true })` rather than silently ignoring

## Acceptance Criteria

- [ ] Only the configured admin user (or chat owner) can approve/reject cross-zone messages
- [ ] Unauthorized approval attempts receive an explicit rejection response
- [ ] `admin_user_id` is documented in settings schema and operator setup guide
- [ ] No regression for authorized approvals

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Authorization checks on callback handlers are easy to forget since the button UI implies only the right person will click it; group chats break this assumption |
