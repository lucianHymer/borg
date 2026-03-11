# Borg

Telegram forum-based multi-session Claude agent with SDK v2, smart routing, and cross-thread orchestration.

## Philosophy

Compound knowledge into repos. The repo should get smarter over time — workflow definitions, learned patterns, and coordination skills all live here, not in external tools. Borg provides the lightest possible infrastructure layer: MCP tools for thread management (create_thread, send_message) and a queue-based message bus. Everything else — how teams coordinate, what roles exist, when to use which workflow — is described in skills and knowledge files that live in the repo. This means any Claude Code session in this repo knows how things work, even without Borg running. Different repos can have different patterns. Borg = plumbing, repo = intelligence.

## Architecture

- **Telegram Client** (`src/telegram-client.ts`) — grammY bot handling all forum topics, I/O and routing log finalization
- **Queue Processor** (`src/queue-processor.ts`) — SDK v2 sessions, routing, history injection
- **Session Manager** (`src/session-manager.ts`) — threadId → session lifecycle, threads.json
- **Router** (`src/router/`) — 14-dimension weighted scoring engine, model selection
- **Message History** (`src/message-history.ts`) — shared JSONL log, tagged by threadId; carries optional token usage + cost fields on outgoing entries
- **Routing Logger** (`src/routing-logger.ts`) — JSONL log of routing decisions
- **Zone Config** (`src/zone-config.ts`) — zone-config.json loader, validation, mtime caching

## Security Zones

Container-level isolation. Agents are separated into **Core** (trusted) and **Perimeter** (untrusted) zones, with **Infra** running telegram-client + routing only. Zones are invisible to agents — `send_message` works identically; cross-zone messages are held for human approval via Telegram inline keyboard.

- `zone-config.json` — maps threads to zones, validated by Zod, mtime-cached via `loadZoneConfig()`
- `BORG_ZONE` env var — always set: `"core"`, `"perimeter"`, or `"infra"`
- `ZONE_CONFIG_PATH` env var — path to zone-config.json
- Per-zone storage: `.borg-core/`, `.borg-perimeter/`, `.borg-infra/`
- Broadcast filtered to core-zone `mainThread` threads

## Key Files

- `.borg/threads.json` — thread configurations (threadId → session mapping)
- `.borg/message-history.jsonl` — all messages across all threads
- `.borg/routing-log.jsonl` — routing decision audit trail
- `.borg/message-models.json` — Telegram messageId → model mapping for reply routing
- `.borg/settings.json` — bot token, chat ID, timezone, intervals
- `zone-config.json` — thread-to-zone mapping (see Security Zones)
- `HEARTBEAT.md` — living task list for heartbeat checks (per-repo)

## Cross-Thread Communication

Agents communicate through the file queue system:
- Read `.borg/threads.json` to see active threads
- Grep `.borg/message-history.jsonl` for any thread's history
- Write JSON to `.borg/queue/outgoing/` with `targetThreadId` field to message another thread
- Master thread (threadId: 1) has visibility across all threads

## Message Sources

Queue messages carry a `source` field: `"user"`, `"cross-thread"`, `"heartbeat"`, `"cli"`, `"system"`, `"broadcast"`.

## Model Routing

Smart routing uses 14 weighted dimensions to classify messages as SIMPLE (haiku), MEDIUM (sonnet), or COMPLEX (opus). Replies to bot messages can only upgrade the model. Fresh messages allow free model selection.

## Coding Conventions

- TypeScript with `nodenext` module resolution
- Node.js 22.22.0 (require(esm) support)
- Relative imports use `.js` extensions per nodenext rules
- Atomic file writes: write to .tmp then rename
- JSONL appends: use appendFileSync (O_APPEND safe on ext4)
- Message history deduplication: appendHistory() deduplicates by messageId (strips `_tg` and `_retry\d+` suffixes), checks last ~50 entries, falls back to timestamp matching (5s window) for outgoing messages without messageId

## Broadcasting

Cross-repo knowledge sharing via a shared Telegram group. The `broadcast` MCP tool posts structured messages; incoming broadcasts fan out to all `mainThread: true` threads with `[use opus]` prefix. See `skills/global/broadcasting.md` for send/receive guidance. Requires `broadcast_chat_id` in settings.json and `mainThread: true` on primary repo threads.

## Build

```sh
npm run build        # TypeScript compilation
docker compose up    # Start infra + core + perimeter containers
```


## Mim Knowledge

@.claude/knowledge/INSTRUCTIONS.md
@.claude/knowledge/KNOWLEDGE_MAP_CLAUDE.md
