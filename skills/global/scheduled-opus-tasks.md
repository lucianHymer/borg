# Scheduled Opus Tasks

Schedule a message to be sent to any thread at a specific time, forcing opus-level processing via the `[use opus]` prefix.

## When to Use

When the user or another thread says things like:
- "Schedule an opus task for thread X at 3am"
- "Send an opus message to the trading thread at midnight"
- "Can you check in with me at 3am with opus?"
- "Have thread X do Y at Z time using opus"

## How It Works

The `[use opus]` prefix in any message triggers the router to upgrade to opus regardless of content complexity. This works on any message source — user, cross-thread, system, or heartbeat-triggered.

## The Pattern: Delegate to a Heartbeated Thread

Threads with heartbeats (main repo threads) already have a recurring ~8-minute check cycle with support for timed tasks via `@HH:MM` syntax in HEARTBEAT.md. This is the primary scheduling mechanism.

### If you ARE a heartbeated thread (main thread)

Add a timed task directly to your own HEARTBEAT.md:

```markdown
## Timed Tasks
- @03:00 — Send `[use opus] Check portfolio status and report issues` to thread 1146 via send_message
```

The heartbeat processor will fire this at the specified time. After execution, remove or update the entry.

### If you are NOT a heartbeated thread (team worker, etc.)

Ask a heartbeated thread to schedule it for you:

1. Use `send_message` to the main thread for your repo
2. Ask it to add a timed task to its HEARTBEAT.md
3. The timed task should use `send_message` back to YOUR thread with `[use opus]` prefix

Example message to send:
> "Can you add a @03:00 timed task to your HEARTBEAT.md to send me (thread 482) this message via send_message: `[use opus] Review overnight trades and iterate on the strategy`"

The main thread adds the entry, its heartbeat fires it at 3am, and your thread wakes up with an opus-routed message.

### Immediate (no scheduling needed)

Just use the `send_message` MCP tool directly with `[use opus]` in the message text:
> `[use opus] Do a deep review of the current portfolio allocation`

## Key Details

- `[use opus]` in the message text triggers the router override — no new tools needed
- The target thread must exist in threads.json
- HEARTBEAT.md `@HH:MM` tasks fire on the next heartbeat cycle after the specified time
- One-shot tasks: remove the timed entry from HEARTBEAT.md after execution
- Recurring tasks: keep the entry and let it fire each day
- This pattern is pure conversation + existing infrastructure — no scripts or cron jobs needed
