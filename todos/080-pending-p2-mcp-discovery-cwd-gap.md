---
status: complete
priority: p2
issue_id: "080"
tags: [code-review, architecture, agent-native, sidecar-services]
dependencies: []
---

# .mcp.json only discovered by agents whose cwd is the Borg repo

## Problem Statement

The `.mcp.json` at the Borg repo root registers Clairvoyant at `http://clairvoyant:3000/mcp`. However, Claude Code discovers project-level `.mcp.json` by walking up from `cwd`. Agent threads whose `cwd` is a different repo will never find this file. Additionally, `queue-processor.ts` explicitly declares `mcpServers` with only the `borg` server at all four `query()` call sites — it's unclear whether the SDK merges `.mcp.json` entries with programmatically provided `mcpServers`.

## Findings

- **Location:** `.mcp.json`, `src/queue-processor.ts` (lines ~708, ~1815, ~1884, ~1949)
- **Source:** Architecture strategist (Critical), Agent-native reviewer (Critical)
- **Impact:** Agents in other repos cannot discover Clairvoyant; even Borg-repo agents may not get it if SDK doesn't merge

## Proposed Solutions

### Option A: Register in queue-processor.ts alongside borg MCP server (Recommended)
Add clairvoyant to the `mcpServers` object at all four `query()` call sites:
```typescript
mcpServers: {
    borg: createBorgMcpServer(threadId),
    clairvoyant: { url: "http://clairvoyant:3000/mcp" },
},
```
- **Pros:** Works for all agents regardless of cwd; follows existing pattern
- **Cons:** Requires code change; fails if clairvoyant container isn't running
- **Effort:** Small
- **Risk:** Low (needs conditional registration when sidecar not enabled)

### Option B: Keep .mcp.json, verify SDK merge behavior
Test whether `settingSources: ["project"]` causes the SDK to merge `.mcp.json` with explicit `mcpServers`. If it does, document the cwd limitation.
- **Pros:** No code change
- **Cons:** Only works for Borg-repo agents; may not work at all
- **Effort:** Small (investigation)
- **Risk:** Medium

### Option C: Environment-gated registration in queue-processor
Only register clairvoyant when a `CLAIRVOYANT_URL` env var is set:
```typescript
const mcpServers: Record<string, any> = { borg: createBorgMcpServer(threadId) };
if (process.env.CLAIRVOYANT_URL) {
    mcpServers.clairvoyant = { url: process.env.CLAIRVOYANT_URL };
}
```
- **Pros:** Graceful when sidecar not running; configurable URL
- **Cons:** Another env var to manage
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Agents in any repo can discover and use Clairvoyant MCP tools
- [ ] No errors when sidecar services are not running
- [ ] Heartbeat and scheduled task sessions also have access

## Work Log

| Date | Action |
|------|--------|
| 2026-03-30 | Created from code review of sidecar services commit |
