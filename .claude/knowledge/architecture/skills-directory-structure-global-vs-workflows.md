# Skills directory structure: global vs workflows

Borg has TWO separate skills directories with different purposes:

## skills/global/ (Borg-specific, syncs to home)
- Location: `/home/lucian/workspace/borg/skills/global/`
- Syncs to: `~/.claude/skills/` for ALL Borg-powered agents on restart
- Purpose: Borg-specific bridge layer that maps generic team concepts to Borg MCP tools
- Files: `borg-teams.md`, `heartbeat-maintenance.md`
- Scope: Global — installed for every agent using Borg infrastructure
- Source of truth: Changes MUST go to repo file, which syncs to home

## .claude/skills/workflows/ (Repo-specific, portable)
- Location: `/home/lucian/workspace/borg/.claude/skills/workflows/`
- Stays in: This repo only (NOT synced to home)
- Purpose: Workflow definitions (dev-team, writing-team) that are team-agnostic and implementation-agnostic
- Files: `dev-team.md`, `writing-team.md`
- Scope: Repo-specific — shared between repos via copy/adapt pattern, not plugins
- Portability: Works with any team infrastructure (Borg, Claude Code teams, etc.) as long as there's shared task list, cross-thread messaging, and thread creation

## When Lucian says "skills"
He could mean either directory depending on context:
- `skills/global/` when talking about Borg-specific bridge layer
- `.claude/skills/workflows/` when talking about portable workflow definitions
- Both when talking about the overall skills architecture

Changes to BOTH always go to the repo files (never just home directory), but only `skills/global/` gets synced to home for global use.

**Related files:** skills/global/borg-teams.md, .claude/skills/workflows/dev-team.md, .claude/skills/workflows/writing-team.md
