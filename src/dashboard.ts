/**
 * Dashboard - Real-time monitoring server for Borg
 * Serves a single HTML page with 7 views and provides API + SSE endpoints.
 */

import express from "express";
import fs from "fs";
import path from "path";
import http from "http";
import { Cron } from "croner";
import { z } from "zod/v4";
import {
    type DockerContainerInspect,
    fetchDockerJson,
    fetchDockerStats,
    getAllContainers,
    isValidContainerId,
    validateAndUpdateMemory,
    OS_RESERVE_BYTES,
} from "./docker-client.js";
import { parseMeminfo, parseCpuPercent, getDiskUsage, countQueueFiles, PROC_BASE } from "./host-metrics.js";
import { toErrorMessage, isValidSessionId, ValidationError } from "./types.js";
import type { PendingApproval, BackgroundTaskState } from "./types.js";
import { mergeCorrectionsOntoDecisions } from "./routing-logger.js";
import { readRecentJsonl } from "./jsonl-reader.js";
import { loadZoneConfig, getThreadZone, addThreadToZone, removeThreadFromZones, saveZoneConfig, clearZoneConfigCache, listZoneDirs, listZoneDirsWithNames } from "./zone-config.js";
import { createZoneContainer, deleteZoneContainer, getZoneContainerStatus } from "./zone-supervisor.js";
import { loadZoneTemplates, ZONE_NAME_REGEX, RESERVED_ZONE_NAMES, SYSTEM_ZONE_NAMES } from "./zone-templates.js";
import { acquireZoneConfigLock } from "./zone-lock.js";
import { writeTaskStopSignal } from "./task-stop.js";

const SCRIPT_DIR = path.resolve(__dirname, "..");
const BORG_DIR = path.join(SCRIPT_DIR, ".borg");
const BORG_INFRA_DIR = path.join(SCRIPT_DIR, ".borg-infra");
const BORG_ZONES_DIR = path.join(SCRIPT_DIR, ".borg-zones");
const STATIC_DIR = path.join(SCRIPT_DIR, "static");
const SESSIONS_DIR = path.join(BORG_DIR, "sessions");
// threads.json is at project root (shared across all zone containers)
const THREADS_FILE = path.join(SCRIPT_DIR, "threads.json");
const PORT = parseInt(process.env.DASHBOARD_PORT || "3100", 10);
const DOCKER_PROXY_URL = process.env.DOCKER_PROXY_URL || "http://localhost:2375";
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT || "";
if (!COMPOSE_PROJECT) {
    console.warn("COMPOSE_PROJECT not set — infra containers will not be shown");
}

// ─── JSONL Readers ───

interface TailState {
    offset: number;
}

// ─── Host Metrics (dashboard-local) ───

function parseLoadAvg(): { load1: number; load5: number; load15: number } {
    try {
        const content = fs.readFileSync(path.join(PROC_BASE, "loadavg"), "utf8");
        const parts = content.split(/\s+/);
        return {
            load1: parseFloat(parts[0]),
            load5: parseFloat(parts[1]),
            load15: parseFloat(parts[2]),
        };
    } catch {
        return { load1: 0, load5: 0, load15: 0 };
    }
}

// ─── Helpers ───

function readJsonSafe<T>(filePath: string, fallback: T): T {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
        return fallback;
    }
}

// ─── Per-client SSE tail reader ───
// Each SSE client gets its own offset tracking so multiple dashboard
// clients don't interfere with each other.

function readNewBytes(filePath: string, state: TailState): string | null {
    if (!fs.existsSync(filePath)) return null;
    const newStat = fs.statSync(filePath);
    // Detect rotation
    if (newStat.size < state.offset) state.offset = 0;
    // Nothing new
    if (newStat.size === state.offset) return null;

    const fd = fs.openSync(filePath, "r");
    try {
        const bytesToRead = newStat.size - state.offset;
        const buf = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buf, 0, bytesToRead, state.offset);
        state.offset = newStat.size;
        return buf.toString("utf8");
    } finally {
        fs.closeSync(fd);
    }
}

// ─── Express App ───

const app = express();

app.use(express.json({
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        // Preserve raw body for webhook delivery proxy (HMAC signature verification)
        req.rawBody = buf;
    },
}));

// Serve static files
app.use("/static", express.static(STATIC_DIR));

// GET /health (unauthenticated)
app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
});

// GET /login (unauthenticated)
app.get("/login", (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, "login.html"));
});

// Auth proxy routes (unauthenticated — these ARE the login flow)
app.post("/auth/claim", async (req, res) => {
    try {
        const response = await fetch("http://infra:3001/auth/claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
        });
        const data = await response.json() as Record<string, unknown>;
        if (response.ok && typeof data.token === "string") {
            // Set cookie server-side with HttpOnly + Secure + SameSite
            const maxAge = 30 * 24 * 60 * 60; // 30 days
            res.setHeader("Set-Cookie",
                `borg_token=${data.token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`);
            // Don't expose the raw token to JS — just confirm success
            res.json({ ok: true, userName: data.userName });
        } else {
            res.status(response.status).json(data);
        }
    } catch (err) {
        res.status(502).json({ error: "Auth service unreachable" });
    }
});

app.post("/auth/validate", async (req, res) => {
    try {
        const response = await fetch("http://infra:3001/auth/validate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
            },
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        res.status(502).json({ error: "Auth service unreachable" });
    }
});

// Webhook delivery proxy (unauthenticated — uses HMAC signature verification on infra side)
app.post("/api/webhooks/:id", async (req: express.Request<{ id: string }> & { rawBody?: Buffer }, res, next) => {
    // Only match webhook IDs (wh_*), not CRUD sub-paths handled by authenticated routes
    if (!req.params.id.startsWith("wh_")) return next();
    try {
        const headers: Record<string, string> = { "Content-Type": req.headers["content-type"] || "application/json" };
        for (const h of ["x-hub-signature-256", "x-hub-signature", "x-github-event", "x-github-delivery"]) {
            if (req.headers[h]) headers[h] = req.headers[h] as string;
        }
        const response = await fetch(`http://infra:3001/api/webhooks/${req.params.id}`, {
            method: "POST",
            headers,
            body: req.rawBody || JSON.stringify(req.body),
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch { res.status(502).json({ error: "Infra unreachable" }); }
});

// ─── Auth Middleware ───

function getCookieValue(req: express.Request, name: string): string | undefined {
    const cookie = req.headers.cookie;
    if (!cookie) return undefined;
    const match = cookie.split(";").map(s => s.trim()).find(s => s.startsWith(`${name}=`));
    return match ? match.slice(name.length + 1) : undefined;
}

async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : getCookieValue(req, "borg_token");

    if (!token) {
        if (req.path.startsWith("/api/")) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        return res.redirect("/login");
    }

    try {
        const response = await fetch("http://infra:3001/auth/validate", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
        if (!response.ok) {
            if (req.path.startsWith("/api/")) {
                return res.status(401).json({ error: "Unauthorized" });
            }
            return res.redirect("/login");
        }
        next();
    } catch {
        // Fail closed — don't bypass auth when infra is unreachable
        if (req.path.startsWith("/api/")) {
            return res.status(503).json({ error: "Auth service unavailable" });
        }
        return res.status(503).send("Authentication service temporarily unavailable. Please retry.");
    }
}

app.use(requireAuth);

// GET / — serves the dashboard HTML
app.get("/", (_req, res) => {
    const htmlPath = path.join(STATIC_DIR, "dashboard.html");
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.status(404).send("Dashboard HTML not found. Place static/dashboard.html.");
    }
});

// GET /api/status — service health, queue depth, thread summary, host metrics
app.get("/api/status", (_req, res) => {
    const threads = readJsonSafe<Record<string, unknown>>(
        THREADS_FILE,
        {},
    );
    const queueIncoming = countQueueFiles(path.join(BORG_DIR, "queue/incoming"));
    const queueProcessing = countQueueFiles(path.join(BORG_DIR, "queue/processing"));
    const queueDeadLetter = countQueueFiles(path.join(BORG_DIR, "queue/dead-letter"));
    const memBytes = parseMeminfo();
    const cpu = parseCpuPercent();
    const load = parseLoadAvg();
    const disk = getDiskUsage(BORG_DIR);
    const mem = {
        totalMB: Math.round(memBytes.totalBytes / 1024 / 1024),
        usedMB: Math.round((memBytes.totalBytes - memBytes.availableBytes) / 1024 / 1024),
        availableMB: Math.round(memBytes.availableBytes / 1024 / 1024),
    };

    // Add zone labels to each thread
    let zoneConfig: ReturnType<typeof loadZoneConfig> = null;
    try { zoneConfig = loadZoneConfig(ZONE_CONFIG_PATH); } catch { /* no zone config */ }

    res.json({
        status: "ok",
        timestamp: Date.now(),
        queue: {
            incoming: queueIncoming,
            processing: queueProcessing,
            deadLetter: queueDeadLetter,
        },
        threads: Object.entries(threads).map(([id, cfg]) => ({
            id,
            ...(cfg as Record<string, unknown>),
            zone: zoneConfig ? getThreadZone(zoneConfig, Number(id)) : undefined,
        })),
        threadCount: Object.keys(threads).length,
        zonesConfigured: !!zoneConfig,
        metrics: { cpu, mem, load, disk },
    });
});

// GET /api/threads — full threads.json
app.get("/api/threads", (_req, res) => {
    const threads = readJsonSafe(THREADS_FILE, {});
    res.json(threads);
});

// GET /api/heartbeats — all threads' HEARTBEAT.md contents
app.get("/api/heartbeats", (_req, res) => {
    const threads = readJsonSafe<Record<string, { name?: string; cwd?: string }>>(
        THREADS_FILE,
        {},
    );
    const results = Object.entries(threads).map(([id, cfg]) => {
        const cwd = cfg.cwd;
        let content: string | null = null;
        let exists = false;
        if (cwd) {
            const heartbeatPath = path.join(cwd, "HEARTBEAT.md");
            if (fs.existsSync(heartbeatPath)) {
                exists = true;
                try { content = fs.readFileSync(heartbeatPath, "utf8"); } catch { content = null; }
            }
        }
        return { threadId: parseInt(id, 10), name: cfg.name || `Thread ${id}`, cwd: cwd || null, exists, content };
    });
    res.json(results);
});

// GET /api/threads/:id/messages — message history filtered by threadId
app.get("/api/threads/:id/messages", (req, res) => {
    const threadId = parseInt(req.params.id, 10);
    const limit = Math.min(parseInt(String(req.query.n ?? "50"), 10) || 50, 200);
    const entries = readRecentJsonl<Record<string, unknown>>(
        path.join(BORG_DIR, "message-history.jsonl"),
        500,
    );
    const filtered = entries.filter(e => e.threadId === threadId).slice(-limit);
    res.json(filtered);
});

// GET /api/messages/recent?n=50 — recent messages across all threads
app.get("/api/messages/recent", (req, res) => {
    const n = Math.min(parseInt(String(req.query.n ?? "50"), 10) || 50, 200);
    const entries = readRecentJsonl(path.join(BORG_DIR, "message-history.jsonl"), n);
    res.json(entries);
});

// GET /api/messages/feed — SSE stream of new messages (broadcast pattern)
app.get("/api/messages/feed", (_req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(":\n\n"); // SSE comment to establish connection

    const historyFile = path.join(BORG_DIR, "message-history.jsonl");
    const tailState: TailState = { offset: 0 };

    // Initialize to current EOF so we only send new messages
    if (fs.existsSync(historyFile)) {
        const stat = fs.statSync(historyFile);
        tailState.offset = stat.size;
    }

    const client: FeedClient = { res, tailState };
    messageFeedClients.add(client);
    startMessageFeed();

    _req.on("close", () => {
        messageFeedClients.delete(client);
        stopMessageFeedIfIdle();
    });
});

// GET /api/routing/feed — SSE stream of routing decisions (broadcast pattern)
app.get("/api/routing/feed", (_req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(":\n\n");

    const routingFile = path.join(BORG_INFRA_DIR, "logs/routing.jsonl");
    const tailState: TailState = { offset: 0 };

    if (fs.existsSync(routingFile)) {
        const stat = fs.statSync(routingFile);
        tailState.offset = stat.size;
    }

    const client: FeedClient = { res, tailState };
    routingFeedClients.add(client);
    startRoutingFeed();

    _req.on("close", () => {
        routingFeedClients.delete(client);
        stopRoutingFeedIfIdle();
    });
});

// GET /api/routing/recent?n=50
app.get("/api/routing/recent", (req, res) => {
    const n = Math.min(parseInt(String(req.query.n ?? "50"), 10) || 50, 200);
    const raw = readRecentJsonl<Record<string, unknown>>(path.join(BORG_INFRA_DIR, "logs/routing.jsonl"), n);
    const decisions = mergeCorrectionsOntoDecisions(raw);
    res.json(decisions);
});

// GET /api/metrics — CPU, RAM, disk, load
app.get("/api/metrics", (_req, res) => {
    const memBytes = parseMeminfo();
    res.json({
        cpu: parseCpuPercent(),
        mem: {
            totalMB: Math.round(memBytes.totalBytes / 1024 / 1024),
            usedMB: Math.round((memBytes.totalBytes - memBytes.availableBytes) / 1024 / 1024),
            availableMB: Math.round(memBytes.availableBytes / 1024 / 1024),
        },
        load: parseLoadAvg(),
        disk: getDiskUsage(BORG_DIR),
        timestamp: Date.now(),
    });
});

// ─── Docker Container Management ───

function parseMemoryLimit(limit: string): number | null {
    const match = limit.match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/i);
    if (!match) return null;
    const num = parseFloat(match[1]);
    const unit = (match[2] || "b").toLowerCase();
    switch (unit) {
        case "k":
        case "kb":
            return Math.round(num * 1024);
        case "m":
        case "mb":
            return Math.round(num * 1024 * 1024);
        case "g":
        case "gb":
            return Math.round(num * 1024 * 1024 * 1024);
        default:
            return Math.round(num);
    }
}

// ─── SSE Broadcast Infrastructure ───

// Per-client state for JSONL tail feeds (each client tracks its own byte offset)
interface FeedClient {
    res: http.ServerResponse;
    tailState: TailState;
}

// ─── Message Feed (broadcast pattern) ───

const messageFeedClients = new Set<FeedClient>();
let messageFeedInterval: ReturnType<typeof setInterval> | null = null;

function startMessageFeed(): void {
    if (messageFeedInterval) return;
    const historyFile = path.join(BORG_DIR, "message-history.jsonl");
    messageFeedInterval = setInterval(() => {
        if (messageFeedClients.size === 0) return;
        for (const client of messageFeedClients) {
            const content = readNewBytes(historyFile, client.tailState);
            if (content === null) continue;
            const lines = content.split("\n").filter(l => l.trim());
            for (const line of lines) {
                try { JSON.parse(line); } catch { continue; } // skip malformed
                try {
                    client.res.write(`data: ${line}\n\n`);
                } catch {
                    messageFeedClients.delete(client);
                    break;
                }
            }
        }
    }, 2000);
}

function stopMessageFeedIfIdle(): void {
    if (messageFeedClients.size === 0 && messageFeedInterval) {
        clearInterval(messageFeedInterval);
        messageFeedInterval = null;
    }
}

// ─── Routing Feed (broadcast pattern) ───

const routingFeedClients = new Set<FeedClient>();
let routingFeedInterval: ReturnType<typeof setInterval> | null = null;

function startRoutingFeed(): void {
    if (routingFeedInterval) return;
    const routingFile = path.join(BORG_INFRA_DIR, "logs/routing.jsonl");
    routingFeedInterval = setInterval(() => {
        if (routingFeedClients.size === 0) return;
        for (const client of routingFeedClients) {
            const content = readNewBytes(routingFile, client.tailState);
            if (content === null) continue;
            const lines = content.split("\n").filter(l => l.trim());
            for (const line of lines) {
                try { JSON.parse(line); } catch { continue; } // skip malformed
                try {
                    client.res.write(`data: ${line}\n\n`);
                } catch {
                    routingFeedClients.delete(client);
                    break;
                }
            }
        }
    }, 2000);
}

function stopRoutingFeedIfIdle(): void {
    if (routingFeedClients.size === 0 && routingFeedInterval) {
        clearInterval(routingFeedInterval);
        routingFeedInterval = null;
    }
}

// ─── Log Feed (broadcast pattern, one group per log type) ───

const logFeedClients: Record<string, Set<FeedClient>> = {};
const logFeedIntervals: Record<string, ReturnType<typeof setInterval>> = {};

function getLogFilePath(type: string): string {
    // telegram.log is in infra, queue.log is in core
    return type === "telegram"
        ? path.join(BORG_INFRA_DIR, "logs/telegram.log")
        : path.join(BORG_DIR, "logs/queue.log");
}

function startLogFeed(type: string): void {
    if (logFeedIntervals[type]) return;
    if (!logFeedClients[type]) logFeedClients[type] = new Set();
    const logFile = getLogFilePath(type);
    logFeedIntervals[type] = setInterval(() => {
        const clients = logFeedClients[type];
        if (!clients || clients.size === 0) return;
        for (const client of clients) {
            const content = readNewBytes(logFile, client.tailState);
            if (content === null) continue;
            const lines = content.split("\n").filter(l => l.trim());
            for (const line of lines) {
                try {
                    client.res.write(`data: ${JSON.stringify(line)}\n\n`);
                } catch {
                    clients.delete(client);
                    break;
                }
            }
        }
    }, 2000);
}

function stopLogFeedIfIdle(type: string): void {
    const clients = logFeedClients[type];
    if ((!clients || clients.size === 0) && logFeedIntervals[type]) {
        clearInterval(logFeedIntervals[type]);
        delete logFeedIntervals[type];
    }
}

// ─── Container Feed (server-side polling with broadcast) ───

const containerFeedClients = new Set<http.ServerResponse>();
let containerFeedInterval: ReturnType<typeof setInterval> | null = null;
let containerFeedPolling = false;

function startContainerFeed(): void {
    if (containerFeedInterval) return;
    containerFeedInterval = setInterval(async () => {
        if (containerFeedClients.size === 0) return;
        // Skip this tick if the previous poll is still running (overlap guard)
        if (containerFeedPolling) return;
        containerFeedPolling = true;
        try {
            const containers = await getAllContainers(DOCKER_PROXY_URL, COMPOSE_PROJECT);
            const host = parseMeminfo();
            const allocatedTotal = containers
                .filter(c => !c.memory.unlimited)
                .reduce((sum, c) => sum + c.memory.limit, 0);
            const unlimitedCount = containers.filter(c => c.memory.unlimited).length;
            const data = JSON.stringify({
                containers,
                host: {
                    totalMemory: host.totalBytes,
                    availableMemory: host.availableBytes,
                    allocatedTotal,
                    osReserve: OS_RESERVE_BYTES,
                    unlimitedCount,
                },
            });
            for (const client of containerFeedClients) {
                try {
                    client.write(`data: ${data}\n\n`);
                } catch {
                    containerFeedClients.delete(client);
                }
            }
        } catch {
            // Docker API may be unavailable, skip this tick
        } finally {
            containerFeedPolling = false;
        }
    }, 5000);
}

function stopContainerFeedIfIdle(): void {
    if (containerFeedClients.size === 0 && containerFeedInterval) {
        clearInterval(containerFeedInterval);
        containerFeedInterval = null;
    }
}

// GET /api/containers — list all dev containers with memory stats
app.get("/api/containers", async (_req, res) => {
    try {
        const containers = await getAllContainers(DOCKER_PROXY_URL, COMPOSE_PROJECT);
        const host = parseMeminfo();
        const allocatedTotal = containers
            .filter(c => !c.memory.unlimited)
            .reduce((sum, c) => sum + c.memory.limit, 0);
        const unlimitedCount = containers.filter(c => c.memory.unlimited).length;
        res.json({
            containers,
            host: {
                totalMemory: host.totalBytes,
                availableMemory: host.availableBytes,
                allocatedTotal,
                osReserve: OS_RESERVE_BYTES,
                unlimitedCount,
            },
        });
    } catch (err) {
        const msg = toErrorMessage(err);
        res.status(502).json({ error: "Failed to fetch containers", detail: msg });
    }
});

// GET /api/containers/:id/stats — live memory stats for a specific container
app.get("/api/containers/:id/stats", async (req, res) => {
    try {
        const containerId = String(req.params.id);
        if (!isValidContainerId(containerId)) {
            res.status(400).json({ error: "Invalid container ID. Expected 12-64 hex characters." });
            return;
        }
        const stats = await fetchDockerStats(DOCKER_PROXY_URL, containerId);
        const inspect = await fetchDockerJson<DockerContainerInspect>(
            DOCKER_PROXY_URL,
            `/containers/${containerId}/json`,
        );
        const usage = stats.memory_stats?.usage || 0;
        const limit = inspect.HostConfig.Memory || stats.memory_stats?.limit || 0;
        res.json({
            id: containerId,
            name: (inspect.Name || "").replace(/^\//, ""),
            memory: {
                usage,
                limit,
                usagePercent: limit > 0 ? Math.round((usage / limit) * 1000) / 10 : 0,
            },
            pids: stats.pids_stats?.current || 0,
        });
    } catch (err) {
        const msg = toErrorMessage(err);
        res.status(502).json({ error: "Failed to fetch container stats", detail: msg });
    }
});

// POST /api/containers/:id/memory — update memory limit
app.post("/api/containers/:id/memory", async (req, res) => {
    try {
        const containerId = String(req.params.id);
        if (!isValidContainerId(containerId)) {
            res.status(400).json({ error: "Invalid container ID. Expected 12-64 hex characters." });
            return;
        }
        const limitStr = (req.body as { limit?: string })?.limit;
        if (!limitStr || typeof limitStr !== "string") {
            res.status(400).json({ error: "Missing or invalid 'limit' field (e.g. '4g', '2048m')" });
            return;
        }

        const newLimitBytes = parseMemoryLimit(limitStr);
        if (newLimitBytes === null) {
            res.status(400).json({ error: "Invalid memory limit format. Use e.g. '4g', '2048m', '1.5gb'" });
            return;
        }
        const hostMem = parseMeminfo();

        const result = await validateAndUpdateMemory(
            DOCKER_PROXY_URL,
            containerId,
            newLimitBytes,
            hostMem.totalBytes,
            COMPOSE_PROJECT,
        );

        res.json(result);
    } catch (err) {
        const msg = toErrorMessage(err);
        const status = err instanceof ValidationError ? 400 : 502;
        res.status(status).json({ error: msg });
    }
});

// GET /api/host/memory — host total RAM and current usage
app.get("/api/host/memory", (_req, res) => {
    const hostMem = parseMeminfo();
    res.json({
        totalMemory: hostMem.totalBytes,
        availableMemory: hostMem.availableBytes,
        usedMemory: hostMem.totalBytes - hostMem.availableBytes,
        osReserve: OS_RESERVE_BYTES,
        maxAllocatable: hostMem.totalBytes - OS_RESERVE_BYTES,
    });
});

// GET /api/containers/feed — SSE stream of container memory stats
app.get("/api/containers/feed", (_req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(":\n\n"); // SSE comment to establish connection

    containerFeedClients.add(res);
    startContainerFeed();

    _req.on("close", () => {
        containerFeedClients.delete(res);
        stopContainerFeedIfIdle();
    });
});

// ─── Session Log Helpers ───

function findSessionLogFile(sessionId: string): string | null {
    // Validate sessionId format (UUID) to prevent path traversal
    if (!isValidSessionId(sessionId)) return null;

    const safeId = path.basename(sessionId); // defense in depth

    // Search across all zone session directories (infra, core, perimeter)
    const sessionDirs = [
        SESSIONS_DIR,
        ...listZoneDirs(ZONE_CONFIG_PATH, BORG_ZONES_DIR, "sessions"),
    ];

    for (const dir of sessionDirs) {
        const logFile = path.join(dir, `${safeId}.jsonl`);
        const resolvedPath = path.resolve(logFile);
        const resolvedDir = path.resolve(dir);
        if (!resolvedPath.startsWith(resolvedDir + path.sep)) continue;
        if (fs.existsSync(logFile)) return logFile;
    }

    return null;
}

function tailLines(filePath: string, n: number): string[] {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    const TAIL_BYTES = Math.min(128 * 1024, stat.size);
    const fd = fs.openSync(filePath, "r");
    try {
        const buf = Buffer.alloc(TAIL_BYTES);
        fs.readSync(fd, buf, 0, TAIL_BYTES, Math.max(0, stat.size - TAIL_BYTES));
        const content = buf.toString("utf8");
        const lines = content.split("\n").filter(l => l.trim());
        return lines.slice(-n);
    } finally {
        fs.closeSync(fd);
    }
}

// GET /api/threads/:id/session-logs?n=20 — tail of Claude SDK session log
app.get("/api/threads/:id/session-logs", (req, res) => {
    const threadId = req.params.id;
    const n = Math.min(parseInt(String(req.query.n ?? "20"), 10) || 20, 200);

    const threads = readJsonSafe<Record<string, { sessionId?: string; cwd?: string }>>(
        THREADS_FILE,
        {},
    );

    const threadConfig = threads[threadId];
    if (!threadConfig?.sessionId) {
        res.json({ lines: [], error: "No active session" });
        return;
    }

    const logFile = findSessionLogFile(threadConfig.sessionId);
    if (!logFile) {
        res.json({ lines: [], error: "Log file not found", sessionId: threadConfig.sessionId });
        return;
    }

    const lines = tailLines(logFile, n);
    res.json({ lines, sessionId: threadConfig.sessionId, logFile });
});

// GET /api/session-logs?n=20 — all active threads' session log tails
app.get("/api/session-logs", (req, res) => {
    const n = Math.min(parseInt(String(req.query.n ?? "20"), 10) || 20, 200);

    const threads = readJsonSafe<Record<string, { sessionId?: string; name?: string }>>(
        THREADS_FILE,
        {},
    );

    const results: Record<string, { name: string; lines: string[]; sessionId: string }> = {};

    for (const [threadId, config] of Object.entries(threads)) {
        if (!config.sessionId) continue;

        const logFile = findSessionLogFile(config.sessionId);
        if (logFile) {
            results[threadId] = {
                name: config.name || `Thread ${threadId}`,
                lines: tailLines(logFile, n),
                sessionId: config.sessionId,
            };
        }
    }

    res.json(results);
});

// GET /api/logs/:type — SSE stream of log files (telegram | queue) (broadcast pattern)
app.get("/api/logs/:type", (req, res) => {
    const type = req.params.type;
    if (type !== "telegram" && type !== "queue") {
        res.status(400).json({ error: "Invalid log type. Use 'telegram' or 'queue'." });
        return;
    }
    const logFile = getLogFilePath(type);

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(":\n\n");

    const tailState: TailState = { offset: 0 };

    if (fs.existsSync(logFile)) {
        const stat = fs.statSync(logFile);
        // Start from last 4KB to show some initial context
        tailState.offset = Math.max(0, stat.size - 4096);
    }

    const client: FeedClient = { res, tailState };
    if (!logFeedClients[type]) logFeedClients[type] = new Set();
    logFeedClients[type].add(client);
    startLogFeed(type);

    req.on("close", () => {
        logFeedClients[type]?.delete(client);
        stopLogFeedIfIdle(type);
    });
});

// ─── Zone Management API ───

const ZONE_CONFIG_PATH = process.env.ZONE_CONFIG_PATH || path.join(SCRIPT_DIR, "zone-config.json");
const ZONE_TEMPLATES_PATH = process.env.ZONE_TEMPLATES_PATH ?? path.join(SCRIPT_DIR, "zone-templates.json");
const ZONE_CONFIG_LOCK_PATH = ZONE_CONFIG_PATH + ".lock";
const HOST_WORKSPACES_DIR = "/host-workspaces"; // dashboard's view of ${WORKSPACE_HOST_BASE}
const ARCHIVED_DIR = path.join(BORG_ZONES_DIR, ".archived");

// Per-zone subdir layout mirrored from scripts/init-zones.sh (ZONE_DIRS array).
// Keep in sync with that script — both are sources of truth for the same shape.
const ZONE_SUBDIRS = [
    "queue/incoming",
    "queue/outgoing",
    "queue/processing",
    "queue/dead-letter",
    "queue/commands",
    "queue/cancel",
    "queue/tasks",
    "queue/task-stop",
    "sessions",
    "status",
    "audio",
    "audio/incoming",
    "images",
    "images/incoming",
    "logs",
    "persistent",
    "claude-skills",
];

function pendingDirs(): string[] {
    return listZoneDirs(ZONE_CONFIG_PATH, BORG_ZONES_DIR, "queue/pending");
}

// GET /api/zones — zone configuration with thread-to-zone mapping + container status
app.get("/api/zones", async (_req, res) => {
    try {
        clearZoneConfigCache();
        const config = loadZoneConfig(ZONE_CONFIG_PATH);
        if (!config) {
            res.json({ configured: false, config: null, threadZones: {}, containerStatus: {} });
            return;
        }

        // Build thread-to-zone lookup from threads.json
        const threads = readJsonSafe<Record<string, { name?: string }>>(
            THREADS_FILE,
            {},
        );
        const threadZones: Record<string, string> = {};
        for (const id of Object.keys(threads)) {
            threadZones[id] = getThreadZone(config, Number(id));
        }

        // Build container status map. System zones (core/perimeter/infra) are
        // compose-managed; for dynamic zones we ask docker-proxy. Failures
        // fall back to "missing" so the dashboard stays usable.
        const zoneNames = Object.keys(config.zones);
        const containerStatus: Record<string, "running" | "created" | "exited" | "missing" | "managed-by-compose"> = {};

        const dynamicLookups = zoneNames
            .filter(name => !SYSTEM_ZONE_NAMES.has(name))
            .map(async (name) => {
                try {
                    const info = await getZoneContainerStatus(name);
                    containerStatus[name] = info.status;
                } catch (err) {
                    console.error(
                        `[dashboard] getZoneContainerStatus("${name}") failed: ${toErrorMessage(err)}`,
                    );
                    containerStatus[name] = "missing";
                }
            });

        for (const name of zoneNames) {
            if (SYSTEM_ZONE_NAMES.has(name)) {
                containerStatus[name] = "managed-by-compose";
            }
        }

        await Promise.all(dynamicLookups);

        res.json({ configured: true, config, threadZones, containerStatus });
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

// POST /api/zones — create a new dynamic zone (config + dirs + container)
app.post("/api/zones", async (req, res) => {
    try {
        const body = req.body as { name?: unknown; template?: unknown };
        const name = typeof body.name === "string" ? body.name : "";
        const template = typeof body.template === "string" ? body.template : "";

        // 1. Validate
        if (!name) {
            res.status(400).json({ error: "Missing zone name", step: "validate" });
            return;
        }
        if (!ZONE_NAME_REGEX.test(name)) {
            res.status(400).json({
                error: `Invalid zone name "${name}" (must match ${ZONE_NAME_REGEX.source})`,
                step: "validate",
            });
            return;
        }
        if (SYSTEM_ZONE_NAMES.has(name)) {
            res.status(400).json({ error: "Cannot create system zone", step: "validate" });
            return;
        }
        if (RESERVED_ZONE_NAMES.has(name)) {
            res.status(400).json({
                error: `Zone name "${name}" is reserved`,
                step: "validate",
            });
            return;
        }
        if (!template) {
            res.status(400).json({ error: "Missing template", step: "validate" });
            return;
        }

        // Validate template existence pre-lock (cheap; avoids lock + rollback path)
        try {
            const templates = loadZoneTemplates(ZONE_TEMPLATES_PATH);
            if (!(template in templates)) {
                res.status(400).json({ error: `Unknown template "${template}"`, step: "validate" });
                return;
            }
        } catch (err) {
            res.status(500).json({ error: toErrorMessage(err), step: "load-templates" });
            return;
        }

        // 2. Acquire lock
        let lock;
        try {
            lock = acquireZoneConfigLock(ZONE_CONFIG_LOCK_PATH);
        } catch (err) {
            res.status(503).json({
                error: `Could not acquire zone-config lock: ${toErrorMessage(err)}`,
                step: "lock",
            });
            return;
        }

        const zoneDir = path.join(BORG_ZONES_DIR, name);
        const workspaceDir = path.join(HOST_WORKSPACES_DIR, "workspace-" + name);
        let configAdded = false;
        let zoneDirCreated = false;
        let workspaceDirCreated = false;

        try {
            // 3. Re-read config
            clearZoneConfigCache();
            const config = loadZoneConfig(ZONE_CONFIG_PATH);
            if (!config) {
                res.status(500).json({
                    error: "zone-config.json does not exist; refusing to create zone in uninitialized borg",
                    step: "load-config",
                });
                return;
            }

            // 4. Exists check
            if (config.zones[name]) {
                res.status(409).json({ error: "Zone already exists", step: "exists" });
                return;
            }

            // 5. Add to config + save
            const updated = structuredClone(config);
            updated.zones[name] = { threads: [], template };
            saveZoneConfig(ZONE_CONFIG_PATH, updated);
            configAdded = true;

            // 6. Create per-zone dir structure (mirror init-zones.sh ZONE_DIRS)
            try {
                for (const sub of ZONE_SUBDIRS) {
                    fs.mkdirSync(path.join(zoneDir, sub), { recursive: true });
                }
                // message-history.jsonl + claude-settings.json (touch empty)
                const historyFile = path.join(zoneDir, "message-history.jsonl");
                if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, "");
                const claudeSettings = path.join(zoneDir, "claude-settings.json");
                if (!fs.existsSync(claudeSettings)) fs.writeFileSync(claudeSettings, "{}");
                zoneDirCreated = true;
            } catch (err) {
                throw new Error(`Failed to create zone "${name}" at step "create-zone-dir": ${toErrorMessage(err)}`);
            }

            // 6b. Sync skills/global/ → claude-skills/ (mirror init-zones.sh L147-149)
            const skillsGlobalDir = path.join(SCRIPT_DIR, "skills", "global");
            const zoneSkillsDir = path.join(BORG_ZONES_DIR, name, "claude-skills");
            if (fs.existsSync(skillsGlobalDir)) {
                try {
                    fs.cpSync(skillsGlobalDir, zoneSkillsDir, { recursive: true });
                } catch (err) {
                    // Best-effort — log and continue. Mirrors init-zones.sh's `|| true`.
                    console.warn(`[dashboard] Failed to sync skills/global → ${zoneSkillsDir}: ${toErrorMessage(err)}`);
                }
            }

            // 7. Create workspace dir (AD7)
            try {
                fs.mkdirSync(workspaceDir, { recursive: true });
                workspaceDirCreated = true;
                try {
                    fs.chownSync(workspaceDir, 1000, 1000);
                } catch (chownErr) {
                    console.error(
                        `[dashboard] chown workspace dir "${workspaceDir}" to 1000:1000 failed (continuing): ${toErrorMessage(chownErr)}`,
                    );
                }
            } catch (err) {
                throw new Error(`Failed to create zone "${name}" at step "create-workspace-dir": ${toErrorMessage(err)}`);
            }

            // 8. Create container
            let containerInfo;
            try {
                containerInfo = await createZoneContainer({ zoneName: name, template });
            } catch (err) {
                // Parse step name from supervisor error message:
                // "Failed to create zone "x" at step "load-template": ..."
                const msg = toErrorMessage(err);
                const stepMatch = msg.match(/at step "([^"]+)"/);
                const step = stepMatch ? stepMatch[1] : "create-container";

                // Rollback: undo dir creates + config addition
                if (workspaceDirCreated) {
                    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
                    catch (rmErr) { console.error(`[dashboard] rollback rm "${workspaceDir}" failed: ${toErrorMessage(rmErr)}`); }
                }
                if (zoneDirCreated) {
                    try { fs.rmSync(zoneDir, { recursive: true, force: true }); }
                    catch (rmErr) { console.error(`[dashboard] rollback rm "${zoneDir}" failed: ${toErrorMessage(rmErr)}`); }
                }
                if (configAdded) {
                    try {
                        clearZoneConfigCache();
                        const cur = loadZoneConfig(ZONE_CONFIG_PATH);
                        if (cur && cur.zones[name]) {
                            const reverted = structuredClone(cur);
                            delete reverted.zones[name];
                            saveZoneConfig(ZONE_CONFIG_PATH, reverted);
                        }
                    } catch (cfgErr) {
                        console.error(`[dashboard] rollback config for "${name}" failed: ${toErrorMessage(cfgErr)}`);
                    }
                }

                res.status(500).json({ error: msg, step });
                return;
            }

            // 9. (lock released in finally)
            // 10. Success
            res.status(201).json({
                name,
                containerId: containerInfo.id,
                status: containerInfo.status,
            });
        } finally {
            lock.release();
        }
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

// DELETE /api/zones/:name — delete a dynamic zone (container + archive dir + config)
app.delete("/api/zones/:name", async (req, res) => {
    try {
        const name = req.params.name;

        // 1. Validate name format
        if (!name || !ZONE_NAME_REGEX.test(name)) {
            res.status(400).json({
                error: `Invalid zone name "${name}" (must match ${ZONE_NAME_REGEX.source})`,
            });
            return;
        }

        // 2. Reject system + reserved zones. SYSTEM_ZONE_NAMES ⊆
        // RESERVED_ZONE_NAMES by construction (see zone-templates.ts), so a
        // single RESERVED check covers both — kept explicit here for the
        // clearer error message on the system-zone subset.
        if (SYSTEM_ZONE_NAMES.has(name)) {
            res.status(400).json({ error: "Cannot delete system zone" });
            return;
        }
        if (RESERVED_ZONE_NAMES.has(name)) {
            res.status(400).json({ error: `Zone name "${name}" is reserved` });
            return;
        }

        // 3. Acquire lock
        let lock;
        try {
            lock = acquireZoneConfigLock(ZONE_CONFIG_LOCK_PATH);
        } catch (err) {
            res.status(503).json({
                error: `Could not acquire zone-config lock: ${toErrorMessage(err)}`,
            });
            return;
        }

        try {
            // 4. Re-read config
            clearZoneConfigCache();
            const config = loadZoneConfig(ZONE_CONFIG_PATH);
            if (!config || !config.zones[name]) {
                res.status(404).json({ error: `Zone "${name}" not found` });
                return;
            }

            // 5. Threads guard
            const threadCount = config.zones[name].threads.length;
            if (threadCount > 0) {
                res.status(409).json({
                    error: `Reassign ${threadCount} thread${threadCount === 1 ? "" : "s"} first`,
                    threadCount,
                });
                return;
            }

            // 6. Delete container (best-effort)
            try {
                await deleteZoneContainer(name);
            } catch (err) {
                console.error(
                    `[dashboard] deleteZoneContainer("${name}") failed (continuing): ${toErrorMessage(err)}`,
                );
            }

            // 7. Archive zone dir
            const zoneDir = path.join(BORG_ZONES_DIR, name);
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const archivedPath = path.join(ARCHIVED_DIR, `${name}-${stamp}`);
            if (fs.existsSync(zoneDir)) {
                try {
                    fs.mkdirSync(ARCHIVED_DIR, { recursive: true });
                    fs.renameSync(zoneDir, archivedPath);
                } catch (err) {
                    console.error(
                        `[dashboard] archive "${zoneDir}" -> "${archivedPath}" failed (continuing): ${toErrorMessage(err)}`,
                    );
                }
            }

            // 8. Remove from config
            const updated = structuredClone(config);
            delete updated.zones[name];
            saveZoneConfig(ZONE_CONFIG_PATH, updated);

            // 10. Success
            res.json({ name, archivedPath });
        } finally {
            lock.release();
        }
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

// GET /api/zone-templates — list available templates + name validation rules
app.get("/api/zone-templates", (_req, res) => {
    try {
        const templates = loadZoneTemplates(ZONE_TEMPLATES_PATH);
        const out: Record<string, { description: string }> = {};
        for (const [name, tpl] of Object.entries(templates)) {
            out[name] = { description: tpl._description ?? "" };
        }
        res.json({
            templates: out,
            reservedNames: Array.from(RESERVED_ZONE_NAMES),
            systemNames: Array.from(SYSTEM_ZONE_NAMES),
            nameRegex: ZONE_NAME_REGEX.source,
        });
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

// POST /api/zones/move — move a thread to a different zone
app.post("/api/zones/move", (req, res) => {
    try {
        const { threadId, zone } = req.body as { threadId?: number; zone?: string };
        if (!threadId || !zone) {
            res.status(400).json({ error: "Missing threadId or zone" });
            return;
        }
        clearZoneConfigCache();
        let config = loadZoneConfig(ZONE_CONFIG_PATH);
        if (!config) {
            // Auto-create zone-config.json with default zones
            config = {
                zones: { core: { threads: [] }, perimeter: { threads: [] } },
                defaults: { newThread: "core" },
            };
            saveZoneConfig(ZONE_CONFIG_PATH, config);
        }
        if (!config.zones[zone]) {
            res.status(400).json({ error: `Zone "${zone}" does not exist` });
            return;
        }
        const updated = structuredClone(config);
        addThreadToZone(updated, threadId, zone);
        saveZoneConfig(ZONE_CONFIG_PATH, updated);
        res.json({ success: true, threadId, zone });
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

// POST /api/zones/remove — remove a thread from all zones
app.post("/api/zones/remove", (req, res) => {
    try {
        const { threadId } = req.body as { threadId?: number };
        if (!threadId) {
            res.status(400).json({ error: "Missing threadId" });
            return;
        }
        clearZoneConfigCache();
        const config = loadZoneConfig(ZONE_CONFIG_PATH);
        if (!config) {
            res.json({ success: true, threadId, zone: null });
            return;
        }
        const updated = removeThreadFromZones(structuredClone(config), threadId);
        saveZoneConfig(ZONE_CONFIG_PATH, updated);
        res.json({ success: true, threadId, zone: null });
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

// GET /api/zones/pending — list pending cross-zone approvals
app.get("/api/zones/pending", (_req, res) => {
    try {
        const pending: Array<PendingApproval & { ageMs: number }> = [];
        for (const dir of pendingDirs()) {
            if (!fs.existsSync(dir)) continue;
            const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const data: PendingApproval = JSON.parse(
                        fs.readFileSync(path.join(dir, file), "utf8"),
                    );
                    pending.push({ ...data, ageMs: Date.now() - data.timestamp });
                } catch { /* skip malformed */ }
            }
        }
        pending.sort((a, b) => a.timestamp - b.timestamp);
        res.json({ pending });
    } catch (err) {
        res.status(500).json({ error: toErrorMessage(err) });
    }
});

// GET /api/usage?days=7 — aggregated token usage and cost data
app.get("/api/usage", (_req, res) => {
    const days = Math.min(Math.max(parseInt(String(_req.query.days ?? "7"), 10) || 7, 1), 90);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    // Read threads.json for name resolution
    const threads = readJsonSafe<Record<string, { name?: string }>>(
        THREADS_FILE,
        {},
    );

    // Collect message history from all zone directories
    const historyFiles: string[] = [];
    const zoneDirs = [
        BORG_DIR,
        ...listZoneDirs(ZONE_CONFIG_PATH, BORG_ZONES_DIR, ""),
    ];

    for (const dir of zoneDirs) {
        const main = path.join(dir, "message-history.jsonl");
        const backup = path.join(dir, "message-history.1.jsonl");
        if (fs.existsSync(main)) historyFiles.push(main);
        if (fs.existsSync(backup)) historyFiles.push(backup);
    }

    // Read and filter entries
    interface UsageEntry {
        ts: number;
        threadId: number;
        model?: string;
        source?: string;
        costUSD?: number;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        durationMs?: number;
        numTurns?: number;
        modelUsage?: Record<string, {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
            cacheCreationInputTokens: number;
            costUSD: number;
        }>;
        direction?: string;
    }

    const entries: UsageEntry[] = [];
    const seenIds = new Set<string>(); // deduplicate across files

    for (const file of historyFiles) {
        try {
            const content = fs.readFileSync(file, "utf8");
            for (const line of content.split("\n")) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line) as UsageEntry & { messageId?: string };
                    if (
                        entry.direction === "out" &&
                        entry.costUSD !== undefined &&
                        entry.ts >= cutoff
                    ) {
                        // Deduplicate by messageId+threadId if available
                        const dedup = entry.messageId
                            ? `${entry.threadId}:${entry.messageId}`
                            : `${entry.threadId}:${entry.ts}`;
                        if (!seenIds.has(dedup)) {
                            seenIds.add(dedup);
                            entries.push(entry);
                        }
                    }
                } catch { /* skip malformed */ }
            }
        } catch { /* file read error */ }
    }

    // Aggregation
    let totalCostUSD = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;

    const byThread = new Map<number, { costUSD: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; queries: number }>();
    const byModel = new Map<string, { costUSD: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; queries: number }>();
    const bySource = new Map<string, { costUSD: number; queries: number }>();
    const byDay = new Map<string, { costUSD: number; queries: number; inputTokens: number; outputTokens: number }>();

    function friendlyModel(model: string | undefined): string {
        if (!model) return "Unknown";
        const lower = model.toLowerCase().replace("[1m]", "");
        if (lower.includes("haiku")) return "Haiku";
        if (lower.includes("sonnet")) return "Sonnet";
        if (lower.includes("opus")) return "Opus";
        if (lower.includes("minimax")) return "M2.5";
        return model;
    }

    for (const e of entries) {
        const cost = e.costUSD ?? 0;
        const inp = e.inputTokens ?? 0;
        const out = e.outputTokens ?? 0;
        const cacheRead = e.cacheReadInputTokens ?? 0;
        const cacheCreate = e.cacheCreationInputTokens ?? 0;

        totalCostUSD += cost;
        totalInputTokens += inp;
        totalOutputTokens += out;
        totalCacheReadTokens += cacheRead;
        totalCacheCreationTokens += cacheCreate;

        // By thread
        const t = byThread.get(e.threadId) ?? { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, queries: 0 };
        t.costUSD += cost;
        t.inputTokens += inp;
        t.outputTokens += out;
        t.cacheReadInputTokens += cacheRead;
        t.cacheCreationInputTokens += cacheCreate;
        t.queries++;
        byThread.set(e.threadId, t);

        // By model
        const modelName = friendlyModel(e.model);
        const m = byModel.get(modelName) ?? { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, queries: 0 };
        m.costUSD += cost;
        m.inputTokens += inp;
        m.outputTokens += out;
        m.cacheReadInputTokens += cacheRead;
        m.cacheCreationInputTokens += cacheCreate;
        m.queries++;
        byModel.set(modelName, m);

        // By source
        const srcName = e.source ?? "user";
        const s = bySource.get(srcName) ?? { costUSD: 0, queries: 0 };
        s.costUSD += cost;
        s.queries++;
        bySource.set(srcName, s);

        // By day
        const date = new Date(e.ts).toISOString().slice(0, 10);
        const d = byDay.get(date) ?? { costUSD: 0, queries: 0, inputTokens: 0, outputTokens: 0 };
        d.costUSD += cost;
        d.queries++;
        d.inputTokens += inp;
        d.outputTokens += out;
        byDay.set(date, d);
    }

    const totalQueries = entries.length;

    res.json({
        totalCostUSD,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens,
        totalCacheCreationTokens,
        totalQueries,
        byThread: Array.from(byThread.entries())
            .map(([threadId, v]) => ({
                threadId,
                threadName: threads[String(threadId)]?.name ?? `Thread ${threadId}`,
                ...v,
            }))
            .sort((a, b) => b.costUSD - a.costUSD),
        byModel: Array.from(byModel.entries())
            .map(([model, v]) => ({ model, ...v }))
            .sort((a, b) => b.costUSD - a.costUSD),
        bySource: Array.from(bySource.entries())
            .map(([source, v]) => ({ source, ...v }))
            .sort((a, b) => b.costUSD - a.costUSD),
        daily: Array.from(byDay.entries())
            .map(([date, v]) => ({ date, ...v }))
            .sort((a, b) => b.date.localeCompare(a.date)),
    });
});

// GET /api/usage/queries — individual query entries with pagination
app.get("/api/usage/queries", (_req, res) => {
    const days = Math.min(Math.max(parseInt(String(_req.query.days ?? "7"), 10) || 7, 1), 90);
    const offset = Math.max(parseInt(String(_req.query.offset ?? "0"), 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(String(_req.query.limit ?? "50"), 10) || 50, 1), 100);
    const filterThread = _req.query.thread ? parseInt(String(_req.query.thread), 10) : null;
    const filterModel = _req.query.model ? String(_req.query.model).toLowerCase() : null;
    const filterSource = _req.query.source ? String(_req.query.source) : null;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const threads = readJsonSafe<Record<string, { name?: string }>>(THREADS_FILE, {});

    // Collect history files from all zone directories (same as /api/usage)
    const historyFiles: string[] = [];
    const zoneDirs = [
        BORG_DIR,
        ...listZoneDirs(ZONE_CONFIG_PATH, BORG_ZONES_DIR, ""),
    ];
    for (const dir of zoneDirs) {
        const main = path.join(dir, "message-history.jsonl");
        const backup = path.join(dir, "message-history.1.jsonl");
        if (fs.existsSync(main)) historyFiles.push(main);
        if (fs.existsSync(backup)) historyFiles.push(backup);
    }

    interface QueryEntry {
        ts: number;
        threadId: number;
        model?: string;
        source?: string;
        costUSD?: number;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        durationMs?: number;
        numTurns?: number;
        message?: string;
        direction?: string;
        messageId?: string;
    }

    const entries: QueryEntry[] = [];
    const seenIds = new Set<string>();

    for (const file of historyFiles) {
        try {
            const content = fs.readFileSync(file, "utf8");
            for (const line of content.split("\n")) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line) as QueryEntry;
                    if (
                        entry.direction === "out" &&
                        entry.costUSD !== undefined &&
                        entry.ts >= cutoff
                    ) {
                        const dedup = entry.messageId
                            ? `${entry.threadId}:${entry.messageId}`
                            : `${entry.threadId}:${entry.ts}`;
                        if (!seenIds.has(dedup)) {
                            seenIds.add(dedup);
                            entries.push(entry);
                        }
                    }
                } catch { /* skip malformed */ }
            }
        } catch { /* file read error */ }
    }

    // Sort newest first
    entries.sort((a, b) => b.ts - a.ts);

    // Apply filters
    function friendlyModelQ(model: string | undefined): string {
        if (!model) return "Unknown";
        const lower = model.toLowerCase();
        if (lower.includes("haiku")) return "Haiku";
        if (lower.includes("sonnet")) return "Sonnet";
        if (lower.includes("opus")) return "Opus";
        if (lower.includes("minimax")) return "M2.5";
        return model;
    }

    const filtered = entries.filter(e => {
        if (filterThread !== null && e.threadId !== filterThread) return false;
        if (filterModel && !friendlyModelQ(e.model).toLowerCase().includes(filterModel)) return false;
        if (filterSource && (e.source ?? "user") !== filterSource) return false;
        return true;
    });

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    res.json({
        queries: page.map(e => ({
            ts: e.ts,
            threadId: e.threadId,
            threadName: threads[String(e.threadId)]?.name ?? `Thread ${e.threadId}`,
            model: friendlyModelQ(e.model),
            source: e.source ?? "user",
            costUSD: e.costUSD ?? 0,
            inputTokens: e.inputTokens ?? 0,
            outputTokens: e.outputTokens ?? 0,
            cacheReadInputTokens: e.cacheReadInputTokens ?? 0,
            cacheCreationInputTokens: e.cacheCreationInputTokens ?? 0,
            durationMs: e.durationMs,
            numTurns: e.numTurns,
            message: e.message ? e.message.slice(0, 120) : undefined,
        })),
        total,
        offset,
        limit,
    });
});

// GET /api/scheduled-tasks — all scheduled tasks with next run times
app.get("/api/scheduled-tasks", (_req, res) => {
    // Read scheduled-tasks.json from all zone directories
    const zoneDirs = [
        BORG_DIR,
        ...listZoneDirs(ZONE_CONFIG_PATH, BORG_ZONES_DIR, ""),
    ];

    interface TaskEntry {
        id: string;
        name: string;
        prompt: string;
        model: string;
        cron: string;
        cwd: string;
        reportThreadId: number;
        enabled: boolean;
        recurring: boolean;
        createdAt: number;
        lastRunTs?: number;
        lastResult?: string;
        lastCostUSD?: number;
    }

    const allTasks: TaskEntry[] = [];
    const seenIds = new Set<string>();

    for (const dir of zoneDirs) {
        const file = path.join(dir, "scheduled-tasks.json");
        try {
            const data = JSON.parse(fs.readFileSync(file, "utf8"));
            for (const task of (data.tasks ?? [])) {
                if (!seenIds.has(task.id)) {
                    seenIds.add(task.id);
                    allTasks.push(task);
                }
            }
        } catch { /* file doesn't exist or is invalid */ }
    }

    // Compute next run times using Croner
    let settingsTimezone = "UTC";
    try {
        const settingsFile = path.join(SCRIPT_DIR, "settings.json");
        const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
        settingsTimezone = settings.timezone || "UTC";
    } catch { /* ignore */ }

    const tasksWithNext = allTasks.map(t => {
        let nextRun: string | null = null;
        try {
            const cron = new Cron(t.cron, { timezone: settingsTimezone });
            const next = cron.nextRun();
            nextRun = next ? next.toISOString() : null;
        } catch { /* invalid cron */ }

        return { ...t, nextRun, timezone: settingsTimezone };
    });

    res.json({ tasks: tasksWithNext });
});

// ─── Background Tasks API ───

// Input validation: messageId and taskId must be safe for use in file paths
const SAFE_ID = /^[a-zA-Z0-9_\-]+$/;

// Zone directories for cross-zone task scanning (infra reads all zones).
// Backed by loadZoneConfig's mtime cache, so calling per request is cheap.
function taskZoneDirs(): string[] {
    return [
        BORG_DIR,
        ...listZoneDirs(ZONE_CONFIG_PATH, BORG_ZONES_DIR, ""),
    ];
}

// GET /api/background-tasks — returns all active background tasks across zones
app.get("/api/background-tasks", (_req, res) => {
    const allStates: BackgroundTaskState[] = [];

    for (const dir of taskZoneDirs()) {
        const tasksDir = path.join(dir, "queue/tasks");
        if (!fs.existsSync(tasksDir)) continue;
        try {
            const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(tasksDir, file), "utf8")) as BackgroundTaskState;
                    allStates.push(data);
                } catch { /* skip malformed */ }
            }
        } catch { /* dir read error */ }
    }

    res.json({ taskStates: allStates });
});

// GET /api/background-tasks/:messageId — returns background tasks for a specific message
app.get("/api/background-tasks/:messageId", (req, res) => {
    const { messageId } = req.params;
    if (!SAFE_ID.test(messageId)) { res.status(400).json({ error: "Invalid messageId" }); return; }

    const data = findBackgroundTasks(messageId);
    res.json(data ?? { threadId: 0, messageId, tasks: {} });
});

// POST /api/background-tasks/:taskId/stop — stop a running background task
app.post("/api/background-tasks/:taskId/stop", (req, res) => {
    const { taskId } = req.params;
    if (!SAFE_ID.test(taskId)) { res.status(400).json({ error: "Invalid taskId" }); return; }

    // Find which zone this task belongs to by scanning task state files.
    // Iterate zone-keyed dirs only (no legacy BORG_DIR) because task-stop writes
    // must land under the rw-mounted zones base (.borg-zones-rw in compose) —
    // a separate read-write mount, distinct from the read-only zones mount.
    // The writeTaskStopSignal helper is the only legitimate writer to that mount.
    for (const { zone, dir } of listZoneDirsWithNames(ZONE_CONFIG_PATH, BORG_ZONES_DIR, "")) {
        const tasksDir = path.join(dir, "queue/tasks");
        if (!fs.existsSync(tasksDir)) continue;
        try {
            const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(tasksDir, file), "utf8"));
                    if (data.tasks && data.tasks[taskId]) {
                        // Found the task — write stop signal via the helper.
                        writeTaskStopSignal(zone, taskId, { ts: Date.now() });
                        res.json({ ok: true, taskId });
                        return;
                    }
                } catch { /* skip */ }
            }
        } catch { /* dir error */ }
    }

    res.status(404).json({ error: "Task not found" });
});

// ─── Single Response Detail ───

// GET /response/:messageId — serve the response detail HTML page
app.get("/response/:messageId", (_req, res) => {
    const htmlPath = path.join(STATIC_DIR, "response.html");
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.status(404).send("Response detail page not found.");
    }
});

/**
 * Find message history entries by messageId across all zone directories.
 * Returns { incoming, outgoing } pair if found.
 */
function findResponseByMessageId(messageId: string): {
    incoming: Record<string, unknown> | null;
    outgoing: Record<string, unknown> | null;
    sessionId: string | undefined;
} {
    const zoneDirs = [
        BORG_DIR,
        ...listZoneDirs(ZONE_CONFIG_PATH, BORG_ZONES_DIR, ""),
    ];

    let incoming: Record<string, unknown> | null = null;
    let outgoing: Record<string, unknown> | null = null;
    let sessionId: string | undefined;

    for (const dir of zoneDirs) {
        const histFile = path.join(dir, "message-history.jsonl");
        if (!fs.existsSync(histFile)) continue;
        try {
            const content = fs.readFileSync(histFile, "utf8");
            for (const line of content.split("\n")) {
                if (!line.trim()) continue;
                try {
                    const entry = JSON.parse(line) as Record<string, unknown>;
                    if (entry.messageId !== messageId) continue;
                    if (entry.direction === "in") {
                        incoming = entry;
                    } else if (entry.direction === "out") {
                        outgoing = entry;
                        if (entry.sessionId) sessionId = entry.sessionId as string;
                    }
                } catch { /* skip malformed */ }
            }
        } catch { /* file read error */ }
    }

    return { incoming, outgoing, sessionId };
}

/**
 * Quick tail-read to find an outgoing entry by messageId.
 * Reads only last 128KB of each history file — much cheaper than full scan.
 */
function findResponseInTail(messageId: string): Record<string, unknown> | null {
    const zoneDirs = [
        BORG_DIR,
        ...listZoneDirs(ZONE_CONFIG_PATH, BORG_ZONES_DIR, ""),
    ];
    const TAIL_BYTES = 128 * 1024;
    for (const dir of zoneDirs) {
        const histFile = path.join(dir, "message-history.jsonl");
        if (!fs.existsSync(histFile)) continue;
        try {
            const stat = fs.statSync(histFile);
            const readStart = Math.max(0, stat.size - TAIL_BYTES);
            const fd = fs.openSync(histFile, "r");
            try {
                const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
                fs.readSync(fd, buf, 0, buf.length, readStart);
                const lines = buf.toString("utf8").split("\n");
                // Scan backwards for faster match
                for (let i = lines.length - 1; i >= 0; i--) {
                    if (!lines[i].trim()) continue;
                    try {
                        const entry = JSON.parse(lines[i]) as Record<string, unknown>;
                        if (entry.messageId === messageId && entry.direction === "out") return entry;
                    } catch { /* skip */ }
                }
            } finally {
                fs.closeSync(fd);
            }
        } catch { /* file read error */ }
    }
    return null;
}

/**
 * Find background task state for a given messageId across all zone directories.
 */
function findBackgroundTasks(messageId: string): BackgroundTaskState | null {
    for (const dir of taskZoneDirs()) {
        const taskFile = path.join(dir, "queue/tasks", `${messageId}.json`);
        if (fs.existsSync(taskFile)) {
            try {
                return JSON.parse(fs.readFileSync(taskFile, "utf8")) as BackgroundTaskState;
            } catch { /* skip */ }
        }
    }
    return null;
}

// GET /api/response/:messageId — full response detail data
app.get("/api/response/:messageId", (req, res) => {
    const { messageId } = req.params;
    const threads = readJsonSafe<Record<string, { name?: string; sessionId?: string }>>(
        THREADS_FILE,
        {},
    );

    const { incoming, outgoing, sessionId } = findResponseByMessageId(messageId);

    if (!incoming && !outgoing) {
        res.status(404).json({ error: "Response not found" });
        return;
    }

    // Get session logs if we have a sessionId
    let sessionLogs: string[] = [];
    const resolvedThreadId = (outgoing?.threadId ?? incoming?.threadId) as number | undefined;
    let resolvedSessionId = sessionId
        || (resolvedThreadId ? threads[String(resolvedThreadId)]?.sessionId : undefined);

    // During processing, sessionId may only be in the status file (before threads.json is updated)
    if (!resolvedSessionId) {
        const zoneDirs = [
            BORG_DIR,
            ...listZoneDirs(ZONE_CONFIG_PATH, BORG_ZONES_DIR, ""),
        ];
        for (const dir of zoneDirs) {
            // Try thread-keyed status file
            if (resolvedThreadId) {
                const tf = path.join(dir, "status", `thread_${resolvedThreadId}.json`);
                if (fs.existsSync(tf)) {
                    try {
                        const status = JSON.parse(fs.readFileSync(tf, "utf8"));
                        if (status.sessionId) { resolvedSessionId = status.sessionId; break; }
                    } catch { /* best effort */ }
                }
            }
            // Legacy: per-messageId
            const sf = path.join(dir, "status", `${messageId}.json`);
            if (fs.existsSync(sf)) {
                try {
                    const status = JSON.parse(fs.readFileSync(sf, "utf8"));
                    if (status.sessionId) { resolvedSessionId = status.sessionId; break; }
                } catch { /* best effort */ }
            }
        }
    }

    if (resolvedSessionId) {
        const logFile = findSessionLogFile(resolvedSessionId);
        if (logFile) {
            sessionLogs = tailLines(logFile, 2000);
        }
    }

    const threadId = (outgoing?.threadId ?? incoming?.threadId) as number | undefined;
    const threadName = threadId ? (threads[String(threadId)]?.name ?? `Thread ${threadId}`) : undefined;

    // Look for background task state
    const backgroundTasks = findBackgroundTasks(messageId);

    res.json({
        messageId,
        threadId,
        threadName,
        incoming,
        outgoing,
        sessionId: resolvedSessionId,
        sessionLogs,
        backgroundTasks,
    });
});

// GET /api/response/:messageId/feed — SSE stream for live response updates
app.get("/api/response/:messageId/feed", (req, res) => {
    const { messageId } = req.params;

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(":\n\n");

    // Find the status file for this messageId (zone-aware)
    function findStatusFile(): string | null {
        const zoneDirs = [
            BORG_DIR,
            ...listZoneDirs(ZONE_CONFIG_PATH, BORG_ZONES_DIR, ""),
        ];
        // Resolve messageId → threadId for thread-keyed status lookup
        const { incoming, outgoing } = findResponseByMessageId(messageId);
        const resolvedThreadId = outgoing?.threadId ?? incoming?.threadId;
        for (const dir of zoneDirs) {
            // Try thread-keyed status file first
            if (resolvedThreadId) {
                const threadFile = path.join(dir, "status", `thread_${resolvedThreadId}.json`);
                if (fs.existsSync(threadFile)) return threadFile;
            }
            // Legacy: per-messageId status file
            const statusFile = path.join(dir, "status", `${messageId}.json`);
            if (fs.existsSync(statusFile)) return statusFile;
        }
        return null;
    }

    // Find session log file for this messageId's thread
    function findSessionLogForMessage(): { logFile: string; sessionId: string } | null {
        const threads = readJsonSafe<Record<string, { sessionId?: string }>>(THREADS_FILE, {});
        const { incoming, outgoing, sessionId } = findResponseByMessageId(messageId);
        // Try: sessionId from outgoing entry → thread's current sessionId (from either incoming or outgoing threadId)
        const threadId = outgoing?.threadId ?? incoming?.threadId;
        const resolvedSessionId = sessionId
            || (threadId ? threads[String(threadId)]?.sessionId : undefined);
        if (!resolvedSessionId) return null;
        const logFile = findSessionLogFile(resolvedSessionId);
        if (!logFile) return null;
        return { logFile, sessionId: resolvedSessionId };
    }

    let sessionLogTail: TailState = { offset: 0 };
    let sessionLogFile: string | null = null;
    let lastStatusJson = "";
    let lastTasksJson = "";
    let completeSent = false;

    // Initialize session log — start from beginning so existing entries are sent
    const sessionInfo = findSessionLogForMessage();
    if (sessionInfo) {
        sessionLogFile = sessionInfo.logFile;
        // offset stays at 0 — first tick will send all existing entries
    }

    const interval = setInterval(() => {
        if (completeSent) return;

        // Check status file
        const statusFile = findStatusFile();
        if (statusFile) {
            try {
                const json = fs.readFileSync(statusFile, "utf8");
                if (json !== lastStatusJson) {
                    lastStatusJson = json;
                    res.write(`event: status\ndata: ${json}\n\n`);
                }
            } catch { /* best effort */ }
        }

        // Check for new session log entries
        if (!sessionLogFile) {
            // Try sessionId from status file first (available early during processing)
            let found = false;
            if (statusFile) {
                try {
                    const status = JSON.parse(lastStatusJson || fs.readFileSync(statusFile, "utf8"));
                    if (status.sessionId) {
                        const logFile = findSessionLogFile(status.sessionId);
                        if (logFile) {
                            sessionLogFile = logFile;
                            sessionLogTail.offset = 0;
                            found = true;
                        }
                    }
                } catch { /* best effort */ }
            }
            // Fall back to message history + threads.json lookup
            if (!found) {
                const info = findSessionLogForMessage();
                if (info) {
                    sessionLogFile = info.logFile;
                    sessionLogTail.offset = 0;
                }
            }
        }

        if (sessionLogFile) {
            const newData = readNewBytes(sessionLogFile, sessionLogTail);
            if (newData) {
                for (const line of newData.split("\n")) {
                    if (!line.trim()) continue;
                    res.write(`event: session-log\ndata: ${line}\n\n`);
                }
            }
        }

        // Check for background task updates
        const bgTasks = findBackgroundTasks(messageId);
        if (bgTasks) {
            const json = JSON.stringify(bgTasks);
            if (json !== lastTasksJson) {
                lastTasksJson = json;
                res.write(`event: background-tasks\ndata: ${json}\n\n`);
            }
        }

        // Check if response is complete: status file gone = processing finished
        // Use tail-read of history (last 64KB) to find the outgoing entry — avoids full file scan
        if (!statusFile && lastStatusJson) {
            // Status file existed before but is now gone — response should be in history
            const outgoing = findResponseInTail(messageId);
            if (outgoing) {
                res.write(`event: complete\ndata: ${JSON.stringify(outgoing)}\n\n`);
                completeSent = true;
                clearInterval(interval);
            }
        }
    }, 2000);

    req.on("close", () => {
        clearInterval(interval);
    });
});

// ─── Webhook CRUD Proxy to Infra ───

/** Extract auth token from Authorization header or cookie, forward as Bearer */
function getProxyAuth(req: express.Request): string {
    if (req.headers.authorization) return req.headers.authorization;
    const cookieToken = getCookieValue(req, "borg_token");
    return cookieToken ? `Bearer ${cookieToken}` : "";
}

function proxyToInfra(method: string, pathFn: (req: express.Request) => string, hasBody = false) {
    return async (req: express.Request, res: express.Response) => {
        try {
            const response = await fetch(`http://infra:3001${pathFn(req)}`, {
                method,
                headers: {
                    ...(hasBody ? { "Content-Type": "application/json" } : {}),
                    Authorization: getProxyAuth(req),
                },
                ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
            });
            const data = await response.json();
            res.status(response.status).json(data);
        } catch { res.status(502).json({ error: "Infra unreachable" }); }
    };
}

app.get("/api/webhooks/list", proxyToInfra("GET", () => "/api/webhooks/list"));
app.post("/api/webhooks/create", proxyToInfra("POST", () => "/api/webhooks/create", true));
app.put("/api/webhooks/:id/update", proxyToInfra("PUT", r => `/api/webhooks/${r.params.id}/update`, true));
app.delete("/api/webhooks/:id/delete", proxyToInfra("DELETE", r => `/api/webhooks/${r.params.id}/delete`));
app.post("/api/webhooks/:id/rotate", proxyToInfra("POST", r => `/api/webhooks/${r.params.id}/rotate`));

app.get("/api/webhooks/deliveries", (_req, res) => {
    const deliveryFile = path.join(BORG_INFRA_DIR, "webhook-deliveries.jsonl");
    const entries = readRecentJsonl<Record<string, unknown>>(deliveryFile, 100);
    res.json(entries);
});

// ─── Start Server ───

const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Dashboard listening on http://0.0.0.0:${PORT}`);
    console.log(`Monitoring: ${BORG_DIR}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
    console.log("Dashboard shutting down...");
    server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
    console.log("Dashboard shutting down...");
    server.close(() => process.exit(0));
});
