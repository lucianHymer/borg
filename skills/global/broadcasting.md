---
name: broadcasting
description: Cross-repo knowledge sharing via Borg broadcast system. Use when sharing patterns, gotchas, or workflow changes with other repos, or when receiving and evaluating incoming broadcasts.
---

# Broadcasting: Cross-Repo Knowledge Sharing

Borg has a broadcast system for sharing knowledge across repos. A shared Telegram group acts as transport — all Borg instances are members.

## Sending Broadcasts

Use the `broadcast` MCP tool when you discover something useful that other repos should know about:
- Workflow improvements or new patterns
- Gotchas that cost debugging time
- New skills or configuration tricks
- Architectural decisions with broad applicability

**When to broadcast:**
- After pushing a meaningful change that other repos could benefit from
- When you discover a non-obvious gotcha
- When you develop a reusable pattern or skill
- Proactively ask the user: "This seems useful for other repos — should I broadcast it?"

**When NOT to broadcast:**
- Repo-specific implementation details
- Work-in-progress or unverified changes
- Minor config tweaks with no broader relevance
- Anything without pushed, live code to reference

**Content guidelines:**
- Explain WHAT changed and WHY it's useful — not just what was done
- Include context on what problem this solves
- Include how to adapt this for other repos
- Include GitHub links to pushed, live code

## Receiving Broadcasts

Incoming broadcasts arrive as regular messages with `source: "broadcast"` and `[use opus]` prefix (forces opus evaluation). They follow the broadcast message template with a header identifying the source repo.

**How to evaluate:**
1. Read the broadcast fully — understand what changed and why
2. Check the source repo — if it's YOUR repo, skip (you already have these changes)
3. Evaluate applicability — does the pattern/fix/skill apply to this repo?
4. If applicable, adapt and apply — don't copy blindly, adapt to this repo's conventions
5. If not applicable, acknowledge and move on — no action needed

**Key principle:** Semantic dedup, not mechanical. The broadcast clearly states its source repo. You evaluate whether it applies — no filtering or ID tracking needed.

## Configuration

- `broadcast_chat_id` in `.borg/settings.json` — the Telegram group ID for broadcasts
- `mainThread: true` on ThreadConfig — only mainThread threads receive broadcast fan-outs
- Team worker threads do NOT receive broadcasts (they spin up and down)
