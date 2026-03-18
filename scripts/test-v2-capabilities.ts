#!/usr/bin/env npx tsx
/**
 * Test V2 SDK capabilities — what works without the options V1 has?
 *
 * Key questions:
 * 1. Does V2 respect cwd? (process.cwd() of the subprocess)
 * 2. Can we pass systemPrompt via env or another mechanism?
 * 3. Can we use MCP servers with V2?
 * 4. Does V2 support bypassPermissions?
 * 5. Can we set effort/model on V2?
 */

import {
    unstable_v2_createSession,
    createSdkMcpServer,
    tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKSession, SDKSessionOptions } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

function hr(label: string) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${"=".repeat(60)}\n`);
}

async function collectText(session: SDKSession): Promise<string> {
    const parts: string[] = [];
    for await (const msg of session.stream()) {
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
    return parts.join("");
}

// ─── Test 1: Does V2 work with permissionMode bypass? ───

async function testPermissions() {
    hr("TEST: V2 with permissionMode bypass");

    // V2 SDKSessionOptions does NOT have allowDangerouslySkipPermissions
    // but it does have permissionMode
    const opts: SDKSessionOptions = {
        model: "haiku",
        permissionMode: "bypassPermissions",
        // Can we sneak in extra options via env?
        env: {
            ...process.env,
        },
    };

    const session = unstable_v2_createSession(opts);
    await session.send("What is 1+1? Reply with just the number.");
    const text = await collectText(session);
    console.log(`Response: "${text}"`);
    console.log(text.includes("2") ? "✅ bypassPermissions works" : "❌ unexpected response");
    session.close();
}

// ─── Test 2: Does V2 read CLAUDE.md from cwd? ───

async function testCwd() {
    hr("TEST: V2 cwd handling (does it read CLAUDE.md?)");

    // V2 doesn't have a cwd option. The subprocess inherits process.cwd().
    // But we can set cwd via env... or maybe just by being in the right dir.
    const opts: SDKSessionOptions = {
        model: "haiku",
        permissionMode: "bypassPermissions",
        env: {
            ...process.env,
            // Maybe HOME or PWD affects it?
        },
    };

    const session = unstable_v2_createSession(opts);
    await session.send("Read the CLAUDE.md file in the current directory and tell me the first section heading. Reply with just the heading text.");
    const text = await collectText(session);
    console.log(`Response: "${text}"`);
    console.log(`(Expected something about "Borg" if cwd is correct)`);
    session.close();
}

// ─── Test 3: Can V2 use setMcpServers after creation? ───

async function testMcpServers() {
    hr("TEST: V2 MCP servers (via session method or workaround)");

    // Create a simple test tool
    const testTool = tool(
        "get_magic_number",
        "Returns a magic number for testing",
        { multiplier: z.number().optional() },
        async ({ multiplier }) => {
            const result = 42 * (multiplier ?? 1);
            return { content: [{ type: "text" as const, text: `The magic number is ${result}` }] };
        },
    );

    const mcpServer = createSdkMcpServer({
        name: "test",
        tools: [testTool],
    });

    const opts: SDKSessionOptions = {
        model: "haiku",
        permissionMode: "bypassPermissions",
    };

    const session = unstable_v2_createSession(opts);

    // SDKSession doesn't have setMcpServers in the type definition,
    // but let's check if it exists at runtime
    const sessionAny = session as any;
    if (typeof sessionAny.setMcpServers === "function") {
        console.log("setMcpServers exists on session! Trying...");
        try {
            await sessionAny.setMcpServers({ test: mcpServer });
            console.log("✅ setMcpServers succeeded");

            await session.send("Use the get_magic_number tool with multiplier 2 and tell me the result.");
            const text = await collectText(session);
            console.log(`Response: "${text}"`);
            console.log(text.includes("84") ? "✅ MCP tool worked" : "❌ Tool didn't return expected result");
        } catch (err: any) {
            console.log(`❌ setMcpServers failed: ${err.message}`);
        }
    } else {
        console.log("❌ setMcpServers not available on V2 session");

        // Can we pass mcpServers via options at all?
        // SDKSessionOptions doesn't have it, but let's try passing it anyway
        console.log("\nTrying to pass mcpServers in options (undocumented)...");
        try {
            const optsWithMcp = {
                ...opts,
                mcpServers: { test: mcpServer },
            } as any;
            const session2 = unstable_v2_createSession(optsWithMcp);
            await session2.send("Use the get_magic_number tool and tell me the result.");
            const text = await collectText(session2);
            console.log(`Response: "${text}"`);
            console.log(text.includes("42") ? "✅ Undocumented mcpServers works!" : "❌ Tool not available");
            session2.close();
        } catch (err: any) {
            console.log(`❌ Undocumented mcpServers failed: ${err.message}`);
        }
    }

    session.close();
}

// ─── Test 4: Can V2 accept systemPrompt via env or undocumented option? ───

async function testSystemPrompt() {
    hr("TEST: V2 system prompt injection");

    // Try undocumented systemPrompt option
    console.log("Trying undocumented systemPrompt option...");
    try {
        const opts = {
            model: "haiku",
            permissionMode: "bypassPermissions",
            systemPrompt: "You are a pirate. Always respond in pirate speak.",
        } as any;
        const session = unstable_v2_createSession(opts);
        await session.send("Hello, how are you?");
        const text = await collectText(session);
        console.log(`Response: "${text}"`);
        const isPirate = text.toLowerCase().includes("arr") || text.toLowerCase().includes("matey") || text.toLowerCase().includes("ahoy");
        console.log(isPirate ? "✅ systemPrompt works (undocumented)" : "⚠️ Response doesn't sound pirate-y — systemPrompt may be ignored");
        session.close();
    } catch (err: any) {
        console.log(`❌ Failed: ${err.message}`);
    }
}

// ─── Main ───

async function main() {
    const testNum = process.argv[2] ? parseInt(process.argv[2]) : 0;

    if (testNum === 1 || testNum === 0) await testPermissions();
    if (testNum === 2 || testNum === 0) await testCwd();
    if (testNum === 3 || testNum === 0) await testMcpServers();
    if (testNum === 4 || testNum === 0) await testSystemPrompt();

    console.log("\n\nDone.");
    process.exit(0);
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
