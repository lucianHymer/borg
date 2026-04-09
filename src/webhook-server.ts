/**
 * Webhook Server — HTTP endpoint for external webhook integrations.
 * Runs inside the infra container alongside telegram-client.
 */

import fs from "fs";
import path from "path";
import http from "http";
import crypto from "crypto";
import express from "express";
import { z } from "zod";
import { loadZoneConfig, getThreadZone } from "./zone-config.js";
import { toErrorMessage } from "./types.js";

const SCRIPT_DIR = path.resolve(__dirname, "..");
const ZONE_CONFIG_PATH = process.env.ZONE_CONFIG_PATH || path.join(SCRIPT_DIR, "zone-config.json");
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(SCRIPT_DIR, "settings.json");
const PORT = parseInt(process.env.WEBHOOK_PORT || "3001", 10);

function readSettings(): Record<string, unknown> {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    } catch {
        return {};
    }
}

/** Write a webhook message to the correct zone's incoming queue. Returns messageId. */
function enqueueWebhookMessage(opts: {
    threadId: number;
    sender: string;
    message: string;
    model?: string;
    idempotencyKey?: string;
}): { messageId: string; zone: string } {
    const zoneConfig = loadZoneConfig(ZONE_CONFIG_PATH);
    if (!zoneConfig) throw new Error("Zone config not available");

    const zone = getThreadZone(zoneConfig, opts.threadId);
    const queueDir = path.join(SCRIPT_DIR, `.borg-${zone}`, "queue", "incoming");
    fs.mkdirSync(queueDir, { recursive: true });

    const ts = Date.now();
    const messageId = opts.idempotencyKey
        ? `webhook_${opts.sender}_${opts.idempotencyKey}`
        : `webhook_${opts.sender}_${ts}_${Math.random().toString(36).slice(2, 8)}`;

    const incoming = {
        channel: "webhook",
        source: "webhook",
        threadId: opts.threadId,
        sender: opts.sender,
        senderId: `webhook:${opts.sender}`,
        message: opts.message,
        isReply: false,
        timestamp: ts,
        messageId,
        ...(opts.model ? { oneshotModel: opts.model } : {}),
    };

    const tmpFile = path.join(queueDir, `${messageId}.json.tmp`);
    const finalFile = path.join(queueDir, `${messageId}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(incoming));
    fs.renameSync(tmpFile, finalFile);

    return { messageId, zone };
}

// ─── Express App ───

const app = express();

app.use(express.json({
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
    },
}));

// ─── Health Check ───

app.get("/health", (_req, res) => {
    res.json({ ok: true });
});

// ─── Generic Webhook Endpoint (Bearer token auth) ───

const WebhookPayloadSchema = z.object({
    threadId: z.number().int().positive(),
    sender: z.string().min(1).max(64),
    message: z.string().min(1).max(32768),
    model: z.string().optional(),
});

app.post("/api/incoming", (req, res) => {
    const secret = readSettings().webhook_secret as string | undefined;
    if (!secret) {
        res.status(503).json({ error: "Webhook not configured — set webhook_secret in settings.json" });
        return;
    }

    const auth = req.headers.authorization;
    const expected = `Bearer ${secret}`;
    if (!auth || auth.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
        res.status(401).json({ error: "Invalid or missing Authorization header" });
        return;
    }

    const parsed = WebhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
        return;
    }

    try {
        const result = enqueueWebhookMessage(parsed.data);
        res.status(202).json(result);
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

// ─── Start/Stop ───

let server: http.Server | null = null;

export function startWebhookServer(): http.Server {
    server = http.createServer(app);
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Webhook server listening on http://0.0.0.0:${PORT}`);
    });
    return server;
}

export function stopWebhookServer(): Promise<void> {
    return new Promise((resolve) => {
        if (server) {
            server.close(() => resolve());
        } else {
            resolve();
        }
    });
}
