/**
 * Dashboard - Real-time monitoring server for Borg
 * Serves a single HTML page with 7 views and provides API + SSE endpoints.
 */

import express from "express";
import fs from "fs";
import path from "path";
import http from "http";
import { Cron } from "croner";
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
import { loadZoneConfig, getThreadZone, addThreadToZone, removeThreadFromZones, saveZoneConfig, clearZoneConfigCache } from "./zone-config.js";

const SCRIPT_DIR = path.resolve(__dirname, "..");
const BORG_DIR = path.join(SCRIPT_DIR, ".borg");
const BORG_INFRA_DIR = path.join(SCRIPT_DIR, ".borg-infra");
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

// JSON body parser (needed for POST endpoints)
app.use(express.json());

// Serve static files
app.use("/static", express.static(STATIC_DIR));

// GET / — serves the dashboard HTML
app.get("/", (_req, res) => {
    const htmlPath = path.join(STATIC_DIR, "dashboard.html");
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.status(404).send("Dashboard HTML not found. Place static/dashboard.html.");
    }
});

// GET /health
app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
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
        path.join(SCRIPT_DIR, ".borg-core", "sessions"),
        path.join(SCRIPT_DIR, ".borg-perimeter", "sessions"),
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
const PENDING_DIRS = [
    path.join(SCRIPT_DIR, ".borg-core/queue/pending"),
    path.join(SCRIPT_DIR, ".borg-perimeter/queue/pending"),
];

// GET /api/zones — zone configuration with thread-to-zone mapping
app.get("/api/zones", (_req, res) => {
    try {
        clearZoneConfigCache();
        const config = loadZoneConfig(ZONE_CONFIG_PATH);
        if (!config) {
            res.json({ configured: false, config: null, threadZones: {} });
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

        res.json({ configured: true, config, threadZones });
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
        for (const dir of PENDING_DIRS) {
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
    const borgDir = BORG_DIR;
    const zoneDirs = [
        borgDir,
        path.join(SCRIPT_DIR, ".borg-core"),
        path.join(SCRIPT_DIR, ".borg-perimeter"),
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
        path.join(SCRIPT_DIR, ".borg-core"),
        path.join(SCRIPT_DIR, ".borg-perimeter"),
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
        path.join(SCRIPT_DIR, ".borg-core"),
        path.join(SCRIPT_DIR, ".borg-perimeter"),
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

// Zone directories for cross-zone task scanning (infra reads all zones)
const TASK_ZONE_DIRS = [
    BORG_DIR,
    path.join(SCRIPT_DIR, ".borg-core"),
    path.join(SCRIPT_DIR, ".borg-perimeter"),
];

// GET /api/background-tasks — returns all active background tasks across zones
app.get("/api/background-tasks", (_req, res) => {
    const allStates: BackgroundTaskState[] = [];

    for (const dir of TASK_ZONE_DIRS) {
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

    // Find which zone this task belongs to by scanning task state files
    for (const dir of TASK_ZONE_DIRS) {
        const tasksDir = path.join(dir, "queue/tasks");
        if (!fs.existsSync(tasksDir)) continue;
        try {
            const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(tasksDir, file), "utf8"));
                    if (data.tasks && data.tasks[taskId]) {
                        // Found the task — write stop signal to this zone
                        const stopDir = path.join(dir, "queue/task-stop");
                        if (!fs.existsSync(stopDir)) {
                            fs.mkdirSync(stopDir, { recursive: true });
                        }
                        const stopFile = path.join(stopDir, `${taskId}.json`);
                        const tmpFile = stopFile + ".tmp";
                        fs.writeFileSync(tmpFile, JSON.stringify({ ts: Date.now() }));
                        fs.renameSync(tmpFile, stopFile);
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
        path.join(SCRIPT_DIR, ".borg-core"),
        path.join(SCRIPT_DIR, ".borg-perimeter"),
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
        path.join(SCRIPT_DIR, ".borg-core"),
        path.join(SCRIPT_DIR, ".borg-perimeter"),
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
    for (const dir of TASK_ZONE_DIRS) {
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
    const resolvedSessionId = sessionId
        || (outgoing?.threadId ? threads[String(outgoing.threadId)]?.sessionId : undefined);
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
            path.join(SCRIPT_DIR, ".borg-core"),
            path.join(SCRIPT_DIR, ".borg-perimeter"),
        ];
        for (const dir of zoneDirs) {
            const statusFile = path.join(dir, "status", `${messageId}.json`);
            if (fs.existsSync(statusFile)) return statusFile;
        }
        return null;
    }

    // Find session log file for this messageId's thread
    function findSessionLogForMessage(): { logFile: string; sessionId: string } | null {
        const threads = readJsonSafe<Record<string, { sessionId?: string }>>(THREADS_FILE, {});
        const { outgoing, sessionId } = findResponseByMessageId(messageId);
        const resolvedSessionId = sessionId
            || (outgoing?.threadId ? threads[String(outgoing.threadId)]?.sessionId : undefined);
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
            const info = findSessionLogForMessage();
            if (info) {
                sessionLogFile = info.logFile;
                sessionLogTail.offset = 0; // Read all existing entries on first find
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
