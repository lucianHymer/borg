# Borg

Telegram forum-based multi-session Claude agent with SDK v2, smart routing, and cross-thread orchestration.

## Architecture

- **Telegram Client** (`src/telegram-client.ts`) — grammY bot handling all forum topics, I/O only
- **Queue Processor** (`src/queue-processor.ts`) — SDK v2 sessions, routing, history injection
- **Session Manager** (`src/session-manager.ts`) — threadId → session lifecycle, threads.json
- **Router** (`src/router/`) — 14-dimension weighted scoring engine, model selection
- **Message History** (`src/message-history.ts`) — shared JSONL log, tagged by threadId
- **Routing Logger** (`src/routing-logger.ts`) — JSONL log of routing decisions

## Key Files

- `.borg/threads.json` — thread configurations (threadId → session mapping)
- `.borg/message-history.jsonl` — all messages across all threads
- `.borg/routing-log.jsonl` — routing decision audit trail
- `.borg/message-models.json` — Telegram messageId → model mapping for reply routing
- `.borg/settings.json` — bot token, chat ID, timezone, intervals
- `HEARTBEAT.md` — living task list for heartbeat checks (per-repo)

## Cross-Thread Communication

Agents communicate through the file queue system:
- Read `.borg/threads.json` to see active threads
- Grep `.borg/message-history.jsonl` for any thread's history
- Write JSON to `.borg/queue/outgoing/` with `targetThreadId` field to message another thread
- Master thread (threadId: 1) has visibility across all threads

## Message Sources

Queue messages carry a `source` field: `"user"`, `"cross-thread"`, `"heartbeat"`, `"cli"`, `"system"`.

## Model Routing

Smart routing uses 14 weighted dimensions to classify messages as SIMPLE (haiku), MEDIUM (sonnet), or COMPLEX (opus). Replies to bot messages can only upgrade the model. Fresh messages allow free model selection.

## Coding Conventions

- TypeScript with `nodenext` module resolution
- Node.js 22.22.0 (require(esm) support)
- Relative imports use `.js` extensions per nodenext rules
- Atomic file writes: write to .tmp then rename
- JSONL appends: use appendFileSync (O_APPEND safe on ext4)

## Build

```sh
npm run build    # TypeScript compilation
npm run telegram # Start Telegram client
npm run queue    # Start queue processor
./borg.sh start  # Start all via tmux
```


## Mim Knowledge

@.claude/knowledge/INSTRUCTIONS.md
@.claude/knowledge/KNOWLEDGE_MAP_CLAUDE.md
