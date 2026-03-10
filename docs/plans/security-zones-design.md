# Security Zones Design Document

**Status:** Final draft — awaiting approval
**Date:** 2026-03-10
**Issue:** #49
**Thread:** zones-planner (1579)

## 1. Problem Statement

All Borg threads run in a single container with full permissions. A socially-engineered agent (e.g. one reading Twitter/Reddit) could trick other agents into leaking secrets, accessing repos, or doing damage. We need container-level isolation between trusted and untrusted agents.

## 2. Architecture

### 2.1 Three Containers

| Container | Contents | Trust Level |
|-----------|----------|-------------|
| **infra** | telegram-client + queue-processor (no agent sessions, no SDK, pure deterministic routing) | Highest — routes everything |
| **core** | Agent SDK sessions for trusted threads | High — repos, trading, writing |
| **perimeter** | Agent SDK sessions for untrusted threads | Low — social media, web-facing |

**Why infra is separate:** Zone containers need full freedom — sudo, read all messages in their zone, full filesystem access within their zone. If routing code runs inside a zone container, that container sees raw unrouted messages from ALL zones before approval has happened. Infra must be a separate container so it's the only thing that sees cross-zone traffic before approval.

**Infra is dumb plumbing.** Not a repo, not a thinking participant, not messageable. It runs:
- Queue processor (Node.js routing code, no SDK, no agents)
- Telegram client (grammY bot, no SDK)

Pure deterministic code. No knowledge accumulation, no learning. Zone enforcement is mechanical: check zone-config.json, route or hold.

### 2.2 Zone Configuration

`zone-config.json` — owned by infra, read-only to zone containers. Agents see their zone in their system prompt but cannot change it. Human-editable via dashboard or direct file edit.

```json
{
  "zones": {
    "core": { "threads": [1, 43, 58, 675, 676, 677, 1146] },
    "perimeter": { "threads": [] }
  },
  "defaults": {
    "newThread": "perimeter"
  }
}
```

### 2.3 Cross-Zone Messaging

`send_message` feels identical to agents — they don't need to know about zones. The routing layer handles it:

- **Same-zone** → direct queue write (like today)
- **Cross-zone** → message held in pending queue, Telegram inline keyboard shown to human (Approve / Reject), delivered on approve

Agents can see ALL threads via `list_threads` regardless of zone. The whole point is agents should proactively message each other cross-zone — they just need human approval to do so.

### 2.4 Per-Zone Storage

Each zone gets its own `.borg-{zone}/` directory:

```
.borg-core/
  ├── queue/incoming/
  ├── queue/outgoing/
  ├── queue/processing/
  ├── queue/dead-letter/
  ├── queue/commands/
  ├── message-history.jsonl
  ├── sessions/
  ├── status/
  ├── audio/
  └── images/

.borg-perimeter/
  └── (same structure)

.borg-infra/
  ├── threads.json          # infra-owned, zones read-only
  ├── zone-config.json      # infra-owned, zones read-only
  ├── queue/pending/        # cross-zone messages awaiting approval
  ├── message-models.json   # routing metadata
  └── logs/routing.jsonl    # routing decisions
```

**Key principle:** Each zone container mounts ONLY its own `.borg-{zone}/` directory read-write, plus `.borg-infra/threads.json` and `.borg-infra/zone-config.json` read-only. Infra mounts everything.

### 2.5 Broadcast Handling

**Broadcasts are core-only** for both sending and receiving:

- **Receiving:** Only `mainThread: true` threads in the core zone receive broadcast fan-outs. Perimeter threads don't need cross-repo knowledge to do their jobs. Keeping them ignorant of repo internals limits what an attacker can extract.
- **Sending:** The `broadcast` MCP tool is only available to core threads. Perimeter threads don't have it.
- **Perimeter wants to broadcast?** Option C — message a core thread (cross-zone approval), core agent decides whether to broadcast. Two layers of review for the highest-risk operation.

## 3. Detailed Design

### 3.1 MCP Tool Access by Zone

| Tool | Core | Perimeter | Notes |
|------|------|-----------|-------|
| `send_message` | ✅ | ✅ | Cross-zone triggers approval |
| `list_threads` | ✅ (all zones) | ✅ (all zones) | Shows zone labels so agents know context |
| `query_knowledge_base` | ✅ | ❌ | Reads master thread's knowledge — core-only |
| `create_thread` | ✅ (core zone) | ✅ (perimeter zone) | New threads inherit creator's zone |
| `configure_thread` | Same-zone only | Same-zone only | Can't modify cross-zone threads |
| `delete_thread` | Same-zone only | Same-zone only | Can't delete cross-zone threads |
| `get_container_stats` | ✅ | ❌ | Infrastructure visibility |
| `get_host_memory` | ✅ | ❌ | |
| `get_system_status` | ✅ | ❌ | |
| `get_current_time` | ✅ | ✅ | Harmless utility |
| `get_elapsed_time` | ✅ | ✅ | Harmless utility |
| `create_dev_container` | Master only | ❌ | |
| `broadcast` | ✅ | ❌ | Perimeter uses Option C (ask core to broadcast) |

**Implementation:** `createBorgMcpServer(sourceThreadId)` already takes a thread ID. Add zone lookup and filter tools based on zone. `list_threads` includes a `zone` field in output.

### 3.2 Thread Lifecycle

**Creation:** `create_thread` assigns new thread to creator's zone. Perimeter agent creating a thread gets a perimeter thread. Entry added to both `threads.json` and `zone-config.json`.

**Deletion:** `delete_thread` removes from both files. Same-zone only.

**Zone migration:** Manual operation (human edits zone-config.json or uses dashboard). Requires session reset since system prompt changes. Intentionally hard — zone changes should be rare and deliberate.

### 3.3 The `threads.json` Ownership Question

Currently agents can write `threads.json` via MCP tools (saveThreads). A compromised agent could:
- Change its own `cwd` to a sensitive directory
- Change another thread's `sessionId` to hijack its session
- Set `mainThread: true` to receive broadcasts

**Solution:** `threads.json` lives in `.borg-infra/`, mounted read-only to zone containers. MCP tools that modify thread state (configure_thread, create_thread, delete_thread) write to a request queue in the zone's directory; infra processes and applies validated changes.

### 3.4 Credential Isolation

| Credential | Core | Perimeter | Infra |
|------------|------|-----------|-------|
| Telegram bot token | ❌ | ❌ | ✅ |
| GitHub installations.json | ✅ | ✅ (branch protection prevents push to main) | ❌ |
| Claude credentials | ✅ | ✅ | ❌ |
| SSH keys | ✅ | ❌ | ❌ |
| Docker proxy | ✅ | ❌ | ❌ |

### 3.5 Heartbeat

- **Core container** runs heartbeats for core threads
- **Perimeter container** runs heartbeats for perimeter threads (if any need them)
- **Infra** does NOT run heartbeats (no agent sessions)

### 3.6 Message History Isolation

- Each zone has its own `message-history.jsonl` — agents `grep` their zone's log only
- Cross-zone messages (after approval): logged in BOTH zone histories (sender's outgoing + recipient's incoming)
- Infra mounts both read-only for routing decisions

### 3.7 Session Management Decomposition

Current `session-manager.ts` mixes infrastructure and agent knowledge. Split into:

1. **`thread-config.ts`** — ThreadConfig type, load/save threads.json, zone-config.json loader
2. **`system-prompts.ts`** — System prompt building, teammate resolution (agent knowledge)
3. **`session-lifecycle.ts`** — Session create/resume/sync (infrastructure)

This reduces coupling and makes the container split cleaner.

### 3.8 Dashboard

- Mounts `.borg-core:ro`, `.borg-perimeter:ro`, `.borg-infra:ro`
- Shows zone labels on threads
- Zone filter in UI
- Zone-config.json editor (human zone management)
- Cross-zone pending approvals visible in dashboard

### 3.9 Docker Compose Layout

```yaml
services:
  infra:
    # telegram-client + queue-processor
    volumes:
      - .borg-infra:/app/.borg-infra
      - .borg-core:/app/.borg-core        # read-write (routes messages)
      - .borg-perimeter:/app/.borg-perimeter  # read-write (routes messages)
    networks: [internal]

  core:
    # Agent SDK sessions for core threads
    volumes:
      - .borg-core:/app/.borg              # read-write (own zone)
      - .borg-infra/threads.json:/app/.borg-infra/threads.json:ro
      - .borg-infra/zone-config.json:/app/.borg-infra/zone-config.json:ro
      - ${WORKSPACE_ROOT}:${WORKSPACE_ROOT}
      - ./secrets/github-installations.json:/secrets/github-installations.json:ro
      - ${CLAUDE_CREDENTIALS}:/home/node/.claude/.credentials.json
      - ./skills/global:/home/node/.claude/skills:ro
    networks: [internal]

  perimeter:
    # Agent SDK sessions for perimeter threads
    volumes:
      - .borg-perimeter:/app/.borg         # read-write (own zone)
      - .borg-infra/threads.json:/app/.borg-infra/threads.json:ro
      - .borg-infra/zone-config.json:/app/.borg-infra/zone-config.json:ro
      - ${WORKSPACE_ROOT}:${WORKSPACE_ROOT}
      - ./secrets/github-installations.json:/secrets/github-installations.json:ro
      - ${CLAUDE_CREDENTIALS}:/home/node/.claude/.credentials.json
      # NO SSH keys, NO docker proxy
    networks: [internal]
```

**Note:** Core and perimeter both mount their zone storage at `/app/.borg` so existing code paths work unchanged. They just can't see the other zone's data.

## 4. Resolved Questions

1. **Perimeter has GitHub access.** GitHub App installations already prevent pushing to main/production branches. Safe for perimeter.
2. **Dev teams won't span zones** in practice — not worth building enforcement for.
3. **Planned perimeter threads:** Twitter agent (reads/learns from Twitter). This is the motivating use case — external social media input that could be used for social engineering.

## 5. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Session manager split introduces bugs | Medium | High | Extensive testing, validate before deploy |
| threads.json write from agents bypasses zones | High (if not addressed) | Critical | Move to infra-owned, MCP-mediated access |
| Cross-zone approval UX is annoying | Medium | Medium | Start with few perimeter threads, tune later |
| Three containers increase memory usage | Low | Medium | Core+perimeter share base image, SDK sessions are the real cost |

## 6. Implementation Tasks

All done in a single phase — containers, storage, and routing land together.

1. Create `zone-config.json` schema and loader (`zone-config.ts`)
2. Add zone label to agent system prompts
3. `list_threads` shows all zones with zone labels
4. Implement cross-zone `send_message` hold + Telegram inline keyboard approval
5. Filter MCP tools by zone (restrict perimeter access per table above)
6. Enforce broadcast delivery to core-zone `mainThread` threads only
7. Split session-manager.ts into thread-config, system-prompts, session-lifecycle
8. Per-zone storage directories (`.borg-core/`, `.borg-perimeter/`, `.borg-infra/`)
9. Move threads.json to infra-owned `.borg-infra/`
10. Create Dockerfile.infra, Dockerfile.core, Dockerfile.perimeter
11. Update docker-compose.yml with three containers + volume mounts
12. Credential isolation per container
13. Add zone column + filter to dashboard
14. Write tests for zone-aware routing, MCP filtering, cross-zone approval

## 7. Acceptance Criteria

- [ ] Three containers running: infra, core, perimeter
- [ ] Perimeter agent cannot read core's message history
- [ ] Perimeter agent can list all threads (with zone labels) but not access core data
- [ ] Cross-zone `send_message` requires human approval via Telegram inline keyboard
- [ ] Same-zone `send_message` works as today (no approval)
- [ ] Zone assignment cannot be changed by agents
- [ ] New threads inherit creator's zone (default: perimeter)
- [ ] Broadcasts only reach core `mainThread` threads
- [ ] Perimeter doesn't have broadcast MCP tool
- [ ] threads.json is infra-owned, read-only to zones
- [ ] Dashboard shows zone labels and supports zone filtering
- [ ] Credential isolation enforced (no SSH/GitHub/docker-proxy in perimeter)
- [ ] All existing single-zone functionality works unchanged (backward compatible)
