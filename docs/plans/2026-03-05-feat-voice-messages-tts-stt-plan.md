---
title: "feat: Add voice message support (TTS/STT)"
type: feat
status: active
date: 2026-03-05
---

# Voice Message Support (TTS & STT)

## Overview

Add bidirectional voice messaging to Borg: transcribe incoming voice messages (STT) and on-demand voice synthesis for any bot response (TTS). Uses a shared Speaches container (Kokoro-82M + faster-whisper) exposed via OpenAI-compatible HTTP API. Every bot response includes an inline "Listen" button — tap it to get a voice summary. Cross-thread, heartbeat, and system messages remain text-only.

## Problem Statement / Motivation

Borg currently only handles text messages. Users who are driving, walking, or otherwise hands-free can't interact naturally. Voice input is faster for many tasks, and voice output provides an ambient/hands-free consumption mode. The user already has this working in OpenClaw and wants feature parity in Borg.

## Proposed Solution

### Architecture

```
STT Path (incoming voice messages):

┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Telegram    │────▶│  telegram-   │────▶│  .borg/queue/   │
│  (voice msg) │     │  client.ts   │     │  incoming/      │
└─────────────┘     │  (download   │     │  (audioPath)    │
                    │   OGG file)  │     └────────┬────────┘
                    └──────────────┘              │
                                                  ▼
                    ┌──────────────┐     ┌─────────────────┐
                    │  Speaches    │◀────│  queue-         │
                    │  /v1/audio/  │     │  processor.ts   │
                    │  transcribe  │────▶│  (transcript →  │
                    └──────────────┘     │   SDK query)    │
                                        └─────────────────┘

TTS Path (on-demand via inline button):

┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  User taps   │────▶│  telegram-   │────▶│  Haiku API   │
│  "Listen"    │     │  client.ts   │     │  (distill    │
│  button      │     │  (callback   │     │   for speech) │
└─────────────┘     │   query)     │     └──────┬───────┘
                    └──────────────┘            │
                                                ▼
                    ┌──────────────┐     ┌──────────────┐
                    │  telegram-   │◀────│  Speaches    │
                    │  client.ts   │     │  /v1/audio/  │
                    │  (replyVoice │     │  speech      │
                    │   to own msg)│     └──────────────┘
                    └──────────────┘
```

### Key Decisions

1. **Speaches container** — Pre-built Docker image (`ghcr.io/speaches-ai/speaches:latest-cpu`) bundles both Kokoro TTS and faster-whisper STT with OpenAI-compatible API. No custom container needed.
2. **STT in queue-processor, not telegram-client** — telegram-client downloads the OGG and passes the file path via queue. queue-processor calls STT before routing. This keeps telegram-client lightweight and leverages existing retry/dead-letter infrastructure.
3. **TTS in queue-processor** — After the SDK generates a text response, queue-processor calls `/v1/audio/speech` to synthesize, then writes the OGG path to the OutgoingMessage. telegram-client just sends it.
4. **On-demand TTS via inline keyboard** — Every user-facing bot response includes a "Listen" inline button. Tapping it triggers Haiku distillation + Kokoro TTS, and the bot replies to its own message with a voice note. Zero wasted compute — voice is only generated when requested.
5. **Haiku speech distillation** — Full agent responses are distilled into brief spoken summaries via Haiku before TTS. The agent writes normally; the speech layer handles making it sound good. This avoids TTS'ing markdown, code blocks, and long technical text.
6. **Voice: `bf_emma`** — British female voice from Kokoro-82M.
7. **STT model: `distil-large-v3`** — English-only, 6x faster than large-v3, within 1% WER.
8. **Voice duration cap** — Reject incoming voice messages over 5 minutes with a polite error. Prevents 30+ minute CPU-bound transcription blocking a thread.
9. **Graceful degradation** — If Speaches container is unreachable, STT sends error to user ("Couldn't transcribe your voice message"), TTS shows toast via `answerCallbackQuery` with error text.

## Technical Approach

### Phase 1: Speaches Container (Docker Compose)

Add a `speaches` service to `docker-compose.yml`:

```yaml
# docker-compose.yml (new service)
speaches:
  image: ghcr.io/speaches-ai/speaches:latest-cpu
  ports:
    - "8000:8000"
  volumes:
    - speaches-cache:/home/ubuntu/.cache/huggingface/hub
  environment:
    - KOKORO__VOICES=bf_emma
  deploy:
    resources:
      limits:
        memory: 4G
  restart: unless-stopped
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
    interval: 30s
    timeout: 10s
    retries: 3
```

**Files:**
- `docker-compose.yml` — add speaches service + volume

**Acceptance criteria:**
- [ ] `docker compose up speaches` starts the container
- [ ] `curl http://speaches:8000/health` returns 200 from the bot container
- [ ] Models download on first request and persist in the volume

### Phase 2: Type Changes & Audio Infrastructure

Update message types and add audio file management.

**`src/types.ts`:**
```typescript
// Add to IncomingMessage
audioPath?: string;         // path to downloaded OGG file (voice messages)
voiceDuration?: number;     // duration in seconds

// Add to OutgoingMessage
audioPath?: string;         // path to synthesized OGG file for sendVoice
```

**New file `src/audio.ts`** — thin HTTP client for Speaches + file management:
```typescript
// Responsibilities:
// - transcribe(oggPath: string): Promise<string>        → POST /v1/audio/transcriptions
// - synthesize(text: string): Promise<string>            → POST /v1/audio/speech → returns OGG path
// - cleanupAudioFile(path: string): void                 → unlink after send
// - isAvailable(): Promise<boolean>                      → GET /health
//
// Config:
// - SPEACHES_URL from env or default "http://speaches:8000"
// - Voice: "bf_emma"
// - STT model: "distil-large-v3"
// - Audio temp dir: .borg/audio/
```

**Files:**
- `src/types.ts` — add `audioPath`, `voiceDuration` fields
- `src/audio.ts` — new file, Speaches client + temp file management

**Acceptance criteria:**
- [ ] `.borg/audio/` directory created on startup
- [ ] `transcribe()` sends OGG to Speaches, returns text
- [ ] `synthesize()` sends text to Speaches, returns path to OGG file
- [ ] `synthesize()` requests `response_format: "opus"` so Speaches returns Telegram-ready OGG/Opus directly
- [ ] All audio format conversion happens in the Speaches container — bot container has no ffmpeg dependency
- [ ] Temp files cleaned up after use
- [ ] Periodic sweep removes orphaned files older than 1 hour

### Phase 3: Incoming Voice Messages (STT)

Handle `message:voice` in telegram-client, transcribe in queue-processor.

**`src/telegram-client.ts`:**
```typescript
// Add alongside existing bot.on("message:text", ...) handler:
bot.on("message:voice", async (ctx) => {
  // 1. Check duration — reject if > 300s (5 min)
  // 2. Download OGG via grammY files plugin or getFile() + fetch
  //    Save to .borg/audio/incoming/<messageId>.ogg
  // 3. Create IncomingMessage with:
  //    - message: "" (empty — queue-processor will fill after STT)
  //    - audioPath: path to downloaded OGG
  //    - voiceDuration: ctx.msg.voice.duration
  // 4. Write to .borg/queue/incoming/ (same as text messages)
  // 5. React with 👀 (same as text messages)
  // 6. Register PendingMessage for status tracking
});
```

**`src/queue-processor.ts`:**
```typescript
// In processMessage(), before routing:
if (incomingMessage.audioPath && !incomingMessage.message) {
  // 1. Call transcribe(incomingMessage.audioPath)
  // 2. Set incomingMessage.message = transcript
  // 3. If transcript is empty, send error reply and return
  // 4. Clean up the downloaded OGG file
  // 5. Proceed with normal routing + SDK query
}
```

**Dependencies:**
- `npm install @grammyjs/files` — for downloading voice files from Telegram

**Files:**
- `src/telegram-client.ts` — add `message:voice` handler
- `src/queue-processor.ts` — add STT step before routing
- `package.json` — add `@grammyjs/files`

**Acceptance criteria:**
- [ ] Voice messages in any forum topic are downloaded and queued
- [ ] Queue processor transcribes before routing
- [ ] Transcript used as message text for routing and SDK query
- [ ] Voice messages >5 min rejected with polite error
- [ ] Empty transcripts handled gracefully
- [ ] Downloaded OGG cleaned up after transcription
- [ ] Deduplication still works (uses audioPath or voiceDuration for voice dedup)
- [ ] Reply-to-bot voice messages carry `isReply`, `replyToModel` for routing upgrade

### Phase 4: On-Demand TTS via Inline Keyboard

Every user-facing bot response includes a "Listen" inline button. When tapped, the bot distills the response via Haiku, synthesizes speech via Kokoro, and replies to its own message with a voice note. Zero wasted compute.

**`src/audio.ts`** — add speech distillation:
```typescript
// - distillForSpeech(text: string): Promise<string>
//   Calls Haiku with: "Distill this into a brief spoken summary, 2-3 sentences.
//   No markdown, no code, no lists. Speak naturally as if telling someone
//   the key takeaway."
//   Returns the distilled text for TTS.
```

**`src/telegram-client.ts`** — add inline keyboard to outgoing messages:
```typescript
// In pollOutgoingQueue(), when sending a user-facing text message:
// Add reply_markup with InlineKeyboardMarkup:
const keyboard = new InlineKeyboard().text("🔊 Listen", `listen:${messageId}`);
await ctx.api.sendMessage(chatId, text, {
  message_thread_id: threadId,
  reply_markup: keyboard,
});
```

**`src/telegram-client.ts`** — handle callback query:
```typescript
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("listen:")) return;

  const messageId = data.replace("listen:", "");
  const originalText = ctx.callbackQuery.message?.text;
  if (!originalText) {
    await ctx.answerCallbackQuery({ text: "Message text not available" });
    return;
  }

  // 1. answerCallbackQuery with loading indicator
  await ctx.answerCallbackQuery({ text: "Generating voice..." });

  // 2. Distill via Haiku
  const speechText = await distillForSpeech(originalText);

  // 3. Synthesize via Kokoro
  const audioPath = await synthesize(speechText);

  // 4. Reply to the original message with voice note
  await ctx.api.sendVoice(chatId, new InputFile(audioPath), {
    message_thread_id: /* look up from message-models.json or ctx */,
    reply_to_message_id: ctx.callbackQuery.message.message_id,
  });

  // 5. Update button to "Listened" or remove keyboard
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });

  // 6. Clean up audio file
  cleanupAudioFile(audioPath);
});
```

**Key details:**
- `callback_query:data` includes the original message object, so we have the text without extra lookups
- `answerCallbackQuery` dismisses the loading spinner on the button
- After voice is sent, remove the inline keyboard (button served its purpose)
- Callback queries DO include chat info, so we can determine the thread
- If TTS fails, show error via `answerCallbackQuery({ text: "Couldn't generate voice", show_alert: true })`

**Files:**
- `src/audio.ts` — add `distillForSpeech()` using Haiku
- `src/telegram-client.ts` — add inline keyboard to outgoing messages + callback query handler

**Acceptance criteria:**
- [ ] Every user-facing bot response has a "Listen" inline button
- [ ] Tapping "Listen" generates a voice reply to the original message
- [ ] Voice is Haiku-distilled, not raw TTS of full response
- [ ] Button is removed after voice is generated
- [ ] Error shown via toast if TTS or distillation fails
- [ ] Cross-thread, heartbeat, system, CLI messages have no button
- [ ] Audio file cleaned up after send
- [ ] Multiple rapid taps don't generate duplicate voice notes

## Alternative Approaches Considered

1. **Custom Docker container with Flask** — The OpenClaw gist describes building a custom Flask container. Rejected because Speaches already exists and provides the same endpoints with better maintenance.

2. **STT in telegram-client** — Would be simpler (transcribe before queuing) but blocks the Telegram event loop during transcription. A 60-second voice message could take 10+ seconds to transcribe, during which no other messages are processed.

3. **Automatic TTS on every response** — Synthesize voice for every user-facing message. Rejected because it wastes compute on messages nobody wants to hear. On-demand via inline button is more efficient and user-controlled.

4. **Separate TTS and STT containers** — Running Kokoro-FastAPI and faster-whisper-server separately. Rejected because Speaches bundles both in one image with shared resources.

5. **Streaming TTS** — Kokoro-FastAPI supports chunked streaming for lower time-to-first-byte. Not needed since we generate the full response first, then synthesize. Could be a future optimization.

## Acceptance Criteria

### Functional Requirements

- [ ] User sends voice message → bot transcribes and processes it
- [ ] Every user-facing bot response has a "Listen" inline button
- [ ] Tapping "Listen" generates a Haiku-distilled voice reply
- [ ] Cross-thread/heartbeat/system messages have no button
- [ ] Voice messages >5 min are rejected with a helpful message
- [ ] Model emoji reactions still appear on text messages
- [ ] Graceful degradation when Speaches or Haiku is unavailable

### Non-Functional Requirements

- [ ] STT latency: <10s for a 60-second voice message on CPU
- [ ] TTS latency: <8s end-to-end (Haiku distill + Kokoro synthesis) — acceptable since user-initiated
- [ ] Speaches container stays under 4GB memory
- [ ] Temp audio files cleaned up within 1 hour
- [ ] Callback query handler doesn't block telegram-client event loop (use async)

### Quality Gates

- [ ] Voice round-trip tested: voice in → text response with Listen button → tap → voice reply
- [ ] Error paths tested (container down, empty transcript, long message, rapid button taps)
- [ ] Existing text-only flow unaffected (regression test)
- [ ] File cleanup verified (no disk leak over 24h)

## Dependencies & Risks

| Dependency | Risk | Mitigation |
|---|---|---|
| Speaches Docker image | Image may not support `bf_emma` voice out of the box | Fall back to default voice; verify in Phase 1 |
| `distil-large-v3` model | English-only; non-English voice messages fail | Document limitation; large-v3 as future upgrade |
| 4GB memory for container | May be tight for both models loaded simultaneously | Monitor; bump to 6GB if needed |
| `@grammyjs/files` plugin | Type compatibility with existing grammY setup | Lightweight plugin; low risk |
| Speaches API stability | OpenAI-compatible API may have quirks | Pin image version; test endpoints |
| Haiku distillation | Extra API call per response; adds ~1-2s latency | Haiku is fast and cheap; graceful fallback to text-only |
| ffmpeg dependency | Not needed — Speaches handles format conversion via `response_format: "opus"` | If Speaches drops opus support, add ffmpeg to bot Dockerfile |
| Shared filesystem | telegram-client and queue-processor must share `.borg/audio/` for file handoff | Both run in the same container; if split later, use a shared volume |

## Success Metrics

- Voice messages are transcribed and processed correctly
- "Listen" button appears on all user-facing responses
- On-demand TTS generates voice replies when requested
- No increase in message processing failures
- Audio temp directory stays under 100MB
- Speaches container runs stably within 4GB

## Future Considerations

- **GPU acceleration** — Move Speaches to GPU for faster inference if CPU latency is too high
- **Multi-language STT** — Switch from `distil-large-v3` to `large-v3` for multilingual support
- **Streaming TTS** — Use chunked streaming for lower perceived latency
- **Voice cloning** — Kokoro supports custom voice training
- **Video notes** — Extract audio from round videos for STT
- **Voice-only mode** — User preference to skip text responses entirely

## References

### Internal References
- `src/telegram-client.ts` — Telegram bot, message handlers, outgoing queue
- `src/queue-processor.ts` — SDK sessions, routing, message processing
- `src/types.ts` — IncomingMessage, OutgoingMessage interfaces
- `src/mcp-tools.ts` — MCP tools for SDK sessions
- `docker-compose.yml` — container orchestration

### External References
- [Speaches (Kokoro + faster-whisper)](https://github.com/speaches-ai/speaches) — combined TTS/STT container
- [Kokoro-82M voices](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) — voice list including bf_emma
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — CTranslate2 Whisper implementation
- [grammY files plugin](https://grammy.dev/plugins/files) — file download helper
- [Telegram Bot API sendVoice](https://core.telegram.org/bots/api#sendvoice) — voice message API
- [OpenClaw voice gist](https://gist.github.com/clawcian/1db2752c22ca82e5f2678f0dc359d35f) — reference implementation

### Related Work
- OpenClaw agent voice implementation (reference architecture)
- Routing feedback emoji reactions plan (`2026-02-19`)
