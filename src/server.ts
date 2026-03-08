/**
 * Lightweight HTTP server for peer-to-peer messaging between Borg instances.
 * Runs inside queue-processor when settings.httpPort is configured.
 * Only accessible on the WireGuard VPN — not exposed to public internet.
 */

import http from "http";
import fs from "fs";
import path from "path";
import type { Settings } from "./session-manager.js";
import { loadThreads, loadSettings } from "./session-manager.js";

const PROJECT_DIR = path.resolve(__dirname, "..");
const BORG_DIR = path.join(PROJECT_DIR, ".borg");
const QUEUE_INCOMING = path.join(BORG_DIR, "queue/incoming");

const MAX_PAYLOAD_BYTES = 100 * 1024; // 100KB

/**
 * Start the peer HTTP server.
 * Returns the server instance for graceful shutdown.
 */
export function startHttpServer(settings: Settings): http.Server {
    const server = http.createServer((req, res) => {
        // Extract client IP (handle IPv6-mapped IPv4)
        let clientIP = req.socket.remoteAddress ?? "";
        if (clientIP.startsWith("::ffff:")) clientIP = clientIP.slice(7);

        if (req.method === "GET" && req.url === "/threads") {
            handleGetThreads(res);
        } else if (req.method === "POST" && req.url === "/incoming") {
            // Read allowed IPs fresh each request so dashboard-added peers work immediately
            const allowedIPs = new Set((loadSettings().peers ?? []).map(p => p.ip));
            handlePostIncoming(req, res, clientIP, allowedIPs);
        } else {
            res.writeHead(404);
            res.end("Not found");
        }
    });

    server.listen(settings.httpPort, () => {
        console.log(`[peer-server] Listening on port ${settings.httpPort}`);
    });

    return server;
}

function handleGetThreads(res: http.ServerResponse): void {
    try {
        const threads = loadThreads();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(threads));
    } catch {
        res.writeHead(500);
        res.end("Could not read threads");
    }
}

function handlePostIncoming(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    clientIP: string,
    allowedIPs: Set<string>,
): void {
    // Reject unknown peer IPs
    if (!allowedIPs.has(clientIP)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PAYLOAD_BYTES) {
            res.writeHead(400);
            res.end("Payload too large");
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });

    req.on("end", () => {
        if (res.writableEnded) return; // already responded (payload too large)

        try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

            // Validate required fields
            if (
                typeof body.threadId !== "number" ||
                typeof body.message !== "string" ||
                typeof body.sender !== "string" ||
                typeof body.messageId !== "string"
            ) {
                res.writeHead(400);
                res.end("Invalid message schema");
                return;
            }

            // Force cross-thread source regardless of what peer sent
            body.source = "cross-thread";

            // Write atomically to incoming queue
            const filename = `peer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            fs.mkdirSync(QUEUE_INCOMING, { recursive: true });
            const tmpPath = path.join(QUEUE_INCOMING, `${filename}.json.tmp`);
            const finalPath = path.join(QUEUE_INCOMING, `${filename}.json`);
            fs.writeFileSync(tmpPath, JSON.stringify(body));
            fs.renameSync(tmpPath, finalPath);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        } catch {
            res.writeHead(400);
            res.end("Invalid JSON");
        }
    });
}
