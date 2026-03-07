# Borg Team Operations

This skill maps generic team concepts to Borg's MCP tools.

## Creating Threads
When a workflow says "create a thread for each role", use the `create_thread`
MCP tool for each role. Set the team, role, and initialMessage fields.
Teammates are derived automatically from the shared `team` field — no manual setup needed.

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

## No Heartbeats
Team threads don't have heartbeats. If periodic work is needed, ask a main
thread to add it to their HEARTBEAT.md.
