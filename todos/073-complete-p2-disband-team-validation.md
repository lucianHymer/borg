---
status: complete
priority: p2
issue_id: "073"
tags: [code-review, validation, consistency]
dependencies: []
---

# disband_team missing Zod regex validation on team parameter

## Problem Statement

The `disband_team` MCP tool accepts a bare `z.string()` for the `team` parameter, while `create_thread` and `configure_thread` validate with `.min(1).max(64).regex(/^[a-z][a-z0-9-]*$/)`. This is inconsistent and allows arbitrary string input.

## Findings

- **Location:** `src/mcp-tools.ts:787`
- **Current:** `{ team: z.string().describe("Team name to disband") }`
- **Should be:** `{ team: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).describe("Team name to disband") }`

## Acceptance Criteria

- [ ] `disband_team` team parameter has same validation as other team tools

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-06 | Created from code review of commit 8117970 | One-line fix |
