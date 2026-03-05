---
status: complete
priority: p1
issue_id: "055"
tags: [code-review, bug, data-integrity, voice]
dependencies: []
---

# Stale destructured `message` variable causes empty history for voice messages

## Problem Statement

In `src/queue-processor.ts` line 722, `message` is destructured from `msg` before STT transcription runs. For voice messages, `msg.message` starts as `""` and is mutated to the transcript at line 765. But the destructured `message` variable remains `""`, causing:

1. **Line 735**: `appendHistory({ ... message ... })` logs an empty string to `message-history.jsonl` for every voice message — the transcript is never recorded as an incoming message
2. **Line 974**: `originalMessage: message` writes an empty string to the outgoing queue

This breaks cross-thread communication (threads grepping history see blank entries) and corrupts the routing audit trail.

## Findings

- Found independently by TypeScript reviewer and Architecture reviewer
- The `msg.message` mutation at line 765 is correct, but lines 735 and 974 still reference the stale destructured `message`
- Lines 864, 866, 875, 985 correctly use `msg.message` — inconsistency suggests the bug was introduced during refactoring

## Proposed Solutions

### Option A: Move appendHistory after STT block (Recommended)
Move the `appendHistory` call to after the STT transcription block so the transcript is captured. Change line 974 to use `msg.message`.
- Pros: Minimal change, preserves existing flow
- Cons: Changes ordering of history logging slightly
- Effort: Small
- Risk: Low

### Option B: Stop destructuring `message`, use `msg.message` everywhere
Remove `message` from the destructuring and reference `msg.message` throughout.
- Pros: Eliminates the class of bug entirely
- Cons: More changes across the function
- Effort: Small
- Risk: Low

## Technical Details

- **Affected files:** `src/queue-processor.ts`
- **Lines:** 722 (destructuring), 735 (appendHistory), 765 (mutation), 974 (originalMessage)

## Acceptance Criteria

- [ ] Voice messages have their transcript logged in message-history.jsonl
- [ ] `originalMessage` in outgoing queue contains the transcript, not empty string
- [ ] Text messages continue to work unchanged
