---
status: complete
priority: p1
issue_id: "058"
tags: [code-review, security, performance, voice]
dependencies: []
---

# No file size validation on voice message downloads

## Problem Statement

The voice handler in `telegram-client.ts` checks `duration > 300` (5 minutes) but does not validate the file size. Telegram allows bot file downloads up to 20MB. Duration is metadata, not enforced — a crafted OGG could have short reported duration but large file size. The file is read entirely into memory (`Buffer.from(await res.arrayBuffer())`) before writing to disk, and again by `transcribe()` via `fs.readFileSync()`.

## Findings

- Found by Security Sentinel and Performance Oracle
- `telegram-client.ts` lines 360-378: no file_size check
- `ctx.getFile()` returns `file.file_size` which can be checked before download
- Bot container has 2GB memory limit; double-buffered 20MB files under load could cause OOM

## Proposed Solutions

### Option A: Check file_size before download (Recommended)
```typescript
const file = await ctx.getFile();
if (file.file_size && file.file_size > 10 * 1024 * 1024) {
    await ctx.reply("Voice file too large (max 10MB).", { ... });
    return;
}
```
- Effort: Small
- Risk: Low

### Option B: Stream download to disk
Use `res.body` piped to a file stream instead of buffering in memory.
- Effort: Medium
- Risk: Low

## Technical Details

- **Affected files:** `src/telegram-client.ts` lines 360-378

## Acceptance Criteria

- [ ] Voice files exceeding size limit are rejected with user-friendly message
- [ ] Normal voice messages continue to work
