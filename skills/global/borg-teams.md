# Borg Team Operations

This skill maps generic team concepts to Borg's MCP tools.

## Creating Threads
When a workflow says "create a thread for each role", use the `create_thread`
MCP tool for each role. Set the team, role, and initialMessage fields.
Teammates are derived automatically from the shared `team` field — no manual setup needed.

## Workspace Isolation (Worktrees)
When a workflow says "create a git worktree for the team":
1. Use Bash to run: `git worktree add /absolute/path/to/borg/.borg/worktrees/{team-name} -b team/{team-name}`
2. When calling `create_thread`, set the `cwd` parameter to the absolute worktree path
3. All team members share the same `cwd` — they all work in the same worktree

Example:
```bash
git worktree add /home/lucian/workspace/borg/.borg/worktrees/my-team -b team/my-team
```
Then use `cwd: "/home/lucian/workspace/borg/.borg/worktrees/my-team"` when creating threads.

## Messaging Teammates
When a workflow says "send to [teammate]", use the `send_message` MCP tool
with the teammate's threadId.

## Team Discovery
Use `list_threads` to see all threads and their team/role assignments.

## Team Cleanup
Use `disband_team` to remove team associations (soft cleanup — keeps threads).
Use `delete_thread` to permanently delete a Telegram forum topic and unregister it
from Borg (hard cleanup — makes teams ephemeral). This is irreversible.
`/clear_team` and `/compact_team` Telegram commands operate on all members
of the current thread's team.

## Shared Task List

All threads in a team share a single task list — tasks created in one thread are immediately visible to all teammates. Team members should:
- Check `TaskList` proactively at the start of each session and after completing any task
- Claim tasks by setting status `in_progress` before starting work
- Mark tasks `completed` immediately when done so blockers clear for teammates

The Planner role is responsible for creating ALL tasks (both workflow scaffolding and implementation subtasks) at the start of a session.

## No Heartbeats
Team threads don't have heartbeats. If periodic work is needed, ask a main
thread to add it to their HEARTBEAT.md.
