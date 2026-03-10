# Scheduled Opus Tasks

Schedule a message to be sent to any thread at a specific time, forcing opus-level processing via the `[use opus]` prefix.

## When to Use

When the user says things like:
- "Schedule an opus task for thread X at 3am"
- "Send an opus message to the trading thread at midnight"
- "Schedule a check-in with thread 1146 tomorrow morning"
- "Have thread X do Y at Z time using opus"

## How It Works

1. **Create a cron job** that writes a cross-thread message to the target thread at the scheduled time
2. The message includes `[use opus]` prefix so the router upgrades to opus regardless of content complexity
3. The target thread's session processes it like any other incoming message — but with opus

## Implementation

Use `CronCreate` to schedule a one-shot or recurring task that sends a message via the `send_message` MCP tool (or writes directly to the outgoing queue).

The cron command should write a JSON file to `/app/.borg/queue/incoming/` with:
```json
{
  "threadId": <TARGET_THREAD_ID>,
  "message": "[use opus] <the actual task/instruction>",
  "source": "system",
  "timestamp": <epoch_ms>
}
```

Example cron command:
```bash
echo '{"threadId":1146,"message":"[use opus] Check portfolio status, review overnight trades, and report any issues.","source":"system","timestamp":'$(date +%s%3N)'}' > /app/.borg/queue/incoming/scheduled_$(date +%s%3N).json
```

## Key Details

- `[use opus]` in the message text triggers the router override — no code changes needed
- The target thread must exist in threads.json
- One-shot tasks: use `at`-style scheduling or a cron that removes itself
- Recurring tasks: use standard cron expressions
- The source thread doesn't need to be running — the queue system handles delivery
- Messages appear in the target thread's Telegram topic with the opus 🔥 reaction

## Examples

**"Schedule an opus check-in with the trading thread at 3am":**
```
CronCreate: 0 3 * * * — write queue message to thread 1146 with [use opus] prefix
```

**"Have the trading bot review positions every 6 hours with opus":**
```
CronCreate: 0 */6 * * * — write queue message with [use opus] and review instructions
```

**"Send an opus message to thread 58 right now":**
Just use `send_message` MCP tool directly with `[use opus]` in the message text. No scheduling needed.
