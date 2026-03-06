# Dev Team Workflow

Use this workflow when a task requires planning, implementation, review, and knowledge capture.

## Roles

### Planner
- Breaks down the task into subtasks and creates implementation plan
- Goes first: receives the initial task/issue from the user
- Answers Worker questions about the plan
- Validates Reviewer concerns about architecture if asked

### Worker
- Implements code based on planner's architecture
- Runs tests, fixes issues
- Waits for planner to provide the plan before starting
- If the plan is unclear or missing detail, ask the Planner — don't guess

### Reviewer
- Orchestrator, not a direct reviewer — discovers and delegates to review sub-agents
- Search for available review sub-agents (check `.claude/skills/` and any installed plugins/skills)
- Spin up one blocking sub-agent per applicable review, running them in parallel
- After sub-agents report back, synthesize a single verdict
- MUST ask the Planner: "Does this implementation match your plan?" — this is a required step
- If issues found: send specific, actionable feedback to Worker (with file paths and line numbers)
- If no review sub-agents are available, fall back to manual review: run `git diff`, read actual changes, verify edge cases
- Never rubber-stamp — if you can't point to specific code you verified, you haven't reviewed

### Documenter
- Activates after the Reviewer approves
- Interviews each teammate (one message each, expect one reply each)
- Captures learnings into CLAUDE.md and project knowledge files
- Keeps CLAUDE.md tight and token-efficient — every line costs tokens in every future session
- Trims stale or redundant entries while adding new ones
- Sends final summary to master thread — this is the team's "done" signal

Note: model selection is handled by the message router, not per-role.

## Message Discipline

**The #1 rule: only send a message if the recipient needs to act on it.**

Every cross-thread message triggers a response (and burns tokens). So:

- NEVER send acknowledgments ("Got it!", "Thanks!", "Great work!")
- NEVER send status updates to teammates ("I'm done!", "All complete!")
- NEVER broadcast to multiple agents — message only the NEXT agent in the chain
- NEVER congratulate or celebrate with teammates

Legitimate messages (recipient must act):
- Planner -> Worker: "Here is the plan, implement it" (deliverable)
- Worker -> Reviewer: "Implementation ready for review" (with branch/commit ref)
- Reviewer -> Worker: "These issues need fixing: ..." (actionable feedback)
- Reviewer -> Planner: "Does this implement what you planned?" (required validation)
- Reviewer -> Planner: "Does this architectural choice look right?" (specific question)
- Worker -> Planner: "The plan says X but I found Y, how should I handle this?" (question)
- Documenter -> each teammate: interview question (expects one reply)
- Documenter -> master thread: final summary (done signal)

If you're about to send a message, ask: "Does the recipient need to DO something with this?"
If no, don't send it. Just continue your own work silently.

## Coordination Flow

1. Create a thread for each role
2. Give the planner the task (issue, description, context)
3. Planner creates plan, sends to **master thread for approval**
4. Master/user approves or rejects the plan
5. If approved, planner sends plan to Worker (one message)
6. Worker implements. If questions arise, asks Planner (minimal back-and-forth)
7. Worker sends ONE message to Reviewer: "ready for review" with commit ref
8. Reviewer discovers and spins up review sub-agents, synthesizes verdict
9. If issues: Reviewer -> Worker with specific fixes. Worker fixes, goto 7
10. Reviewer -> Planner: "Does this match your plan?" (required validation)
11. If Planner flags concerns: Reviewer -> Worker with Planner's feedback, goto 7
12. If approved: Reviewer -> Documenter "approved, ready for documentation"
13. Documenter sends ONE interview message to each teammate, waits for replies
14. Documenter writes docs, sends summary to master thread (DONE)
15. All agents go silent — no farewell messages

## After Completion

- Only the Documenter's message to master thread signals "done"
- Agents do NOT message each other after the Documenter finishes
- The master thread handles PR creation and team cleanup
- If an agent receives a message after completing its role, it responds briefly but does not initiate new cross-thread messages

## Coordination Guidelines
- If a teammate hasn't responded in 10 minutes, resend your message
- After 3 unanswered attempts, escalate to the master thread
- If the master thread reports a teammate is stuck, you may absorb their role

## When to Use

When the user describes a task that would benefit from structured development:
suggest creating a dev team. Ask first — this is a big operation.

## Workspace Isolation

Before any team member writes code, create a git worktree for the team:
- Create a worktree in a team-specific directory
- Create a new branch for the team's work
- Set all team members' working directory to the worktree path

This is not optional — teams must work in isolation from the main branch to avoid conflicts.
