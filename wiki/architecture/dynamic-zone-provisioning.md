# Dynamic Zone Provisioning

Runtime create/delete of agent zones via the dashboard, with init-time replay so zones survive restarts.

## What Is a Dynamic Zone

Any zone in `zone-config.json` that is not `core`, `perimeter`, or `infra`. Dynamic zones are created/destroyed by the dashboard at runtime and persisted across restarts by the init-time supervisor. From the agent's perspective there is no difference between a dynamic zone and a baseline zone — both mount `.borg-zones/<name>/` at `/app/.borg` and run the same image.

## Create Flow

`POST /api/zones` in the dashboard:

1. **Validate** -- name passes `isValidZoneName()` (not in `RESERVED_ZONE_NAMES`, matches charset), template exists in `zone-templates.json`, zone not already present.
2. **Lock** -- acquire `.borg-zones/.zone-lock` via `src/zone-lock.ts` to serialize zone mutations.
3. **Write zone-config** -- atomic write of updated `zone-config.json` (tmp + rename).
4. **Provision storage** -- `mkdir -p .borg-zones/<name>/{queue/{incoming,outgoing,processing,commands},sessions}`, sync `skills/` from the source of truth, create the workspace dir, `chown` everything to uid 1000.
5. **Container** -- `createZoneContainer()` (`src/zone-supervisor.ts`) calls docker-proxy `create`, attaches the zone's secondary networks per template, and starts the container. On any failure the previous steps are rolled back (config entry removed, container removed, dir left in place for inspection).
6. **Respond** -- 201 with the new zone descriptor.

## Delete Flow

`DELETE /api/zones/:name`:

1. **Validate** -- zone exists and is not reserved.
2. **Lock** -- same `.zone-lock`.
3. **Refuse if threads assigned** -- the dashboard returns 409 if any thread in `zone-config.json` still points at the zone; the operator must reassign or delete those threads first.
4. **Stop + remove container** -- best-effort via docker-proxy; failures are logged but do not block.
5. **Archive** -- move `.borg-zones/<name>/` to `.borg-zones/.archived/<name>-<ISO-timestamp>/`. Deletion is never destructive at this layer.
6. **Drop config entry** -- atomic write of updated `zone-config.json`.

## Supervisor Replay at Boot

`scripts/ensure-zone-containers.ts` runs as part of the init service on every boot. It iterates zones in `zone-config.json` and re-creates any container that doesn't already exist (matched by name). It does **not** start containers that exist but are stopped — that preserves the operator's intent if they deliberately stopped a zone. The same code path is used by the dashboard's create flow for the initial creation.

## Templates

`zone-templates.json` defines `trusted` and `untrusted`:

- **trusted** -- full credentials. GitHub app keys, SSH keys, docker-proxy socket. Suitable for repos that need to push code or operate infrastructure.
- **untrusted** -- limited credentials. GitHub only, no SSH, no docker-proxy. Suitable for web-facing or social-media work where credential exposure cost is higher.

Templates control image, memory limits, secondary networks, secret mounts, and env vars. The base container spec (workspace mount, `.borg-zones/<name>/` mount, `BORG_ZONE` env, `threads.json` / `zone-config.json` / `settings.json` shared mounts) is applied to every dynamic zone regardless of template.

## Reserved Names

`RESERVED_ZONE_NAMES` in `src/zone-templates.ts`:

`infra`, `dashboard`, `broker`, `init`, `cloudflared`, `speaches`, `docker-proxy`, `archived`.

The dashboard refuses to create a zone with any of these names — they collide with platform services or the archive root.

## Phase 2 Deferrals

Not implemented in the initial generic-zones release; tracked for follow-up:

- No manual "stop"/"start" UI for individual zones (use `docker compose` directly if needed).
- No per-zone credentials override (templates are the only knob).
- No skills hot-sync without container restart -- changes to `skills/` propagate at next container create.
- No archive purge command -- archived dirs accumulate until manually removed by the operator.

## See

`src/zone-supervisor.ts`, `src/zone-templates.ts`, `src/zone-lock.ts`, `scripts/init-zones.sh`, `scripts/ensure-zone-containers.ts`, `static/dashboard.html` (Create Zone / Manage Zones modals), [Security Zones](security-zones.md).
