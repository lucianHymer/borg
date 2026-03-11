# Security Zones Design Document

**Status:** Final draft — awaiting approval
**Date:** 2026-03-10
**Issue:** #49
**Thread:** zones-planner (1579)

## 1. Problem Statement

All Borg threads run in a single container with full permissions. A socially-engineered agent (e.g. one reading Twitter) could trick other agents into leaking secrets, accessing repos, or doing damage. We need container-level isolation between trusted and untrusted agents.

## 2. Architecture

### 2.1 Three Containers

| Container | Contents | Trust Level |
|-----------|----------|-------------|
| **infra** | telegram-client + queue-processor (no agent sessions, no SDK, pure deterministic routing) | Highest — routes everything |
| **core** | Agent SDK sessions for trusted threads | High — repos, trading, writing |
| **perimeter** | Agent SDK sessions for untrusted threads (e.g. Twitter agent) | Low — social media, web-facing |

**Why infra is separate:** Zone containers need full freedom — sudo, read all messages in their zone, full filesystem access. If routing code runs inside a zone container, that container sees raw unrouted messages from ALL zones before approval. Infra must be separate so it's the only thing that sees cross-zone traffic before approval.

**Infra is dumb plumbing.** Not a repo, not a thinking participant, not messageable. Pure deterministic code. No knowledge accumulation, no learning. Zone enforcement is mechanical: check zone-config.json, route or hold.

**Zones are invisible to agents.** Agents don't know about zones. They see all threads, send messages to any thread, and use the same MCP tools as today. The only difference is that cross-zone messages take longer because a human approves them. All zone enforcement happens in Docker (filesystem isolation) and infra (routing).

### 2.2 Zone Configuration

`zone-config.json` — used by infra's router to decide whether a message crosses zones. Human-editable via dashboard or direct file edit.

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

`send_message` feels identical to agents — they don't know about zones:

- **Same-zone** → direct queue write (like today)
- **Cross-zone** → message held in pending queue, Telegram inline keyboard shown to human (Approve / Reject), delivered on approve

Agents can see ALL threads via `list_threads` regardless of zone. The whole point is agents should proactively message each other — they just need human approval for cross-zone delivery.

### 2.4 Pending Approval Reminders

Infra runs a daily scan of `.borg-infra/queue/pending/`. Any unapproved cross-zone messages are summarized and posted to the master thread's Telegram topic. Each entry includes:
- Sender name/zone
- Target name/zone
- Message preview
- Age (time pending)
- **Telegram message link** to the original approval keyboard message

This makes it easy to click through and approve/reject, preventing approvals from getting lost in message history.

### 2.5 Per-Zone Storage

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
  ├── zone-config.json      # zone routing rules
  ├── queue/pending/        # cross-zone messages awaiting approval
  ├── message-models.json   # routing metadata
  └── logs/routing.jsonl    # routing decisions
```

**threads.json** stays as a single shared file, writable by all containers — same as today. Agents manage it via MCP tools (configure_thread, create_thread, delete_thread) exactly as before. No ownership change needed. Zone isolation comes from Docker filesystem boundaries, not from restricting threads.json access.

**Key principle:** Each zone container mounts its own `.borg-{zone}/` as `/app/.borg` so existing code paths work unchanged. Agents can't see the other zone's queue or message history because Docker doesn't mount it.

### 2.6 Broadcast Handling

**Broadcasts are core-only** for both sending and receiving:

- **Receiving:** Only `mainThread: true` threads in the core zone receive broadcast fan-outs. Infra enforces this by checking zone-config.json during fan-out.
- **Sending:** The `broadcast` MCP tool only exists in core's queue-processor. Perimeter's queue-processor doesn't register it.
- **Perimeter wants to broadcast?** Message a core thread (cross-zone approval), core agent decides whether to broadcast. Two layers of review.

## 3. Detailed Design

### 3.1 What Changes for Agents: Almost Nothing

Agents don't need to know about zones. The zone boundary is enforced by:
1. **Docker** — filesystem isolation (each zone only sees its own `.borg-{zone}/`)
2. **Infra router** — holds cross-zone messages for approval
3. **Infra broadcast handler** — filters fan-out to core-zone mainThread threads

Agents use the same MCP tools, same threads.json, same patterns. The only MCP difference: perimeter's queue-processor doesn't register `broadcast` (since the broadcast Telegram group credentials are only in infra, and infra only fans out to core).

### 3.2 How list_threads Works Cross-Zone

`list_threads` reads the shared `threads.json` (mounted in all containers). It returns ALL threads like today. No zone filtering needed. Agents see the full picture and can send messages to any thread.

### 3.3 How Cross-Zone Routing Works

When infra receives an outgoing `send_message` from a zone container:

1. Look up sender's zone and target's zone in zone-config.json
2. **Same zone?** → Write to target zone's `queue/incoming/` (direct delivery, like today)
3. **Cross zone?** → Write to `.borg-infra/queue/pending/` + show Telegram inline keyboard (Approve / Reject) with sender info and message preview
4. **On approve** → Move from pending to target zone's `queue/incoming/`
5. **On reject** → Notify sender (write to sender zone's `queue/incoming/` with rejection notice)

### 3.4 Thread Lifecycle

**Creation:** `create_thread` works like today (MCP tool creates Telegram topic, adds to threads.json). Infra adds the new thread to zone-config.json in the creator's zone (determined by which zone container the MCP call came from).

**Deletion:** `delete_thread` works like today. Infra removes from zone-config.json.

**Zone migration:** Manual operation (human edits zone-config.json via dashboard). Session reset recommended since the agent moves to a different container.

### 3.5 Credential Isolation

| Credential | Core | Perimeter | Infra |
|------------|------|-----------|-------|
| Telegram bot token | ❌ | ❌ | ✅ |
| GitHub installations.json | ✅ | ✅ (branch protection prevents push to main) | ❌ |
| Claude credentials | ✅ | ✅ | ❌ |
| SSH keys | ✅ | ❌ | ❌ |
| Docker proxy | ✅ | ❌ | ❌ |

### 3.6 Heartbeat

- **Core container** runs heartbeats for core threads
- **Perimeter container** runs heartbeats for perimeter threads (if any need them)
- **Infra** does NOT run heartbeats (no agent sessions)

### 3.7 Message History Isolation

- Each zone has its own `message-history.jsonl` — agents grep their zone's log only
- Cross-zone messages (after approval): logged in BOTH zone histories (sender's outgoing + recipient's incoming)
- Infra writes to both zones' history files when delivering cross-zone messages

### 3.8 Dashboard

- Mounts `.borg-core:ro`, `.borg-perimeter:ro`, `.borg-infra:ro`
- Shows zone labels on threads
- Zone filter in UI
- zone-config.json editor (human zone management)
- Pending cross-zone approvals visible

### 3.9 Docker Compose Layout

```yaml
services:
  infra:
    # telegram-client + queue-processor (routing only, no SDK)
    volumes:
      - .borg-infra:/app/.borg-infra
      - .borg-core:/app/.borg-core        # read-write (routes messages)
      - .borg-perimeter:/app/.borg-perimeter  # read-write (routes messages)
      - ./threads.json:/app/threads.json   # shared, read-write
    networks: [internal]

  core:
    # Agent SDK sessions for core threads
    volumes:
      - .borg-core:/app/.borg              # read-write (own zone)
      - ./threads.json:/app/threads.json   # shared, read-write
      - .borg-infra/zone-config.json:/app/zone-config.json:ro
      - ${WORKSPACE_ROOT}:${WORKSPACE_ROOT}
      - ./secrets/github-installations.json:/secrets/github-installations.json:ro
      - ${CLAUDE_CREDENTIALS}:/home/node/.claude/.credentials.json
      - ./skills/global:/home/node/.claude/skills:ro
    networks: [internal]

  perimeter:
    # Agent SDK sessions for perimeter threads
    volumes:
      - .borg-perimeter:/app/.borg         # read-write (own zone)
      - ./threads.json:/app/threads.json   # shared, read-write
      - .borg-infra/zone-config.json:/app/zone-config.json:ro
      - ${WORKSPACE_ROOT}:${WORKSPACE_ROOT}
      - ./secrets/github-installations.json:/secrets/github-installations.json:ro
      - ${CLAUDE_CREDENTIALS}:/home/node/.claude/.credentials.json
      # NO SSH keys, NO docker proxy
    networks: [internal]
```

**threads.json is a single host file bind-mounted into all 3 containers.** All containers read/write the same inode on the host. The existing atomic write pattern (tmp+rename) prevents partial reads. This is the same concurrency model used today (telegram-client and queue-processor already share threads.json in the current single container).

**Note:** Core and perimeter both mount their zone storage at `/app/.borg` so existing code paths work unchanged.

## 4. Resolved Questions

1. **Perimeter has GitHub access.** Branch protection prevents push to main/production. Safe.
2. **Dev teams won't span zones** in practice — no enforcement needed.
3. **Planned perimeter threads:** Twitter agent (reads/learns from Twitter).
4. **threads.json stays shared and writable.** No ownership change. Zone isolation is Docker-level, not file-level.
5. **Agents don't know about zones.** No zone labels in prompts, no MCP tool filtering (except broadcast). Zones are infrastructure-only.

## 5. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Cross-zone approval UX is annoying | Medium | Medium | Start with few perimeter threads, tune later |
| Pending approvals get lost | Medium | Medium | Daily infra reminder to master thread |
| Three containers increase memory | Low | Medium | Core+perimeter share base image, SDK sessions are the real cost |
| threads.json concurrent writes from 3 containers | Low | Low | Atomic tmp+rename already handles this |

## 6. Implementation Tasks

All done in a single phase — containers, storage, and routing land together.

1. Create `zone-config.json` schema and loader
2. Cross-zone `send_message` hold + Telegram inline keyboard approval in infra
3. Pending approval daily reminder to master thread (with Telegram message links for easy access)
4. Broadcast fan-out filtered to core-zone `mainThread` threads
5. Broadcast MCP tool only registered in core's queue-processor
6. Per-zone storage directories (`.borg-core/`, `.borg-perimeter/`, `.borg-infra/`)
7. Dockerfiles for infra, core, perimeter
8. docker-compose.yml with three containers + volume mounts + credential isolation
9. Dashboard zone labels, filter, zone-config editor
10. Tests for cross-zone routing, approval flow, broadcast filtering

## 7. Acceptance Criteria

- [ ] Three containers running: infra, core, perimeter
- [ ] Perimeter agent cannot read core's message history (Docker isolation)
- [ ] Agents can list all threads and send messages to any thread
- [ ] Cross-zone `send_message` requires human approval via Telegram inline keyboard
- [ ] Same-zone `send_message` works as today (no approval)
- [ ] Daily reminder of pending cross-zone approvals sent to master thread
- [ ] New threads inherit creator's zone (default: perimeter)
- [ ] Broadcasts only reach core `mainThread` threads
- [ ] Broadcast MCP tool not available in perimeter
- [ ] threads.json shared and writable by all containers
- [ ] Dashboard shows zone labels and supports zone filtering
- [ ] Credential isolation enforced (no SSH/docker-proxy in perimeter)
- [ ] All existing functionality works unchanged (backward compatible)
