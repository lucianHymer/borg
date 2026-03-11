# Security zones: container-level isolation for agent threads

Borg isolates agent threads into security zones using separate Docker containers. Zones are purely infrastructure — agents don't know they exist.

## Zones

- **Core** — trusted threads (repos, trading, main). Full credential access (GitHub, SSH, Docker proxy).
- **Perimeter** — untrusted threads (social media, web-facing). GitHub only, no SSH or Docker proxy.
- **Infra** — telegram-client + routing only. No agent SDK sessions. Mounts all zone dirs for cross-zone routing.

## Key Design Principle

Zones are invisible to agents. Agents call `send_message` as always; the routing layer silently holds cross-zone messages for human approval. No zone labels in system prompts, no MCP tool filtering by zone (except broadcast), no agent awareness of zone boundaries. Isolation comes from Docker filesystem boundaries, not from telling agents what zone they're in.

## Configuration

`zone-config.json` maps thread IDs to zones. Owned by infra, read-only to zone containers. Validated with Zod, mtime-cached via `loadZoneConfig()`. New threads default to the zone specified in `defaults.newThread`.

```json
{
  "zones": {
    "core": { "threads": [1, 43, 58] },
    "perimeter": { "threads": [] }
  },
  "defaults": { "newThread": "perimeter" }
}
```

## Cross-Zone Messaging

Same-zone `send_message` delivers directly (unchanged behavior). Cross-zone messages are held in a pending queue (``.borg-infra/queue/pending/``) and an inline keyboard (Approve/Reject) is shown in the master Telegram thread. Approved messages are delivered to the target zone's incoming queue; rejected messages send a notification to the sender.

## Per-Zone Storage

Each zone gets its own `.borg-{zone}/` directory with queue/, message-history.jsonl, etc. Zone containers mount their dir at `/app/.borg` so existing code works unchanged. `threads.json` is a single file bind-mounted to all containers (shared, writable by all — zone isolation is Docker-level, not threads.json-level).

## Docker Layout

`docker compose up` starts all three containers: `infra`, `core`, `perimeter`. There is no single-container mode.
- `BORG_ZONE` env var — always set: `"core"`, `"perimeter"`, or `"infra"`
- `ZONE_CONFIG_PATH` env var points to zone-config.json location

## Cross-Thread Routing

`send_message` (mcp-tools.ts) is zone-unaware — writes one outgoing message with `crossThread: true`. Infra's `pollOutgoingQueue()` handles routing: same-zone messages are delivered directly to the target zone's incoming queue; cross-zone messages go to a pending queue with an inline approval keyboard.

## Heartbeats

Each zone's queue-processor generates heartbeats for its own threads only, using `getThreadsInZone()`. No external heartbeat script.

## Broadcast Filtering

Broadcast fan-out only reaches `mainThread: true` threads in the core zone. The broadcast MCP tool is only registered when `BORG_ZONE` is `"core"` (excluded from perimeter and infra).

## Daily Pending Reminder

Infra scans the pending queue hourly and sends a daily summary to the master thread with sender/target info, age, message preview, and deep links to approval keyboards.

**Related files:** src/zone-config.ts, src/mcp-tools.ts, src/telegram-client.ts, src/queue-processor.ts, src/types.ts, docker-compose.yml, Dockerfile.infra, zone-config.example.json, scripts/init-zones.sh
