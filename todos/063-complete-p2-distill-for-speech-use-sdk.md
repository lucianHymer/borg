---
status: complete
priority: p2
issue_id: "063"
tags: [code-review, voice, architecture]
dependencies: []
---

# Refactor distillForSpeech to use agent SDK instead of raw fetch

## Problem Statement

`distillForSpeech()` in `audio.ts` makes a raw `fetch()` to `api.anthropic.com` instead of using the agent SDK's `query()` function, which is how everything else in the codebase works. The SDK reads `ANTHROPIC_API_KEY` from the environment — nothing special needed.

## Recommended Action

Replace the raw `fetch()` call with the agent SDK `query()` using haiku. Same `ANTHROPIC_API_KEY` env var, same pattern as the rest of the codebase.

## Technical Details

- **Affected files:** `src/audio.ts` lines 96-130
- Replace raw fetch with `query()` from `@anthropic-ai/claude-agent-sdk`
- Use haiku model
- Keep the same system prompt and behavior

## Acceptance Criteria

- [ ] `distillForSpeech` uses agent SDK `query()` instead of raw fetch
- [ ] Same distillation behavior preserved
- [ ] No separate credential path
