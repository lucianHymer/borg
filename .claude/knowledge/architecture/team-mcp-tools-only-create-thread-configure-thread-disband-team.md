# Team MCP tools: create_thread, configure_thread, disband_team, delete_thread

The collaborative agent teams feature has 4 team-related MCP tools:

1. **create_thread** — Creates Telegram forum topic via direct HTTP API + registers in threads.json
2. **configure_thread** — Updates team/role metadata
3. **disband_team** — Removes team association from all threads (soft cleanup, keeps topics)
4. **delete_thread** — Permanently deletes Telegram forum topic + unregisters from threads.json (hard cleanup, makes topics ephemeral)

No clear_team or compact_thread MCP tools — those operations are handled by the /clear_team and /compact_team Telegram commands which queue simple messages. All team MCP tools are available to ALL threads (not master-only). Both create_thread and delete_thread use direct Telegram HTTP API (POST to api.telegram.org/bot<token>/{createForumTopic,deleteForumTopic}) because MCP tools run in queue-processor process while the bot instance lives in telegram-client process (separate processes).

**Related files:** src/mcp-tools.ts, src/session-manager.ts