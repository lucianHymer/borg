---
status: wontfix
priority: p2
issue_id: "084"
tags: [code-review, architecture, docker]
dependencies: []
---

# Zone config atomic writes may fail with EXDEV in zone containers

## Problem Statement

`create_thread` and `delete_thread` in mcp-tools.ts call `saveZoneConfig()` which writes to zone-config.json inside zone containers. However, zone containers mount only the single file `./zone-config.json:/app/zone-config.json` (docker-compose.yml:68, 107). The atomic `write tmp + rename` pattern may fail with EXDEV (cross-device rename) because the .tmp file goes into the container overlayfs layer while zone-config.json is a bind-mounted file. The design doc states infra should own zone-config.json writes.

## Findings

- docker-compose.yml:66-68 mounts `./zone-config.json:/app/zone-config.json` as a single-file bind mount for the core container
- docker-compose.yml:105-107 does the same for the perimeter container
- mcp-tools.ts:711-720 calls `saveZoneConfig()` which performs an atomic write (tmp file + rename)
- When the .tmp file is written to `/app/zone-config.json.tmp`, it lands in the overlayfs layer
- Renaming from overlayfs to bind-mount crosses a device boundary, causing EXDEV on Linux
- The design intent is that infra (not zone containers) should own zone-config.json writes

## Proposed Solutions

- (a) Make zone-config.json read-only in core/perimeter containers and route zone assignment changes through the infra container which owns the file
- (b) Mount the entire parent directory rather than a single file to enable atomic renames within the same filesystem
- (c) Verify atomicity works on the target Linux/Docker version and document it explicitly; fall back to a non-atomic write if EXDEV is caught

## Acceptance Criteria

- [ ] Zone config writes from zone containers either succeed atomically or are prevented with a clear error
- [ ] No silent data corruption from failed atomic renames
- [ ] Ownership of zone-config.json writes is clearly documented and enforced

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Single-file bind mounts are a common Docker footgun for atomic write patterns; the EXDEV error only manifests at runtime |
