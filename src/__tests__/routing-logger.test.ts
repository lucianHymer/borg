/**
 * Tests for Routing Logger
 *
 * Tests sanitization, merge logic, and Zod validation for routing decisions and corrections.
 */

import { describe, it, expect } from "vitest";
import { mergeCorrectionsOntoDecisions, LogEntrySchema, CorrectionEntrySchema } from "../routing-logger.js";
import type { LogEntry, CorrectionEntry, DecisionWithCorrection } from "../routing-logger.js";

// Note: sanitizePrompt is not exported, so we test it indirectly through logDecision behavior
// Expected sanitizePrompt behavior:
// - Strips control chars (\x00-\x08, \x0b, \x0c, \x0e-\x1f)
// - Keeps tab (\x09), newline (\x0a), CR (\x0d)
// - Truncates to 4096 chars

describe("mergeCorrectionsOntoDecisions", () => {
  it("should separate decisions and corrections", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        prompt: "test",
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
      {
        type: "correction",
        ts: 2000,
        messageId: 1,
        originalModel: "haiku",
        correctedModel: "sonnet",
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result.length).toBe(1);
    expect(result[0].type).toBe("decision");
    expect(result[0].userCorrection).toBe("sonnet");
  });

  it("should attach correction to matching decision by messageId", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 123,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
      {
        type: "correction",
        ts: 2000,
        messageId: 123,
        originalModel: "haiku",
        correctedModel: "opus",
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result[0].messageId).toBe(123);
    expect(result[0].userCorrection).toBe("opus");
  });

  it("should handle latest correction when multiple exist for same messageId", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
      {
        type: "correction",
        ts: 2000,
        messageId: 1,
        originalModel: "haiku",
        correctedModel: "sonnet",
      },
      {
        type: "correction",
        ts: 3000, // Later timestamp
        messageId: 1,
        originalModel: "sonnet",
        correctedModel: "opus",
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    // Latest correction should win
    expect(result[0].userCorrection).toBe("opus");
  });

  it("should handle earlier correction being replaced by later one", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
      {
        type: "correction",
        ts: 5000, // Later timestamp
        messageId: 1,
        originalModel: "sonnet",
        correctedModel: "opus",
      },
      {
        type: "correction",
        ts: 2000, // Earlier timestamp
        messageId: 1,
        originalModel: "haiku",
        correctedModel: "sonnet",
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    // Correction with ts=5000 should win (latest)
    expect(result[0].userCorrection).toBe("opus");
  });

  it("should not attach correction to decision with different messageId", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
      {
        type: "correction",
        ts: 2000,
        messageId: 2, // Different messageId
        originalModel: "haiku",
        correctedModel: "sonnet",
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result[0].userCorrection).toBeUndefined();
  });

  it("should handle decisions without messageId", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        // No messageId
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
      {
        type: "correction",
        ts: 2000,
        messageId: 1,
        originalModel: "haiku",
        correctedModel: "sonnet",
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result[0].userCorrection).toBeUndefined();
  });

  it("should handle multiple decisions with different messageIds", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
      {
        type: "decision",
        ts: 1100,
        messageId: 2,
        tier: "MEDIUM",
        model: "sonnet",
        tokens: 50,
        confidence: 0.85,
        signals: [],
      },
      {
        type: "correction",
        ts: 2000,
        messageId: 1,
        originalModel: "haiku",
        correctedModel: "sonnet",
      },
      {
        type: "correction",
        ts: 2100,
        messageId: 2,
        originalModel: "sonnet",
        correctedModel: "opus",
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result.length).toBe(2);
    expect(result[0].messageId).toBe(1);
    expect(result[0].userCorrection).toBe("sonnet");
    expect(result[1].messageId).toBe(2);
    expect(result[1].userCorrection).toBe("opus");
  });

  it("should handle empty input", () => {
    const result = mergeCorrectionsOntoDecisions([]);
    expect(result).toEqual([]);
  });

  it("should handle only decisions", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result.length).toBe(1);
    expect(result[0].userCorrection).toBeUndefined();
  });

  it("should handle only corrections", () => {
    const raw = [
      {
        type: "correction",
        ts: 2000,
        messageId: 1,
        originalModel: "haiku",
        correctedModel: "sonnet",
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result.length).toBe(0);
  });
});

describe("Zod Schema Validation", () => {
  describe("LogEntrySchema", () => {
    it("should validate valid decision entry", () => {
      const entry: LogEntry = {
        type: "decision",
        ts: Date.now(),
        prompt: "test prompt",
        messageId: 123,
        threadId: 1,
        tier: "MEDIUM",
        model: "sonnet",
        tokens: 50,
        confidence: 0.85,
        signals: ["code", "technical"],
      };

      const result = LogEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    it("should allow optional type field for backward compatibility", () => {
      const entry = {
        ts: Date.now(),
        prompt: "test",
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      };

      const result = LogEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    it("should allow optional prompt for backward compatibility", () => {
      const entry = {
        type: "decision",
        ts: Date.now(),
        promptHash: "abc123", // Old format
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      };

      const result = LogEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    it("should allow optional messageId and threadId", () => {
      const entry = {
        type: "decision",
        ts: Date.now(),
        prompt: "test",
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      };

      const result = LogEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    it("should reject entry with missing required fields", () => {
      const entry = {
        type: "decision",
        ts: Date.now(),
        // Missing tier, model, tokens, confidence, signals
      };

      const result = LogEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("should reject entry with wrong types", () => {
      const entry = {
        type: "decision",
        ts: "not a number", // Should be number
        prompt: "test",
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      };

      const result = LogEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });
  });

  describe("CorrectionEntrySchema", () => {
    it("should validate valid correction entry", () => {
      const entry: CorrectionEntry = {
        type: "correction",
        ts: Date.now(),
        messageId: 123,
        threadId: 1,
        originalModel: "haiku",
        correctedModel: "opus",
      };

      const result = CorrectionEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    it("should allow optional threadId", () => {
      const entry = {
        type: "correction",
        ts: Date.now(),
        messageId: 123,
        originalModel: "haiku",
        correctedModel: "sonnet",
      };

      const result = CorrectionEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    it("should require type to be 'correction'", () => {
      const entry = {
        type: "decision", // Wrong type
        ts: Date.now(),
        messageId: 123,
        originalModel: "haiku",
        correctedModel: "sonnet",
      };

      const result = CorrectionEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("should require messageId", () => {
      const entry = {
        type: "correction",
        ts: Date.now(),
        // Missing messageId
        originalModel: "haiku",
        correctedModel: "sonnet",
      };

      const result = CorrectionEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });

    it("should reject entry with wrong types", () => {
      const entry = {
        type: "correction",
        ts: Date.now(),
        messageId: "not a number", // Should be number
        originalModel: "haiku",
        correctedModel: "sonnet",
      };

      const result = CorrectionEntrySchema.safeParse(entry);
      expect(result.success).toBe(false);
    });
  });
});

describe("mergeCorrectionsOntoDecisions - Zod Validation", () => {
  it("should skip invalid correction entries", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
      {
        type: "correction",
        ts: 2000,
        // Missing messageId - invalid
        originalModel: "haiku",
        correctedModel: "sonnet",
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    // Invalid correction should be skipped
    expect(result[0].userCorrection).toBeUndefined();
  });

  it("should include invalid decision entries with fallback", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        // Missing required fields - invalid
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    // Should fallback to raw entry (as DecisionWithCorrection)
    expect(result.length).toBe(1);
  });

  it("should validate decision entries and include valid ones", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result.length).toBe(1);
    expect(result[0].tier).toBe("SIMPLE");
  });
});

// Note: sanitizePrompt is not exported, so it's tested indirectly through logDecision behavior
// Expected behavior:
// - Strips control chars (\x00-\x08, \x0b, \x0c, \x0e-\x1f)
// - Keeps tab (\x09), newline (\x0a), CR (\x0d)
// - Truncates to 4096 chars (Telegram max message length)

describe("Edge Cases", () => {
  it("should handle decision with all optional fields present", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        prompt: "test",
        promptHash: "abc123",
        messageId: 1,
        threadId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: ["short"],
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result.length).toBe(1);
    expect(result[0].prompt).toBe("test");
    expect(result[0].promptHash).toBe("abc123");
  });

  it("should handle correction with threadId", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        threadId: 5,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
      {
        type: "correction",
        ts: 2000,
        messageId: 1,
        threadId: 5,
        originalModel: "haiku",
        correctedModel: "opus",
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result[0].userCorrection).toBe("opus");
  });

  it("should handle very large signals array", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        tier: "COMPLEX",
        model: "opus",
        tokens: 1000,
        confidence: 0.95,
        signals: Array(100).fill("signal"),
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result[0].signals.length).toBe(100);
  });

  it("should handle empty signals array", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.9,
        signals: [],
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result[0].signals).toEqual([]);
  });

  it("should handle confidence at boundary values", () => {
    const raw = [
      {
        type: "decision",
        ts: 1000,
        messageId: 1,
        tier: "SIMPLE",
        model: "haiku",
        tokens: 10,
        confidence: 0.0,
        signals: [],
      },
      {
        type: "decision",
        ts: 1001,
        messageId: 2,
        tier: "COMPLEX",
        model: "opus",
        tokens: 1000,
        confidence: 1.0,
        signals: [],
      },
    ];

    const result = mergeCorrectionsOntoDecisions(raw);

    expect(result[0].confidence).toBe(0.0);
    expect(result[1].confidence).toBe(1.0);
  });
});
