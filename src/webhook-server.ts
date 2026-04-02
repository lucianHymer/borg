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
import { transcribe, distillForSpeech, synthesize, ensureModels, isAvailable } from "./audio.js";

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

/** Send a message directly to a Telegram thread via HTTP API (fire-and-forget). */
async function sendTelegramMessage(threadId: number, text: string): Promise<void> {
    const settings = readSettings();
    const token = settings.telegram_bot_token as string | undefined;
    const chatId = settings.telegram_chat_id as string | undefined;
    if (!token || !chatId) return;

    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                message_thread_id: threadId,
                text,
            }),
        });
    } catch {
        // Best-effort — don't fail the webhook response
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

// ─── Clairvoyant Webhook Endpoint (HMAC-SHA256 auth) ───

const CvEventSchema = z.object({
    id: z.string(),
    task_id: z.string(),
    event_type: z.string(),
    actor_id: z.string(),
    body: z.string().optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    idempotency_key: z.string(),
    created_at: z.string(),
});

const CvTaskSchema = z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    owner_id: z.string().optional().nullable(),
    creator_id: z.string(),
    parent_task_id: z.string().optional().nullable(),
    priority: z.number().optional().nullable(),
    due_date: z.string().optional().nullable(),
    tags: z.array(z.string()).optional(),
    version: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
});

const CvWebhookPayloadSchema = z.object({
    event: CvEventSchema,
    task: CvTaskSchema,
});

app.post("/api/webhooks/clairvoyant", (req: express.Request & { rawBody?: Buffer }, res) => {
    const settings = readSettings();
    const secret = settings.clairvoyant_webhook_secret as string | undefined;
    if (!secret) {
        res.status(503).json({ error: "Clairvoyant webhook not configured — set clairvoyant_webhook_secret in settings.json" });
        return;
    }

    // Verify HMAC-SHA256 signature
    const signature = req.headers["x-ql-signature"] as string | undefined;
    if (!signature || !req.rawBody) {
        res.status(401).json({ error: "Missing X-QL-Signature header" });
        return;
    }

    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        res.status(401).json({ error: "Invalid signature" });
        return;
    }

    // Validate payload
    const parsed = CvWebhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
        return;
    }

    const { event, task } = parsed.data;

    // Only triage unowned tasks — owned tasks already have someone responsible
    if (task.owner_id) {
        res.status(200).json({ filtered: true, reason: "has_owner", owner_id: task.owner_id });
        return;
    }

    // Resolve target thread
    const threadId = settings.clairvoyant_thread_id as number | undefined;
    if (!threadId) {
        res.status(503).json({ error: "No target thread — set clairvoyant_thread_id in settings.json" });
        return;
    }

    // Format a human-readable message for the thread agent
    const tags = task.tags?.length ? ` [${task.tags.join(", ")}]` : "";
    const body = event.body ? `\n\n${event.body}` : "";
    const message = [
        `Clairvoyant event: **${event.event_type}**`,
        `Task: "${task.title}" (${task.id})${tags}`,
        `Status: ${task.status} | Priority: ${task.priority ?? "none"}`,
        `Created by: ${task.creator_id} | Owner: ${task.owner_id ?? "unassigned"}`,
        body,
        `\nCheck your triage instructions in \`.claude/skills/triage.md\` and handle this event accordingly.`,
    ].join("\n");

    try {
        const result = enqueueWebhookMessage({
            threadId,
            sender: "clairvoyant",
            message,
            model: "opus",
            idempotencyKey: event.idempotency_key,
        });

        // Immediate feedback in the triage thread
        const statusLine = `⏳ Processing: "${task.title}" (${task.id})`;
        sendTelegramMessage(threadId, statusLine);

        res.status(202).json(result);
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

// ─── Talk Mode Endpoints ───
// Used by dashboard (proxied here) — infra has rw zone access, speaches, and Anthropic credentials.

const TALK_AUDIO_DIR = path.join(SCRIPT_DIR, ".borg", "audio", "talk");

app.post("/api/talk/send", express.raw({ type: "audio/*", limit: "10mb" }), async (req, res) => {
    const threadId = parseInt(String(req.query.threadId), 10);
    const sender = String(req.query.sender || "Talk Mode User");

    if (!Number.isFinite(threadId)) {
        res.status(400).json({ error: "threadId is required" });
        return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: "No audio data received" });
        return;
    }

    try {
        fs.mkdirSync(TALK_AUDIO_DIR, { recursive: true });
        const messageId = `talk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const audioFile = path.join(TALK_AUDIO_DIR, `${messageId}.webm`);
        const tmpFile = audioFile + ".tmp";
        fs.writeFileSync(tmpFile, req.body);
        fs.renameSync(tmpFile, audioFile);

        await ensureModels();
        const transcript = await transcribe(audioFile);
        try { fs.unlinkSync(audioFile); } catch { /* best effort */ }

        if (!transcript) {
            res.status(422).json({ error: "No speech detected" });
            return;
        }

        // Enqueue using the same zone-aware pattern
        const zoneConfig = loadZoneConfig(ZONE_CONFIG_PATH);
        const zone = zoneConfig ? getThreadZone(zoneConfig, threadId) : "core";
        const incomingDir = path.join(SCRIPT_DIR, `.borg-${zone}`, "queue", "incoming");
        fs.mkdirSync(incomingDir, { recursive: true });

        // Post silent info message to Telegram thread
        const settings = readSettings();
        if (settings.telegram_bot_token && settings.telegram_chat_id) {
            fetch(`https://api.telegram.org/bot${settings.telegram_bot_token as string}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: settings.telegram_chat_id,
                    message_thread_id: threadId === 1 ? undefined : threadId,
                    text: `🎙 *From ${sender} via Talk Mode:*\n\n${transcript}`,
                    parse_mode: "Markdown",
                    disable_notification: true,
                }),
            }).catch(() => {});
        }

        // Write queue message
        const incoming = {
            channel: "talk-mode",
            source: "user",
            threadId,
            sender,
            senderId: `talk:${sender}`,
            message: transcript,
            isReply: false,
            timestamp: Date.now(),
            messageId,
        };
        const queueTmp = path.join(incomingDir, `${messageId}.json.tmp`);
        const queueFinal = path.join(incomingDir, `${messageId}.json`);
        fs.writeFileSync(queueTmp, JSON.stringify(incoming));
        fs.renameSync(queueTmp, queueFinal);

        res.json({ messageId, transcript });
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

app.post("/api/talk/synthesize", express.json(), async (req, res) => {
    const { text } = req.body as { text?: string };
    if (!text) {
        res.status(400).json({ error: "text is required" });
        return;
    }

    try {
        const available = await isAvailable();
        if (!available) {
            res.status(503).json({ error: "TTS service unavailable" });
            return;
        }

        await ensureModels();
        const speechText = await distillForSpeech(text);
        const audioPath = await synthesize(speechText);
        const filename = path.basename(audioPath);

        res.json({ audioUrl: `/audio/${filename}` });
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

// Serve synthesized audio files
app.use("/audio", express.static(path.join(SCRIPT_DIR, ".borg", "audio")));

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
