# Team MCP tools: create_thread, configure_thread, disband_team, delete_thread + broadcast

The collaborative agent teams feature has 4 team-related MCP tools, plus 1 broadcast tool:

1. **create_thread** — Creates Telegram forum topic via direct HTTP API + registers in threads.json. Accepts `workflow` param (path to workflow skill file) — required for team threads so agents know which workflow to follow.
2. **configure_thread** — Updates team/role/workflow metadata
3. **disband_team** — Removes team association from all threads (soft cleanup, keeps topics)
4. **delete_thread** — Permanently deletes Telegram forum topic + unregisters from threads.json (hard cleanup, makes topics ephemeral)

5. **broadcast** — Posts structured message to broadcast Telegram group for cross-repo knowledge sharing. Uses direct Telegram HTTP API like create_thread/delete_thread.

No clear_team or compact_thread MCP tools — those operations are handled by the /clear_team and /compact_team Telegram commands which queue simple messages. All team MCP tools are available to ALL threads (not master-only). Both create_thread and delete_thread use direct Telegram HTTP API (POST to api.telegram.org/bot<token>/{createForumTopic,deleteForumTopic}) because MCP tools run in queue-processor process while the bot instance lives in telegram-client process (separate processes).

**Related files:** src/mcp-tools.ts, src/session-manager.ts