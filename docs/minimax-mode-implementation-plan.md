# Budget Mode Implementation Plan (formerly "Minimax Mode")

## Background

Tested and verified: SDK + proxy integration works. The proxy captures usage from Fireworks/Minimax API and writes to `.borg/minimax-usage.json`.

**Pricing:** $0.30/M input, $0.03/M cached, $1.20/M output (cheapest tier is $3.75/M output, minimax is ~3x cheaper)

## Key Decisions

- **Naming**: "Budget mode" instead of "minimax" - generic so we can swap in different cheap models later
- **Model mapping**: All tiers (haiku/sonnet/opus) → minimax model (no tier-based routing, single model)
- **Per-zone**: Each zone (core, perimeter) runs its own proxy sidecar, not a shared service
- **Emoji**: 💰 for budget mode indicator
- **Commands**: `/budget_on`, `/budget_off` to toggle

## Confirmed Implementation Details

- **Correlation ID required**: Usage file cannot use "read last entry" - multiple queries run in parallel. Each query creates `.borg/minimax-usage-{uuid}.pending`, proxy writes to `.borg/minimax-usage-{uuid}.json`, queue-processor reads specific file after query completes.
- **Usage flow**: Proxy captures usage → queue-processor reads correlation file → merges into appendHistory → flows to message-history.jsonl → dashboard displays (model already labeled per message)

## Architecture

### How It Works

1. **Proxy sidecar** - Run `minimax-proxy.ts` as a sidecar in each zone container (not separate Docker service)
2. **Env injection** - When `budgetMode: true`, set `ANTHROPIC_BASE_URL=http://localhost:9999` for SDK calls
3. **Usage capture** - Use correlation ID pattern:
   - Before query: create `.borg/minimax-usage-{uuid}.pending` with UUID
   - Proxy reads pending files, uses UUID as request ID, writes to `.borg/minimax-usage-{uuid}.json`
   - After query returns: read specific file, convert to QueryUsageData, pass to appendHistory()

### Files Modified

| File | Change |
|------|--------|
| `src/types.ts` | Add `budgetMode?: boolean` to Settings interface |
| `src/session-manager.ts` | Add BUDGET_MODEL constant, read budgetMode from settings |
| `src/queue-processor.ts` | Model routing when budgetMode, correlation ID file handling, usage merge |
| `src/telegram-client.ts` | Add `budget: "💰"` to MODEL_REACTIONS |
| `docker-compose.yml` | Add proxy to zone container entrypoint |
| `.env.minimax-fireworks` | Keep for local testing |
| `scripts/minimax-proxy.ts` | Update to support correlation ID pattern |

## Implementation Steps

### Step 1: Update proxy to support correlation IDs

Modify `scripts/minimax-proxy.ts`:
- Scan for `.pending` files in usage directory
- Use UUID from pending filename as request ID
- Write usage to `.borg/minimax-usage-{uuid}.json` (not JSONL)
- Clean up pending file after writing

### Step 2: Update types and settings

- Add `budgetMode?: boolean` to Settings in types.ts (rename from minimaxMode)

### Step 3: Model routing in queue-processor

When `budgetMode: true` (from env var or settings):
- Always return BUDGET_MODEL (`accounts/fireworks/models/minimax-m2p5`)
- Set `ANTHROPIC_BASE_URL=http://localhost:9999`
- Generate UUID before query, create pending file
- After query completes, read corresponding usage file
- Convert to QueryUsageData and pass to appendHistory()

### Step 4: Docker integration

The proxy runs as a sidecar in each zone via entrypoint.sh - always running (lightweight), used only when `budgetMode=true` in settings.json.

### Step 5: Telegram commands

Add `/budget_on` and `/budget_off` commands in telegram-client.ts:
- Write to settings.json, set budgetMode: true/false
- Requires restart or signal to queue-processor to pick up new setting

### Step 6: UI updates

- Add emoji "💰" for budget model in MODEL_REACTIONS

## Toggle Mechanism

Three ways to enable:
1. **Env var**: `BUDGET_MODE=1` in docker-compose environment
2. **Settings**: `budgetMode: true` in .borg/settings.json
3. **Telegram**: `/budget_on`, `/budget_off` commands

Environment variable takes precedence (checked first in queue-processor).

## Cleanup (after implementation)

Delete:
- This plan file (after implementation complete)