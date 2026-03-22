import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
    writeThreadStatus,
    readThreadStatus,
    clearThreadStatus,
    updateThreadStatusAnchor,
    listActiveThreadStatuses,
    type ThreadStatusData,
} from "../thread-status.js";

const TEMP_DIR = path.join("/tmp", `thread-status-test-${process.pid}`);

beforeEach(() => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

function makeStatus(overrides: Partial<ThreadStatusData> = {}): ThreadStatusData {
    return {
        threadId: 42,
        label: "Thinking",
        startTs: 1000,
        ts: 2000,
        anchorMessageId: "msg_abc",
        ...overrides,
    };
}

// ─── writeThreadStatus + readThreadStatus ───

describe("writeThreadStatus + readThreadStatus", () => {
    it("roundtrips all fields", () => {
        const data = makeStatus({
            preview: "partial response...",
            fullText: "full response text here",
            sessionId: "sess_123",
        });
        writeThreadStatus(TEMP_DIR, data);
        const result = readThreadStatus(TEMP_DIR, 42);
        expect(result).toEqual(data);
    });

    it("writes to thread_{threadId}.json", () => {
        writeThreadStatus(TEMP_DIR, makeStatus({ threadId: 99 }));
        expect(fs.existsSync(path.join(TEMP_DIR, "thread_99.json"))).toBe(true);
    });

    it("creates the status directory if it doesn't exist", () => {
        const nestedDir = path.join(TEMP_DIR, "nested", "status");
        writeThreadStatus(nestedDir, makeStatus());
        expect(fs.existsSync(path.join(nestedDir, "thread_42.json"))).toBe(true);
    });

    it("overwrites existing status", () => {
        writeThreadStatus(TEMP_DIR, makeStatus({ label: "Thinking" }));
        writeThreadStatus(TEMP_DIR, makeStatus({ label: "Using Bash [3]" }));
        const result = readThreadStatus(TEMP_DIR, 42);
        expect(result?.label).toBe("Using Bash [3]");
    });

    it("does not leave tmp files on success", () => {
        writeThreadStatus(TEMP_DIR, makeStatus());
        const files = fs.readdirSync(TEMP_DIR);
        expect(files.filter(f => f.endsWith(".tmp"))).toEqual([]);
    });

    it("handles optional fields being undefined", () => {
        const data = makeStatus(); // no preview, fullText, sessionId
        writeThreadStatus(TEMP_DIR, data);
        const result = readThreadStatus(TEMP_DIR, 42);
        expect(result?.preview).toBeUndefined();
        expect(result?.fullText).toBeUndefined();
        expect(result?.sessionId).toBeUndefined();
    });
});

// ─── readThreadStatus edge cases ───

describe("readThreadStatus", () => {
    it("returns null for missing file", () => {
        expect(readThreadStatus(TEMP_DIR, 999)).toBeNull();
    });

    it("returns null for missing directory", () => {
        expect(readThreadStatus("/nonexistent/path", 42)).toBeNull();
    });

    it("returns null for corrupt JSON", () => {
        const filePath = path.join(TEMP_DIR, "thread_42.json");
        fs.writeFileSync(filePath, "not json{{{");
        expect(readThreadStatus(TEMP_DIR, 42)).toBeNull();
    });

    it("returns null for valid JSON with missing required fields", () => {
        const filePath = path.join(TEMP_DIR, "thread_42.json");
        fs.writeFileSync(filePath, JSON.stringify({ threadId: 42, label: "Thinking" }));
        // Missing anchorMessageId
        expect(readThreadStatus(TEMP_DIR, 42)).toBeNull();
    });

    it("returns null for wrong types in required fields", () => {
        const filePath = path.join(TEMP_DIR, "thread_42.json");
        fs.writeFileSync(filePath, JSON.stringify({
            threadId: "not a number",
            label: "Thinking",
            anchorMessageId: "msg_abc",
        }));
        expect(readThreadStatus(TEMP_DIR, 42)).toBeNull();
    });
});

// ─── clearThreadStatus ───

describe("clearThreadStatus", () => {
    it("removes the status file", () => {
        writeThreadStatus(TEMP_DIR, makeStatus());
        expect(readThreadStatus(TEMP_DIR, 42)).not.toBeNull();
        clearThreadStatus(TEMP_DIR, 42);
        expect(readThreadStatus(TEMP_DIR, 42)).toBeNull();
    });

    it("is a no-op for missing file", () => {
        // Should not throw
        clearThreadStatus(TEMP_DIR, 999);
    });

    it("is a no-op for missing directory", () => {
        clearThreadStatus("/nonexistent/path", 42);
    });

    it("does not affect other threads", () => {
        writeThreadStatus(TEMP_DIR, makeStatus({ threadId: 42 }));
        writeThreadStatus(TEMP_DIR, makeStatus({ threadId: 43 }));
        clearThreadStatus(TEMP_DIR, 42);
        expect(readThreadStatus(TEMP_DIR, 42)).toBeNull();
        expect(readThreadStatus(TEMP_DIR, 43)).not.toBeNull();
    });
});

// ─── updateThreadStatusAnchor ───

describe("updateThreadStatusAnchor", () => {
    it("updates the anchor while preserving other fields", () => {
        writeThreadStatus(TEMP_DIR, makeStatus({
            label: "Using Edit [2]",
            preview: "some preview",
            sessionId: "sess_abc",
        }));
        updateThreadStatusAnchor(TEMP_DIR, 42, "msg_new");
        const result = readThreadStatus(TEMP_DIR, 42);
        expect(result?.anchorMessageId).toBe("msg_new");
        expect(result?.label).toBe("Using Edit [2]");
        expect(result?.preview).toBe("some preview");
        expect(result?.sessionId).toBe("sess_abc");
    });

    it("updates the ts field", () => {
        writeThreadStatus(TEMP_DIR, makeStatus({ ts: 1000 }));
        const before = Date.now();
        updateThreadStatusAnchor(TEMP_DIR, 42, "msg_new");
        const result = readThreadStatus(TEMP_DIR, 42);
        expect(result?.ts).toBeGreaterThanOrEqual(before);
    });

    it("creates a Queued status if no existing file", () => {
        updateThreadStatusAnchor(TEMP_DIR, 42, "msg_first");
        const result = readThreadStatus(TEMP_DIR, 42);
        expect(result).not.toBeNull();
        expect(result?.label).toBe("Queued");
        expect(result?.anchorMessageId).toBe("msg_first");
        expect(result?.threadId).toBe(42);
    });

    it("is idempotent", () => {
        writeThreadStatus(TEMP_DIR, makeStatus());
        updateThreadStatusAnchor(TEMP_DIR, 42, "msg_new");
        updateThreadStatusAnchor(TEMP_DIR, 42, "msg_new");
        const result = readThreadStatus(TEMP_DIR, 42);
        expect(result?.anchorMessageId).toBe("msg_new");
    });
});

// ─── listActiveThreadStatuses ───

describe("listActiveThreadStatuses", () => {
    it("returns empty for missing directory", () => {
        expect(listActiveThreadStatuses("/nonexistent")).toEqual([]);
    });

    it("returns empty for empty directory", () => {
        expect(listActiveThreadStatuses(TEMP_DIR)).toEqual([]);
    });

    it("returns thread IDs for status files", () => {
        writeThreadStatus(TEMP_DIR, makeStatus({ threadId: 42 }));
        writeThreadStatus(TEMP_DIR, makeStatus({ threadId: 99 }));
        writeThreadStatus(TEMP_DIR, makeStatus({ threadId: 1 }));
        const result = listActiveThreadStatuses(TEMP_DIR);
        expect(result.sort()).toEqual([1, 42, 99]);
    });

    it("ignores non-thread files", () => {
        writeThreadStatus(TEMP_DIR, makeStatus({ threadId: 42 }));
        fs.writeFileSync(path.join(TEMP_DIR, "other_file.json"), "{}");
        fs.writeFileSync(path.join(TEMP_DIR, "thread_bad.json"), "{}"); // "bad" is not a number
        const result = listActiveThreadStatuses(TEMP_DIR);
        expect(result).toEqual([42]);
    });

    it("ignores .tmp files", () => {
        writeThreadStatus(TEMP_DIR, makeStatus({ threadId: 42 }));
        fs.writeFileSync(path.join(TEMP_DIR, "thread_99.json.tmp"), "{}");
        const result = listActiveThreadStatuses(TEMP_DIR);
        expect(result).toEqual([42]);
    });
});

// ─── Scenario: message injection flow ───

describe("injection scenario", () => {
    it("simulates the full injection status lifecycle", () => {
        // 1. Primary message dispatched — status created
        writeThreadStatus(TEMP_DIR, makeStatus({
            threadId: 42,
            label: "Thinking",
            anchorMessageId: "msg_1",
        }));
        let status = readThreadStatus(TEMP_DIR, 42);
        expect(status?.label).toBe("Thinking");
        expect(status?.anchorMessageId).toBe("msg_1");

        // 2. Tool use updates
        writeThreadStatus(TEMP_DIR, makeStatus({
            threadId: 42,
            label: "Using Edit [2]",
            anchorMessageId: "msg_1",
            preview: "Making changes...",
        }));
        status = readThreadStatus(TEMP_DIR, 42);
        expect(status?.label).toBe("Using Edit [2]");

        // 3. User sends follow-up (injected) — anchor migrates
        updateThreadStatusAnchor(TEMP_DIR, 42, "msg_2");
        status = readThreadStatus(TEMP_DIR, 42);
        expect(status?.anchorMessageId).toBe("msg_2");
        expect(status?.label).toBe("Using Edit [2]"); // label preserved

        // 4. Another follow-up — anchor migrates again
        updateThreadStatusAnchor(TEMP_DIR, 42, "msg_3");
        status = readThreadStatus(TEMP_DIR, 42);
        expect(status?.anchorMessageId).toBe("msg_3");

        // 5. Response complete — status cleared
        clearThreadStatus(TEMP_DIR, 42);
        expect(readThreadStatus(TEMP_DIR, 42)).toBeNull();
        expect(listActiveThreadStatuses(TEMP_DIR)).toEqual([]);
    });

    it("simulates queued injection when no status exists yet", () => {
        // User sends a message that gets injected before queue-processor
        // has written any status (e.g., very fast follow-up)
        updateThreadStatusAnchor(TEMP_DIR, 42, "msg_fast");
        const status = readThreadStatus(TEMP_DIR, 42);
        expect(status?.label).toBe("Queued");
        expect(status?.anchorMessageId).toBe("msg_fast");
    });

    it("multiple threads don't interfere", () => {
        writeThreadStatus(TEMP_DIR, makeStatus({
            threadId: 42,
            label: "Thinking",
            anchorMessageId: "msg_a",
        }));
        writeThreadStatus(TEMP_DIR, makeStatus({
            threadId: 43,
            label: "Using Bash [1]",
            anchorMessageId: "msg_b",
        }));

        updateThreadStatusAnchor(TEMP_DIR, 42, "msg_a2");

        expect(readThreadStatus(TEMP_DIR, 42)?.anchorMessageId).toBe("msg_a2");
        expect(readThreadStatus(TEMP_DIR, 43)?.anchorMessageId).toBe("msg_b");
        expect(readThreadStatus(TEMP_DIR, 43)?.label).toBe("Using Bash [1]");
    });
});
