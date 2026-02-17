---
status: complete
priority: p2
issue_id: "045"
tags: [code-review, quality, formatting]
---
# Mixed Indentation in queue-processor.ts (2-space vs 4-space)

## Problem Statement
The new heartbeat code in `queue-processor.ts` uses 4-space indentation while the existing code uses 2-space indentation. This creates a visually jarring mix within the same file. Other source files (`session-manager.ts`, `mcp-tools.ts`, `types.ts`) consistently use 4-space.

## Findings
- **Source:** TypeScript Reviewer (Issue #1), Pattern Recognition Specialist (Finding #9)
- **Location:** `src/queue-processor.ts`

| Section | Lines | Indent |
|---|---|---|
| log(), logPrompt(), buildQueryOptions(), collectQueryResponse() | Various | 2-space |
| processMessage(), processQueue() | Various | 2-space |
| **loadHeartbeatState(), saveHeartbeatState(), getDueTier()** | **259-308** | **4-space** |
| **formatCurrentTime()** | **396-399** | **4-space** |
| **processHeartbeat()** | **542-582** | **4-space** |

## Proposed Solutions

### Option A: Reformat entire file to 4-space (Recommended)
- **Effort:** Medium (automated with formatter)
- **Pros:** Matches other source files; consistent within file
- **Cons:** Large diff; best done as standalone commit
- **Risk:** Low — purely cosmetic

### Option B: Keep new code at 2-space to match existing file
- **Effort:** Small
- **Pros:** Consistent within file
- **Cons:** Diverges from other source files
- **Risk:** Low

## Acceptance Criteria
- [ ] `queue-processor.ts` uses one consistent indentation style throughout
- [ ] Style matches the other TypeScript source files in the project
