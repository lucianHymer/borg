<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo.svg" alt="borg logo" width="360">
  </picture>
</p>

# borg

**bot org**

- Manage your org in a Telegram group -- each thread is a repo with Claude Code checked out
- Level up your repo here, level up your repo for everyone (shared knowledge compounding)
- Dev containers that set up the perfect environment automatically
- Secret broker for secure credential forwarding without exposing secrets to agents
- Spin up dev data environments on request
- Real-time dashboard with memory management and resource monitoring

```
Telegram Forum Group
├── General (Master)     → ~/workspace/              (coordinates all threads)
├── Passport             → ~/workspace/passport      (Claude session in passport repo)
├── API Server           → ~/workspace/api           (Claude session in api repo)
├── Frontend             → ~/workspace/frontend      (Claude session in frontend repo)
└── ...                  → each topic = its own agent session
```

Every session is a full [Claude Code agent](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) with file access, code editing, terminal commands, and web search. Sessions persist across messages so context is never lost.

A fork of the original [TinyClaw](https://github.com/lucianHymer/tinyclaw/tree/986b10f) by **Jian**, rebuilt from the ground up.

## Highlights

### GitHub Token Broker

A credential microservice that gives every agent session transparent GitHub access without long-lived tokens.

- **Broker service** mints short-lived GitHub App installation tokens on demand via `@octokit/auth-app`
- **Git credential helper** intercepts `git push/pull/clone`, resolves the org from the URL, fetches a fresh token from the broker
- **gh CLI wrapper** replaces `/usr/bin/gh` with a shim that injects `GH_TOKEN` before calling the real binary

Agents just use `git` and `gh` normally -- authentication is invisible. Supports multiple GitHub orgs via an installation ID mapping file.

### Smart Model Routing

Every message is scored across 14 weighted dimensions (code presence, reasoning markers, token count, technical terms, multi-step patterns, etc.) and routed to the cheapest capable model:

| Tier | Model | When |
|---|---|---|
| SIMPLE | Haiku | Quick questions, status checks |
| MEDIUM | Sonnet | Code review, moderate analysis |
| COMPLEX | Opus | Architecture, complex debugging |

Runs locally in <1ms with zero API calls. Replies to bot messages can only **upgrade** the model, never downgrade. Adapted from [ClawRouter](https://github.com/BlockRunAI/ClawRouter).

### Cross-Thread Communication

Agents can talk to each other. Each session gets MCP tools for `send_message(targetThreadId, message)` and `list_threads()`. Messages route through the file queue so they appear in both the target agent's context and the Telegram topic.

The Master thread (General topic) has elevated visibility -- it receives history from all threads and can coordinate across sessions.

### Heartbeat Loop

Each thread gets periodic check-ins via a heartbeat cron. The agent reads `HEARTBEAT.md` (a living task list) in its repo, takes action on pending items, and reports back. Uses haiku to minimize cost. Responses containing `[NO_UPDATES]` are suppressed from Telegram -- you only get notified when something actually needs attention.

### Real-Time Dashboard

A single-file HTML dashboard (no dependencies) with 7 views:

- **Live Feed** -- SSE-streamed messages across all threads with model-colored badges
- **Thread Detail** -- Chat-bubble view of any thread's conversation
- **Routing Inspector** -- Live routing decisions with confidence scores and signal breakdowns
- **Prompt Inspector** -- Assembled prompts with history injection indicators
- **Metrics** -- CPU, RAM, disk, load from `/proc`
- **Logs** -- Streamed logs with filtering and log-level coloring

### Model Emoji Reactions

When the bot acknowledges your message, it reacts with an eye emoji. When it responds, it adds a model-specific emoji: lightning for haiku, pen for sonnet, fire for opus. Instant visual feedback without cluttering the conversation.

## Architecture

Two processes connected by a file-based queue:

1. **Telegram Client** (`src/telegram-client.ts`) -- grammY bot, pure I/O. Tags messages with `threadId`, writes to `incoming/`, polls `outgoing/` for responses.
2. **Queue Processor** (`src/queue-processor.ts`) -- Picks up messages, routes them, manages Agent SDK sessions, writes responses back.

The queue (`incoming/ → processing/ → outgoing/`) uses atomic writes (`.tmp` + rename) and recovers stuck files on startup. A `dead-letter/` directory catches failures after 3 retries.

Supporting modules: Session Manager (thread lifecycle, system prompts), Router (14-dimension scoring), Message History (shared JSONL log), and MCP Tools (cross-thread messaging).

## Quick Start

```bash
git clone https://github.com/lucianHymer/borg.git
cd borg
npm install && npm run build

./borg.sh start
```

### Initial Setup

Before running `./borg.sh start`, you need to configure Borg:

**Recommended**: Use the interactive setup skill in Claude Code:
- Open Claude Code in this repo
- Say "run the setup wizard" or "help me set up borg"
- The skill will validate configuration, auto-generate secrets, and guide you through missing steps

**Manual setup**: Copy `.env.example` to `.env` and fill in required values. See `.env.example` for detailed comments.

**⚠️ CRITICAL**: The `BROKER_SECRET` in `.env` is **immutable** once dev containers are created. Generate it once with `openssl rand -hex 32` and never change it. Changing it requires regenerating ALL dev container credentials.

### Telegram Setup

1. Create a Telegram group and enable **Topics** in settings (makes it a "forum")
2. Add your bot (from [@BotFather](https://t.me/BotFather)) and make it an admin
3. The "General" topic becomes the Master thread
4. Create topics for each repo and use `/setdir <path>` to assign working directories

### Docker

```bash
# Build and start all services (bot, broker, dashboard)
./borg.sh build && ./borg.sh start

# Or install as a systemd service
./borg.sh install
```

The Docker stack includes the bot, credential broker, and dashboard as separate containers with proper health checks and resource limits.

## CLI

```bash
./borg.sh start|stop|restart|status
./borg.sh send "Run the test suite"   # Send a message from CLI
./borg.sh model [haiku|sonnet|opus]    # Show or switch model
./borg.sh logs [telegram|queue|heartbeat]
./borg.sh attach                       # Attach to tmux session
```

**Telegram commands**: `/reset` (fresh session), `/setdir <path>` (set working directory), `/status` (thread info)

## Credits

- **[TinyClaw](https://github.com/lucianHymer/tinyclaw)** (original) by **Jian** -- the file-based queue architecture
- **[ClawRouter](https://github.com/BlockRunAI/ClawRouter)** by **BlockRunAI** -- 14-dimension routing engine (MIT)
- **[OpenClaw](https://openclaw.ai/)** by **Peter Steinberger** -- always-on agent and heartbeat patterns
- **[Claude Code](https://claude.com/claude-code)** / **[Anthropic Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)** -- the AI engine
- **[grammY](https://grammy.dev/)** -- Telegram bot framework

## License

MIT
