---
status: pending
priority: p3
issue_id: "093"
tags: [code-review, performance, caching]
dependencies: []
---

# saveZoneConfig() needlessly invalidates cache after save

## Problem Statement

`saveZoneConfig()` in zone-config.ts:135-142 sets `cachedConfig = null; cachedMtime = 0` to invalidate the cache after saving. This means the next read will always re-read from disk even though the just-saved data is already in memory. The saved config and its mtime are both known at save time and could be used to populate the cache, avoiding an unnecessary disk read.

## Findings

- After `renameSync` (atomic write), the saved config is known: it's the value passed to `saveZoneConfig()`
- The file's new mtime is immediately available via `fs.statSync(configPath).mtimeMs`
- Nulling the cache forces a redundant disk read on the very next `loadZoneConfig()` call
- In hot paths (e.g., MCP tool that saves then reads config), this adds a gratuitous stat + read

## Proposed Solutions

After the `renameSync`, warm the cache instead of invalidating it:

```typescript
const newMtime = fs.statSync(configPath).mtimeMs;
cachedConfig = config;
cachedMtime = newMtime;
```

This ensures the cache is always consistent with what was written, and avoids the next read hitting disk.

## Acceptance Criteria

- [ ] `saveZoneConfig()` warms the cache with the saved config and new mtime instead of nulling both
- [ ] The next call to `loadZoneConfig()` after a save returns without a disk read (cache hit)
- [ ] Cache still invalidates correctly when an external process writes the file (mtime changes)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Write-through cache is better than write-invalidate when the written value is already in hand |
