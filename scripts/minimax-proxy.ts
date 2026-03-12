#!/usr/bin/env npx tsx
// Budget mode proxy server - captures usage from Fireworks API for cost tracking
// Runs as sidecar, forwards requests to Fireworks while logging usage to correlation files
//
// Correlation ID pattern:
// - queue-processor creates .borg/minimax-usage-{uuid}.pending before query
// - proxy scans for pending files, uses UUID as request ID
// - proxy writes usage to .borg/minimax-usage-{uuid}.json
// - queue-processor reads the specific file after query completes

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";

const TARGET_HOST = "api.fireworks.ai";
const TARGET_PATH = "/inference/v1/messages";
const PORT = 9999;
const USAGE_DIR = ".borg";

// Pricing: $0.30/M input, $0.03/M cached, $1.20/M output
const INPUT_RATE = 0.30 / 1_000_000;
const CACHED_RATE = 0.03 / 1_000_000;
const OUTPUT_RATE = 1.20 / 1_000_000;

function calculateCost(usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }): number {
    const inputCost = (usage.input_tokens || 0) * INPUT_RATE;
    const cachedCost = (usage.cache_read_input_tokens || 0) * CACHED_RATE;
    const outputCost = (usage.output_tokens || 0) * OUTPUT_RATE;
    return inputCost + cachedCost + outputCost;
}

// Ensure the directory exists
if (!fs.existsSync(USAGE_DIR)) {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
}

// Find pending request ID from .pending files
function findPendingRequestId(): string | null {
    try {
        const files = fs.readdirSync(USAGE_DIR);
        for (const file of files) {
            if (file.startsWith("minimax-usage-") && file.endsWith(".pending")) {
                // Extract UUID between minimax-usage- and .pending
                return file.slice(15, -8);
            }
        }
    } catch {
        // Directory doesn't exist yet
    }
    return null;
}

// Write usage to correlation file and clean up pending
function writeUsageFile(requestId: string, usage: any, duration: number): void {
    const costUSD = calculateCost(usage);
    const usageRecord = {
        timestamp: new Date().toISOString(),
        requestId,
        duration,
        usage,
        costUSD,
    };

    // Write to correlation file (single JSON, not JSONL)
    const usageFile = path.join(USAGE_DIR, `minimax-usage-${requestId}.json`);
    fs.writeFileSync(usageFile, JSON.stringify(usageRecord, null, 2));

    // Clean up pending file
    const pendingFile = path.join(USAGE_DIR, `minimax-usage-${requestId}.pending`);
    if (fs.existsSync(pendingFile)) {
        fs.unlinkSync(pendingFile);
    }

    console.log(`[PROXY] ${requestId} USAGE: input=${usage.input_tokens}, output=${usage.output_tokens}, cost=$${costUSD.toFixed(4)}`);
}

const server = http.createServer(async (req, res) => {
    // Check for pending correlation ID first
    const requestId = findPendingRequestId() || Math.random().toString(36).substring(7);
    const startTime = Date.now();

    console.log(`[PROXY] ${requestId} ${req.method} ${req.url}`);

    // Read the body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    // Forward to Fireworks via HTTPS
    const targetReq = https.request({
        hostname: TARGET_HOST,
        port: 443,
        path: TARGET_PATH,
        method: req.method,
        headers: {
            ...req.headers,
            Host: TARGET_HOST,
            "Content-Length": body.length,
        },
    }, (targetRes) => {
        let responseBody = "";

        targetRes.on("data", (chunk) => {
            const chunkStr = chunk.toString();
            responseBody += chunkStr;
            res.write(chunk);
        });

        targetRes.on("end", () => {
            const duration = Date.now() - startTime;

            console.log(`[PROXY] ${requestId} Response status: ${targetRes.statusCode}, body length: ${responseBody.length}`);

            let capturedUsage: any = null;

            // Check if it's SSE (Server-Sent Events)
            if (responseBody.startsWith("event:") || responseBody.includes("\nevent:")) {
                console.log(`[PROXY] ${requestId} Detected SSE response`);

                const lines = responseBody.split("\n");
                let currentEvent = "";

                for (const line of lines) {
                    if (line.startsWith("event:")) {
                        currentEvent = line.substring(6).trim();
                    } else if (line.startsWith("data:")) {
                        const dataStr = line.substring(5).trim();
                        // Check for usage in message, message_delta, or message_stop events
                        if (currentEvent === "message" || currentEvent === "message_delta" || currentEvent === "message_stop") {
                            try {
                                const data = JSON.parse(dataStr);
                                if (data.usage || (data.delta && data.delta.usage)) {
                                    const usage = data.usage || data.delta.usage;
                                    capturedUsage = usage;
                                    // Write to correlation file (only final message_stop has complete usage)
                                    if (currentEvent === "message_stop") {
                                        writeUsageFile(requestId, usage, duration);
                                    }
                                }
                            } catch {
                                // Not JSON, skip
                            }
                        }
                    }
                }
            } else {
                // Try to parse as regular JSON
                try {
                    const data = JSON.parse(responseBody);
                    console.log(`[PROXY] ${requestId} Parsed JSON, keys: ${Object.keys(data)}`);

                    if (data.usage) {
                        capturedUsage = data.usage;
                        writeUsageFile(requestId, data.usage, duration);
                    }
                } catch (e: any) {
                    console.log(`[PROXY] ${requestId} Parse error: ${e.message}`);
                }
            }

            res.end();
        });
    });

    targetReq.on("error", (e) => {
        console.error(`[PROXY] ${requestId} Error:`, e.message);
        res.statusCode = 500;
        res.end("Proxy error");
    });

    targetReq.write(body);
    targetReq.end();
});

server.listen(PORT, () => {
    console.log(`Budget mode proxy listening on http://localhost:${PORT}`);
    console.log(`Forwarding to https://${TARGET_HOST}${TARGET_PATH}`);
    console.log(`Usage directory: ${USAGE_DIR}`);
    console.log(`\nTo use: export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
});