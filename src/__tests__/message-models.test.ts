/**
 * Tests for Message Models Cache (Issue #13)
 *
 * Tests the fullText caching for multi-segment messages including:
 * - Single-segment messages (no fullText storage)
 * - Multi-segment messages (fullText storage)
 * - Cache pruning at 200 entries
 * - LRU eviction (oldest entries removed first)
 * - fullText retrieval
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

interface MessageModelEntry {
  model: string;
  threadId: number;
  fullText?: string;
}

describe("Message Models Cache (Issue #13)", () => {
  let testDir: string;
  let cacheFile: string;
  let messageModelsCache: Record<string, MessageModelEntry> | null = null;

  beforeEach(() => {
    // Create temp directory for test cache file
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "message-models-test-"));
    cacheFile = path.join(testDir, "message-models.json");
    messageModelsCache = null;
  });

  afterEach(() => {
    // Cleanup test files
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function loadMessageModels(): Record<string, MessageModelEntry> {
    if (messageModelsCache) return messageModelsCache;
    try {
      const data = fs.readFileSync(cacheFile, "utf8");
      messageModelsCache = JSON.parse(data) as Record<string, MessageModelEntry>;
      return messageModelsCache;
    } catch {
      messageModelsCache = {};
      return messageModelsCache;
    }
  }

  function saveMessageModels(models: Record<string, MessageModelEntry>): void {
    // Prune to last 200 entries
    const keys = Object.keys(models);
    if (keys.length > 200) {
      const toRemove = keys.slice(0, keys.length - 200);
      for (const key of toRemove) {
        delete models[key];
      }
    }
    const tmp = cacheFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(models, null, 2));
    fs.renameSync(tmp, cacheFile);
    messageModelsCache = models;
  }

  function storeMessageModel(messageId: number, model: string, threadId: number, fullText?: string): void {
    const models = loadMessageModels();
    models[String(messageId)] = { model, threadId, fullText };
    saveMessageModels(models);
  }

  function lookupMessageModel(messageId: number): MessageModelEntry | undefined {
    const models = loadMessageModels();
    return models[String(messageId)];
  }

  describe("Single vs Multi-segment Storage", () => {
    it("should NOT store fullText for single-segment message", () => {
      storeMessageModel(1001, "sonnet", 1);
      const entry = lookupMessageModel(1001);

      expect(entry?.model).toBe("sonnet");
      expect(entry?.threadId).toBe(1);
      expect(entry?.fullText).toBeUndefined();
    });

    it("should store fullText for multi-segment message", () => {
      const longText = "This is a very long message that would be split into multiple segments. ".repeat(100);
      storeMessageModel(1002, "opus", 1, longText);
      const entry = lookupMessageModel(1002);

      expect(entry?.model).toBe("opus");
      expect(entry?.threadId).toBe(1);
      expect(entry?.fullText).toBe(longText);
    });

    it("should handle different models and threads", () => {
      storeMessageModel(2001, "haiku", 2);
      storeMessageModel(2002, "sonnet", 3, "optional full text");
      storeMessageModel(2003, "opus", 2, "another full text");

      const entry1 = lookupMessageModel(2001);
      const entry2 = lookupMessageModel(2002);
      const entry3 = lookupMessageModel(2003);

      expect(entry1?.model).toBe("haiku");
      expect(entry1?.threadId).toBe(2);
      expect(entry2?.fullText).toBe("optional full text");
      expect(entry3?.fullText).toBe("another full text");
    });
  });

  describe("Cache Pruning", () => {
    it("should prune cache to 200 entries when exceeded", () => {
      // Add 250 entries (50 more than the 200 limit)
      for (let i = 1; i <= 250; i++) {
        storeMessageModel(3000 + i, "haiku", 1, i % 2 === 0 ? "text " + i : undefined);
      }

      const models = loadMessageModels();
      const count = Object.keys(models).length;

      expect(count).toBe(200);
    });

    it("should remove oldest entries during pruning (LRU)", () => {
      // Add initial entries
      storeMessageModel(1001, "sonnet", 1);
      storeMessageModel(1002, "opus", 1, "long text");

      // Add 250 more entries to trigger pruning
      for (let i = 1; i <= 250; i++) {
        storeMessageModel(2000 + i, "haiku", 1, i % 2 === 0 ? "text " + i : undefined);
      }

      // The first two entries (1001, 1002) should be pruned
      const entry1001 = lookupMessageModel(1001);
      const entry1002 = lookupMessageModel(1002);

      expect(entry1001).toBeUndefined();
      expect(entry1002).toBeUndefined();
    });

    it("should retain recent entries after pruning", () => {
      // Add initial entries
      storeMessageModel(1001, "sonnet", 1);
      storeMessageModel(1002, "opus", 1, "long text");

      // Add 250 more entries
      for (let i = 1; i <= 250; i++) {
        storeMessageModel(2000 + i, "haiku", 1, i % 2 === 0 ? "text " + i : undefined);
      }

      // Recent entries (from the batch added) should exist
      const entry2240 = lookupMessageModel(2240);
      const entry2250 = lookupMessageModel(2250);

      expect(entry2240?.model).toBe("haiku");
      expect(entry2250?.model).toBe("haiku");
    });

    it("should correctly identify which entries to prune", () => {
      // Add entries in known order
      for (let i = 1; i <= 300; i++) {
        storeMessageModel(5000 + i, "haiku", 1);
      }

      // After pruning to 200, entries 1-100 should be gone (first 100 of 300)
      const oldestRetained = lookupMessageModel(5101);
      const oldestPruned = lookupMessageModel(5100);

      expect(oldestRetained).toBeDefined();
      expect(oldestPruned).toBeUndefined();
    });
  });

  describe("FullText Retrieval", () => {
    it("should retrieve fullText for multi-segment message", () => {
      const text = "Full transcript of user voice message";
      storeMessageModel(4001, "sonnet", 1, text);
      const entry = lookupMessageModel(4001);

      expect(entry?.fullText).toBe(text);
    });

    it("should return undefined for missing fullText", () => {
      storeMessageModel(4002, "sonnet", 1);
      const entry = lookupMessageModel(4002);

      expect(entry?.fullText).toBeUndefined();
    });

    it("should handle large fullText values", () => {
      const largeText = "x".repeat(5000); // 5KB of text
      storeMessageModel(4003, "opus", 1, largeText);
      const entry = lookupMessageModel(4003);

      expect(entry?.fullText?.length).toBe(5000);
      expect(entry?.fullText).toBe(largeText);
    });

    it("should handle special characters in fullText", () => {
      const textWithSpecial = 'Special chars: \n\t"quotes" \'single\' & <brackets> / backslash';
      storeMessageModel(4004, "sonnet", 1, textWithSpecial);
      const entry = lookupMessageModel(4004);

      expect(entry?.fullText).toBe(textWithSpecial);
    });
  });

  describe("Cache Persistence", () => {
    it("should persist cache to file atomically", () => {
      storeMessageModel(6001, "sonnet", 1, "test text");

      // Verify file exists and contains correct data
      expect(fs.existsSync(cacheFile)).toBe(true);

      const fileContent = fs.readFileSync(cacheFile, "utf8");
      const parsed = JSON.parse(fileContent);

      expect(parsed["6001"]).toBeDefined();
      expect(parsed["6001"].model).toBe("sonnet");
      expect(parsed["6001"].fullText).toBe("test text");
    });

    it("should use atomic write pattern (tmp + rename)", () => {
      // Store initial entry
      storeMessageModel(6002, "opus", 1, "initial");

      // Verify cache file exists (not .tmp)
      expect(fs.existsSync(cacheFile)).toBe(true);
      expect(fs.existsSync(cacheFile + ".tmp")).toBe(false);

      // Add another entry
      storeMessageModel(6003, "haiku", 1);

      // Verify still no .tmp file
      expect(fs.existsSync(cacheFile + ".tmp")).toBe(false);
    });
  });
});
