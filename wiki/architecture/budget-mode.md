# Budget Mode

Routes SDK queries through a Minimax proxy instead of direct Anthropic API.

## Components

- `isBudgetMode()` in session-manager.ts checks settings for `budget_mode` enabled
- `BUDGET_PROXY_URL` points to proxy container
- Proxy: `scripts/minimax-proxy.ts`

## Usage Tracking

1. queue-processor creates `.pending` file before query
2. Proxy writes `.json` with usage data after response
3. Correlation: uses `MINIMAX_USAGE_ID` env var (preferred) or falls back to directory scan of first pending file
4. `readBudgetUsage()` has exponential backoff (50ms, 100ms, 200ms) for timing edge cases

## Resilience

- Health check: `checkProxyAvailable()` verifies proxy before use
- Graceful fallback: on connection errors (ECONNREFUSED, timeout), resets proxy state and retries with direct API
- Settings shared via `/app/settings.json` across all zones (infra writes, agent zones read)
- Cache invalidation: `statusInterval` checks settings mtime every 2s to detect `/budget_on` changes

See: `scripts/minimax-proxy.ts`, `src/queue-processor.ts`, `src/session-manager.ts`, `src/telegram-client.ts`
