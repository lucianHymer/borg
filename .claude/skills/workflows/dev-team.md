# Dev Team Workflow

Use this workflow when a task requires planning, implementation, review, and knowledge capture.

## Roles

### Planner
- Breaks down the task into subtasks and creates implementation plan
- Coordinates with worker and reviewer
- Goes first: receives the initial task/issue from the user

### Worker
- Implements code based on planner's architecture
- Runs tests, fixes issues
- Waits for planner to provide the plan before starting

### Reviewer
- Reviews code changes for quality, correctness, security
- Waits for worker to signal readiness for review
- Sends feedback to worker (and planner if architectural)

### Documenter
- Activates after the main work is done
- Interviews each teammate: what did you learn? where did you struggle? what was surprising? what would you do differently?
- Captures learnings into CLAUDE.md and project knowledge files
- Keeps CLAUDE.md tight and token-efficient — every line costs tokens in every future session, so be ruthlessly concise
- Trims stale or redundant entries while adding new ones

Note: model selection is handled by the message router, not per-role.

## Coordination

1. Create a thread for each role
2. Give the planner the task (issue, description, context)
3. Planner creates plan, sends to **master thread for approval**
4. Master/user approves or rejects the plan
5. If approved, planner sends plan to worker
6. Worker implements, signals reviewer when ready
7. Reviewer reviews, sends feedback to worker
8. Loop 6-7 until approved
9. Documenter interviews all teammates, captures learnings
10. Documenter updates CLAUDE.md and knowledge files

## Coordination Guidelines
- If a teammate hasn't responded in 10 minutes, resend your message
- After 3 unanswered attempts, escalate to the master thread
- If the master thread reports a teammate is stuck, you may absorb their role

## Completion
After the documenter finishes:
1. Documenter sends a summary to the master thread
2. Master thread notifies the user that the team's work is complete
3. Master thread creates a PR from the team branch to main (if code was written)

## When to Use

When the user describes a task that would benefit from structured development:
suggest creating a dev team. Ask first — this is a big operation.

## Workspace Isolation

Before any team member writes code, create a git worktree for the team:
- Create a worktree in a team-specific directory
- Create a new branch for the team's work
- Set all team members' working directory to the worktree path

This is not optional — teams must work in isolation from the main branch to avoid conflicts.
