---
title: "feat: Add voice message support (TTS/STT)"
type: feat
status: active
date: 2026-03-05
deepened: 2026-03-05
---

# Voice Message Support (TTS & STT)

## Enhancement Summary

**Deepened on:** 2026-03-05
**Research agents used:** 12 (grammY docs, Speaches best practices, TypeScript reviewer, security sentinel, performance oracle, architecture strategist, simplicity reviewer, pattern recognition, spec flow analyzer, learnings researcher, repo research analyst, Context7)

### Key Improvements
1. **Bug fix identified**: TTS callback double-answer — health check must run BEFORE `answerCallbackQuery` to avoid swallowed error notifications
2. **Performance**: Replace synchronous `readFileSync`/`writeFileSync` with async equivalents in audio.ts to avoid blocking the event loop
3. **Security**: Add path validation to `cleanupAudioFile`, per-user TTS rate limiting, and pinned Speaches image version
4. **Docker hardening**: Add `start_period`, `ENABLE_UI=false`, `WHISPER__COMPUTE_TYPE=int8`, model TTL settings
5. **Opus format risk**: Speaches docs say opus is unsupported but source code includes it — pin image version as insurance
6. **Voice quality**: bf_emma (grade B-) is significantly better than bf_alice (grade D) — correct choice confirmed
7. **Missing flows**: Video notes and audio file attachments silently ignored — add handlers with helpful error messages
8. **Concurrency**: Add global TTS concurrency cap (max 3) to prevent resource exhaustion from parallel "Listen" taps

### New Considerations Discovered
- `answerCallbackQuery` can only be called once per callback — restructure error flow
- Skip Haiku distillation for short messages (<280 chars) — saves 1-2s latency
- Consolidate `bf_alice` default to single source of truth (currently in 3 places)
- Queue-file write failure after successful voice download leaves user with no response — needs error handling
- Multi-chunk responses only distill chunk 1's text for TTS
- `condition: service_healthy` instead of `service_started` for Speaches dependency

---

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

#### Research Insights

**Docker Configuration Best Practices:**
- Add `start_period: 60s` to the healthcheck — models take time to load on first start, preventing false failures during initial download
- Set `ENABLE_UI=false` to disable the Gradio web UI in production (reduces attack surface and memory usage)
- Set `WHISPER__COMPUTE_TYPE=int8` for faster CPU inference with minimal quality loss
- Set `STT_MODEL_TTL=-1` and `TTS_MODEL_TTL=-1` to prevent model unloading if memory allows (avoids reload latency on first request after idle)
- Consider `WHISPER__CPU_THREADS=4` tuned to available cores
- Add `cpus: '4.0'` resource limit — STT is CPU-intensive

**Opus Format Risk:**
- Speaches official docs state "response_format: opus and aac are not supported"
- However, the actual source code (`speaches/routers/speech.py`) includes opus in `RESPONSE_FORMAT_MIME_TYPE_MAP`
- **Mitigation**: Pin the Speaches image to a specific version tag (e.g., `v0.7.3-cpu`) instead of `latest-cpu`. This prevents silent breakage if opus support is removed in a future update.
- **Fallback plan**: If opus breaks, request `wav` format and convert to OGG/Opus via ffmpeg (`ffmpeg -i input.wav -c:a libopus -b:a 64k output.ogg`)

**Bot dependency should use `service_healthy`:**
- The bot container currently depends on Speaches with `condition: service_started`
- Change to `condition: service_healthy` to ensure models are loaded before accepting voice messages
- Without this, early voice messages during startup fail with HTTP errors (handled by error path, but suboptimal UX)

**Voice Quality Research:**
- bf_emma (grade B-) is the best British voice — significantly better than bf_alice (grade D)
- af_heart (grade A) is the best overall voice if American accent is acceptable
- Kokoro TTS optimal input: 100-200 tokens (~50-100 words). Short utterances (<10-20 tokens) may sound unnatural. Long utterances (>400 tokens) may rush.
- This aligns well with Haiku distillation producing 2-3 sentences

**Enhanced docker-compose configuration:**
```yaml
speaches:
  image: ghcr.io/speaches-ai/speaches:v0.7.3-cpu  # pin version
  ports:
    - "127.0.0.1:8000:8000"  # localhost only
  volumes:
    - speaches-cache:/home/ubuntu/.cache/huggingface/hub
  environment:
    - KOKORO__VOICES=bf_emma
    - WHISPER__COMPUTE_TYPE=int8
    - STT_MODEL_TTL=-1
    - TTS_MODEL_TTL=-1
    - ENABLE_UI=false
  deploy:
    resources:
      limits:
        memory: 4G
        cpus: '4.0'
  restart: unless-stopped
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 60s
```

**References:**
- [Speaches Configuration](https://speaches.ai/configuration/)
- [Speaches Installation Guide](https://speaches.ai/installation/)
- [Kokoro-82M VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)

---

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

#### Research Insights

**TypeScript Code Quality (from reviewer):**

- **Validate STT response shape at runtime** — `res.json() as { text: string }` is unsafe. If Speaches returns an error JSON, `data.text` is `undefined` and silently returns empty string, masking API errors as "no speech detected." Use inline validation:
  ```typescript
  const data: unknown = await res.json();
  if (!data || typeof data !== "object" || !("text" in data) || typeof (data as any).text !== "string") {
      throw new Error(`Unexpected STT response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  ```

- **Use async file I/O** — Replace `fs.readFileSync` in `transcribe()` and `fs.writeFileSync` in `synthesize()` with `fs.promises.readFile` / `fs.promises.writeFile`. Synchronous reads of 5-10MB audio files block the Node.js event loop. This is a P0 fix.

- **Add path validation to `cleanupAudioFile`** — Currently accepts any path without checking it's within audio directories. Add a guard:
  ```typescript
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(AUDIO_DIR + "/") && !resolved.startsWith(AUDIO_INCOMING_DIR + "/")) return;
  ```

- **Consolidate TTS voice default** — The `bf_alice` default appears in 3 places: `TTS_VOICE` constant in audio.ts (unused), `synthesize()` fallback, and `session-manager.ts` defaults. Remove the constant, make `voice` a required parameter in `synthesize()`. Single source of truth in Settings.

- **Zod schema validation** — Add `.max(300)` to `voiceDuration` in the IncomingMessage Zod schema for consistency with the 5-minute telegram-client check.

**Simplicity Assessment:**

- **`isAvailable()` health check**: Consider removing entirely. Try/catch on actual `transcribe()`/`synthesize()` calls achieves the same result with zero extra code. The health check adds a function, a per-request HTTP call, and state tracking for something that a failed request already tells you.
- **Periodic file sweep**: Cleanup-after-use is the primary mechanism. The periodic sweep is belt-and-suspenders. A simpler alternative: single cleanup pass at process startup (2 lines instead of an interval + glob + age check).
- **`audioPath` on OutgoingMessage**: Verify this field is actually needed downstream. If TTS is handled entirely in the callback handler (not through the queue), this field on OutgoingMessage may be dead weight.

**Pattern Consistency:**

- SPEACHES_URL via `process.env` (not settings.json) is consistent with how infrastructure endpoints like `DOCKER_PROXY_URL` are handled in the codebase.
- The `audio.ts` module should NOT import or depend on telegram or queue concepts — keep it a pure HTTP client + file manager.
- Follow existing error pattern: `toErrorMessage(err)` for logged errors, bare `catch {}` for best-effort operations.

---

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

#### Research Insights

**grammY Voice Handling Best Practices:**

- **@grammyjs/files setup is critical**: Must call `bot.api.config.use(hydrateFiles(bot.token))` before bot starts, and wrap context type with `FileFlavor<Context>`. Without this, `download()` method is unavailable on file objects.
- **Deduplication**: Use `file_unique_id` (not `file_id`) for voice message dedup. `file_unique_id` is content-based — same audio = same ID even across forwards.
- **File download alternative**: Instead of manually constructing `https://api.telegram.org/file/bot<token>/<file_path>` (which exposes the bot token in the URL), use the @grammyjs/files plugin's `file.download(targetPath)` method. This handles URL construction internally and is safer.
- **Voice message properties**: `ctx.msg.voice` provides `duration` (seconds), `file_id`, `file_unique_id`, `mime_type` ("audio/ogg"), `file_size` (bytes).

**Security Findings:**

- **Path traversal protection in queue-processor is essential** — Validate that `audioPath` resolves within the allowed `.borg/audio/incoming/` directory before reading. The plan already includes this (lines 724-728 in current implementation).
- **File size check (10MB)** alongside duration check (5 min) provides defense in depth. Both should be enforced in telegram-client before downloading.
- **Bot token in download URL**: If manually constructing the download URL, the bot token is in the URL path. If the fetch throws and the error message includes the URL, the token leaks to logs. Sanitize error messages: `.replace(/bot[A-Za-z0-9:_-]+\//, 'bot[REDACTED]/')`.

**Institutional Learnings (from past solutions):**

- **Queue-processor history injection**: `buildHistoryContext()` is conditional on `isNew` flag — only inject for new sessions, not resumed ones. STT-transcribed text follows the same conditional path naturally since it's set on `msg.message` before routing.
- **Metadata propagation pattern**: Adding `audioPath` and `voiceDuration` to IncomingMessage follows the exact precedent of `topicName` field (added to propagate forum topic names through the queue).
- **Retry/dead-letter infrastructure**: Queue-processor retries failed messages up to 3 times with `_retryN` suffix. STT failures that throw will be retried, which is correct for transient Speaches errors.

**Missing Flow: Queue-file write failure:**
- If the voice download succeeds but writing the queue JSON fails (e.g., `ENOSPC`), the user sees the eye-reaction acknowledgment but nothing ever happens. Wrap the queue-file write in a try/catch that replies with an error message and cleans up the downloaded audio file.

**Missing Flow: Video notes and audio attachments:**
- Telegram has three audio types: `voice` (OGG), `video_note` (round video), `audio` (file attachment)
- Only `message:voice` is handled. Add handlers for the others with helpful error messages:
  ```typescript
  bot.on("message:video_note", async (ctx) => {
    await ctx.reply("Video notes aren't supported yet — please send a voice message or text.", ...);
  });
  ```

---

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

#### Research Insights

**BUG: Callback query double-answer (HIGH priority):**

`answerCallbackQuery` can only be called ONCE per callback. The current flow calls it at line 834 ("Generating voice..."), then if `isAvailable()` returns false, calls it again at line 839 ("Voice service unavailable"). The second call is silently swallowed by Telegram. The user sees "Generating voice..." but never learns the service is unavailable.

**Fix**: Restructure the handler to check availability BEFORE answering:
```typescript
// Check availability first
const available = await isAvailable(); // or remove isAvailable() entirely
if (!available) {
    await ctx.answerCallbackQuery({ text: "Voice service unavailable", show_alert: true });
    return;
}
// Only answer with "Generating..." after confirming service is up
await ctx.answerCallbackQuery({ text: "Generating voice..." });
```

Same issue applies to the error catch block — after the callback has been answered, the error toast is lost. **Fix for error feedback**: Send a regular text message to the thread instead of trying to answer the callback again:
```typescript
catch (err) {
    // callback already answered — send text message instead
    try {
        await ctx.api.sendMessage(chatId, "Couldn't generate voice. Try again later.", {
            message_thread_id: threadOpt,
            reply_to_message_id: ctx.callbackQuery.message?.message_id,
        });
    } catch { /* best effort */ }
}
```

**Performance: Skip distillation for short messages:**

For messages under ~280 characters, Haiku distillation is wasted — the text is already speech-length. Skip it:
```typescript
const speechText = text.length <= 280 ? text : await distillForSpeech(text);
```
Saves 1-2 seconds of Haiku API latency for short messages.

**Performance: Cache Speaches health check:**

Every "Listen" tap calls `isAvailable()` adding 50-200ms. Cache with a 30s TTL since Docker healthcheck already runs every 30s:
```typescript
let speachesAvailable = true;
let lastHealthCheck = 0;
async function isSpeachesAvailable(): Promise<boolean> {
    if (Date.now() - lastHealthCheck < 30_000) return speachesAvailable;
    speachesAvailable = await isAvailable();
    lastHealthCheck = Date.now();
    return speachesAvailable;
}
```

**Security: Per-user TTS rate limiting:**

No per-user rate limit on "Listen" taps. A user can rapidly tap "Listen" on different messages, spawning many concurrent Haiku API calls (billing) and Speaches requests (CPU exhaustion):
```typescript
const listenRateLimit = new Map<number, number>(); // userId → lastTimestamp
const LISTEN_COOLDOWN_MS = 10_000; // 10 seconds between requests

const userId = ctx.callbackQuery.from.id;
const lastListen = listenRateLimit.get(userId) ?? 0;
if (Date.now() - lastListen < LISTEN_COOLDOWN_MS) {
    await ctx.answerCallbackQuery({ text: "Please wait before requesting another voice." });
    return;
}
listenRateLimit.set(userId, Date.now());
```

**Security: Global TTS concurrency cap:**

Even with per-user limiting, multiple users can trigger concurrent TTS. Add a global cap:
```typescript
const MAX_TTS_CONCURRENT = 3;
if (listenInFlight.size >= MAX_TTS_CONCURRENT) {
    await ctx.answerCallbackQuery({ text: "Voice generation is busy, try again shortly." });
    return;
}
```

**Architecture note: telegram-client LLM exception:**

`distillForSpeech` is the ONE place where telegram-client directly calls the Anthropic API (via agent SDK `query()`), bypassing the queue-processor. Add a comment documenting this as an intentional exception — it's a fixed task (always Haiku, always one turn) that doesn't need routing.

**TypeScript: Proper narrowing in callback handler:**

Instead of `ctx.callbackQuery.message!.chat.id` with non-null assertions, extract the message once and narrow properly:
```typescript
const message = ctx.callbackQuery.message;
if (!message?.text) {
    await ctx.answerCallbackQuery({ text: "Message text not available" });
    return;
}
// Now message is narrowed — no assertions needed
const chatId = message.chat.id;
const threadOpt = message.message_thread_id;
const originalText = message.text;
```

**grammY: sendVoice requirements:**

- Voice MUST be `.OGG` format encoded with OPUS. Other formats are sent as Audio/Document (not playable voice message).
- Maximum file size: 50MB.
- For forum bots, MUST pass `message_thread_id` — without it, the voice goes to General topic.
- `InputFile` accepts: string (file path), Buffer, ReadableStream, URL, or lazy supplier.

**Orphaned "Listen" buttons after restart:**

Buttons persist in Telegram even after bot restart. This is safe because the callback data is self-contained (`listen:{messageId}`) and the handler extracts text from `ctx.callbackQuery.message.text`. Orphaned buttons work correctly after restart. No gap.

**Multi-chunk responses:**

The Listen button is only on chunk 1 of multi-chunk responses. Distillation receives only chunk 1's text. For long responses split across messages, the voice summary covers only the first 4096 characters. This is acceptable given distillation already produces a 2-3 sentence summary, but worth noting.

---

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

#### Research Insights: Additional Quality Gates

From spec flow analysis and security review:

- [ ] **Callback double-answer bug**: Verify health check runs BEFORE `answerCallbackQuery` — test with Speaches down
- [ ] **TTS error feedback**: Verify error message sent as text reply (not swallowed callback answer)
- [ ] **Rate limiting**: Verify rapid "Listen" taps from same user are throttled
- [ ] **Concurrent TTS cap**: Verify max 3 concurrent TTS operations, 4th gets "busy" message
- [ ] **Video note handler**: Verify video_note messages get helpful redirect message
- [ ] **Audio file attachment handler**: Verify audio file attachments get helpful redirect message
- [ ] **Queue-file write failure**: Verify user gets error reply if disk full after voice download
- [ ] **Async file I/O**: Verify no `readFileSync` or `writeFileSync` in audio hot paths
- [ ] **Path validation on cleanup**: Verify `cleanupAudioFile` refuses paths outside audio directories
- [ ] **STT response validation**: Verify unexpected Speaches response shapes throw (not silent empty string)

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

#### Research Insights: Additional Risks

| Risk | Severity | Details | Mitigation |
|---|---|---|---|
| **Opus format undocumented** | HIGH | Speaches docs say opus unsupported but source includes it | Pin image version; have ffmpeg fallback ready |
| **Callback double-answer** | HIGH | Bug: second `answerCallbackQuery` silently fails, user never sees error | Restructure handler: health check before answer |
| **No TTS rate limiting** | MEDIUM | Rapid taps = unbounded Haiku API calls + Speaches CPU | Per-user cooldown (10s) + global cap (3 concurrent) |
| **Sync file I/O blocking** | MEDIUM | `readFileSync` of 5-10MB OGG blocks event loop | Replace with `fs.promises.readFile` |
| **TTS voice default in 3 places** | LOW | `bf_alice` hardcoded in audio.ts constant, synthesize() fallback, and session-manager.ts | Consolidate to Settings only |
| **Speaches as bottleneck at scale** | MEDIUM | CPU-only inference, 4GB limit, single container for both models | GPU acceleration as future upgrade; monitor queue depth |
| **Queue-file ENOSPC** | LOW | Disk full after voice download = silent message loss | Wrap queue-write in try/catch with user error reply |

## Scalability Assessment

From performance analysis:

| Metric | Current (1 user) | 10x | 100x |
|---|---|---|---|
| Voice messages/hour | ~5 | ~50 | ~500 |
| TTS "Listen" taps/hour | ~3 | ~30 | ~300 |
| Speaches queue depth | 1 | 5-10 | 50+ (unworkable) |
| Audio disk usage (pre-cleanup) | ~50MB | ~500MB | ~5GB |
| Bot container memory pressure | Low | Moderate | Critical |

**Bottleneck chain at 10x**: Speaches container (CPU-only, 4GB) is the first thing that breaks. At 10 concurrent requests, internal queue depth grows and latency balloons to 50-150 seconds. **Highest-leverage upgrade**: GPU acceleration for Speaches or splitting STT/TTS into separate containers.

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
- [Speaches Documentation](https://speaches.ai/) — configuration, API reference
- [Speaches Configuration](https://speaches.ai/configuration/) — environment variables, model settings
- [Kokoro-82M voices](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) — voice list including bf_emma
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — CTranslate2 Whisper implementation
- [distil-whisper/distil-large-v3](https://huggingface.co/distil-whisper/distil-large-v3) — model card and benchmarks
- [grammY files plugin](https://grammy.dev/plugins/files) — file download helper
- [grammY Inline Keyboards](https://grammy.dev/plugins/keyboard) — inline keyboard and callback queries
- [Telegram Bot API sendVoice](https://core.telegram.org/bots/api#sendvoice) — voice message API
- [OpenClaw voice gist](https://gist.github.com/clawcian/1db2752c22ca82e5f2678f0dc359d35f) — reference implementation

### Institutional Learnings Applied
- `docs/solutions/integration-issues/borg-v2-first-live-run-fixes.md` — emoji reaction handler pattern, message handler structure
- `docs/solutions/integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md` — queue metadata propagation precedent (topicName)
- `docs/solutions/integration-issues/sdk-v2-mcpservers-silent-ignore.md` — cross-process message tracking patterns
- `docs/solutions/architecture-reviews/code-review-cycle-2-systemic-patterns-and-prevention.md` — cross-cutting review findings

### Related Work
- OpenClaw agent voice implementation (reference architecture)
- Routing feedback emoji reactions plan (`2026-02-19`)
