---
status: complete
priority: p2
issue_id: "076"
tags: [code-review, agent-native, feature-gap]
dependencies: []
---

# Agent-native gaps: task reading, clear/compact team, timed tasks docs

## Problem Statement

Three agent-native parity gaps exist:
1. **Task visibility**: Users see task status via pinned Telegram messages. Agents have no MCP tool to read task status and the system prompt doesn't mention tasks exist.
2. **Clear/compact team**: Users have `/clear_team` and `/compact_team` Telegram commands. Agents could send `/clear` via `send_message` to each teammate but this is not documented anywhere.
3. **Timed tasks**: The `@HH:MM` syntax for HEARTBEAT.md timed tasks is not mentioned in `buildHeartbeatBlock()` system prompt.

## Findings

- **Task visibility:** Task files at `~/.claude/tasks/<taskListId>/` are readable but agents don't know they exist
- **Clear/compact:** `borg-teams.md:19-20` mentions commands but doesn't explain agent-native equivalent
- **Timed tasks:** `buildHeartbeatBlock()` lists Quick/Hourly/Daily tasks but not Timed Tasks

## Proposed Solutions

### Minimal (Recommended)
1. Add `## Timed Tasks` section to `buildHeartbeatBlock()` explaining `@HH:MM` syntax
2. Add clear/compact guidance to `buildTeamBlock()`: "Send '/clear' or '/compact' to a teammate via send_message"
3. Update `borg-teams.md` to explain agent-native equivalents

### Extended
4. Add `get_tasks` MCP tool that reads from `~/.claude/tasks/<taskListId>/`

## Acceptance Criteria

- [ ] System prompt mentions timed tasks `@HH:MM` syntax
- [ ] Team block or bridge skill documents clear/compact via send_message
- [ ] (Optional) get_tasks MCP tool for agent task visibility

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-06 | Created from code review of commit 8117970 | Always check: can an agent do what a user can do? |
