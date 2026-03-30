---
status: pending
priority: p2
issue_id: "082"
tags: [code-review, security, sidecar-services]
dependencies: []
---

# MCP endpoint registered without authentication

## Problem Statement

`.mcp.json` registers Clairvoyant with no auth headers. Any container on the `internal` network can call `http://clairvoyant:3000/mcp`. This means a compromised perimeter-zone agent (untrusted by design) could invoke Clairvoyant MCP tools, bypassing zone-based access control. The Clairvoyant server has JWT auth support but the `.mcp.json` doesn't configure it.

## Findings

- **Location:** `.mcp.json`
- **Source:** Security sentinel (Medium), Agent-native reviewer (Warning)
- **Note:** Clairvoyant is building JWT auth — this is a placeholder until that's ready

## Proposed Solutions

### Option A: Add auth header once JWT mechanism is ready (Recommended)
```json
{
  "mcpServers": {
    "clairvoyant": {
      "url": "http://clairvoyant:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${CLAIRVOYANT_TOKEN}"
      }
    }
  }
}
```
- **Pros:** Follows Clairvoyant's own auth design
- **Cons:** Blocked on Clairvoyant implementing JWT issuance
- **Effort:** Small (once JWT is ready)
- **Risk:** Low

### Option B: Restrict MCP registration to core-zone only
Only mount `.mcp.json` or register the MCP server in core-zone containers.
- **Pros:** Zone-based access control
- **Cons:** Perimeter agents can't use task management
- **Effort:** Medium
- **Risk:** Low

## Acceptance Criteria

- [ ] MCP endpoint requires authentication
- [ ] Perimeter-zone access is intentionally granted or denied

## Work Log

| Date | Action |
|------|--------|
| 2026-03-30 | Created from code review — blocked on Clairvoyant JWT implementation |
