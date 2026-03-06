# distillForSpeech uses agent SDK query() not raw fetch

The distillForSpeech function in audio.ts uses the agent SDK's query() function with sonnet model to distill long bot responses into natural spoken form for TTS. It does NOT use raw fetch() to the Anthropic API — the user was explicit that the SDK pattern is the same as everywhere else in the codebase (reads ANTHROPIC_API_KEY from environment, nothing special). Falls back to truncation on error. Input capped at 4096 chars. The user considers the distillation feature "really cool" and wants to keep it.

**Related files:** src/audio.ts