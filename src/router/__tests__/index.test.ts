/**
 * Tests for Router Main Entry Point
 *
 * Tests the route() function including:
 * - Large context override
 * - Tier selection
 * - Ambiguous default handling
 * - Model mapping
 */

import { describe, it, expect } from "vitest";
import { route, DEFAULT_ROUTING_CONFIG } from "../index.js";
import type { RoutingConfig } from "../types.js";

const config = DEFAULT_ROUTING_CONFIG;

describe("route() - Basic Routing", () => {
  it("should route simple prompts to haiku", () => {
    const result = route("hello", undefined, { config });
    expect(result.model).toBe("haiku");
    expect(result.tier).toBe("SIMPLE");
    expect(result.method).toBe("rules");
  });

  it("should route complex prompts to opus", () => {
    const result = route(
      "prove this theorem step by step using mathematical reasoning and derive the result formally",
      undefined,
      { config },
    );
    expect(result.model).toBe("opus");
    expect(result.tier).toBe("COMPLEX");
  });

  it("should route medium prompts to sonnet", () => {
    const result = route(
      "write a function to process user input with some validation",
      undefined,
      { config },
    );
    expect(result.model).toBe("sonnet");
    expect(result.tier).toBe("MEDIUM");
  });

  it("should include estimated token count", () => {
    const result = route("test prompt", undefined, { config });
    expect(result.estimatedTokens).toBeGreaterThan(0);
    // ~4 chars per token: "test prompt" = 11 chars = ~3 tokens
    expect(result.estimatedTokens).toBe(Math.ceil(11 / 4));
  });

  it("should include confidence score", () => {
    const result = route("hello", undefined, { config });
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1.0);
  });

  it("should include reasoning", () => {
    const result = route("hello", undefined, { config });
    expect(result.reasoning).toBeDefined();
    expect(result.reasoning.length).toBeGreaterThan(0);
  });

  it("should include signals", () => {
    const result = route("hello", undefined, { config });
    expect(Array.isArray(result.signals)).toBe(true);
  });
});

describe("route() - Large Context Override", () => {
  it("should force COMPLEX for very large prompts", () => {
    const longPrompt = "x".repeat(400000); // 100k tokens
    const result = route(longPrompt, undefined, { config });

    expect(result.tier).toBe("COMPLEX");
    expect(result.model).toBe("opus");
    expect(result.confidence).toBe(0.95);
    expect(result.signals).toContain("large-context");
    expect(result.reasoning).toContain("100000 tokens");
  });

  it("should force COMPLEX when combined prompt+system exceeds limit", () => {
    const prompt = "x".repeat(200000); // 50k tokens
    const system = "y".repeat(200000); // 50k tokens
    const result = route(prompt, system, { config });

    expect(result.tier).toBe("COMPLEX");
    expect(result.model).toBe("opus");
  });

  it("should not trigger override for prompts just under threshold", () => {
    // Just under 100k tokens (~399k chars)
    const prompt = "x".repeat(399000);
    const result = route(prompt, undefined, { config });

    // Should use normal routing (likely COMPLEX due to length, but not via override)
    expect(result.signals).not.toContain("large-context");
  });

  it("should use custom maxTokensForceComplex if provided", () => {
    const customConfig: RoutingConfig = {
      ...config,
      overrides: {
        ...config.overrides,
        maxTokensForceComplex: 1000, // Much lower threshold
      },
    };

    const mediumPrompt = "x".repeat(5000); // ~1250 tokens
    const result = route(mediumPrompt, undefined, { config: customConfig });

    expect(result.tier).toBe("COMPLEX");
    expect(result.signals).toContain("large-context");
  });
});

describe("route() - System Prompt Handling", () => {
  it("should include system prompt in token estimation", () => {
    const withoutSystem = route("test", undefined, { config });
    const withSystem = route("test", "x".repeat(1000), { config });

    expect(withSystem.estimatedTokens).toBeGreaterThan(withoutSystem.estimatedTokens);
  });

  it("should include system prompt in classification", () => {
    // System prompt has code keywords
    const result = route(
      "simple",
      "write a function with async code and import statements",
      { config },
    );

    // Should detect code presence from system prompt
    expect(result.signals.some(s => s.includes("code"))).toBe(true);
  });

  it("should handle undefined system prompt", () => {
    const result = route("test", undefined, { config });
    expect(result.tier).not.toBe(null);
  });

  it("should handle empty system prompt", () => {
    const result = route("test", "", { config });
    expect(result.tier).not.toBe(null);
  });
});

describe("route() - Ambiguous Default Tier", () => {
  it("should default to MEDIUM for ambiguous results", () => {
    // Create config with impossible confidence threshold
    const strictConfig: RoutingConfig = {
      ...config,
      scoring: {
        ...config.scoring,
        confidenceThreshold: 0.99,
      },
    };

    const result = route("medium text", undefined, { config: strictConfig });

    expect(result.tier).toBe("MEDIUM"); // ambiguousDefaultTier
    expect(result.confidence).toBe(0.5);
    expect(result.reasoning).toContain("ambiguous");
    expect(result.reasoning).toContain("MEDIUM");
  });

  it("should respect custom ambiguousDefaultTier", () => {
    const customConfig: RoutingConfig = {
      ...config,
      scoring: {
        ...config.scoring,
        confidenceThreshold: 0.99,
      },
      overrides: {
        ...config.overrides,
        ambiguousDefaultTier: "SIMPLE",
      },
    };

    const result = route("medium text", undefined, { config: customConfig });

    expect(result.tier).toBe("SIMPLE");
    expect(result.reasoning).toContain("SIMPLE");
  });
});

describe("route() - Model Mapping", () => {
  it("should map SIMPLE tier to configured model", () => {
    const customConfig: RoutingConfig = {
      ...config,
      tiers: {
        SIMPLE: "custom-haiku",
        MEDIUM: "sonnet",
        COMPLEX: "opus",
      },
    };

    const result = route("hello", undefined, { config: customConfig });

    expect(result.tier).toBe("SIMPLE");
    expect(result.model).toBe("custom-haiku");
  });

  it("should map MEDIUM tier to configured model", () => {
    const customConfig: RoutingConfig = {
      ...config,
      tiers: {
        SIMPLE: "haiku",
        MEDIUM: "custom-sonnet",
        COMPLEX: "opus",
      },
    };

    const result = route("write a function", undefined, { config: customConfig });

    expect(result.tier).toBe("MEDIUM");
    expect(result.model).toBe("custom-sonnet");
  });

  it("should map COMPLEX tier to configured model", () => {
    const customConfig: RoutingConfig = {
      ...config,
      tiers: {
        SIMPLE: "haiku",
        MEDIUM: "sonnet",
        COMPLEX: "custom-opus",
      },
    };

    const result = route(
      "prove this theorem step by step",
      undefined,
      { config: customConfig },
    );

    expect(result.tier).toBe("COMPLEX");
    expect(result.model).toBe("custom-opus");
  });
});

describe("route() - Reasoning Output", () => {
  it("should include score in reasoning", () => {
    const result = route("test", undefined, { config });
    expect(result.reasoning).toMatch(/score=/);
  });

  it("should include signals in reasoning", () => {
    const result = route("hello", undefined, { config });
    // Should have "short (X tokens)" signal
    expect(result.reasoning).toContain("short");
  });

  it("should show ambiguous reasoning when applicable", () => {
    const strictConfig: RoutingConfig = {
      ...config,
      scoring: {
        ...config.scoring,
        confidenceThreshold: 0.99,
      },
    };

    const result = route("test", undefined, { config: strictConfig });
    expect(result.reasoning).toContain("ambiguous");
    expect(result.reasoning).toContain("default");
  });

  it("should format score to 3 decimal places", () => {
    const result = route("test", undefined, { config });
    const scoreMatch = result.reasoning.match(/score=([\d.-]+)/);
    expect(scoreMatch).not.toBe(null);

    if (scoreMatch) {
      const scorePart = scoreMatch[1];
      const decimalIndex = scorePart.indexOf(".");
      if (decimalIndex !== -1) {
        const decimals = scorePart.substring(decimalIndex + 1);
        expect(decimals.length).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe("route() - Edge Cases", () => {
  it("should handle empty prompt", () => {
    const result = route("", undefined, { config });
    expect(result.tier).toBe("SIMPLE");
    expect(result.model).toBe("haiku");
  });

  it("should handle very long prompt", () => {
    const longPrompt = "x".repeat(500000);
    const result = route(longPrompt, undefined, { config });
    expect(result.tier).toBe("COMPLEX");
  });

  it("should handle prompt with special characters", () => {
    const result = route("@#$%^&*()", undefined, { config });
    expect(result.tier).not.toBe(null);
  });

  it("should handle Unicode characters", () => {
    const result = route("こんにちは 🌍", undefined, { config });
    expect(result.tier).not.toBe(null);
  });

  it("should handle whitespace-only prompt", () => {
    const result = route("   \n\t  ", undefined, { config });
    expect(result.tier).toBe("SIMPLE");
  });

  it("should handle prompt with mixed languages", () => {
    const result = route(
      "Hello 你好 こんにちは مرحبا",
      undefined,
      { config },
    );
    expect(result.tier).not.toBe(null);
  });
});

describe("route() - Consistency", () => {
  it("should return consistent results for same input", () => {
    const prompt = "write a function to process data";
    const result1 = route(prompt, undefined, { config });
    const result2 = route(prompt, undefined, { config });

    expect(result1.tier).toBe(result2.tier);
    expect(result1.model).toBe(result2.model);
    expect(result1.confidence).toBe(result2.confidence);
  });

  it("should be case-insensitive", () => {
    const lower = route("hello world", undefined, { config });
    const upper = route("HELLO WORLD", undefined, { config });

    expect(lower.tier).toBe(upper.tier);
    expect(lower.model).toBe(upper.model);
  });
});

describe("route() - Method Field", () => {
  it("should always set method to 'rules'", () => {
    const simple = route("hello", undefined, { config });
    const complex = route("x".repeat(500000), undefined, { config });

    expect(simple.method).toBe("rules");
    expect(complex.method).toBe("rules");
  });
});
