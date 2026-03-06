---
status: complete
priority: p3
issue_id: "078"
tags: [code-review, type-safety, coupling]
dependencies: []
---

# TaskListMapping type duplicated between queue-processor and telegram-client

## Problem Statement

The `TaskListMapping` shape is defined as an interface in `queue-processor.ts:501` and used inline as `Record<string, { threadIds: number[]; team?: string }>` in `telegram-client.ts:1020`. Also, `TASK_LISTS_FILE` path is independently defined in both files. These implicit contracts could drift.

## Findings

- **Location:** `src/queue-processor.ts:501`, `src/telegram-client.ts:1020`
- **Also:** `TASK_LISTS_FILE` defined independently in both files

## Proposed Solutions

Export `TaskListMapping` from `types.ts` and share the file path constant.

## Acceptance Criteria

- [ ] Shared type definition for TaskListMapping
- [ ] Shared constant for TASK_LISTS_FILE path

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-06 | Created from code review of commit 8117970 | Shared file contracts need shared types |
