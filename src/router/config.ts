/**
 * Default Routing Config
 *
 * Scoring uses 14 weighted dimensions with sigmoid confidence calibration.
 *
 * Adapted from ClawRouter (MIT licensed, BlockRunAI)
 */

import type { RoutingConfig } from "./types.js";

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  version: "1.0",

  scoring: {
    tokenCountThresholds: { simple: 50, complex: 500 },

    codeKeywords: [
      "function", "class", "import", "def", "select", "async", "await",
      "const", "let", "var", "return", "```",
      // Chinese
      "函数", "类", "导入", "定义", "查询", "异步",
      // Japanese
      "関数", "クラス", "インポート", "非同期",
    ],

    reasoningKeywords: [
      "prove", "theorem", "derive", "step by step", "chain of thought",
      "formally", "mathematical", "proof", "logically",
      // Chinese
      "证明", "定理", "推导", "逐步", "思维链",
      // Japanese
      "証明", "定理", "導出", "ステップバイステップ",
    ],

    simpleKeywords: [
      "what is", "define", "translate", "hello", "yes or no",
      "capital of", "how old", "who is", "when was",
      // Chinese
      "什么是", "定义", "翻译", "你好", "是否",
      // Japanese
      "とは", "定義", "翻訳", "こんにちは",
    ],

    technicalKeywords: [
      "algorithm", "optimize", "architecture", "distributed",
      "kubernetes", "microservice", "database", "infrastructure",
      // Chinese
      "算法", "优化", "架构", "分布式", "微服务",
      // Japanese
      "アルゴリズム", "最適化", "アーキテクチャ",
    ],

    creativeKeywords: [
      "story", "poem", "compose", "brainstorm", "creative", "imagine", "write a",
      // Chinese
      "故事", "诗", "创作", "头脑风暴", "创意",
      // Japanese
      "物語", "詩", "作曲", "ブレインストーム",
    ],

    imperativeVerbs: [
      "build", "create", "implement", "design", "develop",
      "construct", "generate", "deploy", "configure", "set up",
    ],

    constraintIndicators: [
      "under", "at most", "at least", "within", "no more than",
      "o(", "maximum", "minimum", "limit", "budget",
    ],

    outputFormatKeywords: [
      "json", "yaml", "xml", "table", "csv", "markdown", "schema",
      "format as", "structured",
    ],

    referenceKeywords: [
      "above", "below", "previous", "following", "the docs",
      "the api", "the code", "earlier", "attached",
    ],

    negationKeywords: [
      "don't", "do not", "avoid", "never", "without",
      "except", "exclude", "no longer",
    ],

    domainSpecificKeywords: [
      "quantum", "fpga", "vlsi", "risc-v", "asic", "photonics",
      "genomics", "proteomics", "topological", "homomorphic",
      "zero-knowledge", "lattice-based",
    ],

    // Dimension weights (sum to 1.0)
    dimensionWeights: {
      tokenCount: 0.08,
      codePresence: 0.15,
      reasoningMarkers: 0.18,
      technicalTerms: 0.10,
      creativeMarkers: 0.05,
      simpleIndicators: 0.12,
      multiStepPatterns: 0.12,
      questionComplexity: 0.05,
      imperativeVerbs: 0.03,
      constraintCount: 0.04,
      outputFormat: 0.03,
      referenceComplexity: 0.02,
      negationComplexity: 0.01,
      domainSpecificity: 0.02,
    },

    // Tier boundaries (simplified to 3 tiers)
    tierBoundaries: {
      simpleMedium: 0.08,
      mediumComplex: 0.20,
    },

    confidenceSteepness: 12,
    confidenceThreshold: 0.7,
  },

  tiers: {
    SIMPLE: "haiku",
    MEDIUM: "sonnet",
    COMPLEX: "opus",
  },

  overrides: {
    maxTokensForceComplex: 100_000,
    ambiguousDefaultTier: "MEDIUM",
  },
};
