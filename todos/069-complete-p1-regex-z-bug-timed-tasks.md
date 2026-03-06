---
status: complete
priority: p1
issue_id: "069"
tags: [code-review, bug, regex]
dependencies: []
---

# \Z regex bug in getTimedTasks — timed tasks silently fail

## Problem Statement

The `getTimedTasks()` function in `session-manager.ts` uses `\Z` in a JavaScript regex to match end-of-string. `\Z` is a PCRE/Python/Ruby construct — JavaScript does not support it. It is treated as a literal backslash + "Z" character, which means the regex **fails to match** when `## Timed Tasks` is the last section in HEARTBEAT.md (the most natural position). All timed tasks in a trailing section are silently ignored.

## Findings

- **Location:** `src/session-manager.ts:217`
- **Regex:** `/^## Timed Tasks\s*\n([\s\S]*?)(?=^## |\Z)/m`
- **Impact:** Timed tasks (`@HH:MM` annotations) never fire when `## Timed Tasks` is the last section
- **Confirmed by:** 5 of 8 review agents independently identified this bug
- **Severity:** Silent data loss — no error, no warning, tasks just don't execute

## Proposed Solutions

### Option A: Fix the lookahead termination (Recommended)
Replace `\Z` with a proper end-of-string match:
```typescript
const sectionMatch = heartbeatMd.match(/^## Timed Tasks\s*\n([\s\S]*?)(?=\n## |\s*$)/m);
```
- **Pros:** Minimal change, fixes the bug
- **Cons:** Need to verify `$` behavior with `m` flag (matches end-of-line in multiline)
- **Effort:** Small
- **Risk:** Low

### Option B: Two-pass approach
Find section start, then capture until next `## ` or end:
```typescript
const start = heartbeatMd.indexOf('## Timed Tasks');
if (start === -1) return [];
const afterHeader = heartbeatMd.indexOf('\n', start);
const nextSection = heartbeatMd.indexOf('\n## ', afterHeader);
const section = nextSection === -1
    ? heartbeatMd.slice(afterHeader + 1)
    : heartbeatMd.slice(afterHeader + 1, nextSection);
```
- **Pros:** No regex edge cases, clear logic
- **Cons:** More lines of code
- **Effort:** Small
- **Risk:** Low

## Recommended Action

Option A — fix the regex termination.

## Technical Details

- **Affected files:** `src/session-manager.ts`
- **Components:** Heartbeat timed task scheduling

## Acceptance Criteria

- [ ] Timed tasks fire correctly when `## Timed Tasks` is the last section in HEARTBEAT.md
- [ ] Timed tasks still work when followed by another `## ` section
- [ ] Add a test case for both scenarios

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-06 | Created from code review of commit 8117970 | `\Z` is not valid JavaScript regex — always use `$` or explicit string methods |

## Resources

- Commit: 8117970
- PCRE vs JS regex differences: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions
