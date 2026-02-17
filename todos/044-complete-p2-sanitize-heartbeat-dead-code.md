---
status: complete
priority: p2
issue_id: "044"
tags: [code-review, security, agent-native]
---
# sanitizeHeartbeatContent() Is Dead Code — Never Called at Runtime

## Problem Statement
The `sanitizeHeartbeatContent()` function in `session-manager.ts:145` is defined, exported, and documented but never imported or called anywhere in the runtime codebase. It was designed as defense-in-depth against cross-pollination prompt injection attacks where a compromised worker thread writes malicious content into its HEARTBEAT.md. The current defense relies entirely on prompt-level instructions telling the master agent to treat worker files as untrusted.

## Findings
- **Source:** Security Sentinel (Finding 1 — Medium severity), Agent-Native Reviewer (Warning 1)
- **Location:** `src/session-manager.ts:145-157` (function definition)
- **Zero callsites** across all `.ts` files in `src/`

The function handles:
- Truncation to 2048 bytes
- Stripping fenced code blocks (``` ... ```)
- Stripping inline HTML tags

But the cross-pollination reading happens via the agent running shell commands during heartbeat, not through a code path that calls this function.

## Proposed Solutions

### Option A: Restore explicit CLI instructions in prompt (Recommended short-term)
- **Effort:** Small
- **Pros:** Immediate; matches old prompt behavior; works with current architecture
- **Cons:** Prompt-level defense is soft; function remains unused
- **Risk:** Low

This is addressed by todo 042 (master daily extras) which restores the `head -c 2048` and `sed` sanitization CLI commands in the prompt.

### Option B: Create `read_worker_heartbeat` MCP tool (Future)
- **Effort:** Medium
- **Pros:** Code-enforced sanitization; `sanitizeHeartbeatContent()` finally wired up; agent gets clean data without needing to self-sanitize
- **Cons:** New MCP tool not in the current plan's scope; adds complexity
- **Risk:** Low — plan's deferred items don't prohibit this, but it wasn't planned

### Option C: Remove the function
- **Effort:** Trivial
- **Pros:** Eliminates dead code confusion
- **Cons:** Loses the defense-in-depth investment; would need to be rewritten for Option B
- **Risk:** Medium — removes a useful building block

## Acceptance Criteria
- [ ] Either: sanitizeHeartbeatContent() is wired into a code path that handles cross-pollination reads
- [ ] Or: prompt-level sanitization instructions are restored (via todo 042)
- [ ] Or: function is removed with a comment explaining the architectural decision
