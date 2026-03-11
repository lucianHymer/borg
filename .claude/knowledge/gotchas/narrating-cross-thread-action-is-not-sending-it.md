# Narrating a cross-thread action is not the same as taking it

When a workflow step requires sending a cross-thread message (e.g., "Reviewer MUST ask the Planner to confirm"), that message must be sent in the same response — not described as a future intention.

**The failure mode:** Writing "once you confirm..." or "I will send this to the Planner" as narrative prose without actually calling `send_message`. The step then stalls waiting for user intervention.

**The rule:** If your workflow says to take a cross-thread action, take it in the same response. Don't leave it as a narrative placeholder. The user should never have to prompt you to execute a step you already described.

This applies to all tool-based actions in workflow steps: if the step says "send", "message", "notify", or "ask" — do it now.

**Related files:** .claude/skills/workflows/dev-team.md
