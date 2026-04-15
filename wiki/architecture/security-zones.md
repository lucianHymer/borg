# Security Zones

Container-level isolation for agent threads. Zones are invisible to agents.

## Zones

- **Core** -- trusted threads (repos, trading, main). Full credential access (GitHub, SSH, Docker proxy).
- **Perimeter** -- untrusted threads (social media, web-facing). GitHub only, no SSH or Docker proxy.
- **Infra** -- telegram-client + routing only. No agent SDK sessions. Mounts all zone dirs for cross-zone routing.

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

Each zone gets `.borg-{zone}/` with queue/, message-history.jsonl, etc. Zone containers mount their dir at `/app/.borg` so existing code works unchanged.

`threads.json` is a single file bind-mounted to all containers (shared, writable by all).

## Docker Layout

`docker compose up` starts all three containers: `infra`, `core`, `perimeter`. No single-container mode.

- `BORG_ZONE` env var -- always `"core"`, `"perimeter"`, or `"infra"`
- `ZONE_CONFIG_PATH` -- path to zone-config.json

## Routing

`send_message` (mcp-tools.ts) is zone-unaware -- writes one outgoing message with `crossThread: true`. Infra's `pollOutgoingQueue()` handles routing: same-zone direct delivery, cross-zone to pending queue with approval keyboard.

## Heartbeats

Each zone's queue-processor generates heartbeats for its own threads only via `getThreadsInZone()`.

## Broadcast Filtering

Broadcast fan-out only reaches `mainThread: true` threads in the core zone. The `broadcast` MCP tool is only registered when `BORG_ZONE` is `"core"`.

## Daily Pending Reminder

Infra scans pending queue hourly, sends daily summary to master thread with sender/target info, age, message preview, and deep links to approval keyboards.

See: `src/zone-config.ts`, `src/mcp-tools.ts`, `src/telegram-client.ts`, `src/queue-processor.ts`, `docker-compose.yml`, `zone-config.example.json`, `scripts/init-zones.sh`
