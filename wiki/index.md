# Borg Wiki

Telegram forum-based multi-session Claude agent with SDK v2, sticky model selection, and cross-thread orchestration.

## Architecture

- [Core Pipeline](architecture/core-pipeline.md) — telegram-client vs queue-processor responsibilities, message coalescing, edit/delete queued messages, preview truncation
- [Cross-Thread Messaging](architecture/cross-thread-messaging.md) — send_message flow, pending message registration, _tg suffix convention, narrating-is-not-sending gotcha
- [Security Zones](architecture/security-zones.md) — container-level isolation (core/perimeter/infra), cross-zone approval, zone-config.json
- [Model Selection](architecture/model-selection.md) — sticky per-thread model, usage extraction from SDK results, usage in message-history.jsonl, emoji reactions
- [Teams and Workflows](architecture/teams-and-workflows.md) — MCP tools for teams, three-layer workflow abstraction, skills directory structure
- [Voice and Images](architecture/voice-and-images.md) — TTS/STT via Speaches, image download+Read pattern, distill functions, TTS config
- [Webhooks](architecture/webhooks.md) — HTTP endpoint, HMAC validation, formatters, ignoreSenders, bearer token CRUD
- [Broadcast](architecture/broadcast.md) — cross-repo knowledge sharing via shared Telegram group
- [Cancel and Stall Detection](architecture/cancel-and-stall.md) — cancel signal files, absolute-time stall detection
- [Budget Mode](architecture/budget-mode.md) — Minimax proxy routing, usage tracking, graceful fallback

## Development

- [Message History](development/message-history.md) — dedup by messageId, direction check gotcha, suffix normalization, timestamp fallback
- [Telegram Formatting](development/telegram-formatting.md) — MarkdownV2 conversion, plain text fallback, cross-thread indicators
- [Telegram API Notes](development/telegram-api-notes.md) — reaction API, grammY event handling, allowed_updates config
- [GitHub App Gotchas](development/github-app-gotchas.md) — app token cannot approve its own PRs
