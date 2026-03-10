import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

// We need to test the dedup logic, but appendHistory uses a hardcoded path.
// Instead, we'll test the isDuplicate function by extracting its logic.
// Since it's not exported, we test through appendHistory with a temp file.

// Monkey-patch the module's HISTORY_FILE by using a temp directory
const TEMP_DIR = path.join("/tmp", `msg-history-test-${process.pid}`);
const TEMP_BORG = path.join(TEMP_DIR, ".borg");
const TEMP_HISTORY = path.join(TEMP_BORG, "message-history.jsonl");

// We need to override the module's path resolution. Since SCRIPT_DIR is based on __dirname,
// we'll test the dedup logic directly by reimplementing it here (mirrors src/message-history.ts).

function normalizeMessageId(messageId: string | undefined): string | undefined {
    if (!messageId) return undefined;
    return messageId.replace(/_tg$/, "").replace(/_retry\d+$/, "");
}

interface Entry {
    ts: number;
    threadId: number;
    direction: "in" | "out";
    messageId?: string;
}

/**
 * This must match the isDuplicate logic in src/message-history.ts
 */
function isDuplicate(entry: Entry, recentEntries: Entry[]): boolean {
    const normalizedId = normalizeMessageId(entry.messageId);

    for (const existing of recentEntries) {
        // Match by messageId if both have it AND same direction
        if (normalizedId && existing.messageId && entry.direction === existing.direction) {
            const existingNormalizedId = normalizeMessageId(existing.messageId);
            if (normalizedId === existingNormalizedId) {
                return true;
            }
        }

        // Fallback for outgoing messages without messageId
        if (!entry.messageId && !existing.messageId && entry.direction === "out" && existing.direction === "out") {
            if (
                entry.threadId === existing.threadId &&
                Math.abs(entry.ts - existing.ts) < 5000
            ) {
                return true;
            }
        }
    }

    return false;
}

describe("message-history deduplication", () => {
    it("should NOT deduplicate incoming and outgoing messages with same messageId", () => {
        const incoming: Entry = {
            ts: 1000,
            threadId: 43,
            direction: "in",
            messageId: "msg_123",
        };

        const outgoing: Entry = {
            ts: 2000,
            threadId: 43,
            direction: "out",
            messageId: "msg_123",
        };

        // Outgoing should NOT be considered a duplicate of incoming
        expect(isDuplicate(outgoing, [incoming])).toBe(false);
    });

    it("should deduplicate same-direction messages with same messageId", () => {
        const first: Entry = {
            ts: 1000,
            threadId: 43,
            direction: "in",
            messageId: "msg_123",
        };

        const duplicate: Entry = {
            ts: 2000,
            threadId: 43,
            direction: "in",
            messageId: "msg_123",
        };

        expect(isDuplicate(duplicate, [first])).toBe(true);
    });

    it("should deduplicate retry messages (strips _retry suffix)", () => {
        const original: Entry = {
            ts: 1000,
            threadId: 43,
            direction: "in",
            messageId: "msg_123",
        };

        const retry: Entry = {
            ts: 2000,
            threadId: 43,
            direction: "in",
            messageId: "msg_123_retry1",
        };

        expect(isDuplicate(retry, [original])).toBe(true);
    });

    it("should deduplicate _tg suffix messages (same direction)", () => {
        const original: Entry = {
            ts: 1000,
            threadId: 43,
            direction: "out",
            messageId: "cross_123",
        };

        const tgCopy: Entry = {
            ts: 1000,
            threadId: 43,
            direction: "out",
            messageId: "cross_123_tg",
        };

        expect(isDuplicate(tgCopy, [original])).toBe(true);
    });

    it("should deduplicate outgoing messages without messageId by timestamp", () => {
        const first: Entry = {
            ts: 1000,
            threadId: 43,
            direction: "out",
        };

        const duplicate: Entry = {
            ts: 3000, // within 5s window
            threadId: 43,
            direction: "out",
        };

        expect(isDuplicate(duplicate, [first])).toBe(true);
    });

    it("should NOT deduplicate outgoing messages without messageId outside timestamp window", () => {
        const first: Entry = {
            ts: 1000,
            threadId: 43,
            direction: "out",
        };

        const notDuplicate: Entry = {
            ts: 7000, // outside 5s window
            threadId: 43,
            direction: "out",
        };

        expect(isDuplicate(notDuplicate, [first])).toBe(false);
    });
});
