---
status: complete
priority: p3
issue_id: "095"
tags: [code-review, agent-native, ux]
dependencies: []
---

# list_threads MCP tool omits zone membership, making cross-zone delivery opaque

## Problem Statement

The `list_threads` MCP tool output (mcp-tools.ts:128-150) shows `isMaster`, `mainThread`, `team`, `role`, and `cwd` but not zone membership. In a zones-only deployment, whether two threads share a zone determines whether a `send_message` call delivers instantly (same zone) or requires human approval and may be rejected (cross-zone). Agents cannot distinguish these two cases without zone information, making cross-zone coordination opaque.

## Findings

- `list_threads` output includes: `threadId`, `name`, `isMaster`, `mainThread`, `team`, `role`, `cwd`
- Zone name is stored in `ThreadConfig` but not surfaced in `list_threads`
- An agent planning to coordinate with another thread cannot tell from `list_threads` output alone whether the target thread is in the same zone or a different one
- Cross-zone messages have meaningfully different semantics: they require human approval in the target zone, may be rejected, and have higher latency. This is an invisible footgun.

## Proposed Solutions

Option A (add zone field): Add `zone?: string` to the `list_threads` output for each thread. Straightforward — the data is already available in `ThreadConfig`.

Option B (update tool description): Update the `list_threads` tool description to note that cross-zone messaging requires human approval. Agents can then infer risk from the description rather than per-thread data.

Option A is preferred — the description alone is insufficient context for an agent deciding whether to send a message. Having the zone name per thread lets the agent reason clearly.

Consider also updating the `send_message` tool description to warn that cross-zone delivery requires human approval.

## Acceptance Criteria

- [x] `list_threads` output includes a `zone` field (or equivalent) for each thread
- [x] An agent can determine same-zone vs cross-zone status for any pair of threads from `list_threads` output alone
- [x] `send_message` tool description (or a related tool) notes the human-approval requirement for cross-zone messages

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Agent-visible delivery semantics must be surfaced in tool output, not buried in architecture docs |
| 2026-03-11 | Fixed: list_threads now loads zone config (with try/catch, non-fatal) and appends `zone=<name>` to each thread line; tool description updated to warn about cross-zone approval requirement | Zone field omitted (not appended) when zone config absent, so non-zone deployments unaffected |
