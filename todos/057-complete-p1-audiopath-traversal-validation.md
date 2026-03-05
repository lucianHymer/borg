---
status: complete
priority: p1
issue_id: "057"
tags: [code-review, security, voice]
dependencies: []
---

# Path traversal via audioPath in queue messages

## Problem Statement

The `audioPath` field in incoming queue messages is validated only as `z.string().optional()`. The queue processor passes this path directly to `transcribe()`, which calls `fs.readFileSync(oggPath)`. A crafted queue message with `audioPath: "/etc/shadow"` would read an arbitrary file and send its contents to the Speaches container.

While this is an internal-only attack (requires writing to the queue directory), it violates defense in depth.

## Findings

- Found by Security Sentinel
- `src/queue-processor.ts` line 65: schema only validates as string
- `src/audio.ts` line 42: `fs.readFileSync(oggPath)` with no path validation

## Proposed Solutions

### Option A: Validate audioPath prefix (Recommended)
Add a path prefix check before calling `transcribe()`:
```typescript
if (msg.audioPath && !msg.audioPath.startsWith(AUDIO_INCOMING_DIR + "/")) {
    throw new Error("audioPath outside allowed directory");
}
```
- Effort: Small
- Risk: Low

## Technical Details

- **Affected files:** `src/queue-processor.ts` (add validation before STT block)

## Acceptance Criteria

- [ ] Queue messages with audioPath outside AUDIO_INCOMING_DIR are rejected
- [ ] Normal voice messages continue to work
