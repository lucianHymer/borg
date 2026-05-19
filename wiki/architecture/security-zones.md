# Security Zones

Container-level isolation for agent threads. Zones are invisible to agents.

## Layers

- **Routing layer** (`infra`) -- telegram-client + cross-zone routing only. No agent SDK sessions. Mounts `.borg-zones/` (parent) read-only for cross-zone visibility, plus its own `.borg-infra/` scratch.
- **Agent zones** -- any zone in `zone-config.json` other than `infra`. Each runs in its own Docker container with `BORG_ZONE=<name>` and mounts `.borg-zones/<name>/` at `/app/.borg`. Agents see only `/app/.borg`.
- **Templates** -- `zone-templates.json` defines `trusted` (full credentials: GitHub, SSH, Docker proxy) and `untrusted` (limited credentials). The dashboard's create-zone API picks a template per zone.

## Key Principle

Agents don't know zones exist. `send_message` works identically everywhere; cross-zone messages are silently held for human approval. No zone labels in system prompts, no MCP tool filtering by zone (except broadcast), no agent awareness of zone boundaries.

## Configuration

`zone-config.json` maps thread IDs to zones. Owned by infra, read-only to zone containers. Validated with Zod, mtime-cached via `loadZoneConfig()`.

```json
{
  "zones": {
    "core": { "threads": [1, 43, 58] },
    "perimeter": { "threads": [] }
  },
  "defaults": { "newThread": "perimeter" }
}
```

New threads default to the zone specified in `defaults.newThread`.

## Cross-Zone Messaging

- Same-zone: delivers directly (unchanged behavior)
- Cross-zone: held in `.borg-infra/queue/pending/`, inline keyboard (Approve/Reject) shown in master thread
- Approved: delivered to target zone's incoming queue
- Rejected: notification sent to sender

## Per-Zone Storage

Each zone gets `.borg-zones/<name>/` with queue/, message-history.jsonl, etc. Agent containers mount their own dir at `/app/.borg` so existing code works unchanged. The routing layer mounts `.borg-zones/` (parent) read-only so it can read every zone's outgoing queue without having to know the zone list at compose time.

`threads.json` is a single file bind-mounted to all containers (shared, writable by all).

## Docker Layout

`docker compose up` starts the `infra` routing layer plus one container per agent zone declared in `zone-config.json`. No single-container mode.

- `BORG_ZONE` env var -- routing layer is `"infra"`; agent zones get their assigned name (`"core"`, `"perimeter"`, or any dashboard-created zone)
- `ZONE_CONFIG_PATH` -- path to zone-config.json

## Creating a Zone

Zones are created via the dashboard's "+ Zone" button (POST /api/zones) or replayed at init time by the supervisor for any zone already in `zone-config.json` that's missing its container. There is no MCP tool and no agent capability for creating or deleting zones — these are human-only operations. Deletion archives the data dir under `.borg-zones/.archived/` rather than removing it. See [Dynamic Zone Provisioning](dynamic-zone-provisioning.md).

## Routing

`send_message` (mcp-tools.ts) is zone-unaware -- writes one outgoing message with `crossThread: true`. Infra's `pollOutgoingQueue()` handles routing: same-zone direct delivery, cross-zone to pending queue with approval keyboard.

## Heartbeats

Each zone's queue-processor generates heartbeats for its own threads only via `getThreadsInZone()`.

## Broadcast Filtering

Broadcast fan-out only reaches `mainThread: true` threads in the core zone. The `broadcast` MCP tool is only registered when `BORG_ZONE` is `"core"`.

## Daily Pending Reminder

Infra scans pending queue hourly, sends daily summary to master thread with sender/target info, age, message preview, and deep links to approval keyboards.

See: `src/zone-config.ts`, `src/zone-templates.ts`, `src/zone-supervisor.ts`, `src/mcp-tools.ts`, `src/telegram-client.ts`, `src/queue-processor.ts`, `docker-compose.yml`, `zone-config.example.json`, `zone-templates.json`, `scripts/init-zones.sh`, `scripts/ensure-zone-containers.ts`
