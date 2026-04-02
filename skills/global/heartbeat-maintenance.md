---
name: heartbeat-maintenance
description: Managing HEARTBEAT.md task lists for Borg threads. Use when adding, removing, or organizing heartbeat tasks across quick, hourly, daily, and timed tiers.
---

# Heartbeat Maintenance

## Structure

HEARTBEAT.md has these sections:

### Quick Tasks
Fast checks (< 10 seconds) — correlate git status with GitHub PR status, verify local commits have PRs or are pushed, file existence, flag checks.
Runs every heartbeat cycle (~8 min).
Always synthesize GitHub remote state with local git state to understand the full picture.

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
