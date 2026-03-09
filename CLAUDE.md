# Borg

Telegram forum-based multi-session Claude agent with SDK v2, smart routing, and cross-thread orchestration.

## Philosophy

Compound knowledge into repos. The repo should get smarter over time — workflow definitions, learned patterns, and coordination skills all live here, not in external tools. Borg provides the lightest possible infrastructure layer: MCP tools for thread management (create_thread, send_message) and a queue-based message bus. Everything else — how teams coordinate, what roles exist, when to use which workflow — is described in skills and knowledge files that live in the repo. This means any Claude Code session in this repo knows how things work, even without Borg running. Different repos can have different patterns. Borg = plumbing, repo = intelligence.

## Architecture

- **Telegram Client** (`src/telegram-client.ts`) — grammY bot handling all forum topics, I/O and routing log finalization
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
- `send_message` routes to peer Borg instances (other repos, same host) via `peers` in `.borg/settings.json`

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
- Message history deduplication: appendHistory() deduplicates by messageId (strips `_tg` and `_retry\d+` suffixes), checks last ~50 entries, falls back to timestamp matching (5s window) for outgoing messages without messageId

## Build

```sh
npm run build    # TypeScript compilation
npm run telegram # Start Telegram client
npm run queue    # Start queue processor
./borg.sh start  # Start all via tmux
```


## Key Learnings (Peer Messaging, PR #30)

**Design iteration lesson:** Started with filesystem-based peers (PR #29), then HTTP+filesystem dual transport, then simplified to HTTP-only. The biggest win came from ruthlessly simplifying the security model once we understood what WireGuard already provides. Initial plan had HMAC signing, complex config — final version: just peer IP validation + JSON schema validation. *Key insight:* WireGuard handles all transport security; application-level crypto is redundant.

**Organizational lesson:** The Planner handed work to Worker before the human user approved the plan. This caused waste (Worker built the filesystem version, then pivoted when the revised plan was approved). **Critical fix:** Dev-team workflow now explicitly requires human (Lucian) approval in the GitHub issue BEFORE Planner tells Worker to start. Master thread approval is not sufficient.

**Architecture insight:** Unified HTTP transport (not dual filesystem+HTTP) keeps the code path clean. `send_message` treats local cross-thread and peer sends identically up to the delivery point — same queue structure, different target. This single-path approach prevented bugs and made validation straightforward.

**The `_tg` suffix gotcha:** Ownership is the key rule. QUEUE_OUTGOING entries can ONLY target threadIds owned by the local telegram-client. For peer sends, skip the `_tg` display entry entirely — the peer's telegram-client handles its own display when processing the message from its queue. This non-obvious rule is exactly what future agents would repeat as a bug if not documented.

**Config simplification:** Peer config went from `{ name, url, threadsJsonUrl, expectedIp, sharedSecret }` to just `{ name, ip }`. Simpler is better.

## Mim Knowledge

@.claude/knowledge/INSTRUCTIONS.md
@.claude/knowledge/KNOWLEDGE_MAP_CLAUDE.md
