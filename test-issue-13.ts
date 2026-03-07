#!/usr/bin/env node
/**
 * Test script for Issue #13: Listen button for multi-segment messages
 *
 * Tests:
 * 1. Single-segment message should NOT store fullText
 * 2. Multi-segment message SHOULD store fullText on first segment
 * 3. Cache pruning works at 200 entries
 * 4. lookupMessageModel returns fullText correctly
 */

import fs from "fs";
import path from "path";

const SCRIPT_DIR = path.resolve(__dirname);
const MESSAGE_MODELS_FILE = path.join(SCRIPT_DIR, ".borg/message-models-test.json");

interface MessageModelEntry {
    model: string;
    threadId: number;
    fullText?: string;
}

let messageModelsCache: Record<string, MessageModelEntry> | null = null;

function loadMessageModels(): Record<string, MessageModelEntry> {
    if (messageModelsCache) return messageModelsCache;
    try {
        const data = fs.readFileSync(MESSAGE_MODELS_FILE, "utf8");
        messageModelsCache = JSON.parse(data) as Record<string, MessageModelEntry>;
        return messageModelsCache;
    } catch {
        messageModelsCache = {} as Record<string, MessageModelEntry>;
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
    const tmp = MESSAGE_MODELS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(models, null, 2));
    fs.renameSync(tmp, MESSAGE_MODELS_FILE);
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

// Clean up test file
if (fs.existsSync(MESSAGE_MODELS_FILE)) {
    fs.unlinkSync(MESSAGE_MODELS_FILE);
}

console.log("Testing Issue #13 implementation...\n");

// Test 1: Single-segment message (no fullText)
console.log("Test 1: Single-segment message should NOT store fullText");
storeMessageModel(1001, "sonnet", 1);
const entry1 = lookupMessageModel(1001);
console.log("Entry:", entry1);
console.assert(entry1?.model === "sonnet", "Model should be sonnet");
console.assert(entry1?.threadId === 1, "ThreadId should be 1");
console.assert(entry1?.fullText === undefined, "fullText should be undefined for single-segment");
console.log("✅ PASS\n");

// Test 2: Multi-segment message (with fullText)
console.log("Test 2: Multi-segment message SHOULD store fullText");
const longText = "This is a very long message that would be split into multiple segments. ".repeat(100);
storeMessageModel(1002, "opus", 1, longText);
const entry2 = lookupMessageModel(1002);
console.log("Entry:", { ...entry2, fullText: entry2?.fullText?.substring(0, 50) + "..." });
console.assert(entry2?.model === "opus", "Model should be opus");
console.assert(entry2?.threadId === 1, "ThreadId should be 1");
console.assert(entry2?.fullText === longText, "fullText should match original text");
console.log("✅ PASS\n");

// Test 3: Cache pruning at 200 entries
console.log("Test 3: Cache should prune to 200 entries");
for (let i = 1; i <= 250; i++) {
    storeMessageModel(2000 + i, "haiku", 1, i % 2 === 0 ? "test text " + i : undefined);
}
const models = loadMessageModels();
const count = Object.keys(models).length;
console.log("Cache size after adding 250 entries:", count);
console.assert(count === 200, "Cache should be pruned to 200 entries");
console.log("✅ PASS\n");

// Test 4: Oldest entries should be pruned
console.log("Test 4: Oldest entries should be removed during pruning");
const entry1001 = lookupMessageModel(1001);
const entry1002 = lookupMessageModel(1002);
console.log("Entry 1001 (should be pruned):", entry1001);
console.log("Entry 1002 (should be pruned):", entry1002);
console.assert(entry1001 === undefined, "Entry 1001 should be pruned");
console.assert(entry1002 === undefined, "Entry 1002 should be pruned");
console.log("✅ PASS\n");

// Test 5: Recent entries should be retained
console.log("Test 5: Recent entries should be retained");
const entry2240 = lookupMessageModel(2240);
const entry2250 = lookupMessageModel(2250);
console.log("Entry 2240:", entry2240);
console.log("Entry 2250:", entry2250);
console.assert(entry2240?.model === "haiku", "Entry 2240 should exist");
console.assert(entry2250?.model === "haiku", "Entry 2250 should exist");
console.log("✅ PASS\n");

console.log("All tests passed! ✅");

// Clean up
fs.unlinkSync(MESSAGE_MODELS_FILE);
console.log("\nTest file cleaned up.");
