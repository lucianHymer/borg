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
import {
    claimAuthCode,
    checkRateLimit,
    recordFailedAttempt,
    createToken,
    validateToken,
    getGitHubToken,
    startAuthSweep,
    stopAuthSweep,
} from "./auth.js";
import { formatters } from "./webhook-formatters.js";

const SCRIPT_DIR = path.resolve(__dirname, "..");
const ZONE_CONFIG_PATH = process.env.ZONE_CONFIG_PATH || path.join(SCRIPT_DIR, "zone-config.json");
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(SCRIPT_DIR, "settings.json");
const BORG_DIR = path.join(SCRIPT_DIR, ".borg");
const WEBHOOKS_FILE = path.join(BORG_DIR, "webhooks.json");
const DELIVERIES_FILE = path.join(BORG_DIR, "webhook-deliveries.jsonl");
const PORT = parseInt(process.env.WEBHOOK_PORT || "3001", 10);

// ─── Webhook Config Types ───

interface WebhookConfig {
    name: string;
    secret: string;
    requireSignature: boolean; // whether to verify HMAC signatures on incoming webhooks
    signatureHeader: string;   // e.g. "x-hub-signature-256"
    signaturePrefix: string;   // e.g. "sha256="
    hmacAlgorithm: string;     // e.g. "sha256"
    threadId?: number;
    formatter: string;         // "github" | "raw"
    eventFilter?: string[];    // e.g. ["issues", "pull_request"]
    labelFilter?: string[];    // e.g. ["agent:triage"] — only deliver if issue/PR has a matching label
    ntfy?: { topic: string; debounceMs?: number };
    createdAt: number;
}

interface WebhooksFile {
    [id: string]: WebhookConfig;
}

// ─── Mtime-Cached Webhooks Loader ───

let cachedWebhooks: WebhooksFile | null = null;
let cachedWebhooksMtime: number = 0;

function loadWebhooks(): WebhooksFile {
    try {
        const stat = fs.statSync(WEBHOOKS_FILE);
        if (cachedWebhooks && stat.mtimeMs === cachedWebhooksMtime) {
            return cachedWebhooks;
        }
        const raw = fs.readFileSync(WEBHOOKS_FILE, "utf-8");
        const parsed = JSON.parse(raw) as WebhooksFile;
        cachedWebhooks = parsed;
        cachedWebhooksMtime = stat.mtimeMs;
        return parsed;
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            return {};
        }
        throw err;
    }
}

let cachedSettings: Record<string, unknown> | null = null;
let cachedSettingsMtime: number = 0;

function readSettings(): Record<string, unknown> {
    try {
        const stat = fs.statSync(SETTINGS_FILE);
        if (cachedSettings && stat.mtimeMs === cachedSettingsMtime) return cachedSettings;
        cachedSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        cachedSettingsMtime = stat.mtimeMs;
        return cachedSettings!;
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

// ─── Webhook Event Coalescing ───
// When GitHub fires multiple events for the same issue/PR in rapid succession
// (e.g. created + labeled + assigned), coalesce them into one delivery.

const COALESCE_WINDOW_MS = 3000; // 3 seconds

interface CoalescedEvent {
    formatted: string;
    event: string;
    action: string;
}

interface CoalesceEntry {
    timer: NodeJS.Timeout;
    events: CoalescedEvent[];
    webhookId: string;
    config: WebhookConfig;
    subject: string; // e.g. "Issue #61: title"
}

const coalesceBatches = new Map<string, CoalesceEntry>();

/** Extract a coalescing key from a GitHub webhook payload. Returns null if not coalesceable. */
function getCoalesceKey(webhookId: string, headers: Record<string, string>, body: unknown): { key: string; subject: string } | null {
    const event = headers["x-github-event"];
    if (!event) return null;

    const payload = body as {
        issue?: { number?: number; title?: string };
        pull_request?: { number?: number; title?: string };
        repository?: { full_name?: string };
    };

    const entity = payload.pull_request || payload.issue;
    if (!entity?.number) return null; // push events, etc. — deliver immediately

    const repo = payload.repository?.full_name || "unknown";
    const kind = payload.pull_request ? "PR" : "Issue";
    const key = `${webhookId}:${repo}#${entity.number}`;
    const subject = `${kind} #${entity.number}: ${entity.title || ""}`;
    return { key, subject };
}

/** Deliver a coalesced batch: enqueue one combined message + one Telegram status. */
function deliverCoalescedBatch(entry: CoalesceEntry): void {
    const { events, config, webhookId, subject } = entry;
    const actions = events.map(e => e.action || e.event).join(", ");

    // Combine formatted messages — if only one event, use it directly
    const combined = events.length === 1
        ? events[0].formatted
        : events.map(e => e.formatted).join("\n\n---\n\n");

    let messageId: string | undefined;
    if (config.threadId) {
        try {
            const result = enqueueWebhookMessage({
                threadId: config.threadId,
                sender: config.name,
                message: combined,
            });
            messageId = result.messageId;

            // Send one processing status to Telegram
            const settings = readSettings();
            const botToken = settings.telegram_bot_token as string | undefined;
            const chatId = settings.telegram_chat_id as number | undefined;
            if (botToken && chatId) {
                const statusText = events.length === 1
                    ? `⏳ Processing ${subject} (${actions})...`
                    : `⏳ Processing ${subject} — ${events.length} events (${actions})...`;
                fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_thread_id: config.threadId,
                        text: statusText,
                    }),
                }).catch(() => {});
            }
        } catch (err) {
            console.error("Failed to deliver coalesced webhook:", err);
        }
    }

    // Ntfy for all events in batch
    if (config.ntfy) {
        debounceNtfy(config.ntfy.topic, config.ntfy.debounceMs ?? 0, combined);
    }

    // Log each event in the batch
    for (const e of events) {
        try {
            const deliveryEntry = JSON.stringify({
                webhookId,
                ts: Date.now(),
                event: e.event,
                status: "ok",
                coalesced: events.length > 1,
                ...(config.threadId ? { threadId: config.threadId } : {}),
                ...(config.ntfy ? { ntfy: true } : {}),
            });
            fs.appendFileSync(DELIVERIES_FILE, deliveryEntry + "\n");
        } catch {
            // Best-effort logging
        }
    }
}

// ─── Ntfy Debounce State ───

const ntfyBatches = new Map<string, { timer: NodeJS.Timeout; messages: string[] }>();

function debounceNtfy(topic: string, debounceMs: number, message: string): void {
    const existing = ntfyBatches.get(topic);
    if (existing) {
        existing.messages.push(message);
        return; // timer already running
    }

    const messages = [message];
    const timer = setTimeout(async () => {
        ntfyBatches.delete(topic);
        const summary = messages.length === 1
            ? messages[0]
            : `${messages.length} events:\n\n${messages.join("\n\n---\n\n")}`;
        try {
            await fetch(`http://ntfy:80/${topic}`, {
                method: "POST",
                body: summary.slice(0, 4000), // ntfy has message size limits
            });
        } catch (err) {
            console.error("ntfy send failed:", err);
        }
    }, debounceMs);
    timer.unref(); // don't keep process alive
    ntfyBatches.set(topic, { timer, messages });
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

// ─── Webhook Helpers ───

function extractToken(req: express.Request): string | null {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return null;
    return auth.slice(7);
}

async function requireToken(req: express.Request, res: express.Response, next: express.NextFunction) {
    const token = extractToken(req);
    if (!token) { res.status(401).json({ error: "Missing token" }); return; }
    const valid = await validateToken(token);
    if (!valid) { res.status(401).json({ error: "Invalid token" }); return; }
    next();
}

function writeWebhooks(webhooks: WebhooksFile): void {
    fs.mkdirSync(path.dirname(WEBHOOKS_FILE), { recursive: true });
    const tmpFile = WEBHOOKS_FILE + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(webhooks, null, 2));
    fs.renameSync(tmpFile, WEBHOOKS_FILE);
    // Invalidate mtime cache so next loadWebhooks() re-reads
    cachedWebhooks = null;
    cachedWebhooksMtime = 0;
}

function redactSecret(config: WebhookConfig): WebhookConfig & { secret: string } {
    return { ...config, secret: "***" };
}

// ─── Webhook CRUD Routes (Bearer token auth) ───

app.get("/api/webhooks/list", requireToken, (_req, res) => {
    const webhooks = loadWebhooks();
    const list = Object.entries(webhooks).map(([id, config]) => ({
        id,
        ...redactSecret(config),
        ...(config.ntfy ? { ntfyTopic: config.ntfy.topic, ntfyDebounceMs: config.ntfy.debounceMs } : {}),
    }));
    res.json({ webhooks: list });
});

app.post("/api/webhooks/create", requireToken, (req, res) => {
    const ALLOWED_HMAC_ALGORITHMS = ["sha256", "sha1", "sha512"];
    const ALLOWED_FORMATTERS = Object.keys(formatters);
    const { name, signatureHeader, hmacAlgorithm, threadId, formatter, eventFilter, labelFilter, ntfy, ntfyTopic, ntfyDebounceMs, requireSignature: reqSig } = req.body || {};
    const requireSig = reqSig !== false; // default true
    if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
    }
    if (hmacAlgorithm && !ALLOWED_HMAC_ALGORITHMS.includes(hmacAlgorithm)) {
        res.status(400).json({ error: `Invalid hmacAlgorithm. Allowed: ${ALLOWED_HMAC_ALGORITHMS.join(", ")}` });
        return;
    }
    if (formatter && !ALLOWED_FORMATTERS.includes(formatter)) {
        res.status(400).json({ error: `Invalid formatter. Allowed: ${ALLOWED_FORMATTERS.join(", ")}` });
        return;
    }
    if (threadId != null && (typeof threadId !== "number" || !Number.isInteger(threadId) || threadId <= 0)) {
        res.status(400).json({ error: "threadId must be a positive integer" });
        return;
    }
    if (eventFilter && (!Array.isArray(eventFilter) || !eventFilter.every((e: unknown) => typeof e === "string"))) {
        res.status(400).json({ error: "eventFilter must be an array of strings" });
        return;
    }
    if (labelFilter && (!Array.isArray(labelFilter) || !labelFilter.every((e: unknown) => typeof e === "string"))) {
        res.status(400).json({ error: "labelFilter must be an array of strings" });
        return;
    }

    const id = "wh_" + crypto.randomBytes(4).toString("hex");
    const secret = requireSig ? crypto.randomBytes(32).toString("hex") : "";

    const config: WebhookConfig = {
        name,
        secret,
        requireSignature: requireSig,
        signatureHeader: signatureHeader || "x-hub-signature-256",
        signaturePrefix: "sha256=",
        hmacAlgorithm: hmacAlgorithm || "sha256",
        formatter: formatter || "github",
        createdAt: Date.now(),
        ...(threadId != null ? { threadId } : {}),
        ...(eventFilter ? { eventFilter } : {}),
        ...(labelFilter ? { labelFilter } : {}),
        ...(ntfy ? { ntfy } : ntfyTopic ? { ntfy: { topic: ntfyTopic, ...(ntfyDebounceMs ? { debounceMs: ntfyDebounceMs } : {}) } } : {}),
    };

    const webhooks = loadWebhooks();
    webhooks[id] = config;
    writeWebhooks(webhooks);

    const response = { id, ...config };
    if (!requireSig) delete (response as Record<string, unknown>).secret;
    res.status(201).json(response);
});

app.put("/api/webhooks/:id/update", requireToken, (req: express.Request<{ id: string }>, res) => {
    const webhooks = loadWebhooks();
    const existing = webhooks[req.params.id];
    if (!existing) {
        res.status(404).json({ error: "Webhook not found" });
        return;
    }

    const { name, threadId, ntfy, ntfyTopic, ntfyDebounceMs, formatter, eventFilter, labelFilter } = req.body || {};
    if (name !== undefined) existing.name = name;
    if (threadId !== undefined) existing.threadId = threadId;
    if (ntfy !== undefined) existing.ntfy = ntfy;
    else if (ntfyTopic !== undefined) existing.ntfy = { topic: ntfyTopic, ...(ntfyDebounceMs ? { debounceMs: ntfyDebounceMs } : {}) };
    if (formatter !== undefined) existing.formatter = formatter;
    if (eventFilter !== undefined) existing.eventFilter = eventFilter;
    if (labelFilter !== undefined) existing.labelFilter = labelFilter;

    webhooks[req.params.id] = existing;
    writeWebhooks(webhooks);

    res.json({ id: req.params.id, ...redactSecret(existing) });
});

app.delete("/api/webhooks/:id/delete", requireToken, (req: express.Request<{ id: string }>, res) => {
    const webhooks = loadWebhooks();
    if (!webhooks[req.params.id]) {
        res.status(404).json({ error: "Webhook not found" });
        return;
    }

    delete webhooks[req.params.id];
    writeWebhooks(webhooks);

    res.json({ deleted: true });
});

app.post("/api/webhooks/:id/rotate", requireToken, (req: express.Request<{ id: string }>, res) => {
    const webhooks = loadWebhooks();
    if (!webhooks[req.params.id]) {
        res.status(404).json({ error: "Webhook not found" });
        return;
    }

    const newSecret = crypto.randomBytes(32).toString("hex");
    webhooks[req.params.id].secret = newSecret;
    writeWebhooks(webhooks);

    res.json({ id: req.params.id, secret: newSecret });
});

// ─── Generic Webhook Handler (HMAC signature auth) ───

app.post("/api/webhooks/:id", (req: express.Request<{ id: string }> & { rawBody?: Buffer }, res) => {
    const webhooks = loadWebhooks();
    const config = webhooks[req.params.id];
    if (!config) {
        res.status(404).json({ error: "Webhook not found" });
        return;
    }

    // Verify HMAC signature (skip if requireSignature is false)
    if (config.requireSignature !== false) {
        const signature = req.headers[config.signatureHeader.toLowerCase()] as string | undefined;
        if (!signature || !req.rawBody) {
            res.status(401).json({ error: "Missing signature" });
            return;
        }

        const computed = config.signaturePrefix +
            crypto.createHmac(config.hmacAlgorithm, config.secret).update(req.rawBody).digest("hex");

        if (signature.length !== computed.length ||
            !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed))) {
            res.status(401).json({ error: "Invalid signature" });
            return;
        }
    }

    // Handle GitHub ping event
    const githubEvent = req.headers["x-github-event"] as string | undefined;
    if (githubEvent === "ping") {
        res.status(200).json({ pong: true });
        return;
    }

    // Event filtering
    if (config.eventFilter && config.eventFilter.length > 0 && githubEvent) {
        if (!config.eventFilter.includes(githubEvent)) {
            res.status(200).json({ filtered: true });
            return;
        }
    }

    // Label filtering — check if issue/PR has a matching label
    if (config.labelFilter && config.labelFilter.length > 0) {
        const payload = req.body as { issue?: { labels?: Array<{ name?: string }> }; pull_request?: { labels?: Array<{ name?: string }> } };
        const entity = payload.pull_request || payload.issue;
        const labels = (entity?.labels || []).map(l => l.name || "").filter(Boolean);
        const hasMatch = config.labelFilter.some(f => labels.includes(f));
        if (!hasMatch) {
            res.status(200).json({ filtered: true, reason: "label" });
            return;
        }
    }

    // Format payload
    const formatter = formatters[config.formatter];
    if (!formatter) {
        res.status(500).json({ error: `Unknown formatter: ${config.formatter}` });
        return;
    }

    const headers = req.headers as Record<string, string>;
    const formatted = formatter(headers, req.body);
    if (!formatted) {
        res.status(200).json({ skipped: true });
        return;
    }

    // Coalesce events for the same issue/PR within a short window
    const eventStr = githubEvent ? `${githubEvent}${req.body?.action ? `.${req.body.action}` : ""}` : "unknown";
    const action = (req.body as { action?: string })?.action || "";
    const coalesceInfo = getCoalesceKey(req.params.id, req.headers as Record<string, string>, req.body);

    if (coalesceInfo) {
        const { key, subject } = coalesceInfo;
        const existing = coalesceBatches.get(key);

        if (existing) {
            // Append to existing batch, keep timer running
            existing.events.push({ formatted, event: eventStr, action });
            res.status(200).json({ coalesced: true, key });
            return;
        }

        // Start new coalesce window
        const entry: CoalesceEntry = {
            timer: setTimeout(() => {
                coalesceBatches.delete(key);
                deliverCoalescedBatch(entry);
            }, COALESCE_WINDOW_MS),
            events: [{ formatted, event: eventStr, action }],
            webhookId: req.params.id,
            config,
            subject,
        };
        entry.timer.unref();
        coalesceBatches.set(key, entry);

        res.status(200).json({ coalesced: true, key });
        return;
    }

    // Non-coalesceable event (push, etc.) — deliver immediately
    let messageId: string | undefined;
    if (config.threadId) {
        try {
            const result = enqueueWebhookMessage({
                threadId: config.threadId,
                sender: config.name,
                message: formatted,
            });
            messageId = result.messageId;
        } catch (err) {
            res.status(500).json({ error: toErrorMessage(err) });
            return;
        }
    }

    if (config.ntfy && formatted) {
        debounceNtfy(config.ntfy.topic, config.ntfy.debounceMs ?? 0, formatted);
    }

    try {
        const deliveryEntry = JSON.stringify({
            webhookId: req.params.id,
            ts: Date.now(),
            event: eventStr,
            status: "ok",
            ...(config.threadId ? { threadId: config.threadId } : {}),
            ...(config.ntfy ? { ntfy: true } : {}),
        });
        fs.appendFileSync(DELIVERIES_FILE, deliveryEntry + "\n");
    } catch {
        // Best-effort logging
    }

    res.status(200).json({ delivered: true, ...(messageId ? { messageId } : {}) });
});

// ─── Auth Endpoints ───

app.post("/auth/claim", async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(ip)) {
        res.status(429).json({ error: "Too many attempts" });
        return;
    }

    const code = req.body?.code;
    if (!code || typeof code !== "string") {
        res.status(400).json({ error: "Missing code" });
        return;
    }

    const result = claimAuthCode(code);
    if (!result) {
        recordFailedAttempt(ip);
        res.status(401).json({ error: "Invalid or expired code" });
        return;
    }

    const tokenInfo = await createToken(result.telegramUserId, result.userName);
    res.json({ token: tokenInfo.token, expires_at: tokenInfo.expiresAt, userName: tokenInfo.userName });
});

app.post("/auth/gh-token", async (req, res) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) {
        res.status(401).json({ error: "Missing or invalid Authorization header" });
        return;
    }

    const org = req.body?.org as string | undefined;
    const result = await getGitHubToken(token, org);
    if (!result) {
        res.status(401).json({ error: "Invalid token or no access" });
        return;
    }

    res.json(result);
});

app.post("/auth/validate", async (req, res) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) {
        res.status(401).json({ error: "Missing or invalid Authorization header" });
        return;
    }

    const tokenInfo = await validateToken(token);
    if (!tokenInfo) {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
    }

    res.json({ valid: true, userName: tokenInfo.userName });
});

// ─── Start/Stop ───

let server: http.Server | null = null;

export function startWebhookServer(): http.Server {
    startAuthSweep();
    server = http.createServer(app);
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Webhook server listening on http://0.0.0.0:${PORT}`);
    });
    return server;
}

export function stopWebhookServer(): Promise<void> {
    stopAuthSweep();
    return new Promise((resolve) => {
        if (server) {
            server.close(() => resolve());
        } else {
            resolve();
        }
    });
}
