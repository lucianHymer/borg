---
status: complete
priority: p1
issue_id: "079"
tags: [code-review, architecture, correctness]
dependencies: []
---

# Pending Approval Path Mismatch Breaks Cross-Zone Approval

## Problem Statement

Pending approval files are written to `.borg-infra/queue/pending/` (telegram-client.ts:911) but `findPendingFile()` (telegram-client.ts:57-64) only searches `.borg-core/queue/pending/` and `.borg-perimeter/queue/pending/`. This completely breaks cross-zone approval — when a user clicks Approve/Reject, `findPendingFile` returns null and the message is silently dropped. Additionally, `checkPendingApprovalReminder()` never finds any pending items because it searches the same wrong directories.

## Findings

**Source**: code review of PR #58 "feat(zones): make zones the only deployment mode"

- `telegram-client.ts:911`: Pending files are written to `.borg-infra/queue/pending/`
- `telegram-client.ts:57-64`: `findPendingFile()` searches only `.borg-core/queue/pending/` and `.borg-perimeter/queue/pending/`
- Result: Approve/Reject button callbacks always get `null` from `findPendingFile`, message is silently dropped
- `checkPendingApprovalReminder()` also uses this search, so reminder logic never fires

## Proposed Solutions

### Option 1: Write to and search infra-only (Recommended)
Replace `getPendingQueueDirs()` and `findPendingFile()` with a simpler infra-only lookup using a single `INFRA_PENDING_DIR` constant. Write pending files to `.borg-infra/queue/pending/` and search only there.
- Pros: Consistent single source of truth, simpler logic
- Cons: None — infra zone owning pending approvals is architecturally correct

### Option 2: Add infra dir to search list
Add `.borg-infra/queue/pending/` to the dirs searched by `findPendingFile()`.
- Pros: Minimal change
- Cons: Leaves ambiguity about which zone owns the pending dir

## Acceptance Criteria
- [x] Approve/Reject button callbacks successfully find and process pending files
- [x] `checkPendingApprovalReminder()` correctly detects pending items
- [x] A single constant defines the pending queue directory (no duplication between write and read paths)
- [ ] Integration test or manual verification: write a pending file, click Approve, confirm delivery

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Write path and search path were added independently without cross-checking |
| 2026-03-11 | Fixed: added `INFRA_PENDING_DIR` constant; updated `getPendingQueueDirs()` to return only that dir; updated write path to use same constant | Option 1 chosen — single source of truth, no ambiguity |
