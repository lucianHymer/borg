# Unit testing: Vitest conventions and philosophy

## Infrastructure
Vitest 4.x with v8 coverage provider. Config in `vitest.config.ts`. Tests run in Node environment with globals enabled. Coverage reporters: text, json, html. npm scripts: `npm test` (watch), `npm test -- --run` (once), `npm run test:coverage`.

## File Organization
Tests live in `__tests__/` directories alongside source code they test. Pattern: `src/__tests__/foo.test.ts` for top-level modules, `src/router/__tests__/rules.test.ts` for subdirectory modules. Include pattern: `src/**/*.test.ts`.

## Testing Philosophy
**Test business logic with complex edge cases, skip thin wrappers around external systems.** High-value targets: router scoring (14-dimension weighted system), JSONL reader (tail-reading, partial lines, malformed data), routing logger (merge logic, Zod validation). Explicitly NOT tested: telegram-client.ts (grammY wrapper), queue-processor.ts (SDK wrapper), audio.ts (HTTP calls), mcp-tools.ts (orchestration). This avoids brittle mocks of external APIs and focuses test budget on code with real branching logic.

## Conventions
- **No mocking for pure functions**: Router scoring, JSONL parsing, and merge logic are pure — test them directly with real inputs.
- **Real file system for I/O tests**: JSONL reader tests use `fs.mkdtempSync()` to create temp directories, write real files, and clean up in `afterEach`. This catches real encoding/boundary issues that mocks would miss.
- **Edge case coverage**: Unicode, multilingual keywords, CRLF line endings, buffer boundaries, malformed JSON, empty inputs, boundary values.
- **Imports use `.js` extensions**: Per nodenext module resolution, test imports use `.js` extensions (e.g., `from "../rules.js"`).
- **Zod schema validation tests**: Exported schemas (LogEntrySchema, CorrectionEntrySchema) tested via `safeParse` to verify backward compatibility with optional fields.

## Coverage Targets (Phase 1)
- Router rules (classifyByRules): 14 dimensions, confidence calibration, reasoning marker override — ~60 tests
- Router index (route()): Large context override, tier mapping, ambiguous defaults — ~30 tests
- Routing logger (mergeCorrectionsOntoDecisions): Latest-correction-wins, schema validation — ~32 tests
- JSONL reader (readRecentJsonl): Tail-reading, partial lines, buffer boundaries — ~27 tests
- Total: 141 tests, ~465ms runtime

**Related files:** vitest.config.ts, package.json, src/router/__tests__/, src/__tests__/
