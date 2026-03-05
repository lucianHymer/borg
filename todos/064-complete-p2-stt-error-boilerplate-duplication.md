---
status: complete
priority: p2
issue_id: "064"
tags: [code-review, quality, voice]
dependencies: ["055"]
---

# Duplicated STT error-response boilerplate in queue-processor

## Problem Statement

The empty-transcript and STT-error paths in `queue-processor.ts` (lines 744-788) are nearly identical ~20-line blocks: both construct an `OutgoingMessage`, write it atomically, call `clearStatus`, `cleanupAudioFile`, unlink `processingFile`, and return. They differ only in the `message` and `originalMessage` strings.

## Findings

- Found by TypeScript Reviewer and Code Simplicity Reviewer
- ~40 lines of copy-paste that should be a helper

## Proposed Solutions

### Option A: Extract writeErrorAndBail helper (Recommended)
```typescript
function writeErrorAndBail(opts: { channel, threadId, sender, messageId, message, originalMessage, processingFile, audioPath }): void
```
- Effort: Small
- Risk: None

## Technical Details

- **Affected files:** `src/queue-processor.ts` lines 744-788

## Acceptance Criteria

- [ ] Both error paths use a shared helper
- [ ] Behavior unchanged
