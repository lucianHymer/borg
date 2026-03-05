---
status: pending
priority: p2
issue_id: "059"
tags: [code-review, performance, voice, architecture]
dependencies: []
---

# STT transcription blocks queue processor slot for up to 2 minutes

## Problem Statement

In `queue-processor.ts`, `await transcribe(msg.audioPath)` runs inside `processMessage()`, holding an `activeThreads` slot for up to 120 seconds (the STT timeout). During this time, no other message for the same thread can be processed, and one of the limited concurrent slots is occupied doing I/O unrelated to Claude SDK sessions.

## Findings

- Found by Performance Oracle
- With `max_concurrent_sessions` of 3-5, two simultaneous voice messages could saturate the queue
- STT is pure I/O work that doesn't need a session slot

## Proposed Solutions

### Option A: Move STT to telegram-client before enqueuing
Transcribe in telegram-client.ts after downloading the OGG, before writing the queue file. The message enters the queue with text already populated.
- Pros: Simplest; queue processor unchanged; STT doesn't consume session slots
- Cons: Adds latency to the acknowledgement flow in telegram-client
- Effort: Medium
- Risk: Low

### Option B: Pre-processing step in queue scanner
Add a transcription step in the queue scanner loop that runs before dispatching to `processMessage()`, without claiming an active slot.
- Pros: Keeps telegram-client thin
- Cons: More complex queue scanner logic
- Effort: Medium
- Risk: Medium

## Technical Details

- **Affected files:** `src/queue-processor.ts` (lines 740-790), potentially `src/telegram-client.ts`

## Acceptance Criteria

- [ ] STT transcription does not hold a queue processing slot
- [ ] Other messages for other threads are not blocked during transcription
