# Heartbeat Maintenance

How to manage HEARTBEAT.md files for Borg threads.

## Structure

HEARTBEAT.md has these sections:

### Quick Tasks
Fast checks (< 10 seconds) — git status, file existence, flag checks.
Runs every heartbeat cycle (~8 min).

### Hourly Tasks
Moderate checks — git fetch, CI status, upstream changes.
Runs once per hour.

### Daily Tasks
Thorough checks — PR reviews, stale branch cleanup, daily summaries.
Runs once per day.

### Timed Tasks
Tasks with specific time annotations. Format: `@HH:MM` before the task.
Multiple times per task are supported.

Example:
```
## Timed Tasks
- @06:00 @17:30 — Send standup summary to general
- @09:00 — Check overnight alerts
```

Timed tasks fire on the first heartbeat run after their scheduled time.
Times are in the bot's configured timezone.

### Urgent Flags
Anything needing immediate human attention.

### Notes
Scratch space for context between heartbeats.

## Guidelines
- Add tasks relevant to your repo
- Remove irrelevant tasks
- Put tasks in the right tier
- Keep it concise — this file is read every heartbeat cycle
