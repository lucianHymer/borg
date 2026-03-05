---
status: complete
priority: p2
issue_id: "068"
tags: [code-review, voice, feature]
dependencies: []
---

# Add TTS voice and speed configurability via settings

## Problem Statement

Voice and speed are hardcoded in `audio.ts` (`TTS_VOICE = "bf_emma"`) and `docker-compose.yml` (`KOKORO__VOICES=bf_emma`). User wants configurable voice/speed with defaults of `bf_alice` at 1.0x speed.

## Recommended Action

1. Add `tts_voice` and `tts_speed` to the `Settings` interface in `session-manager.ts` with defaults `"bf_alice"` and `1.0`
2. Update `audio.ts` to read from settings instead of constants — `synthesize()` should accept voice/speed params
3. Update `docker-compose.yml` to set `KOKORO__VOICES=bf_alice` (or multiple voices)
4. Update `telegram-client.ts` TTS callback to pass settings values through

## Technical Details

- **Affected files:** `src/session-manager.ts` (Settings interface), `src/audio.ts` (synthesize params), `src/telegram-client.ts` (pass config), `docker-compose.yml` (KOKORO__VOICES)

## Acceptance Criteria

- [ ] `tts_voice` and `tts_speed` in `.borg/settings.json` control TTS output
- [ ] Default voice is `bf_alice`, default speed is `1.0`
- [ ] Changing settings.json changes voice without code changes
