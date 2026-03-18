#!/usr/bin/env npx tsx
/**
 * Test V1 AsyncIterable multi-turn — try every coordination strategy.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKUserMessage, Options } from "@anthropic-ai/claude-agent-sdk";

const OPTS: Options = {
    model: "haiku",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: "Reply with ONLY the number, nothing else.",
};

function makeMsg(text: string, sid = ""): SDKUserMessage {
    return {
        type: "user",
        session_id: sid,
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
    } as SDKUserMessage;
}

// Test: Don't consume stream with for-await (which auto-returns).
// Instead, manually call iterator.next() and DON'T break on result.
// Maybe the generator gets a chance to yield the next message before
// the SDK subprocess decides to exit.
async function testManualIterator() {
    console.log("\n=== TEST: Manual iterator, don't break on result ===\n");

    let resolveNext: ((v: void) => void) | null = null;
    let turn = 0;

    async function* input(): AsyncGenerator<SDKUserMessage> {
        yield makeMsg("What is 5 + 3?");
        console.log("  [gen] first message yielded, waiting for signal...");
        await new Promise<void>(r => { resolveNext = r; });
        console.log("  [gen] got signal, yielding second message");
        yield makeMsg("What is 10 + 10?");
        console.log("  [gen] second message yielded, waiting for signal...");
        await new Promise<void>(r => { resolveNext = r; });
        console.log("  [gen] done");
    }

    const q = query({ prompt: input(), options: OPTS });
    const iter = q[Symbol.asyncIterator]();

    let turns: string[] = [];
    let currentText = "";

    while (true) {
        const { done, value: msg } = await iter.next();
        if (done) {
            console.log("  [iter] done=true");
            break;
        }

        if (msg.type === "assistant") {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === "text") currentText += block.text;
                }
            }
            const stop = (msg as any).message?.stop_reason;
            if (stop === "end_turn") {
                turn++;
                console.log(`  [iter] end_turn #${turn}: "${currentText}"`);
                turns.push(currentText);
                currentText = "";
                // Signal generator to yield next message
                if (resolveNext) {
                    resolveNext();
                    resolveNext = null;
                }
            }
        } else if (msg.type === "result") {
            turn++;
            if (currentText) {
                turns.push(currentText);
                currentText = "";
            }
            console.log(`  [iter] result #${turn}`);
            // DON'T break — see if more events come after signaling
            if (resolveNext) {
                resolveNext();
                resolveNext = null;
            }
            // But do break if we've seen 2+ turns
            if (turns.length >= 2) break;
        } else {
            const sub = "subtype" in msg ? `:${(msg as any).subtype}` : "";
            console.log(`  [iter] ${msg.type}${sub}`);
        }
    }

    console.log(`\nTurns: ${turns.length}`);
    turns.forEach((t, i) => console.log(`  Turn ${i + 1}: "${t}"`));
    console.log(turns.length >= 2 ? "✅ WORKS" : "❌ FAILED");

    try { q.close(); } catch {}
}

// Test: Use streamInput() AFTER creating query with AsyncIterable
// (streaming mode should be active)
async function testStreamInputAfterIterable() {
    console.log("\n=== TEST: AsyncIterable prompt + streamInput() for second message ===\n");

    async function* input(): AsyncGenerator<SDKUserMessage> {
        yield makeMsg("What is 5 + 3?");
    }

    const q = query({ prompt: input(), options: OPTS });

    // Consume first response
    let text1 = "";
    let sessionId = "";
    for await (const msg of q) {
        if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;
        if (msg.type === "assistant") {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === "text") text1 += block.text;
                }
            }
        }
        if (msg.type === "result") break;
    }
    console.log(`Turn 1: "${text1}" (session: ${sessionId})`);

    // Now try streamInput
    console.log("Trying streamInput()...");
    try {
        await q.streamInput((async function* () {
            yield makeMsg("What is 10 + 10?", sessionId);
        })());
        console.log("streamInput() succeeded! Consuming response...");

        let text2 = "";
        for await (const msg of q) {
            if (msg.type === "assistant") {
                const content = (msg as any).message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "text") text2 += block.text;
                    }
                }
            }
            if (msg.type === "result") break;
        }
        console.log(`Turn 2: "${text2}"`);
        console.log("✅ streamInput after AsyncIterable WORKS");
    } catch (err: any) {
        console.log(`❌ streamInput failed: ${err.message}`);
    }

    try { q.close(); } catch {}
}

async function main() {
    const test = process.argv[2] ?? "all";
    if (test === "a" || test === "all") await testManualIterator();
    if (test === "b" || test === "all") await testStreamInputAfterIterable();
    process.exit(0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
