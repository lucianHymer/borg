---
status: complete
priority: p2
issue_id: "062"
tags: [code-review, bug, voice]
dependencies: []
---

# Voice deduplication uses duration as a weak proxy for content

## Problem Statement

In `telegram-client.ts` line 354, voice dedup uses `voice_${duration}s` as the content fingerprint. Two different voice messages of the same duration (in whole seconds) from the same user within the dedup window would be incorrectly dropped.

## Findings

- Found by TypeScript Reviewer and Performance Oracle
- Duration is metadata with second-level granularity — collisions are common
- `ctx.getFile()` returns `file.file_unique_id` which is a stable content identifier

## Proposed Solutions

### Option A: Use file_unique_id (Recommended)
```typescript
if (isDuplicate(threadId, String(ctx.from.id), `voice_${file.file_unique_id}`)) {
```
- Effort: Trivial (file is already fetched on the next line)
- Risk: None

## Technical Details

- **Affected files:** `src/telegram-client.ts` line 354

## Acceptance Criteria

- [ ] Two different voice messages of the same duration are not deduplicated
- [ ] Actual duplicate voice messages are still caught
