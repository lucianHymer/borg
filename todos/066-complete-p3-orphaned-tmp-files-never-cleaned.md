---
status: complete
priority: p3
issue_id: "066"
tags: [code-review, voice, cleanup]
dependencies: []
---

# Orphaned .tmp audio files never cleaned up

## Problem Statement

In `audio.ts` line 149, `sweepOldAudioFiles` skips `.tmp` files. If a write fails mid-way (crash, disk error), the `.tmp` file will never be cleaned up, accumulating on disk over time.

## Proposed Solutions

Clean up `.tmp` files that are older than `MAX_AGE_MS` (same as regular files).

## Technical Details

- **Affected files:** `src/audio.ts` line 149

## Acceptance Criteria

- [ ] Old `.tmp` files are cleaned up by the sweep
- [ ] In-progress `.tmp` files (recent) are not deleted
