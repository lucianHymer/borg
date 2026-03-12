# Budget mode (Minimax proxy) implementation

Budget mode routes SDK queries through a Minimax proxy (scripts/minimax-proxy.ts) instead of direct Anthropic API. Key components:
- `isBudgetMode()` in session-manager.ts checks settings for budget_mode enabled
- `BUDGET_PROXY_URL` points to the proxy container
- Usage tracking: queue-processor creates .pending file before query, proxy writes .json with usage data after response
- Proxy correlation: Uses MINIMAX_USAGE_ID env var (preferred) or falls back to directory scanning first pending file
- Retry logic: readBudgetUsage() has exponential backoff (50ms, 100ms, 200ms) for timing edge cases
- Health check: checkProxyAvailable() verifies proxy is reachable before using it
- Graceful fallback: On connection errors (ECONNREFUSED, timeout), resets proxy state and retries with direct API
- Settings: Shared via /app/settings.json across zones (infra writes, core/perimeter reads)
- Cache invalidation: statusInterval checks settings mtime every 2s to detect /budget_on changes

**Related files:** scripts/minimax-proxy.ts, src/queue-processor.ts, src/session-manager.ts, src/telegram-client.ts