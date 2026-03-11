---
status: complete
priority: p2
issue_id: "089"
tags: [code-review, agent-native, ux]
dependencies: []
---

# Agents unaware of cross-zone approval latency and rejection

## Problem Statement

Agents calling `send_message` to a cross-zone thread receive "Message sent to thread X (Y)" immediately, implying delivery. But the message may sit pending human approval indefinitely or be rejected. Agents have no way to know a message is pending, set user expectations, or handle a rejection system message. The system prompt and tool description have no mention of zones or approval latency.

## Findings

- mcp-tools.ts:74: `send_message` tool description makes no mention of cross-zone approval requirement
- The tool returns a success message immediately after writing to the outgoing queue, before any human review
- If a human rejects the message, a system message is presumably delivered back to the sending agent, but the format is undocumented in the system prompt
- Agents in core calling `send_message` to a perimeter thread (or vice versa) will assume delivery has occurred and may proceed with follow-up actions that depend on the message being received
- session-manager.ts:430 system prompt has no explanation of zone boundaries, approval workflow, or rejection message format
- This creates a poor agent-native experience: agents cannot set user expectations or implement retry/escalation logic

## Proposed Solutions

- Update `send_message` tool description (mcp-tools.ts:74) to note that cross-zone delivery requires human approval and may be delayed or rejected
- Update system prompt in session-manager.ts to explain rejection message format so agents can recognize and handle it
- Optionally make `send_message` return a different acknowledgment string for cross-zone sends (e.g., "Message queued for cross-zone approval to thread X") vs. same-zone sends
- Document the rejection system message format so agents can implement appropriate handling

## Acceptance Criteria

- [x] `send_message` tool description mentions cross-zone approval requirement
- [x] System prompt explains the rejection message format agents may receive
- [ ] Agents can distinguish cross-zone pending sends from delivered sends based on tool return value
- [x] No regression for same-zone `send_message` behavior

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Agent-native UX requires tools to accurately describe their delivery semantics; "sent" implies delivery but cross-zone approval breaks this invariant |
| 2026-03-11 | Fixed: updated send_message description (mcp-tools.ts:74) and added Zone Approval section to both buildMasterCrossThreadBlock() and buildWorkerCrossThreadBlock() in session-manager.ts | The third acceptance criterion (distinguishing return value) is left pending — it would require inspecting zone membership at call time and is a separate, larger change |
