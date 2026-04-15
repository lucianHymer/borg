# Teams and Workflows

Collaborative agent teams with portable workflow definitions.

## Philosophy

Compound knowledge into repos. Borg provides the lightest possible infrastructure (MCP tools for thread management). Everything else -- workflows, roles, coordination -- lives in repo skills files. Any Claude Code session in the repo knows how things work, even without Borg running. Different repos can have different patterns. Borg = plumbing, repo = intelligence.

## MCP Tools

4 team-related tools + 1 broadcast tool, available to ALL threads (not master-only):

1. **create_thread** -- Creates Telegram forum topic via direct HTTP API + registers in threads.json. Accepts `workflow` param (path to workflow skill file).
2. **configure_thread** -- Updates team/role/workflow metadata
3. **disband_team** -- Removes team association from all threads (soft cleanup, keeps topics)
4. **delete_thread** -- Permanently deletes Telegram forum topic + unregisters (hard cleanup, ephemeral topics)
5. **broadcast** -- Posts to broadcast group (see broadcast.md)

Both create_thread and delete_thread use direct Telegram HTTP API because MCP tools run in queue-processor process while the bot instance lives in telegram-client (separate processes).

## Team Commands

`/clear_team` and `/compact_team` work by writing standard incoming queue messages (`/clear` or `/compact` as message text) to each team member's thread. No custom command handlers needed. The existing pipeline processes them like any other message.

No compactSummary in ThreadConfig, no compact command in CommandMessageSchema, no clear_team MCP tools. Keep it simple: queue a message, let the pipeline handle it.

## Three-Layer Abstraction

1. **Generic workflow skills** (`.claude/skills/workflows/`) -- Describe roles, coordination, who goes first. Natural language, NO tool-specific references. Portable across any team infrastructure.
2. **Borg team bridge** (`~/.claude/skills/borg-teams.md`) -- The ONE globally-installed Borg-specific piece. Maps generic concepts to Borg MCP tools.
3. **Claude Code native fallback** -- Same workflows work without Borg; agent implements "create a thread" differently.

## Skills Directory Structure

### skills/global/ (Borg-specific, syncs to home)
- Syncs to `~/.claude/skills/` for all Borg-powered agents on restart
- Contains: `borg-teams.md`, `heartbeat-maintenance.md`
- Changes MUST go to repo file (syncs to home, not the other way)

### .claude/skills/workflows/ (repo-specific, portable)
- Stays in this repo only (NOT synced to home)
- Contains: `dev-team.md`, `writing-team.md`
- Works with any team infrastructure that provides shared task list, cross-thread messaging, thread creation

See: `src/mcp-tools.ts`, `src/session-manager.ts`, `src/telegram-client.ts`, `.claude/skills/workflows/`, `skills/global/`
