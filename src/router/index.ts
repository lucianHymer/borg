/**
 * Anthropic Router - Main Entry Point
 *
 * Classifies requests and routes to the cheapest Anthropic model.
 * 100% local — rules-based scoring handles all requests in <1ms.
 *
 * Adapted from ClawRouter (MIT licensed, BlockRunAI)
 */

import type { Tier, RoutingDecision, RoutingConfig } from "./types.js";
import { classifyByRules } from "./rules.js";

export type RouterOptions = {
  config: RoutingConfig;
};

/**
 * Route a request to the cheapest capable Anthropic model.
 *
 * 1. Check overrides (large context)
 * 2. Run rule-based classifier (14 weighted dimensions, <1ms)
 * 3. If ambiguous, default to MEDIUM tier
 * 4. Return model for tier
 */
export function route(
  prompt: string,
  systemPrompt: string | undefined,
  options: RouterOptions,
): RoutingDecision {
  const { config } = options;

  // Estimate input tokens (~4 chars per token)
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const estimatedTokens = Math.ceil(fullText.length / 4);

  // Override: large context → force COMPLEX
  if (estimatedTokens > config.overrides.maxTokensForceComplex) {
    return {
      model: config.tiers.COMPLEX,
      tier: "COMPLEX",
      confidence: 0.95,
      method: "rules",
      reasoning: `Input exceeds ${config.overrides.maxTokensForceComplex} tokens`,
      signals: ["large-context"],
      estimatedTokens,
    };
  }

  // Rule-based classification
  const ruleResult = classifyByRules(prompt, systemPrompt, estimatedTokens, config.scoring);

  let tier: Tier;
  let confidence: number;
  let reasoning = `score=${ruleResult.score.toFixed(3)} | ${ruleResult.signals.join(", ")}`;

  if (ruleResult.tier !== null) {
    tier = ruleResult.tier;
    confidence = ruleResult.confidence;
  } else {
    // Ambiguous — default to MEDIUM
    tier = config.overrides.ambiguousDefaultTier;
    confidence = 0.5;
    reasoning += ` | ambiguous -> default: ${tier}`;
  }

  return {
    model: config.tiers[tier],
    tier,
    confidence,
    method: "rules",
    reasoning,
    signals: ruleResult.signals,
    estimatedTokens,
  };
}

export { DEFAULT_ROUTING_CONFIG } from "./config.js";
export { maxTier } from "./types.js";
export type { RoutingDecision, Tier, DimensionName, RoutingConfig, ScoringConfig, TierConfig } from "./types.js";
