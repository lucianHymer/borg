---
status: complete
priority: p3
issue_id: "065"
tags: [code-review, agent-native, voice, dead-code]
dependencies: []
---

# OutgoingMessage.audioPath is dead code; voice features not agent-accessible

## Problem Statement

`audioPath` on `OutgoingMessage` (types.ts:38) is declared but never written to or consumed. TTS happens entirely in telegram-client.ts via the callback handler, not through the outgoing queue. This field is dead infrastructure. Separately, the voice feature is entirely human-facing — no MCP tool exists for agents to synthesize speech or know that input was voice-transcribed.

## Findings

- Found by Code Simplicity, TypeScript, and Agent-Native reviewers
- Agent-native score: 0/2 voice capabilities are agent-accessible
- `pollOutgoingQueue` never checks `audioPath`; always uses `sendMessage` (text)
- No `synthesize_voice` MCP tool exists
- Agents don't know when input was voice-transcribed

## Proposed Solutions

### Option A: Wire audioPath + add MCP tool (Full feature)
1. In `pollOutgoingQueue`, check `data.audioPath` and use `sendVoice` when present
2. Add `synthesize_voice` MCP tool in `mcp-tools.ts`
3. Tag voice-transcribed messages with metadata for agent awareness
- Effort: Medium
- Risk: Low

### Option B: Remove dead field (Minimal)
Remove `audioPath` from `OutgoingMessage` since it's unused. Accept voice as human-only for now.
- Effort: Trivial
- Risk: None

## Technical Details

- **Affected files:** `src/types.ts`, `src/telegram-client.ts`, `src/mcp-tools.ts`

## Acceptance Criteria

- [ ] Either: audioPath is wired end-to-end with agent access, OR dead field is removed
