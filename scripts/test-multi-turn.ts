#!/usr/bin/env npx tsx
/**
 * Test script: Explore multi-turn session approaches with the Claude Agent SDK.
 *
 * Tests:
 * 1. V1 query() with string prompt → streamInput() for second message
 * 2. V1 query() with AsyncIterable prompt → second message via iterable
 * 3. V2 unstable_v2_createSession() → send() for multi-turn
 *
 * Run: npx tsx scripts/test-multi-turn.ts
 */

import {
    query,
    unstable_v2_createSession,
    unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";
import type {
    SDKMessage,
    SDKUserMessage,
    Query,
    SDKSession,
    Options,
    SDKSessionOptions,
} from "@anthropic-ai/claude-agent-sdk";

const CWD = process.cwd();

// ─── Helpers ───

async function collectResponse(iter: AsyncIterable<SDKMessage>): Promise<{ text: string; sessionId: string | null }> {
    const parts: string[] = [];
    let sessionId: string | null = null;

    for await (const msg of iter) {
        if ("session_id" in msg && msg.session_id) {
            sessionId = msg.session_id;
        }
        if (msg.type === "assistant") {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === "text") parts.push(block.text);
                }
            }
        }
        if (msg.type === "result") {
            const result = msg as any;
            if (result.subtype === "success" && result.result && parts.length === 0) {
                parts.push(result.result);
            }
        }
    }

    return { text: parts.join("\n"), sessionId };
}

function hr(label: string) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${"=".repeat(60)}\n`);
}

// ─── Test 1: V1 string prompt → streamInput() ───

async function testV1StringThenStreamInput() {
    hr("TEST 1: V1 string prompt → streamInput()");

    const opts: Options = {
        model: "haiku",
        cwd: CWD,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        systemPrompt: "You are a test bot. Reply in one short sentence only.",
    };

    console.log("Creating query with string prompt...");
    const q = query({ prompt: "What is 2+2? Reply with just the number.", options: opts });

    console.log("Collecting first response...");
    const r1 = await collectResponse(q);
    console.log(`Response 1: "${r1.text}"`);
    console.log(`Session ID: ${r1.sessionId}`);

    // Now try streamInput on the same query
    console.log("\nTrying streamInput() on the same query...");
    try {
        const userMsg: SDKUserMessage = {
            type: "user",
            message: { role: "user", content: "What is 3+3? Reply with just the number." },
            parent_tool_use_id: null,
            session_id: r1.sessionId ?? "",
        };
        await q.streamInput((async function* () { yield userMsg; })());
        console.log("streamInput() succeeded! Collecting second response...");
        const r2 = await collectResponse(q);
        console.log(`Response 2: "${r2.text}"`);
        console.log("✅ V1 string + streamInput WORKS");
    } catch (err: any) {
        console.log(`❌ streamInput() failed: ${err.message}`);
    }

    try { q.close(); } catch {}
}

// ─── Test 2: V1 AsyncIterable prompt ───

async function testV1AsyncIterable() {
    hr("TEST 2: V1 AsyncIterable prompt (controlled generator)");

    // Create a controllable async generator
    let resolveNext: ((msg: SDKUserMessage | null) => void) | null = null;
    const pendingMessages: (SDKUserMessage | null)[] = [];

    async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
        while (true) {
            // Check if there's already a message waiting
            if (pendingMessages.length > 0) {
                const msg = pendingMessages.shift()!;
                if (msg === null) return; // Signal to close
                yield msg;
                continue;
            }
            // Wait for next message
            const msg = await new Promise<SDKUserMessage | null>((resolve) => {
                resolveNext = resolve;
            });
            resolveNext = null;
            if (msg === null) return; // Signal to close
            yield msg;
        }
    }

    function pushMessage(text: string, sessionId: string) {
        const msg: SDKUserMessage = {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            session_id: sessionId,
        };
        if (resolveNext) {
            resolveNext(msg);
        } else {
            pendingMessages.push(msg);
        }
    }

    function closeGenerator() {
        if (resolveNext) {
            resolveNext(null);
        } else {
            pendingMessages.push(null);
        }
    }

    const opts: Options = {
        model: "haiku",
        cwd: CWD,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        systemPrompt: "You are a test bot. Reply in one short sentence only.",
    };

    // Push first message before creating query
    pushMessage("What is 2+2? Reply with just the number.", "");

    console.log("Creating query with AsyncIterable prompt...");
    const q = query({ prompt: messageGenerator(), options: opts });

    // Consume events until we see a result
    console.log("Collecting first response...");
    let sessionId = "";
    const parts1: string[] = [];
    let gotResult = false;

    for await (const msg of q) {
        if ("session_id" in msg && msg.session_id) {
            sessionId = msg.session_id;
        }
        if (msg.type === "assistant") {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === "text") parts1.push(block.text);
                }
            }
            // Check for end_turn
            const stopReason = (msg as any).message?.stop_reason;
            if (stopReason === "end_turn") {
                console.log(`Got end_turn. Text so far: "${parts1.join("")}"`);
                // Don't break — see if result follows
            }
        }
        if (msg.type === "result") {
            gotResult = true;
            console.log(`Got result message.`);
            break;
        }
    }

    console.log(`Response 1: "${parts1.join("")}"`);
    console.log(`Session ID: ${sessionId}`);
    console.log(`Got result: ${gotResult}`);

    if (gotResult) {
        console.log("\nPushing second message...");
        pushMessage("What is 3+3? Reply with just the number.", sessionId);

        console.log("Collecting second response...");
        const parts2: string[] = [];

        for await (const msg of q) {
            if (msg.type === "assistant") {
                const content = (msg as any).message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "text") parts2.push(block.text);
                    }
                }
            }
            if (msg.type === "result") {
                break;
            }
        }

        console.log(`Response 2: "${parts2.join("")}"`);
        console.log("✅ V1 AsyncIterable multi-turn WORKS");
    } else {
        console.log("❌ Never got result — generator may be blocking");
    }

    closeGenerator();
    try { q.close(); } catch {}
}

// ─── Test 3: V2 session API ───

async function testV2Session() {
    hr("TEST 3: V2 unstable_v2_createSession → send()");

    const opts: SDKSessionOptions = {
        model: "haiku",
        permissionMode: "bypassPermissions",
        // V2 doesn't have: cwd, systemPrompt, effort, settingSources,
        // allowDangerouslySkipPermissions, mcpServers, resume
        // Let's see what happens...
    };

    console.log("Creating V2 session...");
    let session: SDKSession;
    try {
        session = unstable_v2_createSession(opts);
    } catch (err: any) {
        console.log(`❌ Failed to create V2 session: ${err.message}`);
        return;
    }

    console.log("Sending first message...");
    try {
        await session.send("What is 2+2? Reply with just the number.");
    } catch (err: any) {
        console.log(`❌ send() failed: ${err.message}`);
        session.close();
        return;
    }

    console.log("Streaming first response...");
    const parts1: string[] = [];
    try {
        for await (const msg of session.stream()) {
            if (msg.type === "assistant") {
                const content = (msg as any).message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "text") parts1.push(block.text);
                    }
                }
            }
            if (msg.type === "result") {
                break;
            }
        }
        console.log(`Response 1: "${parts1.join("")}"`);
    } catch (err: any) {
        console.log(`❌ stream() failed: ${err.message}`);
        session.close();
        return;
    }

    console.log(`Session ID: ${session.sessionId}`);

    // Second message
    console.log("\nSending second message...");
    try {
        await session.send("What is 3+3? Reply with just the number.");
    } catch (err: any) {
        console.log(`❌ send() failed on second message: ${err.message}`);
        session.close();
        return;
    }

    console.log("Streaming second response...");
    const parts2: string[] = [];
    try {
        for await (const msg of session.stream()) {
            if (msg.type === "assistant") {
                const content = (msg as any).message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "text") parts2.push(block.text);
                    }
                }
            }
            if (msg.type === "result") {
                break;
            }
        }
        console.log(`Response 2: "${parts2.join("")}"`);
        console.log("✅ V2 session multi-turn WORKS");
    } catch (err: any) {
        console.log(`❌ stream() failed on second response: ${err.message}`);
    }

    // Test if we can set MCP servers on V2
    console.log("\nChecking V2 capabilities...");
    const sessionAny = session as any;
    console.log(`  Has setMcpServers: ${typeof sessionAny.setMcpServers === "function"}`);
    console.log(`  Has setModel: ${typeof sessionAny.setModel === "function"}`);

    session.close();
}

// ─── Test 4: V2 resume session ───

async function testV2Resume() {
    hr("TEST 4: V2 resume session");

    const opts: SDKSessionOptions = {
        model: "haiku",
        permissionMode: "bypassPermissions",
    };

    // Create initial session
    console.log("Creating initial V2 session...");
    const session1 = unstable_v2_createSession(opts);

    await session1.send("Remember the word 'pineapple'. Reply with just 'OK'.");
    for await (const msg of session1.stream()) {
        if (msg.type === "result") break;
    }

    const sid = session1.sessionId;
    console.log(`Session ID: ${sid}`);
    session1.close();

    // Resume
    console.log("\nResuming session...");
    try {
        const session2 = unstable_v2_resumeSession(sid, opts);

        await session2.send("What word did I ask you to remember? Reply with just the word.");
        const parts: string[] = [];
        for await (const msg of session2.stream()) {
            if (msg.type === "assistant") {
                const content = (msg as any).message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "text") parts.push(block.text);
                    }
                }
            }
            if (msg.type === "result") break;
        }
        console.log(`Resumed response: "${parts.join("")}"`);
        console.log(parts.join("").toLowerCase().includes("pineapple") ? "✅ Resume WORKS" : "❌ Resume didn't recall");
        session2.close();
    } catch (err: any) {
        console.log(`❌ Resume failed: ${err.message}`);
    }
}

// ─── Main ───

async function main() {
    const testNum = process.argv[2] ? parseInt(process.argv[2]) : 0;

    if (testNum === 1 || testNum === 0) await testV1StringThenStreamInput();
    if (testNum === 2 || testNum === 0) await testV1AsyncIterable();
    if (testNum === 3 || testNum === 0) await testV2Session();
    if (testNum === 4 || testNum === 0) await testV2Resume();

    console.log("\n\nDone.");
    process.exit(0);
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
