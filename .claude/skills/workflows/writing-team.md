# Writing Team Workflow

Use this workflow when a writing task requires research, outlining, drafting, editing, and knowledge capture.

## Workspace Isolation

Before creating team members, you MUST create a git worktree:
```
git worktree add .borg/worktrees/{team-name} -b team/{team-name}
```
Set all team members' working directory to the worktree path. This is not
optional — teams must work in isolation from the main branch.

## GitHub Integration

- **Outliner**: If given a GitHub issue, overwrite its body with the full outline (no comments — comments create conflicting information). If no issue exists, create one. The issue body IS the outline.
- **Writer**: Always opens a pull request on the worktree branch referencing the issue (`Closes #N`). Never merge — that's the master thread's job.
- **Editor**: Approves the PR on GitHub when satisfied. Editorial commentary stays in-thread.
- Store issue/PR numbers in task metadata (`issueNumber`, `prNumber`) for visibility across the team.

## Shared Task List

All team members share a task list. **Be proactive about it:**
- Check `TaskList` at the start of every session and after completing any task
- Claim tasks by setting yourself as owner and status `in_progress` BEFORE starting work
- Mark tasks `completed` immediately when done — teammates may be waiting for blockers to clear
- Never start a task that is blocked or already owned by someone else

## Standard Tasks (Outliner always creates these)

The Outliner creates ALL tasks upfront at the start — both standard workflow tasks and dynamic section tasks. Standard tasks are always the same regardless of what's being written:

| # | Owner | Subject | Blocked by |
|---|-------|---------|------------|
| 1 | Outliner | Research topic and create outline | — |
| 2 | Outliner | Create or update GitHub issue with outline | #1 |
| 3 | Writer | Review outline; clarify with Outliner if unclear, then proceed | #2 |
| 4–N | Writer | [Dynamic section/chapter tasks — see below] | #3 |
| N+1 | Writer | Open pull request | all section tasks |
| N+2 | Editor | Edit and review PR; ask Outliner to confirm outline was followed | #N+1 |
| N+3 | Documenter | Interview team and capture learnings | #N+2 |

Use `addBlockedBy` when creating tasks so blockers are enforced and agents see work unlock in sequence.

## Dynamic Section Tasks

After the standard tasks, Outliner creates the actual writing subtasks (tasks #4–N). These are specific to the piece — e.g., "Draft introduction", "Write section on X", "Write conclusion", "Add citations/references". Rules:
- All blocked by task #3 (Writer: review outline)
- All block the PR task (Writer: open pull request)
- Be granular enough that Writer can check them off as it goes
- Each should be completable in one focused session
- Order should reflect the logical reading order of the piece

## Roles

### Outliner
- Goes first: receives the topic, brief, or assignment from the user
- Researches the topic — gathers sources, context, and key points
- Creates a structured outline: thesis/angle, sections with key points, target audience, tone
- Creates ALL tasks (standard + dynamic) upfront with correct blockers
- Creates or overwrites the GitHub issue body with the full outline
- Sends outline to master thread for approval before Writer begins
- Answers Writer questions if outline is unclear
- Validates Editor's "does this follow the outline?" check at the end

### Writer
- Waits for task #3 to unblock before starting
- Claims task #3, reviews outline, messages Outliner if anything is unclear, then marks it done
- Claims and drafts sections one at a time in order
- Writes in the appropriate tone and style for the target audience
- Places content in files within the worktree (e.g., `content/`, `drafts/`, or project-specific paths)
- Opens the PR when all section tasks are completed

### Editor
- Claims the review task when it unblocks (after PR is open)
- Reviews for: clarity, coherence, flow, grammar, factual accuracy, tone consistency
- MUST ask the Outliner: "Does this follow your outline and cover the key points?" — required step
- Approves the PR on GitHub when satisfied
- If issues found: sends specific, actionable feedback to Writer (which section, what to fix, why)
- Suggests cuts, restructuring, or additions with concrete examples
- Never rubber-stamp — if you can't point to specific passages you verified, you haven't edited

### Documenter
- Claims the docs task when it unblocks (after editing approved)
- Interviews each teammate (one message each, expect one reply each)
- Captures learnings: style decisions, what worked, audience insights, process improvements
- Updates CLAUDE.md and project knowledge files with reusable patterns
- Keeps CLAUDE.md tight and token-efficient — every line costs tokens in every future session
- Sends final summary to master thread — this is the team's "done" signal

Note: model selection is handled by the message router, not per-role.

## Message Discipline

**The #1 rule: only send a message if the recipient needs to act on it.**

Every cross-thread message triggers a response (and burns tokens). So:

- NEVER send acknowledgments ("Got it!", "Thanks!", "Great work!")
- NEVER send status updates to teammates — update the task list instead, they can see it
- NEVER broadcast to multiple agents — message only the NEXT agent in the chain
- NEVER congratulate or celebrate with teammates

Legitimate messages (recipient must act):
- Outliner → Writer: "Here is the outline, draft sections #4–N" (deliverable, includes outline)
- Writer → Outliner: "The outline says X but I think Y works better, should I adjust?" (question)
- Writer → Editor: "PR ready for review: #N" (with PR link)
- Editor → Outliner: "Does this follow what you outlined?" (required validation)
- Editor → Writer: "These sections need revision: ..." (actionable feedback with specifics)
- Documenter → each teammate: interview question (one message, expects one reply)
- Documenter → master thread: final summary (done signal)

When you finish a workflow step, update the task status — don't message teammates to tell them you're done.

## Coordination Flow

1. Create a thread for each role
2. Give the Outliner the topic (brief, assignment, context, references)
3. Outliner researches, creates all tasks (standard + dynamic) with blockers, then creates/updates GitHub issue
4. Outliner sends outline to **master thread for approval**
5. Master/user approves or rejects the outline
6. If approved, Outliner sends outline to Writer: "draft sections #4–N"
7. Writer claims task #3, reviews outline, asks Outliner if unclear, marks #3 done
8. Writer claims and drafts sections; opens PR when all are done
9. Editor's task unblocks — claims it, reviews the full piece
10. Editor asks Outliner to confirm outline was followed (required)
11. If issues: Editor → Writer with specific revision notes; Writer revises and updates PR, goto 9
12. If approved: Editor approves PR on GitHub; Documenter's task unblocks
13. Documenter sends ONE interview message to each teammate, waits for replies
14. Documenter writes learnings, sends summary to master thread (DONE)
15. All agents go silent — no farewell messages

## After Completion

- Only the Documenter's message to master thread signals "done"
- Agents do NOT message each other after the Documenter finishes
- The master thread handles PR merge and team cleanup (`/clear_team`)
- If an agent receives a message after completing its role, it responds briefly but does not initiate new cross-thread messages

## When to Use

When the user asks for content creation (newsletter, blog post, article, documentation, essay):
suggest setting up a writing team. Ask first — this is a big operation.
