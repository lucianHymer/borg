# distillForSpeech and distillForReading use agent SDK query() not raw fetch

Both distillation functions in audio.ts use the agent SDK's query() function with short model aliases (e.g. "haiku") — NOT fully-qualified model IDs. The SDK resolves "haiku", "sonnet", "opus" to the latest version automatically. NEVER use specific versioned model names like "claude-sonnet-4-6" or "claude-haiku-4-5-20251001" — always use the short aliases.

- **distillForSpeech**: uses "sonnet", converts bot responses into natural spoken form for TTS. Input capped at 4096 chars.
- **distillForReading**: uses "sonnet", summarizes voice message transcripts in 2-3 sentences. Input capped at 2048 chars.

Both fall back to truncation on SDK error. Does NOT use raw fetch() to the Anthropic API — the SDK pattern is the same as everywhere else in the codebase.

**Related files:** src/audio.ts