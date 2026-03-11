---
status: pending
priority: p3
issue_id: "094"
tags: [code-review, docs, cleanup]
dependencies: []
---

# Stale comments referencing single-container mode after zones-only transition

## Problem Statement

Several comments remain from before the zones-only transition and now describe defunct behaviour or mask misconfiguration. These are misleading to future contributors who read the code expecting comments to reflect current architecture.

## Findings

1. **telegram-client.ts:866** — comment says `"In infra mode, poll all zone outgoing queues; in single-container, just one"`. Single-container mode no longer exists after PR #58. The comment describes a conditional that is now unconditional.

2. **telegram-client.ts:583** — broadcast fallback comment `// no zone config = all mainThread threads` describes a fallback path that masks misconfiguration in zones-only mode. In zones-only mode, missing zone config is always a bug, not a valid alternative mode. The comment normalises misconfiguration as expected behaviour.

## Proposed Solutions

1. For telegram-client.ts:866: Remove the `"in single-container, just one"` clause. Update comment to simply describe what the code does now: `"Poll all zone outgoing queues"`.

2. For telegram-client.ts:583: Either remove the fallback entirely (zones-only means zone config is always required) and throw/log an error on missing config, or if the fallback must remain for resilience, update the comment to call it out as a misconfiguration recovery path, not intended operation.

## Acceptance Criteria

- [ ] telegram-client.ts:866 comment no longer references single-container mode
- [ ] telegram-client.ts:583 comment either removed (with fallback eliminated) or updated to clearly label it as a misconfiguration recovery path
- [ ] No other comments in the codebase reference single-container as a current operating mode

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Stale comments that normalise misconfiguration are worse than no comments |
