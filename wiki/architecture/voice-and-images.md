# Voice and Images

Bidirectional voice messaging and image support.

## Voice (TTS/STT)

Speaches container (Kokoro-82M TTS + faster-whisper STT) exposed as OpenAI-compatible HTTP API.

- **STT:** telegram-client downloads OGG, queue-processor transcribes via Speaches before routing to Claude
- **TTS:** telegram-client handles "Listen" inline button callbacks -- distills text, synthesizes via Speaches, sends voice reply
- **Audio files:** `.borg/audio/` (outgoing TTS), `.borg/audio/incoming/` (downloaded voice messages), cleaned up after use with periodic sweep as backup

### Distill Functions

Both use agent SDK `query()` with **short model aliases** (e.g. "sonnet") -- never fully-qualified model IDs like "claude-sonnet-4-6".

- **distillForSpeech:** uses "sonnet", converts responses to spoken form. Input capped at 4096 chars.
- **distillForReading:** uses "sonnet", summarizes voice transcripts in 2-3 sentences. Input capped at 2048 chars.

Both fall back to truncation on SDK error.

### TTS Config

In `.borg/settings.json`: `tts_voice` (default "bf_alice"), `tts_speed` (default 1.0). Docker compose `KOKORO__VOICES` env var must include any voices you want available.

### Speaches Queuing

The Speaches container handles request queuing internally. No application-level concurrency limiting needed.

## Images

Photo messages downloaded to disk; Claude uses the Read tool to view them (Read tool supports images natively).

### Flow

1. telegram-client downloads largest photo size to `.borg/images/incoming/` (atomic: tmp+rename)
2. Queue message includes `imagePath` and optional caption
3. queue-processor validates imagePath is within allowed directory, builds instruction: `[Image received: /path]\nPlease analyze this image using the Read tool.`
4. Claude receives instruction, uses Read tool

### Constraints

- **Size limit:** 5MB (Claude Read tool limit). Telegram allows 20MB but we reject >5MB with user feedback.
- **Dedup:** Uses Telegram's `file_unique_id` with `photo_` prefix (same pattern as voice with `voice_` prefix)
- **Cleanup:** No per-message cleanup. `startPeriodicCleanup()` sweeps every 15 minutes, removes files older than 48 hours.
- **Caption:** Included as `Caption: {text}` after the Read tool instruction if present.

See: `src/audio.ts`, `src/images.ts`, `src/telegram-client.ts`, `src/queue-processor.ts`, `docker-compose.yml`
