# Speaches Audio (TTS/STT)

You have access to a local text-to-speech and speech-to-text server via the Speaches container.
Use it whenever you need to generate audio from text or transcribe audio to text.

**Base URL:** `http://speaches:8000` (OpenAI-compatible API)

## Text-to-Speech (TTS)

Generate spoken audio from text:

```bash
curl -s -X POST http://speaches:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "speaches-ai/Kokoro-82M-v1.0-ONNX",
    "voice": "bf_alice",
    "input": "Your text here",
    "speed": 1.0,
    "response_format": "mp3"
  }' -o output.mp3
```

**Parameters:**
- `model` — always `speaches-ai/Kokoro-82M-v1.0-ONNX`
- `voice` — see voices below (default: `bf_alice`)
- `input` — the text to speak
- `speed` — playback speed multiplier (default: 1.0)
- `response_format` — `mp3`, `wav`, `opus`, `flac`

**Available voices (English):**
- British female: `bf_alice` (default), `bf_emma`, `bf_isabella`, `bf_lily`
- British male: `bm_daniel`, `bm_fable`, `bm_george`, `bm_lewis`
- American female: `af_heart`, `af_alloy`, `af_bella`, `af_jessica`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky`
- American male: `am_adam`, `am_echo`, `am_eric`, `am_liam`, `am_michael`, `am_onyx`, `am_puck`

Also supports Spanish, French, Italian, Portuguese, Japanese, Chinese, and Hindi voices.

## Speech-to-Text (STT)

Transcribe an audio file to text:

```bash
curl -s -X POST http://speaches:8000/v1/audio/transcriptions \
  -F "file=@/path/to/audio.ogg" \
  -F "model=Systran/faster-distil-whisper-large-v3"
```

Returns JSON: `{"text": "transcribed text here"}`

**Supported input formats:** OGG, MP3, WAV, FLAC, M4A, WebM

## Health Check

```bash
curl -s http://speaches:8000/health
```

## Tips

- The server queues requests internally — just send them, no concurrency limiting needed.
- For long text, TTS may take a few seconds. Use a 60s timeout.
- For long audio, STT may take longer. Use a 120s timeout.
- Audio files are binary — save to disk, then use or send them as needed.
- If you need to send the generated audio to Telegram, save to a file and tell the user where it is, or use the Borg voice message flow.
