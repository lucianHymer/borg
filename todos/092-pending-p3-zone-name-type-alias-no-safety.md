---
status: complete
priority: p3
issue_id: "092"
tags: [code-review, type-safety]
dependencies: []
---

# ZoneName type alias provides no actual type safety

## Problem Statement

`type ZoneName = string` (zone-config.ts:23) adds no type safety — it is structurally identical to `string`. Any `string` can be passed where `ZoneName` is expected without a compiler error. If the intent is to prevent accidents (passing an arbitrary string where a validated zone name is required), it should use a branded type pattern. As written it is documentation that looks like safety but provides none.

## Findings

- `type ZoneName = string` is a structural alias — TypeScript treats it as identical to `string`
- Any `string` satisfies `ZoneName` without casting; the type provides zero compile-time protection
- The alias may give a false sense of safety to readers and future contributors
- Branded types (`string & { __brand: "ZoneName" }`) require explicit casting at creation points (e.g., after validation) and prevent accidental passing of unvalidated strings

## Proposed Solutions

Option A (brand it): Change to `type ZoneName = string & { __brand: "ZoneName" }`. Add a `toZoneName(s: string): ZoneName` validator/cast function that validates the name meets zone naming rules and casts. Use it at all entry points (user input, config parsing).

Option B (remove it): Delete the alias and just use `string` everywhere. Honest about the lack of safety; less misleading than a fake-safe alias.

Option A is preferred if zone name validation rules exist or should exist. Option B is simpler if no validation is needed.

## Acceptance Criteria

- [x] `ZoneName` either uses a brand (`& { __brand: "ZoneName" }`) that enforces explicit casting, or is removed in favor of plain `string`
- [x] If branded, a constructor/validator function exists at all entry points (Zod schema, manual validation)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-11 | Created from code review of PR #58 | Structural type aliases look like safety guards but are invisible to the type checker |
| 2026-03-11 | Applied Option B (comment approach): added `// Documentation alias only — not a branded type` above the alias; kept alias for readability in function signatures | Branding was judged disproportionate for a low-stakes internal name with no external input validation needed |
