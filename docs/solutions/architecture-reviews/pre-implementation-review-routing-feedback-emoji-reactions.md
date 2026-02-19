---
title: "Pre-Implementation Review: Routing Feedback via Emoji Reactions"
date: 2026-02-19
category: architecture-reviews
problem_type: pre-implementation-review
tags:
  - routing
  - emoji-reactions
  - telegram-integration
  - data-validation
  - agent-parity
  - xss-prevention
  - jsonl-logging
  - pre-implementation
  - multi-agent-review
  - deepen-stage
components:
  - src/telegram-client.ts
  - src/routing-logger.ts
  - src/types.ts
  - src/queue-processor.ts
  - src/dashboard.ts
  - src/mcp-tools.ts
  - static/dashboard.html
technologies:
  - typescript
  - grammy
  - telegram-bot-api
  - zod
  - jsonl
severity: critical
agents_used: 12
critical_bugs_found: 4
medium_issues_found: 10
api_assumptions_validated: 5
new_phases_added: 1
related_plans:
  - docs/plans/2026-02-19-feat-routing-feedback-emoji-reactions-plan.md
  - docs/brainstorms/2026-02-19-routing-feedback-brainstorm.md
---

# Pre-Implementation Review: Routing Feedback via Emoji Reactions

12 parallel review/research agents analyzed the routing feedback plan before implementation, catching 4 critical bugs, 10 medium-priority issues, and validating 5 external API assumptions. One new implementation phase (MCP tools) was added.

**Review stage:** Deepen (post-plan, pre-implementation)
**Plan file:** `docs/plans/2026-02-19-feat-routing-feedback-emoji-reactions-plan.md`

---

## Investigation Steps (What Each Agent Found)

### security-sentinel
- Chat ID validation requirement on reaction events
- Validation of `stored.model` against known model set before logging corrections (prevents data pollution from tampered message-models.json)
- Privacy note: raw prompts now in plaintext JSONL served via unauthenticated dashboard API — flagged as acceptable for internal tool on trusted network

### kieran-typescript-reviewer
- **Critical:** `RoutingMetadata` missing `model` field — every logged entry would have `model: undefined`
- **Critical:** `lookupMessageModel()` return type change breaks existing caller at line 243 — all reply-to-bot messages rejected by queue Zod validation
- `tier` should use `Tier` union type, not bare `string`

### code-simplicity-reviewer
- **Critical:** Bot self-reaction filter (`ctx.from?.id === bot.botInfo.id`) was dead code — Telegram API guarantees bots don't receive own reaction events
- `logDecision` should be placed once at end of processing block, not duplicated per send path
- Debug logging for pruned message lookups (make data loss observable)

### pattern-recognition-specialist
- Matched `routingMetadata` nested object to existing `topicName` queue propagation precedent
- `ROUTING_LOG` path constant needs shared export from routing-logger.ts
- Normalize-on-load for message-models.json migration consistent with mtime cache pattern

### performance-oracle
- **Critical:** Growth estimate 30x too pessimistic — raw messages ~500B, growth 3-5x (not 120x), rotation every ~250 days (not 8 days)
- Cross-process JSONL rotation race: extremely narrow window, at most one entry lost, benign
- Prompt truncation to 4096 chars bounds worst-case entry at ~4.3KB

### agent-native-reviewer
- **New phase:** Dashboard gains routing data but agents had zero MCP access — added `get_routing_decisions` (read-only, all threads) and `log_routing_correction` (master-only mutation)
- Applied established tool tiering: read-only for all, mutations gated behind `sourceThreadId === 1`

### architecture-strategist
- Moving `logDecision` to telegram-client changes it from "I/O only" to "I/O + routing log finalization" — requires CLAUDE.md update
- Validated nested `routingMetadata` as justified structural evolution
- Rollback risk: old code reads `[object Object]` from modified message-models.json — rollback requires deleting the file

### julik-frontend-races-reviewer
- `escapeHtml()` doesn't escape double quotes — title attribute XSS via prompt containing `"`
- Full `innerHTML` replacement on SSE destroys scroll position — proposed incremental DOM patching
- Anonymous reactions (`user` undefined) handled correctly since handler doesn't depend on `user` field

### data-integrity-guardian
- `LogEntry` lacked type discriminator — added `type: "decision"` for proper discriminated union
- Correction ordering bug: reversed array means oldest correction wins without timestamp comparison
- Tier summary denominator wrong: `entries.length` includes corrections, diluting percentages

### data-migration-expert
- Recommended "normalize on load" for message-models.json (not "normalize on read") — eliminates permanent mixed-type state
- Old string entries age out via 1000-entry pruning (~20 days at 50 msgs/day)
- `threadId: 0` for old entries semantically meaningless — changed to optional

### best-practices-researcher (Telegram Bot API)
- Confirmed `MessageReactionUpdated` has exactly 7 fields, no `message_thread_id`
- Confirmed `DEFAULT_UPDATE_TYPES` excludes `message_reaction` and `message_reaction_count`
- Confirmed bots do NOT receive `message_reaction` for bot-set reactions
- Confirmed 79 valid emoji, ⚡/✍/🔥 all valid
- Bot must be admin in group for reaction events

---

## Critical Bugs Caught

### Bug 1: `model` missing from RoutingMetadata

**Caught by:** kieran-typescript-reviewer

**What would have happened:** `RoutingMetadata` was defined with `tier`, `confidence`, `signals`, `tokens`, `prompt` — but no `model`. When `logDecision()` wrote `routingMetadata.model` to the JSONL, every entry would be `"model": undefined` (or omitted from JSON). The entire feedback loop breaks: corrections compare `correctedModel` against the decision's `model`, but there's no `model` to compare against. Dashboard model badges would be empty. The bug is **silent** — no runtime error, just bad data.

**Fix:** Added `model: string` to `RoutingMetadata`, documented as the "effective model after reply-upgrade logic." Corresponding Zod schema includes `model: z.string()`. Queue-processor construction explicitly includes `model: effectiveModel`.

### Bug 2: `replyToModel` serialization breakage

**Caught by:** kieran-typescript-reviewer (traced full call chain through serialization and Zod validation)

**What would have happened:** The plan changed `lookupMessageModel()` return from `string | undefined` to `{model, threadId} | undefined`. But the existing caller at `telegram-client.ts:243` passes the result directly as `replyToModel` into the queue message. Queue-processor validates with `z.string().optional()`. After the change, `replyToModel` would be `{model: "sonnet", threadId: 5}`, failing Zod string validation. **Every reply-to-bot message would be rejected.** This is a regression that breaks existing functionality.

**Fix:** Extract `.model` at the call site: `const replyToModel = stored?.model;`. Plan explicitly lists all 5 `storeMessageModel` and 2 `lookupMessageModel` call sites.

### Bug 3: Bot self-reaction filter was dead code

**Caught by:** code-simplicity-reviewer, confirmed by Telegram API research

**What would have happened:** The plan included `ctx.from?.id === bot.botInfo.id` at the top of the reaction handler. This would execute on every event but never match — Telegram guarantees bots don't receive `message_reaction` for bot-set reactions. Dead code adds confusion for future readers.

**Fix:** Removed the filter. Added comment: `// Note: bot self-reactions do NOT trigger this handler (Telegram API guarantee)`.

### Bug 4: Growth estimate 30x too pessimistic

**Caught by:** performance-oracle

**What would have happened:** Original estimate: "~120x per entry, rotates every ~8 days." This assumed enriched prompts (24KB each). The brainstorm already decided "raw user message, not enriched prompt," but the growth math was based on enriched sizes. Would have driven unnecessary engineering (increased thresholds, compression, alternate storage).

**Fix:** Corrected: raw messages average ~500B, growth 3-5x, rotation every ~250 days. 10MB threshold kept as-is.

---

## New Requirements Discovered

| Requirement | Discovered By | Impact |
|---|---|---|
| Agent-native MCP tools (`get_routing_decisions`, `log_routing_correction`) | agent-native-reviewer | New Phase 5 added to plan |
| Server-side correction merge (brainstorm said "flat dataset") | architecture-strategist, data-integrity-guardian | API redesign |
| Prompt sanitization (strip control chars, truncate 4096) | security-sentinel, data-integrity-guardian | New `sanitizePrompt()` function |
| `escapeAttr()` for HTML attributes (quotes unescaped) | julik-frontend-races-reviewer | New utility, XSS prevention |
| Correction ordering by timestamp | data-integrity-guardian | Map construction fix |
| Tier summary uses decisions.length not entries.length | data-integrity-guardian | Denominator fix |
| Bot must be admin in group | Telegram API research | Deployment prerequisite |
| `type: "decision"` discriminator on LogEntry | data-integrity-guardian | Union type fix |
| Normalize message-models.json on load (not on read) | data-migration-expert | Migration strategy change |
| CLAUDE.md architecture description update | architecture-strategist | Documentation fix |

---

## API Assumptions Validated

| Assumption | Status | Source |
|---|---|---|
| `MessageReactionUpdated` lacks `message_thread_id` | **Confirmed** | Telegram Bot API spec — 7 fields only |
| `DEFAULT_UPDATE_TYPES` excludes `message_reaction` | **Confirmed** | grammY source (`grammy/out/bot.js`) |
| Bots don't receive own reaction events | **Confirmed** | Telegram Bot API: "Updates are not received for reactions set by bots" |
| ⚡, ✍, 🔥 are valid reaction emoji | **Confirmed** | 79 valid emoji as of Bot API 9.0 |
| Bot must be admin for reaction events | **Confirmed** | Telegram Bot API requirement for group chats |

---

## Related Documentation

| Document | Relationship |
|---|---|
| [borg-v2-first-live-run-fixes.md](../integration-issues/borg-v2-first-live-run-fixes.md) | **Foundational** — Issue 4 established emoji reactions (⚡✍🔥), `reactWithModel()`, REACTION_INVALID gotcha |
| [code-review-cycle-2-systemic-patterns-and-prevention.md](./code-review-cycle-2-systemic-patterns-and-prevention.md) | **Pattern library** — SSE broadcast, mtime cache, Zod validation, code duplication prevention |
| [heartbeat-reliability-code-managed-timing-and-quantitative-decisions.md](./heartbeat-reliability-code-managed-timing-and-quantitative-decisions.md) | **Defensive patterns** — Zod at boundaries, cache reset on validation failure, assumption-dependent simplification tagging |
| [metadata-propagation-and-credential-forwarding-across-layers.md](../integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md) | **Exact precedent** — `topicName` queue propagation pattern identical to `routingMetadata` |
| [multi-agent-review-onboarding-heartbeat-infra.md](./multi-agent-review-onboarding-heartbeat-infra.md) | **Methodology** — Same 12-agent parallel review process |

### Cross-Cutting Patterns Reused

| Pattern | Source | Application |
|---|---|---|
| Emoji reactions (⚡✍🔥) | borg-v2-first-live-run-fixes#4 | Reverse map for detecting corrections |
| SSE broadcast | code-review-cycle-2#039 | Correction updates without full re-render |
| Zod at boundaries | code-review-cycle-2#041 | RoutingMetadataSchema, LogEntrySchema, CorrectionEntrySchema |
| Queue metadata flow | metadata-propagation | `routingMetadata` nested object on OutgoingMessage |
| Type discriminators | code-review-cycle-2#041 | `type: "decision" | "correction"` in JSONL |
| JSONL append safety | borg-v2-evolution | `appendFileSync` safe on ext4 for single-writer <4KB |
| Shared path constants | code-review-cycle-2 | ROUTING_LOG exported from routing-logger.ts |

---

## Prevention Strategies

### 1. Interface Completeness (Missing Fields on Serialization Boundaries)

**Bug:** RoutingMetadata lacked `model`. Every logged entry had `model: undefined`.

**Root cause:** Interface designed without verifying the full serialize → deserialize → consume round-trip.

**Prevention checklist:**
- [ ] Every field in new interface: required or explicitly optional with default?
- [ ] Does consumer use every field? Any unused fields?
- [ ] Add Zod schema at serialization boundary, not just TypeScript interface
- [ ] Round-trip test: write → read → validate all fields present

**CI enforcement:**
```bash
# All JSONL appends use Zod validation
grep -n "appendFileSync.*\.jsonl" src/*.ts | grep -v "Schema.parse\|safeParse" && FAIL
```

### 2. Return Type Changes (Breaking Callers)

**Bug:** `lookupMessageModel()` return change from `string` to `{model, threadId}` broke queue Zod validation.

**Root cause:** Return type changed in isolation without auditing all call sites through serialization boundaries.

**Prevention checklist:**
- [ ] `grep -rn "functionName" src/` — find ALL call sites
- [ ] For each: is result passed to another function? Serialized? Zod-validated?
- [ ] Document call site migration in plan (don't defer to implementation)

### 3. API Assumption Verification

**Bug:** Plan included dead self-reaction filter based on wrong assumption.

**Root cause:** Assumption about Telegram API made without checking existing `.claude/knowledge/api/` docs.

**Prevention checklist:**
- [ ] Is there a `.claude/knowledge/api/` doc for this API?
- [ ] Plan cites exact version/section of external docs
- [ ] Plan states: "Verified in [source]: [quote]"

### 4. Estimation Methodology

**Bug:** Growth estimate 30x too pessimistic (120x vs 3-5x actual).

**Root cause:** Estimate based on theoretical max without grounding in actual message sizes.

**Prevention checklist:**
- [ ] Estimate cites data source or reference class
- [ ] Labeled as conservative/aggressive/realistic
- [ ] Solution still works if estimate is 10x wrong?

### 5. Brainstorm-Plan Alignment

**Bug:** Plan had client-side merge; brainstorm said "flat dataset, no merging."

**Root cause:** Plan added features not in brainstorm without cross-referencing.

**Prevention checklist:**
- [ ] Every plan feature traced to brainstorm requirement
- [ ] Deviations listed explicitly with justification
- [ ] Scope additions require explicit approval

### 6. Context-Aware HTML Escaping

**Bug:** `escapeHtml()` doesn't escape quotes — title attribute XSS.

**Root cause:** Generic `escapeHtml()` used in attribute context where `"` must be escaped.

**Prevention:** Use `escapeAttr()` for HTML attributes: `escapeHtml() + .replace(/"/g, '&quot;').replace(/'/g, '&#39;')`.

### 7. Agent-Native Parity

**Bug:** Dashboard gains data; agents get nothing.

**Root cause:** Dashboard-first design, MCP tools treated as afterthought.

**Prevention:** From MEMORY.md: "Every dashboard endpoint needs MCP tool counterpart at design time."

---

## Key Insight: Deepen Stage Value

This review caught 4 critical bugs that would have been shipped and discovered only through production failures or user reports. The bugs were in the **plan**, not in code — they would have been faithfully implemented as designed.

**What code review cannot catch:**
- Missing fields on interfaces (TypeScript compiles fine with `undefined`)
- External API behavior assumptions (requires documentation research)
- Brainstorm-plan alignment (requires cross-document comparison)
- Growth estimates (requires grounding in real data)

**What the deepen stage uniquely provides:**
- 12 specialized perspectives applied simultaneously
- External API documentation validation
- Cross-reference against institutional knowledge (docs/solutions/)
- Pattern compliance checking against MEMORY.md conventions

**Cost-benefit:** ~5 minutes of agent time caught bugs that would have taken hours to diagnose in production (silent bad data, broken reply routing, dead code confusion).

---

## Files Changed

| File | Change |
|---|---|
| `docs/plans/2026-02-19-feat-routing-feedback-emoji-reactions-plan.md` | Enhanced with 6 critical fixes, 10 new requirements, research insights, Phase 5 (MCP tools) |

## Process Applied

Compound Engineering pipeline: brainstorm → plan → **deepen** → (work pending)

12 agents: security-sentinel, kieran-typescript-reviewer, code-simplicity-reviewer, pattern-recognition-specialist, performance-oracle, agent-native-reviewer, architecture-strategist, julik-frontend-races-reviewer, data-integrity-guardian, data-migration-expert, best-practices-researcher (Telegram API), best-practices-researcher (grammY)
