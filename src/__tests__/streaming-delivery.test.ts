import { describe, it, expect } from "vitest";
import type { OutgoingMessage } from "../types.js";

// ─── writeStreamingOutgoing format validation ───

function makeStreamingMessage(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
    return {
        channel: "telegram",
        threadId: 42,
        sender: "user",
        model: "sonnet",
        message: "Hello from the stream",
        originalMessage: "(streaming text block)",
        timestamp: Date.now(),
        messageId: "msg_abc",
        streaming: true,
        streamSequence: 0,
        ...overrides,
    };
}

function makeStreamCompleteMessage(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
    return {
        channel: "telegram",
        threadId: 42,
        sender: "user",
        model: "sonnet",
        message: "Full accumulated text here",
        originalMessage: "(stream complete)",
        timestamp: Date.now(),
        messageId: "msg_abc",
        streamComplete: true,
        accumulatedText: "Full accumulated text here",
        ...overrides,
    };
}

describe("streaming OutgoingMessage format", () => {
    it("streaming message has required fields", () => {
        const msg = makeStreamingMessage();
        expect(msg.streaming).toBe(true);
        expect(msg.streamSequence).toBe(0);
        expect(msg.streamComplete).toBeUndefined();
        expect(msg.accumulatedText).toBeUndefined();
    });

    it("streaming message serializes to valid JSON", () => {
        const msg = makeStreamingMessage({ streamSequence: 3 });
        const json = JSON.stringify(msg, null, 2);
        const parsed = JSON.parse(json);
        expect(parsed.streaming).toBe(true);
        expect(parsed.streamSequence).toBe(3);
        expect(parsed.threadId).toBe(42);
        expect(parsed.message).toBe("Hello from the stream");
    });

    it("streamComplete message has accumulatedText", () => {
        const msg = makeStreamCompleteMessage();
        expect(msg.streamComplete).toBe(true);
        expect(msg.accumulatedText).toBe("Full accumulated text here");
        expect(msg.streaming).toBeUndefined();
    });

    it("streamComplete serializes to valid JSON", () => {
        const msg = makeStreamCompleteMessage({ accumulatedText: "test text" });
        const json = JSON.stringify(msg, null, 2);
        const parsed = JSON.parse(json);
        expect(parsed.streamComplete).toBe(true);
        expect(parsed.accumulatedText).toBe("test text");
    });

    it("streaming and streamComplete are mutually exclusive", () => {
        const streaming = makeStreamingMessage();
        const complete = makeStreamCompleteMessage();
        expect(streaming.streaming).toBe(true);
        expect(streaming.streamComplete).toBeUndefined();
        expect(complete.streamComplete).toBe(true);
        expect(complete.streaming).toBeUndefined();
    });
});

// ─── Stream blocks tracking ───

describe("streamBlocks tracking", () => {
    it("tracks Telegram message_ids per stream", () => {
        const blocks = new Map<string, number[]>();

        // Simulate 3 streaming blocks arriving
        const anchorId = "msg_123";
        blocks.set(anchorId, []);
        blocks.get(anchorId)!.push(1001);
        blocks.get(anchorId)!.push(1002);
        blocks.get(anchorId)!.push(1003);

        expect(blocks.get(anchorId)).toEqual([1001, 1002, 1003]);
    });

    it("getLast returns the last block", () => {
        const blocks = new Map<string, number[]>();
        const anchorId = "msg_456";
        blocks.set(anchorId, [2001, 2002, 2003]);

        const arr = blocks.get(anchorId)!;
        const last = arr[arr.length - 1];
        expect(last).toBe(2003);
    });

    it("clear removes the entry", () => {
        const blocks = new Map<string, number[]>();
        blocks.set("msg_789", [3001, 3002]);
        blocks.delete("msg_789");
        expect(blocks.has("msg_789")).toBe(false);
    });

    it("handles empty blocks array", () => {
        const blocks = new Map<string, number[]>();
        blocks.set("msg_empty", []);
        const arr = blocks.get("msg_empty")!;
        expect(arr.length).toBe(0);
        expect(arr[arr.length - 1]).toBeUndefined();
    });
});

// ─── Outgoing file sorting ───

describe("outgoing file sorting", () => {
    it("sorts streaming files in sequence order", () => {
        const files = [
            "stream_42_msg_abc_2_1710000003.json",
            "stream_42_msg_abc_0_1710000001.json",
            "stream_42_msg_abc_1_1710000002.json",
            "stream_complete_42_msg_abc_1710000004.json",
        ];

        files.sort((a, b) => a.localeCompare(b));

        // stream_ sorts before stream_complete_ because 'stream_4' < 'stream_c'
        expect(files[0]).toContain("_0_");
        expect(files[1]).toContain("_1_");
        expect(files[2]).toContain("_2_");
        expect(files[3]).toContain("stream_complete");
    });

    it("batch messages sort after streaming messages", () => {
        const files = [
            "telegram_user123_1710000005.json",
            "stream_42_msg_abc_0_1710000001.json",
            "stream_complete_42_msg_abc_1710000004.json",
        ];

        files.sort((a, b) => a.localeCompare(b));

        expect(files[0]).toContain("stream_42");
        expect(files[1]).toContain("stream_complete");
        expect(files[2]).toContain("telegram_");
    });
});
