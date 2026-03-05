# TTS voice and speed settings in .borg/settings.json

TTS configuration lives in .borg/settings.json with two fields: tts_voice (string, default "bf_alice") and tts_speed (number, default 1.0). The Settings interface in session-manager.ts defines these. The synthesize() function in audio.ts accepts optional voice and speed params. telegram-client.ts passes settings.tts_voice and settings.tts_speed when calling synthesize(). The docker-compose KOKORO__VOICES env var must include any voices you want available (currently set to bf_alice). User explicitly wants bf_alice as default at normal speed, with easy configurability — no code changes needed to switch voice.

**Related files:** src/session-manager.ts, src/audio.ts, src/telegram-client.ts, docker-compose.yml