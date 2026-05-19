---
title: "feat: Generic user-defined security zones"
type: feat
status: proposed
date: 2026-05-19
---

# Generic User-Defined Security Zones

## Overview

Today Borg has two hardcoded agent security zones (`core`, `perimeter`) plus the `infra` routing layer. The zone *schema* already supports arbitrary names — `zone-config.ts` validates zones as `z.record(z.string(), ...)`. The hardcoding lives in the *plumbing*: docker-compose service definitions, individual `.borg-{name}` bind mounts on the agentless containers, `scripts/init-zones.sh`, hardcoded `zoneDirs` arrays in the dashboard, and hardcoded badge colors in the UI.

This plan makes zones first-class objects that can be created, deleted, and managed entirely from the dashboard — no compose edits, no shell access required. Containers for new zones are launched on demand via the Docker API.

## Goals

- A logged-in dashboard user can create a new zone, pick a template (trusted/untrusted), and have a running container within seconds
- Threads can be assigned to any zone via the existing badge dropdown
- Deleting a zone is safe (refuses if threads present, archives data instead of deleting)
- Existing `core` / `perimeter` deployments migrate cleanly without manual intervention
- Borg deployment remains portable across machines (rsync + `docker compose up`)
- Agents have **no** ability to create/delete/rename zones — dashboard-only operation
- Zone reviewer skill (`.claude/agents/zone-reviewer.md`) and knowledge entries reflect the new structure

## Non-Goals (Phase 2)

These are intentionally **out of scope** for this plan; they ship later:

- Zone container restart/stop/logs from the dashboard
- Renaming a zone after creation (delete + recreate is the workaround)
- Custom resource limits per zone (defaults to 1G memory; edit `zone-config.json` manually for now)
- More than two templates (`trusted` / `untrusted`)
- A "compose import" command that brings dynamically-created zones back under compose management

---

## Background: Current State

### What's already generic

- `zone-config.ts` — zone names are arbitrary strings (`z.record(z.string(), ...)`). All helper functions (`getThreadZone`, `addThreadToZone`, etc.) operate on zone names without hardcoding values.
- `/api/zones` and `/api/zones/move` dashboard endpoints — already work with any zone name in `zone-config.json`.
- Dashboard's `_availableZones` array is fetched dynamically from `/api/zones` — new zones already appear in the badge dropdown.

### What's hardcoded

| Location | What's hardcoded | How it blocks generic zones |
|---|---|---|
| `docker-compose.yml` | `core` and `perimeter` services declared statically | New zones can't be added without editing compose |
| `docker-compose.yml` (infra service) | Individual bind mounts: `./.borg-core`, `./.borg-perimeter` | Infra can't see new zones without restart |
| `docker-compose.yml` (dashboard service) | Same — individual ro mounts per zone | Dashboard can't see new zones without restart |
| `scripts/init-zones.sh` | `for zone in core perimeter` loop | Bootstrap misses any new zones |
| `src/dashboard.ts` | Multiple hardcoded `zoneDirs` arrays (lines ~861, 1041, 1147, 1213, 1305, 1344, 1418, 1480) for cross-zone scanning | Dashboard ignores data in new zones |
| `static/dashboard.html:1407` | `colors = { core: ..., perimeter: ... }` for badge tint | New zones render as gray (acceptable) |
| `zone-config.example.json` | Default zone list | Used by init script as seed |

### The "infra is a zone" confusion

Today the `infra` container has:
- `BORG_ZONE=infra` env var
- A `.borg-infra/` directory (its scratch state — pending-approval queue, its own message log)
- Read-only mounts of `.borg-core/` and `.borg-perimeter/` so it can route messages

But `zone-config.json` does **not** list `infra` in its `zones` block — only `core` and `perimeter`. Threads can never be assigned to infra. **Infra is the routing layer, not a routable zone.** It has its own storage because the container needs scratch space; it isn't a participant in zone semantics.

This plan makes that distinction explicit by moving `.borg-infra/` outside of `.borg-zones/` (see Directory Restructure below).

---

## Architectural Decisions

### AD1: Directory restructure

**Before:** Each zone dir is a sibling at repo root:
```
borg/
  .borg-core/
  .borg-perimeter/
  .borg-infra/
```

**After:** User zones nest under a single parent; infra stays a separate sibling:
```
borg/
  .borg-zones/
    core/
    perimeter/
    {any-user-zone}/
  .borg-infra/                       # routing layer's own state — not a zone
  .borg-zones/.archived/             # deleted zones go here (not deleted)
    {name}-{timestamp}/
```

**Why this shape:**
- Agentless containers (infra, dashboard) mount `.borg-zones/` once. Docker can't glob individual bind mounts, but a single parent mount picks up new subdirs automatically — no compose edits, no container restarts.
- Agent containers mount only their own zone: `./.borg-zones/{name}` → `/app/.borg`. Single-zone visibility preserved.
- `.borg-infra/` stays outside `.borg-zones/` because it isn't a zone. Naming honesty.
- `.archived/` lives under `.borg-zones/` with a leading dot so the listing iterator skips it.

### AD2: Compose vs. Docker API

Static services (`infra`, `dashboard`, `core`, `perimeter`, `broker`, `docker-proxy`, `speaches`, `cloudflared`, `init`) stay declared in `docker-compose.yml`. Dynamically-created zones use the Docker API directly via the existing `docker-proxy` (regex already permits `containers/create.*`, `start`, `stop`, `update`, and `DELETE`).

**Why:**
- Compose has no first-class way to add services at runtime
- The Docker API path keeps the dashboard the single source of truth for dynamic zones
- "Dynamic" containers are not orphans — the supervisor (AD3) ensures they exist on every boot

### AD3: Zone supervisor for restart persistence

A new step in the `init` container reads `zone-config.json` and, for each zone that isn't `core`, `perimeter`, or `infra`, calls the Docker API to create+start the container if it doesn't already exist. This guarantees host reboots restore the full set of zone containers.

**Why an init-container step (not a separate service):**
- The existing `init` service already runs once at compose-up and exits, and other services `depends_on: { init: { condition: service_completed_successfully } }`. Adding zone supervision there keeps lifecycle aligned.
- A long-running supervisor would conflict with future "zone restart/stop" features (Phase 2) by fighting state.
- The dashboard already handles the runtime create/delete; init only needs the cold-boot case.

### AD4: Templates

Two templates baked into `zone-config.json`:

- **trusted** — clone of current `core`:
  - Mounts: workspace, github-installations, claude credentials, claude skills, claude settings, claude plugins (named volume per zone), `${WORKSPACE_ROOT}`
  - Networks: `internal`, `dev`
  - Env: `CREDENTIAL_BROKER_URL`, `BROKER_SECRET`, `PUBLIC_HOST`, `DEV_NETWORK`, `DOCKER_PROXY_URL`
  - Resource limit: 4G memory
- **untrusted** — clone of current `perimeter`:
  - Mounts: workspace, github-installations, claude credentials, claude skills, claude settings, claude plugins (named volume per zone), `${WORKSPACE_ROOT}` (sandboxed by Claude Code itself)
  - Networks: `internal` only
  - Env: `CREDENTIAL_BROKER_URL`, `BROKER_SECRET`
  - Resource limit: 1G memory
  - Explicitly: no SSH keys, no docker-proxy

Templates live in a new `zone-templates.json` file. The Docker API container spec is built by combining: shared base (image, restart policy, init=true, BORG_ZONE env, the zone's `.borg-zones/{name}/` mount as `/app/.borg`) + template-specific fields.

`core` and `perimeter` are reclassified as `trusted` and `untrusted` respectively in `zone-config.json`; the compose-declared `core` / `perimeter` services keep matching configs for backwards compat during this transition.

### AD5: Reserved names + validation

Zone name must match `^[a-z0-9][a-z0-9-]{1,30}$` (lowercase, alphanumeric + dash, 2–31 chars, starts non-dash). Disallowed names:
- `infra`, `dashboard`, `broker`, `init`, `cloudflared`, `speaches`, `docker-proxy` (compose service names — would clash)
- `archived` (used by `.archived/` archive folder)
- Anything starting with `.` (filesystem hidden convention)

Validation runs in the API endpoint AND in the create UI (defense in depth).

### AD6: Zone deletion is reversible

`DELETE /api/zones/:name`:
- Refuses if `zone-config.json` shows any threads assigned to this zone
- Refuses for `core`, `perimeter`, or `infra` (system zones — never deletable)
- Stops + removes the container via Docker API
- Moves `.borg-zones/{name}/` to `.borg-zones/.archived/{name}-{ISO-timestamp}/`
- Removes the zone block from `zone-config.json`

No data is permanently destroyed. A future "purge" command could clear old archives.

### AD7: Per-zone workspace via `${WORKSPACE_HOST_BASE}/workspace-${ZONE}`

Today both `core` and `perimeter` mount `${WORKSPACE_ROOT}:${WORKSPACE_ROOT}` pass-through. Filesystem "isolation" is only Claude Code's in-process permission system — a harness-escaped agent in perimeter could read the entire workspace. AD7 makes isolation real at the Docker mount layer.

**The shape:**
- Each zone container mounts `${WORKSPACE_HOST_BASE}/workspace-${ZONE}` (host) → `${WORKSPACE_ROOT}` (container)
- Inside any container, the path is always `${WORKSPACE_ROOT}` (= `/home/lucian/workspace`) — agents never see or need their zone name in cwd
- Per-zone subdirs are bind-mount siblings on the host: `~/workspace-core/`, `~/workspace-perimeter/`, `~/workspace-foo/`
- No `workspaces` schema field — path is deterministic from zone name. Simpler.

**Env vars:**
- New: `WORKSPACE_HOST_BASE` (default `/home/lucian`) — parent dir on the host where `workspace-{zone}/` subdirs live
- Unchanged: `WORKSPACE_ROOT=/home/lucian/workspace` — canonical *inside-container* path, kept identical to current value so agents' muscle memory stays intact

**Compose changes (static zones):**
```yaml
core:
  - ${WORKSPACE_HOST_BASE}/workspace-core:${WORKSPACE_ROOT}      # CHANGED
perimeter:
  - ${WORKSPACE_HOST_BASE}/workspace-perimeter:${WORKSPACE_ROOT} # CHANGED
```

**Base spec (dynamic zones):**
```json
{ "type": "bind", "source": "${WORKSPACE_HOST_BASE}/workspace-{ZONE}", "target": "${WORKSPACE_ROOT}" }
```
Workspace mount is part of the **base** spec (every dynamic zone gets it), not per-template — there's no useful zone without a workspace, and templates are about credentials/network, not storage.

**Who can write to `${WORKSPACE_HOST_BASE}`:**
- **`init`** — rw mount, mkdirs `workspace-${zone}` + chowns 1000:1000 for each zone in zone-config, then exits
- **`dashboard`** — rw mount, mkdirs + chowns when creating a new dynamic zone (must happen *before* Docker mounts it into the zone container, otherwise Docker auto-creates as root-owned and the agent can't write)
- **Agent zone containers** — mount only their own subdir at `${WORKSPACE_ROOT}`; cannot see parent or sibling zones
- **`infra`** — no workspace mount (unchanged)

**Dashboard file viewer:**
- Today mounts `${WORKSPACE_ROOT}:/home/lucian/workspace:ro`
- Switches to `${WORKSPACE_HOST_BASE}:/host-workspaces:ro` (dual-purpose with the rw mount above — Docker honors the most permissive when paths overlap; we use the rw path for mkdirs and the ro symlink for serving)
- Frontend file viewer gets a zone selector; defaults to the zone of the currently-viewed thread

**Borg repo location:** Moves from `~/workspace/borg` → `~/workspace-core/borg`. Borg is just another repo core works on; "perimeter cannot edit borg's source" is correct posture. The compose project root moves with it; users `cd ~/workspace-core/borg && docker compose up -d`.

**Migration (host-side, manual — one-time, BEFORE `docker compose up`):**
```bash
mv ~/workspace ~/workspace-core
mkdir ~/workspace-perimeter
sudo chown -R 1000:1000 ~/workspace-core ~/workspace-perimeter
# borg repo is now at ~/workspace-core/borg
cd ~/workspace-core/borg
docker compose up -d
```

**Loud failure mode if skipped:** Docker auto-creates empty `~/workspace-core` (root-owned), agents see an empty workspace, repo edits fail with permission errors. Noisy and immediate. Document prominently at the top of the migration section.

**Dynamic zone create flow extension:** Between zone-config write and container create, the dashboard:
1. mkdir `${WORKSPACE_HOST_BASE}/workspace-${name}` via its rw mount
2. chown 1000:1000 (the dashboard runs as a uid that can chown — verify; if not, use Node's `fs.chownSync` which requires CAP_CHOWN)
3. Build container spec with workspace mount
4. POST containers/create

If the chown can't be done from the dashboard (uid restriction), fall back to spawning a one-shot helper container that does the chown — adds a Docker API call but keeps the dashboard's caps narrow. Decided at implementation time after probing the dashboard container's effective uid.

**Trade-off accepted:** dashboard has rw on `${WORKSPACE_HOST_BASE}` (could in theory create `workspace-anything` or delete subdirs). This is bounded ambient authority on a directory the dashboard already needs to see read-only, and the dashboard is explicitly the "agentless human interface." Consistent with the broader sole-writer model. Per-zone workspace deletion is gated through the same delete flow that archives the zone directory.

---

## Detailed Design

### Directory Restructure

#### New structure

```
.borg-zones/
  core/
    queue/
      incoming/
      outgoing/
      processing/
      task-stop/
      task-state/
      cancel/
    sessions/
    images/
      incoming/
    audio/
      incoming/
    persistent/
      ssh/
    claude-skills/
    claude-settings.json
    message-history.jsonl
    message-models.json
    routing.jsonl
    scheduled-tasks.json
    markdown-parse-failures.jsonl
    settings.json                    # zone-local copy of bot settings
  perimeter/
    (same shape)
  .archived/
    foo-2026-05-19T20-15-00Z/
      ...
.borg-infra/                         # outside .borg-zones/
  queue/
    pending/                         # cross-zone approval queue
    outgoing/                        # this container's own outbound
  message-history.jsonl
  settings.json
zone-config.json                     # bind-mounted into all containers
zone-templates.json                  # NEW — template definitions, bind-mounted ro into infra
threads.json                         # shared
settings.json                        # shared
```

#### Migration script

`scripts/init-zones.sh` is rewritten to:

1. Detect old structure: if `.borg-core/` or `.borg-perimeter/` exists at repo root AND `.borg-zones/` does not exist:
   ```bash
   mkdir -p .borg-zones
   [ -d .borg-core ] && mv .borg-core .borg-zones/core
   [ -d .borg-perimeter ] && mv .borg-perimeter .borg-zones/perimeter
   ```
2. Ensure each zone listed in `zone-config.json` has the expected subdirectory layout (create any missing subdirs)
3. Ensure `.borg-infra/` exists with its expected subdirs
4. Sync skills from `skills/global/` into each zone's `claude-skills/` directory (existing behavior, just iterates over all zones in config)
5. `chown -R 1000:1000` all `.borg-zones/*` and `.borg-infra/`

**Idempotent.** Safe to re-run. The old-→-new rename block only fires if the new structure is absent.

### Compose Changes

`docker-compose.yml` diff (conceptually):

```yaml
infra:
  volumes:
    - ./.borg-infra:/app/.borg-infra
    - ./.borg-infra:/app/.borg                  # unchanged
    # - ./.borg-core:/app/.borg-core           # REMOVED
    # - ./.borg-perimeter:/app/.borg-perimeter # REMOVED
    - ./.borg-zones:/app/.borg-zones            # NEW — parent mount
    - ./threads.json:/app/threads.json
    - ./zone-config.json:/app/zone-config.json
    - ./zone-templates.json:/app/zone-templates.json:ro   # NEW
    - ./settings.json:/app/settings.json
    - ${CLAUDE_CREDENTIALS}:/home/node/.claude/.credentials.json:ro

core:
  volumes:
    - ./.borg-zones/core:/app/.borg            # CHANGED PATH
    - ./threads.json:/app/threads.json
    - ./zone-config.json:/app/zone-config.json
    - ./settings.json:/app/settings.json
    ... (rest unchanged)

perimeter:
  volumes:
    - ./.borg-zones/perimeter:/app/.borg       # CHANGED PATH
    ... (rest unchanged)

dashboard:
  volumes:
    - ./.borg-zones/core:/app/.borg:ro                   # CHANGED PATH (primary)
    # - ./.borg-core:/app/.borg-core:ro                 # REMOVED
    # - ./.borg-perimeter:/app/.borg-perimeter:ro       # REMOVED
    - ./.borg-zones:/app/.borg-zones:ro                  # NEW — parent ro mount
    - ./.borg-infra:/app/.borg-infra:ro
    # rw mounts for background task stop signals
    - ./.borg-zones/core/queue/task-stop:/app/.borg-zones/core/queue/task-stop
    - ./.borg-zones/perimeter/queue/task-stop:/app/.borg-zones/perimeter/queue/task-stop
    # NB: dynamic zones get rw task-stop mounts via the dashboard's container spec when zone is created
    ... (rest unchanged)
```

**Note on dashboard task-stop mounts:** The dashboard's `/api/background-tasks/:messageId/stop` endpoint currently has rw mounts for hardcoded zones' `task-stop/` dirs. Two options for handling dynamic zones:

- **Option A (chosen):** Mount `.borg-zones/` rw into the dashboard for the task-stop path only (the rest stays ro). This means the dashboard has full rw on `.borg-zones/.../queue/task-stop/` for *all* zones — but read-only everywhere else under `.borg-zones/`. Docker doesn't support per-subpath permissions on a single mount, so we'd need two mounts: `./.borg-zones:/app/.borg-zones:ro` plus a write-through via a sibling mount. Cleanest: drop the rw split and let the dashboard write directly to task-stop via its ro view — *not possible*.
- **Option B (chosen):** Add `./.borg-zones:/app/.borg-zones-rw` as a separate rw mount used only for task-stop writes; the rest of the dashboard uses the ro mount. Adds a small abstraction in `dashboard.ts` (`TASK_STOP_BASE` env var) but keeps everything else principled.

**Implementation note:** Use Option B. The dashboard's stop-task code path writes to `${TASK_STOP_BASE}/${zoneName}/queue/task-stop/{messageId}.json`. `TASK_STOP_BASE` defaults to `/app/.borg-zones-rw`.

### Zone Templates

New file `zone-templates.json` at repo root:

```json
{
  "trusted": {
    "image": "borg-agent:latest",
    "memory": "4G",
    "networks": ["internal", "dev"],
    "mounts": [
      { "type": "bind", "source": "./secrets/github-installations.json", "target": "/secrets/github-installations.json", "readonly": true },
      { "type": "bind", "source": "${CLAUDE_CREDENTIALS}", "target": "/home/node/.claude/.credentials.json" },
      { "type": "bind", "source": "./.borg-zones/{ZONE}/claude-skills", "target": "/home/node/.claude/skills" },
      { "type": "bind", "source": "./.borg-zones/{ZONE}/claude-settings.json", "target": "/home/node/.claude/settings.json" },
      { "type": "volume", "name": "claude-plugins-{ZONE}", "target": "/home/node/.claude/plugins" }
    ],
    "env": {
      "CREDENTIAL_BROKER_URL": "http://broker:3000",
      "BROKER_SECRET": "${BROKER_SECRET}",
      "PUBLIC_HOST": "${PUBLIC_HOST}",
      "DEV_NETWORK": "borg_dev",
      "DOCKER_PROXY_URL": "http://docker-proxy:2375/v1.47"
    }
  },
  "untrusted": {
    "image": "borg-agent:latest",
    "memory": "1G",
    "networks": ["internal"],
    "mounts": [
      { "type": "bind", "source": "./secrets/github-installations.json", "target": "/secrets/github-installations.json", "readonly": true },
      { "type": "bind", "source": "${CLAUDE_CREDENTIALS}", "target": "/home/node/.claude/.credentials.json" },
      { "type": "bind", "source": "./.borg-zones/{ZONE}/claude-skills", "target": "/home/node/.claude/skills" },
      { "type": "bind", "source": "./.borg-zones/{ZONE}/claude-settings.json", "target": "/home/node/.claude/settings.json" },
      { "type": "volume", "name": "claude-plugins-{ZONE}", "target": "/home/node/.claude/plugins" }
    ],
    "env": {
      "CREDENTIAL_BROKER_URL": "http://broker:3000",
      "BROKER_SECRET": "${BROKER_SECRET}"
    }
  }
}
```

**Placeholders:**
- `${WORKSPACE_ROOT}`, `${BROKER_SECRET}`, `${PUBLIC_HOST}`, `${CLAUDE_CREDENTIALS}` — resolved from the dashboard's process env at container-create time
- `{ZONE}` — replaced with the zone name being created

**Base spec (applied to every dynamically-created zone, regardless of template):**

```json
{
  "image": "borg-agent:latest",
  "init": true,
  "restart": "on-failure",
  "stop_grace_period": "30s",
  "mounts": [
    { "type": "bind", "source": "./.borg-zones/{ZONE}", "target": "/app/.borg" },
    { "type": "bind", "source": "${WORKSPACE_HOST_BASE}/workspace-{ZONE}", "target": "${WORKSPACE_ROOT}" },
    { "type": "bind", "source": "./threads.json", "target": "/app/threads.json" },
    { "type": "bind", "source": "./zone-config.json", "target": "/app/zone-config.json" },
    { "type": "bind", "source": "./settings.json", "target": "/app/settings.json" }
  ],
  "env": {
    "NODE_ENV": "production",
    "BORG_ZONE": "{ZONE}",
    "ZONE_CONFIG_PATH": "/app/zone-config.json",
    "DEFAULT_CWD": "${WORKSPACE_ROOT}"
  }
}
```

The Docker API call merges base + template, substitutes placeholders, then POSTs to `/v1.47/containers/create?name=borg-zone-{ZONE}`.

**Container naming:** `borg-zone-{ZONE}` (e.g. `borg-zone-foo`). This avoids clashing with compose-managed `borg-core-1` / `borg-perimeter-1` names, and makes them easy to identify in `docker ps`.

**Image build:** Add a `borg-agent:latest` image build step. Currently `core` and `perimeter` both use `build: .` — they share Dockerfile content. We tag the build explicitly:

```yaml
core:
  image: borg-agent:latest
  build: .
perimeter:
  image: borg-agent:latest
  build: .
```

`docker compose build` (or first `up`) populates the tag; dynamic zone creations reuse it.

### Zone Lifecycle Management

#### Init-time supervisor (in `scripts/init-zones.sh`)

After directory setup and before exit:

```bash
# Read zone-config.json
# For each zone NOT in [core, perimeter]:
#   If container borg-zone-{zone} doesn't exist:
#     POST to docker-proxy /containers/create + /start
#   (curl through docker-proxy at http://docker-proxy:2375/v1.47/...)
```

Implementation: a small Node.js helper `scripts/ensure-zone-containers.ts` that imports `loadZoneConfig`, reads templates, and uses the same Docker API client the dashboard will use. Invoked at end of `init-zones.sh`.

**Why Node:** the dashboard's container spec builder will live in TypeScript anyway; sharing it avoids duplication. The `init` container runs `node:22-slim` so TS via `tsx` is fine — or we compile the helper to JS as part of build.

#### Dashboard create flow

`POST /api/zones`:

```typescript
// Body: { name: string, template: "trusted" | "untrusted" }
// Validate: name regex, reserved names, name not already in zone-config.json
// 1. Acquire zone-config.json lock (open with O_EXCL on a sidecar .lock file)
// 2. Re-read zone-config.json
// 3. Add the new zone: { [name]: { threads: [], template: <chosen> } }
// 4. saveZoneConfig() (atomic tmp+rename)
// 5. Create the directory structure under .borg-zones/{name}/ (mirror init-zones.sh's per-zone seeding)
// 6. Build container spec from base + template
// 7. POST docker-proxy /containers/create?name=borg-zone-{name}
// 8. POST docker-proxy /containers/{id}/start
// 9. Connect the container to required networks (POST /networks/{net}/connect for each)
//    NB: containers/create only supports ONE primary network; additional networks need separate connect calls
// 10. Release lock
// 11. Return { success: true, name, containerId }
```

**Error handling:** Each step has a rollback. If container create fails, remove the zone block from `zone-config.json` and the directory. If `start` fails, remove the container too. Errors return 500 with the failing step in the body.

#### Dashboard delete flow

`DELETE /api/zones/:name`:

```typescript
// 1. Validate name is not in [core, perimeter, infra]
// 2. Acquire lock
// 3. Re-read zone-config.json
// 4. Check zone has no assigned threads (zone.threads.length === 0). Refuse with 409 if not.
// 5. POST docker-proxy /containers/borg-zone-{name}/stop
// 6. DELETE docker-proxy /containers/borg-zone-{name}
// 7. Move directory: .borg-zones/{name} → .borg-zones/.archived/{name}-{ISO8601}
// 8. Remove zone block from zone-config.json
// 9. saveZoneConfig()
// 10. Release lock
```

Steps 5–6 are best-effort — if the container is already gone, log and continue. Step 7 must succeed (a partial deletion would leave a broken state).

**Schema change:** `ZoneConfigSchema` now includes an optional `template` field on each zone entry:

```typescript
zones: z.record(
    z.string(),
    z.object({
        threads: z.array(z.number().int().positive()),
        template: z.enum(["trusted", "untrusted"]).optional(),  // NEW; system zones omit it
    }),
)
```

`core` is treated as `trusted`; `perimeter` is treated as `untrusted` (hardcoded fallback in code, since their containers are compose-managed not API-created).

### Dashboard Backend

All new code goes in `src/dashboard.ts` (or extracted helpers).

#### Existing endpoint changes

- **`GET /api/zones`** — already returns `{ configured, config, threadZones }`. Now also returns each zone's `template` field (if set), and adds `containerStatus: "running" | "stopped" | "missing" | "managed-by-compose"` per zone (computed by querying `docker-proxy /containers/json?filters={"name":["borg-zone-..."]}`). `managed-by-compose` is set for `core`, `perimeter`, `infra`.
- **`POST /api/zones/move`** — no signature change; works as today.
- **`POST /api/zones/remove`** — no signature change.

#### New endpoints

- **`POST /api/zones`** — create. Body: `{ name: string, template: "trusted" | "untrusted" }`. Returns 201 with `{ name, containerId, status }`, or 4xx/5xx with `{ error, step? }`.
- **`DELETE /api/zones/:name`** — delete. Returns 200 with `{ name, archivedPath }`, 409 if threads still assigned, 400 for reserved names, 5xx for Docker API failures.
- **`GET /api/zone-templates`** — list available templates. Returns `{ trusted: { ...description }, untrusted: { ...description } }`. Used by the create modal to populate the template picker. Description text comes from `zone-templates.json` (add an `_description` field per template).

#### Shared helpers

- `src/zone-templates.ts` — load and validate `zone-templates.json` (Zod schema, mtime cache like `zone-config.ts`).
- `src/zone-supervisor.ts` — build container specs and call Docker API. Used by both `scripts/ensure-zone-containers.ts` and `src/dashboard.ts`.
- `src/zone-lock.ts` — file-based lock for zone-config.json mutations (open `zone-config.json.lock` with `O_EXCL`, retry with backoff on EEXIST). Prevents two concurrent create/delete races.

#### Dynamic `zoneDirs` resolution

Replace every hardcoded `zoneDirs` array (currently 6+ locations in `dashboard.ts`) with a single helper:

```typescript
function listZoneDirs(opts: { includeInfra?: boolean } = {}): string[] {
    const zonesParent = "/app/.borg-zones";
    const dirs = fs.readdirSync(zonesParent, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith("."))
        .map(d => path.join(zonesParent, d.name));
    if (opts.includeInfra) dirs.push("/app/.borg-infra");
    return dirs;
}
```

Cache the result for ~5 seconds to avoid syscalls in hot paths (the cache is invalidated on zone create/delete by clearing a module-level Map). Use this helper for: `/api/usage`, `/api/messages`, `/api/scheduled-tasks`, `/api/background-tasks`, history scans (`findMessageHistoryByMessageId`, etc.), status file lookups.

#### Mounts (re-stated)

Dashboard `volumes:`:
- `./.borg-zones:/app/.borg-zones:ro` (read all zones)
- `./.borg-zones:/app/.borg-zones-rw` (write task-stop signals only — code restricts itself to `*/queue/task-stop/`)
- `./.borg-infra:/app/.borg-infra:ro`
- `./.borg-zones/core:/app/.borg:ro` (the dashboard's "home" zone — keeps `/app/.borg` legacy references working; could be removed if no code still reads from `/app/.borg`)
- Drop the per-zone `core/perimeter` rw task-stop mounts.

### Dashboard Frontend

#### Dropdown styling bug fix

`static/dashboard.html` references CSS variables `--bg-card` and `--bg-alt` that **do not exist** in `:root`:

```css
:root {
  --bg-primary: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  /* No --bg-card or --bg-alt */
}
```

This makes the zone dropdown render with transparent background (badges underneath bleed through). Two grep hits affected (lines 1425, 1433, 1458 in `showZoneDropdown` and the existing zone-filter `<select>` on line 863).

**Fix:** Replace `var(--bg-card)` → `var(--bg-secondary)` and `var(--bg-alt)` → `var(--bg-tertiary)` everywhere they appear. Do a full-file grep for both `--bg-card` and `--bg-alt`; replace all (likely <10 occurrences total). Same fix in any of the file's siblings if the dashboard is split (currently single-file).

#### New: "Create Zone" UI

Add a "+ Zone" button next to the existing zone-filter dropdown in the threads-tab header. Clicking it opens a modal:

```
+---------------------------------------------+
| Create New Zone                       [X]   |
|---------------------------------------------|
|                                             |
|  Zone name: [____________]                  |
|             (lowercase, a-z 0-9 -, 2-31)    |
|                                             |
|  Template:  ( ) trusted                     |
|             ( ) untrusted                   |
|             trusted: full credentials       |
|             untrusted: GitHub only          |
|                                             |
|              [Cancel]  [Create]             |
+---------------------------------------------+
```

Behavior:
- Live validation on the name field (regex + reserved-names list — both shared with the backend via the `/api/zone-templates` endpoint that also returns the reserved list and regex pattern)
- "Create" button disabled until name is valid + template selected
- On submit: `POST /api/zones`, show inline error if 4xx, close modal + `fetchOverview()` on 2xx
- A small "Creating container..." spinner shows during the API call (typically 1–3s)

#### Zone badge dropdown — add management entries

In `showZoneDropdown` (current code), after the per-zone items, add:
- A separator
- A "Manage zones..." item that opens the zone-management modal (a list view with each zone + Delete button + container status pill)

Zone-management modal contents:

```
Zones
  core          [running]  (managed by compose, system)
  perimeter     [running]  (managed by compose, system)
  infra         [running]  (routing layer, system)
  foo           [running]  [Delete]   (3 threads — delete disabled, tooltip explains)
  bar           [missing]  [Delete]   (0 threads)
  ----
  [+ Create new zone]
```

Delete button calls `DELETE /api/zones/:name`. On 409 (threads still assigned), show an inline message: "Reassign N threads first." 

System zones (`core`, `perimeter`, `infra`) are visually distinct (gray, no Delete button).

#### Generic badge color

`zoneBadge()` currently has `colors = { core: 'var(--accent-green)', perimeter: 'var(--accent-yellow)' }`. Change to derive color deterministically from the zone name (hash-to-hue):

```javascript
function zoneColor(name) {
  if (name === 'core') return 'var(--accent-green)';
  if (name === 'perimeter') return 'var(--accent-yellow)';
  // Hash zone name to a hue in [0, 360)
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 60%, 55%)`;
}
```

`core` and `perimeter` keep their established colors so existing users don't see a UI shift.

### Knowledge & Skill Updates

The Zone Security Reviewer agent (`.claude/agents/zone-reviewer.md`) and several knowledge entries reference the old structure. Update them in the same PR as the implementation, so reviewers immediately see the new rules.

#### `.claude/agents/zone-reviewer.md`

Replace the "Zone Architecture" section with a generic statement:

> Borg has a routing layer (`infra`) and any number of agent zones. Each agent zone runs in its own Docker container with `BORG_ZONE=<name>` and mounts `.borg-zones/<name>/` at `/app/.borg`. The routing layer mounts `.borg-zones/` (parent) read-only for cross-zone visibility, plus its own `.borg-infra/` scratch space. Agents see only `/app/.borg` — they don't know their zone name from filesystem inspection.

Replace the explicit "Core" / "Perimeter" / "Infra" bullets with role descriptions:

- **Agent zones** — run agent SDK sessions. Mount their own `.borg-zones/<name>/` only.
- **Infra zone (routing layer)** — runs telegram-client + routing. Mounts all zones via `.borg-zones/` parent (read-only) plus its own `.borg-infra/`. Not a routable zone — threads cannot be assigned to it.
- **Templates** — `trusted` (full credentials) and `untrusted` (limited credentials). Reviewers should check that no zone gains privileges beyond its template.

In "Mount Point Violations," replace bullets that mention `.borg-core` / `.borg-perimeter` with:
- Agent containers must mount **only** their own `.borg-zones/<name>/`
- Agentless containers (`infra`, `dashboard`) mount `.borg-zones/` parent (read-only for dashboard, read-write for infra) plus `.borg-infra/`
- Per-zone secrets (SSH, docker-proxy) are governed by the zone's template — flag any deviation

In "Init Script Safety":
- Migration from old flat `.borg-{name}` structure → `.borg-zones/{name}/` is one-shot; only fires when the new structure is absent
- Per-zone subdirs are created from a single template, iterating over all zones in `zone-config.json` (no hardcoded zone list)

Add a new section: **Zone Creation/Deletion Path Safety**

- Only the dashboard can create/delete zones (no MCP tools, no agent capability)
- `zone-config.json` is read-only to all agent containers; only the `dashboard` and `infra` containers have it mounted read-write
- Reserved zone names: `infra`, `dashboard`, `broker`, `init`, `cloudflared`, `speaches`, `docker-proxy`, `archived`
- Zone deletion archives data (`.borg-zones/.archived/...`) rather than deleting — guards against accidental data loss

#### Knowledge entries

`.claude/knowledge/architecture/security-zones-container-isolation.md` — rewrite to drop "Core / Perimeter / Infra" as the canonical zones and describe the new structure. Move the docker-compose snippet to reference the parent mount. Add a "Creating a zone" subsection pointing at the dashboard.

`.claude/knowledge/architecture/usage-tracking-data-in-message-history-jsonl.md` — line referencing "Infra has read-only mounts for all zone `.borg-{zone}/` directories" → update to "Infra mounts `.borg-zones/` parent read-only plus `.borg-infra/`."

`.claude/knowledge/architecture/budget-mode-minimax-proxy-implementation.md` — line "Settings: Shared via /app/settings.json across zones (infra writes, core/perimeter reads)" → "...across all zones (infra writes, agent zones read)."

`CLAUDE.md` (root) — update the "Security Zones" section in the same way: drop "Core / Perimeter / Infra" enumeration, describe the routing layer + arbitrary zones model, point at the dashboard for creation.

Create a new knowledge entry: `.claude/knowledge/architecture/dynamic-zone-provisioning.md` capturing the create/delete flow, the supervisor's init-time replay, and Phase 2 deferrals. Add to the knowledge map.

---

## File-by-File Change Checklist

A junior dev should be able to work through this in order.

### Phase A — Plumbing (no UI yet)

1. **`zone-templates.json`** — new file at repo root. Schema as in "Zone Templates" above. Include `core` and `perimeter` as `trusted`/`untrusted` references for documentation.
2. **`src/zone-templates.ts`** — new file. Zod schema, mtime-cached loader. Exports `loadZoneTemplates()`, `resolveTemplate(name)`, `RESERVED_ZONE_NAMES`, `ZONE_NAME_REGEX`.
3. **`src/zone-config.ts`** — extend `ZoneConfigSchema` with optional `template` field on each zone.
4. **`src/zone-lock.ts`** — new file. `acquireZoneConfigLock()` returns a disposable; throws after N retries.
5. **`src/zone-supervisor.ts`** — new file. Exports `createZoneContainer(name, template)`, `deleteZoneContainer(name)`, `ensureZoneContainersExist()`. All three speak Docker API directly via `fetch` to the docker-proxy URL.
6. **`scripts/init-zones.sh`** — rewrite per "Migration script" above. Old-→-new directory rename; per-zone seeding loop reads `zone-config.json`; `chown -R` on the new tree.
7. **`scripts/ensure-zone-containers.ts`** — new file. Invoked at end of `init-zones.sh`. Calls `ensureZoneContainersExist()`.
8. **`docker-compose.yml`** — apply the diff from "Compose Changes":
   - `infra.volumes` — replace per-zone mounts with `.borg-zones` parent + `.borg-infra` + `zone-templates.json:ro`
   - `core.volumes` — `.borg-zones/core:/app/.borg` + workspace becomes `${WORKSPACE_HOST_BASE}/workspace-core:${WORKSPACE_ROOT}` (AD7)
   - `perimeter.volumes` — `.borg-zones/perimeter:/app/.borg` + workspace becomes `${WORKSPACE_HOST_BASE}/workspace-perimeter:${WORKSPACE_ROOT}` (AD7)
   - `dashboard.volumes` — `.borg-zones` parent ro + separate rw mount for task-stop + `.borg-infra` ro + `${WORKSPACE_HOST_BASE}:/host-workspaces` (rw for zone-create, ro view for file browser)
   - `dashboard.environment` — add `WORKSPACE_HOST_BASE`, `WORKSPACE_ROOT`, `BROKER_SECRET`, `PUBLIC_HOST`, `CLAUDE_CREDENTIALS` (needed for template placeholder resolution at zone-create time)
   - `init.volumes` — add `${WORKSPACE_HOST_BASE}:/host-workspaces` (rw, for per-zone workspace dir creation)
   - `core` and `perimeter` services: add `image: borg-agent:latest` (alongside `build: .`)
   - Add `init` service step to invoke `scripts/ensure-zone-containers.ts` after the existing setup
9. **`Dockerfile.infra`** — no changes expected. Sanity-check that path references aren't hardcoded.
10. **`zone-config.example.json`** — bump to include `template` fields on `core` (trusted) and `perimeter` (untrusted). Default `newThread` stays `core`.
10a. **`.env.example`** — add `WORKSPACE_HOST_BASE=/path/to/parent` with comment explaining per-zone workspace mounts. Update `WORKSPACE_ROOT` comment to clarify it's now the **container-internal** path, not the host path.

### Phase B — Dashboard backend

11. **`src/dashboard.ts`** — replace all hardcoded `zoneDirs` arrays with `listZoneDirs()` helper.
12. **`src/dashboard.ts`** — add `POST /api/zones`, `DELETE /api/zones/:name`, `GET /api/zone-templates`.
13. **`src/dashboard.ts`** — extend `GET /api/zones` response with `template` and `containerStatus` per zone.
14. **`src/dashboard.ts`** — task-stop write path: switch base from `/app/.borg-core/queue/task-stop` and `/app/.borg-perimeter/queue/task-stop` to `${TASK_STOP_BASE}/${zoneName}/queue/task-stop`. Default `TASK_STOP_BASE=/app/.borg-zones-rw`. Look up zone by scanning task state files (existing logic, just generalized).

### Phase C — Dashboard frontend

15. **`static/dashboard.html`** — replace `var(--bg-card)` → `var(--bg-secondary)`, `var(--bg-alt)` → `var(--bg-tertiary)` (full-file).
16. **`static/dashboard.html`** — `zoneColor()` helper for hash-based color of unknown zones.
17. **`static/dashboard.html`** — Create Zone modal (HTML + JS, ~80 lines).
18. **`static/dashboard.html`** — Zone management modal (HTML + JS, ~100 lines).
19. **`static/dashboard.html`** — "Manage zones..." entry in the badge dropdown.

### Phase D — Skill/knowledge updates

20. **`.claude/agents/zone-reviewer.md`** — per "Zone Creation/Deletion Path Safety" section above.
21. **`.claude/knowledge/architecture/security-zones-container-isolation.md`** — rewrite.
22. **`.claude/knowledge/architecture/usage-tracking-data-in-message-history-jsonl.md`** — single-line correction.
23. **`.claude/knowledge/architecture/budget-mode-minimax-proxy-implementation.md`** — single-line correction.
24. **`.claude/knowledge/architecture/dynamic-zone-provisioning.md`** — new file, ~50 lines.
25. **`.claude/knowledge/KNOWLEDGE_MAP_CLAUDE.md`** — add the new dynamic-zone-provisioning entry.
26. **`CLAUDE.md`** (root) — update the Security Zones section.

### Phase E — Tests

27. **`tests/zone-config.test.ts`** — extend with template field assertions.
28. **`tests/zone-supervisor.test.ts`** — new. Mock docker-proxy `fetch` (via `nock` or a tiny in-process HTTP stub). Test create-success, create-rollback-on-failure, delete-success, delete-refuse-on-threads.
29. **`tests/zone-lock.test.ts`** — new. Test mutex behavior on concurrent acquires.
30. **`tests/dashboard.zones.test.ts`** — new. Supertest-style coverage of POST/DELETE endpoints with mocked Docker API.

---

## Migration Plan

For each existing Borg deployment:

> **READ BEFORE `docker compose up`:** This migration has a **host-side step** (workspace rename) that cannot be automated by the init container. If you skip it, Docker will silently create empty workspace dirs as root-owned, agents will see an empty workspace, and any file edit will fail with EACCES. Do the host steps first.

### Step 1 — Host-side (manual, one-time)

```bash
docker compose down

# 1a. Workspace rename (AD7)
mv ~/workspace ~/workspace-core
mkdir ~/workspace-perimeter
sudo chown -R 1000:1000 ~/workspace-core ~/workspace-perimeter

# 1b. The borg repo now lives at ~/workspace-core/borg
cd ~/workspace-core/borg

# 1c. Add the new env var to .env
echo 'WORKSPACE_HOST_BASE=/home/lucian' >> .env   # adjust path for your host
```

Verify before continuing:
- `ls ~/workspace-core/borg/docker-compose.yml` shows the file
- `ls -ld ~/workspace-core ~/workspace-perimeter` shows uid/gid `1000:1000`

### Step 2 — Container-side (automated)

```bash
cd ~/workspace-core/borg
docker compose pull   # or build, depending on your setup
docker compose up -d
```

The new `init` service:
- Detects `.borg-core/` + `.borg-perimeter/` at repo root + no `.borg-zones/` → renames into `.borg-zones/core` and `.borg-zones/perimeter`
- Creates any missing subdirs
- `chown -R 1000:1000` the new `.borg-zones/` tree
- Ensures `${WORKSPACE_HOST_BASE}/workspace-${zone}/` exists + chowned for each zone in zone-config
- Calls `ensure-zone-containers.ts`, which sees zone-config.json contains only `core` and `perimeter` (both compose-managed) and exits no-op

### Step 3 — Verify

- Open the dashboard; threads appear in their zones as before
- `docker exec borg-core-1 ls /home/lucian/workspace` shows your repos
- `docker exec borg-perimeter-1 ls /home/lucian/workspace` shows an **empty** directory (intentional — perimeter no longer has cross-zone fs access; this is the bug fix)

### Step 4 — Cleanup (after one good day)

- `rm -rf ~/workspace-core/borg/.borg-core ~/workspace-core/borg/.borg-perimeter` if init's rename left them behind (it should not — `mv` was used, not `cp`)

### Rollback

```bash
docker compose down
mv ~/workspace-core/borg ~/borg-tmp   # save it
mv ~/workspace-core ~/workspace
mv ~/borg-tmp ~/workspace/borg
cd ~/workspace/borg
git checkout main      # or whatever pre-AD7 branch
mv .borg-zones/core .borg-core 2>/dev/null || true
mv .borg-zones/perimeter .borg-perimeter 2>/dev/null || true
rm -rf ~/workspace-perimeter
docker compose up -d
```

The data renames are reversible because all operations used `mv`, not `cp`. The borg-repo move is also reversible.

### Live trading-ops thread (thread 1146)

This thread runs in core and must not have a forced stop. The compose `stop_grace_period: 30s` is honored by `docker compose down`. Plan the migration during a market-closed window if possible.

---

## Portability

Borg's state is entirely in disk files. To migrate a deployment to a new host:

```bash
# On the old host:
docker compose down
# Verify nothing is writing:
ls -lR .borg-zones .borg-infra threads.json zone-config.json settings.json

# Copy to new host:
rsync -av --progress \
  ./.borg-zones ./.borg-infra ./threads.json ./zone-config.json \
  ./zone-templates.json ./settings.json ./secrets/ ./.env \
  new-host:/path/to/borg/

# On the new host:
cd /path/to/borg
docker compose up -d --build
# The init service rebuilds containers for core/perimeter and re-launches
# any dynamic zones referenced in zone-config.json
```

**Not migrated by rsync (and don't need to be):**
- `claude-plugins-core`, `claude-plugins-perimeter`, `claude-plugins-{zone}` named volumes — Claude Code regenerates these on first run
- `speaches-cache` named volume — re-downloads STT/TTS models on first use
- Docker images — `docker compose build` on the new host rebuilds from Dockerfiles

**Disaster recovery:** All zone data is on disk + rsync'able. The destruction surface is essentially "what gets nuked when the host disk dies." A nightly rsync of those paths to a backup host is sufficient for full recovery.

---

## Testing Plan

### Unit

- `zone-templates.ts` — load/parse, placeholder resolution (`${WORKSPACE_ROOT}`, `{ZONE}`), unknown template rejection
- `zone-supervisor.ts` — spec composition correctness, rollback ordering on Docker API failure
- `zone-lock.ts` — mutex semantics, stale-lock recovery
- `zone-config.ts` — schema with new `template` field, backwards-compat with old configs

### Integration (require a real docker-proxy)

- Create zone end-to-end: `POST /api/zones { name: "test-zone", template: "untrusted" }` → container running → directory created → zone in config
- Delete zone end-to-end: `DELETE /api/zones/test-zone` → container gone → directory archived → zone removed from config
- Refuse-delete when threads present
- Refuse-create on reserved name / bad name / existing name
- Concurrent create requests for same name — only one wins, the other gets 409

### Manual

- Dashboard: open badge dropdown, verify solid background (regression on the styling bug)
- Dashboard: hash-color renders deterministically for arbitrary zone names
- Migration: deploy to a staging copy with existing `.borg-core` / `.borg-perimeter` data; verify rename and continued operation
- Restart persistence: create a dynamic zone, `docker compose down`, `docker compose up -d`, verify the dynamic container is recreated

---

## Open Risks / Edge Cases

- **Docker proxy permissions:** the existing regex allows `containers/create.*` and `DELETE containers/[a-f0-9]+.*`. Verify the delete regex accepts the container ID (not the name) — Docker API returns IDs from create. If our code uses name-based delete (`DELETE /containers/borg-zone-foo`), the regex pattern `[a-f0-9]+` won't match. **Fix:** Either look up the ID before delete (preferred), or widen the regex to accept names (`[a-zA-Z0-9_.-]+`). Lean toward the lookup; tighter proxy regex is better.
- **Image tag drift:** `borg-agent:latest` will get out of date if the Dockerfile changes but no `docker compose build` runs. Add `docker compose build` to deploy docs and consider tagging by git SHA in future.
- **Network attachment:** Docker's `POST /containers/create` accepts one network in `HostConfig.NetworkMode`; secondary networks require `POST /networks/{id}/connect` calls after create. Get this right in `zone-supervisor.ts` — the dev network attachment for `trusted` zones is critical for the trading-ops workflow.
- **Workspace mount uid mismatch:** Mounting `${WORKSPACE_ROOT}` works because the host owns the files as `1000:1000` and the container runs as `node` (uid 1000). If a new zone wants different filesystem boundaries (e.g. read-only workspace), templates are the right knob. Out of scope here.
- **Claude credentials mount:** The credentials file is mounted into every zone. This is per the existing design (`core` and `perimeter` both mount it) but worth flagging — a compromised untrusted zone could read Claude credentials. Consider per-zone credentials in Phase 2.
- **`init` service ordering:** `init` runs once at compose-up and exits successfully. If `ensure-zone-containers.ts` fails (e.g., docker-proxy not yet healthy), compose treats the init as failed and downstream services don't start. **Mitigation:** Make `ensure-zone-containers.ts` resilient — retry with backoff for up to 30s waiting on docker-proxy, log loudly but exit 0 even on individual zone failures (the dashboard will surface "missing" state for the user to investigate). Also: init now needs `depends_on: docker-proxy: service_healthy` (currently no dep — was just `node:22-slim` running a shell script).

- **Supervisor image:** `ensure-zone-containers.ts` needs compiled TS. Run it under the **dashboard image** (already has compiled `src/`, already mounts `zone-config.json` and the templates file). Init becomes a two-stage script: stage 1 = shell (mkdirs, chowns); stage 2 = `docker exec` into the dashboard image's entrypoint with an alternate command. Alternative considered: compile a standalone supervisor binary — rejected as duplication.

- **Dynamic-zone supervisor scope (AD3 clarification):** Supervisor creates a container only if **no container with that name exists** (running OR stopped). If a user manually `docker stop borg-zone-foo`, the supervisor on next boot leaves it stopped — user intent is preserved. Phase 2 will add explicit "start zone" UI; for now, manual `docker start borg-zone-foo` works.

- **Dashboard's chown capability:** dashboard runs as `node` (uid 1000) by default. mkdir works fine; chown to 1000:1000 of a dir the dashboard just created is also fine (you own what you create). But if `init` created the dir first as uid 1000, the dashboard re-chowning is a no-op. Verified path: no special caps needed. If a future change runs the dashboard as a different uid, fall back to spawning a one-shot helper container that does chown via root inside the helper.

- **Latent dashboard issue: `BORG_DIR` reads (out of scope, follow-up).** Audit found 18 places in `src/dashboard.ts` that read from `BORG_DIR` (= `/app/.borg`, mapped to core) for "primary zone" stats: queue counters (line 240), disk usage (line 246), message-history reads (309/319/332/439), sessions dir (line 32), logs (line 509). In a multi-zone world some of these should iterate across all zones (queue depth across all zones, disk usage as a sum, etc.). For this PR: keep `/app/.borg:ro → core` mount to preserve current behavior. **Follow-up PR: "Generalize dashboard BORG_DIR primary-zone reads to iterate across zones."** File this immediately after merge so it doesn't get lost; the first non-core zone you create will surface the bug.

---

## Phase 2 (not in this plan)

- Zone restart / stop / logs viewer in the dashboard
- Zone rename
- Per-zone resource limits configurable from the UI (memory, CPU shares)
- Additional templates (e.g., `air-gapped` — no internet egress)
- Per-zone credentials (Claude credentials, GitHub installations) instead of shared
- A "compose import" command that emits a docker-compose fragment for a dynamically-created zone, for users who want to manage everything via compose

---

## Summary Diff (TL;DR)

- Move `.borg-{core,perimeter}` → `.borg-zones/{core,perimeter}`. Keep `.borg-infra/` as a sibling. Add `.borg-zones/.archived/` for soft-deletes.
- **AD7:** Per-zone workspace mounts — host `${WORKSPACE_HOST_BASE}/workspace-{zone}/` → container `${WORKSPACE_ROOT}`. Real filesystem isolation between zones. Perimeter loses cross-zone fs access (bug fix). Manual host rename required during migration.
- Borg repo moves from `~/workspace/borg` → `~/workspace-core/borg`.
- One-time `init-zones.sh` migration for `.borg-` dirs; manual `mv ~/workspace ~/workspace-core` for the workspace tree.
- Dynamically-created zones are real Docker containers created by the dashboard via docker-proxy; a startup hook re-creates them on host reboot from `zone-config.json`.
- Two templates: `trusted` (clone of core) and `untrusted` (clone of perimeter), defined in `zone-templates.json`. Workspace mount is per-zone-instance (AD7), not per-template.
- Dashboard gets create/delete UI; existing badge dropdown styling bug (`--bg-card`/`--bg-alt` reference undefined CSS vars) fixed inline.
- Knowledge entries and the Zone Security Reviewer skill updated to drop hardcoded `core`/`perimeter`/`infra` enumeration and describe the generic shape.
- Portability preserved: state is on disk; new hosts come up via rsync (now including `~/workspace-{core,perimeter,...}/`) + `docker compose up`.

## PR sequencing

- **PR 1** (Phase A + B): plumbing + dashboard backend. Includes AD7 (compose + workspace mounts + migration). Safe to ship without UI — existing zone-filter dropdown still works for assignment.
- **PR 2** (Phase C + D): dashboard create/delete UI + knowledge updates.
- **PR 3** (Phase E): tests.
- **PR 4** (follow-up): BORG_DIR generalization in dashboard (see Open Risks).
