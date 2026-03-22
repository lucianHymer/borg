#!/usr/bin/env node
/**
 * Queue Processor - Agent SDK v1 query() API with persistent sessions
 *
 * Processes messages from all channels (Telegram, CLI, heartbeat, cross-thread, etc.)
 * via a file-based queue. Regular messages use persistent sessions (SessionPool) —
 * the SDK subprocess stays alive across messages for near-zero latency on consecutive
 * messages and better prompt caching. Heartbeats, scheduled tasks, and one-shots use
 * standalone query() calls. Background tasks are monitored asynchronously after end_turn
 * without blocking the thread slot.
 */

import fs from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
    SDKAssistantMessage,
    SDKResultMessage,
    SDKToolProgressMessage,
    SDKTaskStartedMessage,
    SDKTaskProgressMessage,
    SDKTaskNotificationMessage,
    SDKMessage,
    Options,
    Query,
    CanUseTool as SDKCanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import { SessionPool } from "./session-pool.js";
import { toErrorMessage, isValidSessionId, TASK_LISTS_FILENAME } from "./types.js";
import type { IncomingMessage, OutgoingMessage, TaskListMapping, BackgroundTaskInfo, BackgroundTaskState } from "./types.js";
import {
    appendHistory,
    buildHistoryContext,
    getRecentHistory,
} from "./message-history.js";
import { createBorgMcpServer } from "./mcp-tools.js";
import { loadZoneConfig, getThreadsInZone } from "./zone-config.js";
import type { MessageSource, MessageHistoryEntry } from "./message-history.js";
import {
    loadThreads,
    saveThreads,
    loadSettings,
    resetThread,
    configureThread,
    updateThread,
    deleteThreadField,
    buildThreadPrompt,
    buildHeartbeatPrompt,
    parseHeartbeatSections,
    formatHumanTime,
    getTimedTasks,
    isBudgetMode,
    invalidateSettingsCacheIfChanged,
    BUDGET_MODEL,
    BUDGET_PROXY_URL,
    checkProxyAvailable,
    getProxyAvailable,
    resetProxyAvailable,
} from "./session-manager.js";
import type { ThreadConfig, HeartbeatTier, HeartbeatSections } from "./session-manager.js";
import { loadTasks, getDueTasks, markTaskComplete, markTaskQueued } from "./scheduled-tasks.js";
import type { ScheduledTask } from "./scheduled-tasks.js";
import { z } from "zod/v4";

// ─── Zod Schemas for Queue Messages ───

const MessageSourceSchema = z.enum(["user", "cross-thread", "heartbeat", "cli", "system", "broadcast", "scheduled-task", "one-shot"]);

const IncomingMessageSchema = z.object({
    channel: z.string(),
    source: MessageSourceSchema.optional(),
    threadId: z.number(),
    sourceThreadId: z.number().optional(),
    sender: z.string(),
    senderId: z.string().optional(),
    message: z.string(),
    isReply: z.boolean().optional(),
    replyToText: z.string().optional(),
    replyToModel: z.string().optional(),
    topicName: z.string().optional(),
    timestamp: z.number(),
    messageId: z.string(),
    audioPath: z.string().optional(),
    voiceDuration: z.number().optional(),
    imagePath: z.string().optional(),
    imagePaths: z.array(z.string()).optional(),
    telegramMessageId: z.number().optional(),
    oneshotModel: z.string().optional(),
});

const CommandMessageSchema = z.object({
    command: z.string(),
    threadId: z.number(),
    args: z.record(z.string(), z.string()).optional(),
    timestamp: z.number(),
});

// ─── Paths ───

const SCRIPT_DIR = path.resolve(__dirname, "..");
const BORG_DIR = path.join(SCRIPT_DIR, ".borg");
const QUEUE_INCOMING = path.join(BORG_DIR, "queue/incoming");
const QUEUE_OUTGOING = path.join(BORG_DIR, "queue/outgoing");
const QUEUE_PROCESSING = path.join(BORG_DIR, "queue/processing");
const QUEUE_DEAD_LETTER = path.join(BORG_DIR, "queue/dead-letter");
const QUEUE_COMMANDS = path.join(BORG_DIR, "queue/commands");
const QUEUE_CANCEL = path.join(BORG_DIR, "queue/cancel");
const QUEUE_TASKS = path.join(BORG_DIR, "queue/tasks");
const QUEUE_TASK_STOP = path.join(BORG_DIR, "queue/task-stop");
const QUEUE_STATUS = path.join(BORG_DIR, "status");
const LOG_FILE = path.join(BORG_DIR, "logs/queue.log");
const PROMPTS_LOG = path.join(BORG_DIR, "logs/prompts.jsonl");
const PROMPTS_LOG_BACKUP = path.join(BORG_DIR, "logs/prompts.1.jsonl");
const MAX_PROMPTS_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const SESSIONS_DIR = path.join(BORG_DIR, "sessions");
const TASK_LISTS_FILE = path.join(BORG_DIR, TASK_LISTS_FILENAME);

// ─── Budget Mode Usage Reading ───

/**
 * Read budget mode usage from correlation file with retry logic
 * Uses exponential backoff to handle timing edge cases where proxy hasn't written the file yet
 */
function readBudgetUsage(usageId: string): QueryUsageData | null {
    const usageFile = path.join(BORG_DIR, `minimax-usage-${usageId}.json`);
    const maxRetries = 3;
    const initialDelayMs = 50;
    let result: QueryUsageData | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (fs.existsSync(usageFile)) {
                const content = fs.readFileSync(usageFile, "utf8");
                const data = JSON.parse(content);
                // Convert to QueryUsageData format
                result = {
                    totalCostUSD: data.costUSD,
                    // Fireworks input_tokens includes cache reads; subtract to get net non-cached count
                    inputTokens: data.usage.input_tokens - (data.usage.cache_read_input_tokens || 0),
                    outputTokens: data.usage.output_tokens,
                    cacheReadInputTokens: data.usage.cache_read_input_tokens || 0,
                    cacheCreationInputTokens: 0,
                    durationMs: data.duration,
                    durationApiMs: data.duration,
                    numTurns: 1,
                    modelUsage: {},
                };
                break; // Success - exit retry loop
            }
        } catch (err) {
            log("WARN", `Failed to read budget usage file ${usageId} (attempt ${attempt + 1}): ${toErrorMessage(err)}`);
        }

        // Wait before retry with exponential backoff
        if (attempt < maxRetries - 1) {
            const delayMs = initialDelayMs * Math.pow(2, attempt);
            const now = Date.now();
            while (Date.now() - now < delayMs) {
                // Busy wait - minimal delay for responsiveness
            }
        }
    }

    // Clean up the usage file after reading (success or failure)
    try {
        if (fs.existsSync(usageFile)) {
            fs.unlinkSync(usageFile);
        }
    } catch {
        // Ignore cleanup errors
    }

    if (!result) {
        log("WARN", `Budget usage file ${usageId} not found after ${maxRetries} attempts`);
    }
    return result;
}

// ─── Ensure queue directories exist ───

[
    QUEUE_INCOMING,
    QUEUE_OUTGOING,
    QUEUE_PROCESSING,
    QUEUE_DEAD_LETTER,
    QUEUE_COMMANDS,
    QUEUE_CANCEL,
    QUEUE_TASKS,
    QUEUE_TASK_STOP,
    QUEUE_STATUS,
    path.dirname(LOG_FILE),
    SESSIONS_DIR,
].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ─── Retry Helpers (hoisted above recovery so recovery can use them) ───

const MAX_RETRIES = 3;

function getRetryCount(filename: string): number {
    const match = filename.match(/_retry(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

function buildRetryFilename(filename: string, retryNum: number): string {
    const base = filename.replace(/_retry\d+/, "");
    const ext = path.extname(base);
    const stem = base.slice(0, -ext.length);
    return `${stem}_retry${retryNum}${ext}`;
}

// ─── Startup Recovery: move stuck processing/ files back to incoming/ ───
// Increment retry count so crash-loops eventually hit dead-letter.

{
    const stuckFiles = fs
        .readdirSync(QUEUE_PROCESSING)
        .filter((f) => f.endsWith(".json"));
    for (const file of stuckFiles) {
        try {
            const currentRetry = getRetryCount(file);
            if (currentRetry >= MAX_RETRIES - 1) {
                // Exhausted retries — move to dead-letter instead of looping forever
                const deadLetterPath = path.join(
                    QUEUE_DEAD_LETTER,
                    `${Date.now()}_${file}`,
                );
                fs.renameSync(path.join(QUEUE_PROCESSING, file), deadLetterPath);
                console.log(`[RECOVERY] Max retries exceeded, moved to dead-letter: ${file}`);
            } else {
                // Bump retry count so the file converges toward dead-letter
                const retryFilename = buildRetryFilename(file, currentRetry + 1);
                fs.renameSync(
                    path.join(QUEUE_PROCESSING, file),
                    path.join(QUEUE_INCOMING, retryFilename),
                );
                console.log(`[RECOVERY] Moved stuck file back to incoming: ${file} -> ${retryFilename}`);
            }
        } catch {
            // Best effort — file may have been cleaned up already
        }
    }
    if (stuckFiles.length > 0) {
        console.log(
            `[RECOVERY] Recovered ${stuckFiles.length} stuck message(s) from processing/`,
        );
    }
}

// ─── Tier / Model Mapping ───

// Default model for threads that don't have one explicitly set
const DEFAULT_THREAD_MODEL = "sonnet";

// ─── Session Log Sync ───

const CLAUDE_HOME = path.join(process.env.HOME || "/root", ".claude");

function cwdToProjectSlug(cwd: string): string {
    return "-" + cwd.replace(/^\//, "").replace(/[^a-zA-Z0-9-]/g, "-");
}

// Track synced byte offsets per sessionId so we only append new data
const syncOffsets = new Map<string, number>();

function syncSessionLog(sessionId: string, cwd: string): void {
    try {
        // Validate sessionId format (UUID) to prevent path traversal
        if (!isValidSessionId(sessionId)) return;

        const slug = cwdToProjectSlug(cwd);
        const safeId = path.basename(sessionId); // defense in depth
        const src = path.join(CLAUDE_HOME, "projects", slug, `${safeId}.jsonl`);
        const dest = path.join(SESSIONS_DIR, `${safeId}.jsonl`);

        // Verify resolved paths stay within intended directories
        const resolvedSrc = path.resolve(src);
        const resolvedDest = path.resolve(dest);
        const resolvedSessionsDir = path.resolve(SESSIONS_DIR);
        const resolvedProjectsDir = path.resolve(CLAUDE_HOME, "projects");
        if (!resolvedDest.startsWith(resolvedSessionsDir + path.sep)) return;
        if (!resolvedSrc.startsWith(resolvedProjectsDir + path.sep)) return;

        if (!fs.existsSync(src)) return;

        const srcStat = fs.statSync(src);
        let synced = syncOffsets.get(sessionId);

        // Cold start: initialize offset from existing dest size
        // (avoids re-appending the whole file after process restart)
        if (synced === undefined) {
            synced = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        }

        // Detect truncation/rotation (shouldn't happen, but be safe)
        if (srcStat.size < synced) synced = 0;

        // Nothing new
        if (srcStat.size === synced) return;

        // Read only the new bytes from src
        const bytesToRead = srcStat.size - synced;
        const buf = Buffer.alloc(bytesToRead);
        const fd = fs.openSync(src, "r");
        try {
            fs.readSync(fd, buf, 0, bytesToRead, synced);
        } finally {
            fs.closeSync(fd);
        }

        // Append to dest
        fs.appendFileSync(dest, buf);
        syncOffsets.set(sessionId, srcStat.size);
    } catch {
        // Session log sync is best-effort
    }
}

/** Persist sessionId to threads.json and sync the session log immediately. */
function persistSessionId(threadId: number, sessionId: string): void {
    updateThread(threadId, { sessionId, lastActive: Date.now() });
    const cwd = loadThreads()[String(threadId)]?.cwd;
    if (cwd) syncSessionLog(sessionId, cwd);
}

function syncAllActiveSessionLogs(): void {
    try {
        const threads = loadThreads();
        for (const [, config] of Object.entries(threads)) {
            if (config.sessionId && config.cwd) {
                syncSessionLog(config.sessionId, config.cwd);
            }
        }
    } catch {
        // Best effort
    }
}

// ─── Heartbeat State Management ───

interface LastReport {
    ts: number;
    summary: string;
}

interface HeartbeatTimestamps {
    quick: number;
    hourly: number;
    daily: number;
    lastReport?: LastReport;
}

type HeartbeatState = Record<string, HeartbeatTimestamps>;

const DEFAULT_TIMESTAMPS: Readonly<HeartbeatTimestamps> = { quick: 0, hourly: 0, daily: 0 };
const HOURLY_INTERVAL_MS = 60 * 60 * 1000;
const DAILY_INTERVAL_MS = 24 * HOURLY_INTERVAL_MS;

const HEARTBEAT_STATE_FILE = path.join(BORG_DIR, "heartbeat-state.json");

const LastReportSchema = z.object({
    ts: z.number().nonnegative(),
    summary: z.string(),
});
const HeartbeatTimestampsSchema = z.object({
    quick: z.number().nonnegative(),
    hourly: z.number().nonnegative(),
    daily: z.number().nonnegative(),
    lastReport: LastReportSchema.optional(),
});
const HeartbeatStateSchema = z.record(z.string(), HeartbeatTimestampsSchema);

let heartbeatStateCache: HeartbeatState | null = null;
let heartbeatStateMtime = 0;

function loadHeartbeatState(): HeartbeatState {
    try {
        const mtime = fs.statSync(HEARTBEAT_STATE_FILE).mtimeMs;
        if (heartbeatStateCache && mtime === heartbeatStateMtime) return heartbeatStateCache;
        const raw: unknown = JSON.parse(fs.readFileSync(HEARTBEAT_STATE_FILE, "utf8"));
        const parsed = HeartbeatStateSchema.safeParse(raw);
        if (!parsed.success) {
            heartbeatStateCache = null;
            heartbeatStateMtime = 0;
            return {};
        }
        heartbeatStateCache = parsed.data;
        heartbeatStateMtime = mtime;
        return heartbeatStateCache;
    } catch {
        heartbeatStateCache = null;
        heartbeatStateMtime = 0;
        return {};
    }
}

function saveHeartbeatState(state: HeartbeatState): void {
    const dir = path.dirname(HEARTBEAT_STATE_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = HEARTBEAT_STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, HEARTBEAT_STATE_FILE);
    heartbeatStateCache = state;
    heartbeatStateMtime = fs.statSync(HEARTBEAT_STATE_FILE).mtimeMs;
}

function getDueTier(threadId: string): HeartbeatTier {
    const state = loadHeartbeatState();
    const ts = state[threadId] || DEFAULT_TIMESTAMPS;
    const now = Date.now();

    if (now - ts.daily > DAILY_INTERVAL_MS) return "daily";
    if (now - ts.hourly > HOURLY_INTERVAL_MS) return "hourly";
    return "quick";
}

function updateHeartbeatState(threadId: string, tier: HeartbeatTier): void {
    const state = loadHeartbeatState();
    const threads = loadThreads();
    const now = Date.now();

    // Prune entries for threads no longer in threads.json
    for (const key of Object.keys(state)) {
        if (!threads[key]) delete state[key];
    }

    if (!state[threadId]) state[threadId] = { ...DEFAULT_TIMESTAMPS };

    state[threadId].quick = now;
    if (tier === "hourly" || tier === "daily") state[threadId].hourly = now;
    if (tier === "daily") state[threadId].daily = now;

    saveHeartbeatState(state);
}

const LAST_REPORT_MAX_LENGTH = 1000;

function saveLastReport(threadId: string, report: string): void {
    const state = loadHeartbeatState();
    if (!state[threadId]) state[threadId] = { ...DEFAULT_TIMESTAMPS };
    state[threadId].lastReport = {
        ts: Date.now(),
        summary: report.length > LAST_REPORT_MAX_LENGTH
            ? report.slice(0, LAST_REPORT_MAX_LENGTH) + "…"
            : report,
    };
    saveHeartbeatState(state);
}

// ─── Logger ───

function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    try {
        fs.appendFileSync(LOG_FILE, logMessage);
    } catch {
        // Logging should never crash the process
    }
}

// ─── Prompt Logging ───

function logPrompt(entry: {
    threadId: number;
    messageId: string;
    model: string;
    systemPromptAppend: string;
    userMessage: string;
    historyInjected: boolean;
    historyLines: number;
    promptLength: number;
}): void {
    try {
        // Rotate if needed
        if (fs.existsSync(PROMPTS_LOG)) {
            const stats = fs.statSync(PROMPTS_LOG);
            if (stats.size > MAX_PROMPTS_LOG_SIZE) {
                fs.renameSync(PROMPTS_LOG, PROMPTS_LOG_BACKUP);
            }
        }
        const line =
            JSON.stringify({
                timestamp: Date.now(),
                ...entry,
                userMessage: entry.userMessage.substring(0, 500),
            }) + "\n";
        fs.appendFileSync(PROMPTS_LOG, line);
    } catch {
        // Logging should never crash the process
    }
}

// ─── Concurrency Control ───

let activeCount = 0;
let scanning = false;
let activeHeartbeatCount = 0;
let activeScheduledTaskCount = 0;

// Background task monitors that run independently after end_turn
const activeBackgroundMonitors = new Map<number, Promise<void>>();

// Persistent session pool for reusing SDK sessions across messages
const sessionPool = new SessionPool({
    idleTimeoutMinutes: 30,
    maxSessions: 16,
    log,
});

// ─── SDK canUseTool Adapter ───

const sdkCanUseTool: SDKCanUseTool = async (toolName, input, _options) => {
    const { canUseTool: sessionCanUseTool } = await import(
        "./session-manager.js"
    );
    const result = await sessionCanUseTool(toolName, input);
    if (result.behavior === "allow") {
        return {
            behavior: "allow",
            updatedInput: result.updatedInput as Record<string, unknown> | undefined,
        };
    }
    return { behavior: "deny", message: result.message };
};

// ─── Budget Proxy Setup ───

/**
 * Set up the budget/Fireworks proxy for a query. Returns a usageId if the proxy
 * was activated (caller should pass to readBudgetUsage after the query), or
 * undefined if direct API will be used.
 */
async function setupBudgetProxy(model: string): Promise<string | undefined> {
    const isFireworksModel = model.includes("fireworks");
    const needsProxy = isFireworksModel || isBudgetMode();
    if (!needsProxy) {
        delete process.env.ANTHROPIC_BASE_URL;
        return undefined;
    }
    const proxyOk = await checkProxyAvailable();
    if (!proxyOk) {
        delete process.env.ANTHROPIC_BASE_URL;
        return undefined;
    }
    const usageId = crypto.randomUUID();
    const pendingFile = path.join(BORG_DIR, `minimax-usage-${usageId}.pending`);
    fs.writeFileSync(pendingFile, "");
    process.env.ANTHROPIC_BASE_URL = `${BUDGET_PROXY_URL}/${usageId}`;
    return usageId;
}

// ─── Time Injection ───

function formatCurrentTime(): string {
    try {
        return formatHumanTime(loadSettings().timezone);
    } catch {
        return formatHumanTime("UTC");
    }
}

// ─── Source-Aware Prefix ───

function buildSourcePrefix(msg: IncomingMessage): string {
    const prefixMap: Record<MessageSource, string> = {
        user: `[${msg.sender} via Telegram]:`,
        "cross-thread": `[Cross-thread from ${msg.sender} (thread ${msg.sourceThreadId})]:`,
        heartbeat: `[Heartbeat check-in]:`,
        cli: `[CLI message]:`,
        system: `[System event]:`,
        broadcast: `[Broadcast]:`,
        "scheduled-task": `[Scheduled task]:`,
        "one-shot": `[${msg.sender} via /do]:`,
    };
    return prefixMap[msg.source ?? "user"];
}

// ─── Recent One-Shot Context Hint ───
// When a user message arrives shortly after a one-shot (scheduled task, heartbeat,
// or /do) ran on the same thread, the persistent session has no awareness of that
// output. This function checks recent history and returns a hint if needed.

const ONE_SHOT_SOURCES = new Set(["scheduled-task", "heartbeat", "one-shot"]);

function getRecentOneShotHint(threadId: number): string {
    const recent = getRecentHistory({ threadId, limit: 10 });
    if (recent.length === 0) return "";

    // Find the last outgoing message on this thread
    const lastOut = [...recent].reverse().find(e => e.direction === "out");
    if (!lastOut) return "";

    // If the most recent outgoing message was from a one-shot source,
    // the session doesn't know about it. Once the session responds,
    // its own message becomes the latest and this hint goes away naturally.
    if (!lastOut.source || !ONE_SHOT_SOURCES.has(lastOut.source)) return "";
    if (lastOut.message === "[heartbeat:suppressed]") return "";

    const agoMin = Math.round((Date.now() - lastOut.ts) / 60_000);
    const sourceLabel = lastOut.source === "scheduled-task"
        ? "a scheduled task"
        : lastOut.source === "one-shot" ? "a /do one-shot command" : "a heartbeat";
    return `[Note: ${sourceLabel} ran on this thread ~${agoMin}m ago and posted a response, but it ran outside your session so you don't have direct context. If the user's message seems to reference something you didn't say, check .borg/message-history.jsonl for threadId ${threadId} to see what was posted.]`;
}

// ─── Status File Helpers (per-thread) ───
// Status is keyed by threadId, not messageId. The anchorMessageId tracks which
// user message the status indicator should appear below in Telegram.

import {
    writeThreadStatus,
    clearThreadStatus,
    updateThreadStatusAnchor,
} from "./thread-status.js";

function writeStatus(threadId: number, anchorMessageId: string, label: string, startTs: number, preview?: string, fullText?: string, sessionId?: string): void {
    writeThreadStatus(QUEUE_STATUS, {
        threadId, label, startTs, ts: Date.now(),
        anchorMessageId, preview, fullText, sessionId,
    });
}

function clearStatus(threadId: number): void {
    clearThreadStatus(QUEUE_STATUS, threadId);
}

// ─── Build v1 query options ───

// ─── Task List Tracking ───

function getTaskListId(threadId: number, threadConfig: ThreadConfig): string {
    if (threadConfig.team) {
        return `borg-team-${threadConfig.team}`;
    }
    return `borg-${threadId}`;
}

// Track which (taskListId, threadId) pairs are already registered to avoid redundant file I/O
const registeredTaskPairs = new Set<string>();

function updateTaskListMapping(threadId: number, taskListId: string, team?: string): void {
    const key = `${taskListId}:${threadId}`;
    if (registeredTaskPairs.has(key)) return;

    try {
        let mapping: TaskListMapping = {};
        try {
            mapping = JSON.parse(fs.readFileSync(TASK_LISTS_FILE, "utf8"));
        } catch { /* file doesn't exist yet */ }

        if (!mapping[taskListId]) {
            mapping[taskListId] = { threadIds: [], team };
        }
        if (!mapping[taskListId].threadIds.includes(threadId)) {
            mapping[taskListId].threadIds.push(threadId);
        }
        mapping[taskListId].team = team;

        const tmp = TASK_LISTS_FILE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2));
        fs.renameSync(tmp, TASK_LISTS_FILE);
        registeredTaskPairs.add(key);
    } catch {
        // Best effort — task visibility is not critical
    }
}

async function buildQueryOptions(
    threadId: number,
    threadConfig: ThreadConfig,
    effectiveModel: string,
    stderrLines?: string[],
    messageText?: string,
): Promise<Options> {
    // Enable SDK task tracking
    const taskListId = getTaskListId(threadId, threadConfig);
    process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId;
    process.env.CLAUDE_CODE_ENABLE_TASKS = "true";

    // Update task-lists mapping so telegram-client can find which threads use which task list
    updateTaskListMapping(threadId, taskListId, threadConfig.team);

    // Effort: default medium, "ultrathink" in message bumps to max (opus) or high (sonnet)
    const isUltrathink = messageText ? /\bultrathink\b/i.test(messageText) : false;
    let effort: "low" | "medium" | "high" | "max" = "medium";
    if (isUltrathink) {
        effort = effectiveModel.includes("opus") ? "max" : "high";
    }

    const opts: Options = {
        model: effectiveModel,
        effort,
        cwd: threadConfig.cwd,
        canUseTool: sdkCanUseTool,
        settingSources: ["project", "user"],
        systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: buildThreadPrompt(threadConfig, { threadId, model: effectiveModel }),
        },
        mcpServers: {
            borg: createBorgMcpServer(threadId),
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        stderr: stderrLines
            ? (data: string) => { stderrLines.push(data); }
            : undefined,
    };

    // Use budget proxy URL when budget mode is enabled (via env var, SDK reads from process.env)
    // Check proxy availability first - fall back to direct API if proxy unavailable
    if (isBudgetMode()) {
        const proxyOk = await checkProxyAvailable();
        if (proxyOk) {
            process.env.ANTHROPIC_BASE_URL = BUDGET_PROXY_URL;
        } else {
            log("WARN", "Budget proxy unavailable, falling back to direct API");
            delete process.env.ANTHROPIC_BASE_URL;
        }
    } else {
        delete process.env.ANTHROPIC_BASE_URL;
    }

    // Resume existing session if available — but only if the session file exists.
    // After container restarts, session JSONL files may be gone, causing
    // "No conversation found with session ID" errors from the SDK.
    if (threadConfig.sessionId && isValidSessionId(threadConfig.sessionId)) {
        const slug = cwdToProjectSlug(threadConfig.cwd);
        const sessionFile = path.join(CLAUDE_HOME, "projects", slug, `${threadConfig.sessionId}.jsonl`);
        if (fs.existsSync(sessionFile)) {
            opts.resume = threadConfig.sessionId;
        } else {
            log("WARN", `Session file missing for thread ${threadId} (${threadConfig.sessionId}) — starting fresh`);
            deleteThreadField(threadId, "sessionId");
        }
    }

    return opts;
}

// ─── Usage data from SDK result messages ───

interface QueryUsageData {
    totalCostUSD: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    durationMs: number;
    durationApiMs: number;
    numTurns: number;
    modelUsage: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
        webSearchRequests: number;
    }>;
}

// ─── Collect full response text from query stream ───

interface QueryEventObserver {
    onSessionId?(sessionId: string): void;
    onToolUse?(toolName: string): void;
    onToolProgress?(toolName: string, elapsedSeconds: number): void;
    onCompacting?(): void;
    onStallDetected?(): void;
    onTextContent?(text: string): void;
    onTaskStarted?(taskId: string, description: string): void;
    onTaskProgress?(taskId: string, summary: string | undefined): void;
    onTaskCompleted?(taskId: string, status: string, summary: string): void;
    /** If true, skip stall detection and drain — next events belong to injected messages. */
    hasPendingInjections?(): boolean;
}

// Stall detection: if no active background tasks and end_turn seen, wait this long
// before giving up. With active background tasks, we wait indefinitely.
const END_TURN_STALL_TIMEOUT_MS = 90_000; // 90 seconds
const POST_END_TURN_POLL_MS = 5_000; // 5 seconds per event poll

// Subprocess liveness: if zero events arrive for this long, the subprocess is likely dead.
// Active sessions always emit events (tool_progress, assistant messages, etc.) so silence
// means the child process crashed. Intentionally long — legit sessions can run for hours.
const SUBPROCESS_LIVENESS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const LIVENESS_POLL_MS = 30_000; // 30 seconds per poll iteration

// Alert threshold for long-running background tasks (2 hours)
const BACKGROUND_TASK_ALERT_MS = 2 * 60 * 60 * 1000;

interface PrimaryResponseResult {
    text: string;
    sessionId: string | undefined;
    stallRecovered: boolean;
    usage?: QueryUsageData;
    /** Active background tasks at end_turn (empty if none) */
    activeTasks: Map<string, BackgroundTaskInfo>;
    /** The query object, needed for background monitoring and stopTask */
    query: Query;
    /** Whether background tasks are still running and need monitoring */
    hasBackgroundTasks: boolean;
}

// ─── Extract usage data from SDK result message ───

function extractUsageData(result: SDKResultMessage): QueryUsageData {
    const muValues = Object.values(result.modelUsage);
    return {
        totalCostUSD: result.total_cost_usd,
        inputTokens: muValues.reduce((s, m) => s + m.inputTokens, 0) || result.usage.input_tokens,
        outputTokens: muValues.reduce((s, m) => s + m.outputTokens, 0) || result.usage.output_tokens,
        cacheReadInputTokens: muValues.reduce((s, m) => s + m.cacheReadInputTokens, 0) || (result.usage.cache_read_input_tokens ?? 0),
        cacheCreationInputTokens: muValues.reduce((s, m) => s + m.cacheCreationInputTokens, 0) || (result.usage.cache_creation_input_tokens ?? 0),
        durationMs: result.duration_ms,
        durationApiMs: result.duration_api_ms,
        numTurns: result.num_turns,
        modelUsage: Object.fromEntries(
            Object.entries(result.modelUsage).map(([model, mu]) => [model, {
                inputTokens: mu.inputTokens,
                outputTokens: mu.outputTokens,
                cacheReadInputTokens: mu.cacheReadInputTokens,
                cacheCreationInputTokens: mu.cacheCreationInputTokens,
                costUSD: mu.costUSD,
                webSearchRequests: mu.webSearchRequests,
            }]),
        ),
    };
}

// ─── Process a single SDK message (shared between primary and background collection) ───

interface MessageProcessingState {
    parts: string[];
    capturedSessionId: string | undefined;
    usageData: QueryUsageData | undefined;
    sawEndTurn: boolean;
    endTurnSeenAt: number;
    sawResult: boolean;
    activeTasks: Map<string, BackgroundTaskInfo>;
    observer: QueryEventObserver | undefined;
}

// ─── Shared task event handler (used by both primary collection and background monitor) ───

function applyTaskEvent(
    msg: SDKMessage,
    activeTasks: Map<string, BackgroundTaskInfo>,
    observer?: QueryEventObserver,
): void {
    if (msg.type !== "system" || !("subtype" in msg)) return;
    if (msg.subtype === "task_started") {
        const taskMsg = msg as SDKTaskStartedMessage;
        activeTasks.set(taskMsg.task_id, {
            taskId: taskMsg.task_id,
            description: taskMsg.description,
            startedAt: Date.now(),
            status: "running",
        });
        observer?.onTaskStarted?.(taskMsg.task_id, taskMsg.description);
    }
    if (msg.subtype === "task_progress") {
        const taskMsg = msg as SDKTaskProgressMessage;
        const existing = activeTasks.get(taskMsg.task_id);
        if (existing) {
            existing.summary = taskMsg.summary;
            existing.lastToolName = taskMsg.last_tool_name;
            existing.usage = {
                totalTokens: taskMsg.usage.total_tokens,
                toolUses: taskMsg.usage.tool_uses,
                durationMs: taskMsg.usage.duration_ms,
            };
        }
        observer?.onTaskProgress?.(taskMsg.task_id, taskMsg.summary);
    }
    if (msg.subtype === "task_notification") {
        const taskMsg = msg as SDKTaskNotificationMessage;
        const existing = activeTasks.get(taskMsg.task_id);
        if (existing) {
            existing.status = taskMsg.status;
            existing.summary = taskMsg.summary;
            if (taskMsg.usage) {
                existing.usage = {
                    totalTokens: taskMsg.usage.total_tokens,
                    toolUses: taskMsg.usage.tool_uses,
                    durationMs: taskMsg.usage.duration_ms,
                };
            }
        }
        observer?.onTaskCompleted?.(taskMsg.task_id, taskMsg.status, taskMsg.summary);
    }
}

function processSDKMessage(msg: SDKMessage, state: MessageProcessingState): void {
    // Always capture the latest session_id (it may change after compaction)
    if ("session_id" in msg && msg.session_id) {
        const isNew = state.capturedSessionId !== msg.session_id;
        state.capturedSessionId = msg.session_id;
        if (isNew) {
            state.observer?.onSessionId?.(msg.session_id);
        }
    }

    if (msg.type === "assistant") {
        const assistantMsg = msg as SDKAssistantMessage;
        const content = assistantMsg.message?.content;
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === "text" && typeof block.text === "string") {
                    state.parts.push(block.text);
                    state.observer?.onTextContent?.(block.text);
                }
                if (block.type === "tool_use" && "name" in block) {
                    state.observer?.onToolUse?.(block.name);
                }
            }
        }
        // Track end_turn on top-level assistant messages (not from subagents)
        const stopReason = assistantMsg.message?.stop_reason;
        if (stopReason === "end_turn" && assistantMsg.parent_tool_use_id === null) {
            if (!state.sawEndTurn) {
                state.endTurnSeenAt = Date.now();
            }
            state.sawEndTurn = true;
        } else if (stopReason === "tool_use") {
            state.sawEndTurn = false;
            state.endTurnSeenAt = 0;
        }
    }

    if (msg.type === "tool_progress") {
        const toolMsg = msg as SDKToolProgressMessage;
        state.observer?.onToolProgress?.(
            toolMsg.tool_name,
            toolMsg.elapsed_time_seconds,
        );
    }

    if (
        msg.type === "system" &&
        "subtype" in msg &&
        msg.subtype === "status" &&
        "status" in msg &&
        msg.status === "compacting"
    ) {
        state.observer?.onCompacting?.();
    }

    // Track background tasks
    applyTaskEvent(msg, state.activeTasks, state.observer);

    if (msg.type === "result") {
        const result = msg as SDKResultMessage;
        if (
            result.subtype === "success" &&
            "result" in result &&
            typeof result.result === "string"
        ) {
            if (state.parts.length === 0) {
                state.parts.push(result.result);
            }
        }
        state.usageData = extractUsageData(result);
        state.sawResult = true;
    }
}

// ─── Collect primary response (returns at end_turn if background tasks are active) ───

async function collectPrimaryResponse(
    q: Query,
    observer?: QueryEventObserver,
): Promise<PrimaryResponseResult> {
    const state: MessageProcessingState = {
        parts: [],
        capturedSessionId: undefined,
        usageData: undefined,
        sawEndTurn: false,
        endTurnSeenAt: 0,
        sawResult: false,
        activeTasks: new Map(),
        observer,
    };

    let stallDetected = false;
    const iterator = q[Symbol.asyncIterator]();

    while (true) {
        let iterResult!: IteratorResult<SDKMessage, void>;

        if (state.sawEndTurn && state.parts.length > 0) {
            // If there are active background tasks, return immediately —
            // the background monitor will continue consuming the stream
            const runningTasks = [...state.activeTasks.values()].filter(t => t.status === "running");
            if (runningTasks.length > 0) {
                log("INFO", `end_turn with ${runningTasks.length} active background task(s) — returning primary response`);
                return {
                    text: state.parts.join("\n\n"),
                    sessionId: state.capturedSessionId,
                    stallRecovered: false,
                    usage: state.usageData,
                    activeTasks: state.activeTasks,
                    query: q,
                    hasBackgroundTasks: true,
                };
            }

            // If there are injected messages pending, DON'T return yet — we need to
            // consume the trailing `result` event first. In streaming mode, result comes
            // right after end_turn. If we break before consuming it, the result event
            // leaks into the next collectPrimaryResponse call and causes it to exit
            // immediately via sawResult, yielding "(No response generated)".
            // The sawResult check (after processSDKMessage) will break us out once
            // the result event is consumed. The drain section already guards against
            // consuming events meant for injected messages.

            // No background tasks — use stall detection to avoid hanging indefinitely
            const elapsed = Date.now() - state.endTurnSeenAt;
            if (elapsed >= END_TURN_STALL_TIMEOUT_MS) {
                stallDetected = true;
                observer?.onStallDetected?.();
                log(
                    "WARN",
                    `end_turn stall detected after ${Math.round(elapsed / 1000)}s — returning collected response (${state.parts.join("").length} chars)`,
                );
                break;
            }
            const remaining = END_TURN_STALL_TIMEOUT_MS - elapsed;
            const pollTimeout = Math.min(POST_END_TURN_POLL_MS, remaining);
            let timeoutHandle: ReturnType<typeof setTimeout>;
            const timeoutPromise = new Promise<"timeout">((resolve) => {
                timeoutHandle = setTimeout(() => resolve("timeout"), pollTimeout);
            });
            const winner = await Promise.race([
                iterator.next().then((r) => ({ kind: "event" as const, result: r })),
                timeoutPromise.then(() => ({ kind: "timeout" as const })),
            ]);
            if (winner.kind === "timeout") {
                continue;
            }
            clearTimeout(timeoutHandle!);
            iterResult = winner.result;
        } else {
            // Liveness detection: the SDK subprocess should always emit events
            // while working (tool_progress, assistant messages, etc.). If nothing
            // arrives for SUBPROCESS_LIVENESS_TIMEOUT_MS, it's likely dead.
            // We call iterator.next() once and race the same promise against
            // repeated short timeouts to avoid creating dangling next() calls.
            const eventPromise = iterator.next().then(
                (r) => ({ kind: "event" as const, result: r }),
            );
            let livenessElapsed = 0;
            while (livenessElapsed < SUBPROCESS_LIVENESS_TIMEOUT_MS) {
                const remaining = SUBPROCESS_LIVENESS_TIMEOUT_MS - livenessElapsed;
                const pollMs = Math.min(LIVENESS_POLL_MS, remaining);
                let livenessHandle: ReturnType<typeof setTimeout>;
                const livenessPromise = new Promise<"timeout">((resolve) => {
                    livenessHandle = setTimeout(() => resolve("timeout"), pollMs);
                });
                const winner = await Promise.race([
                    eventPromise,
                    livenessPromise.then(() => ({ kind: "timeout" as const })),
                ]);
                if (winner.kind === "timeout") {
                    livenessElapsed += pollMs;
                    continue;
                }
                clearTimeout(livenessHandle!);
                iterResult = winner.result;
                break;
            }
            if (livenessElapsed >= SUBPROCESS_LIVENESS_TIMEOUT_MS) {
                stallDetected = true;
                observer?.onStallDetected?.();
                log(
                    "WARN",
                    `No SDK events for ${Math.round(livenessElapsed / 1000)}s — subprocess likely dead, returning collected response (${state.parts.join("").length} chars)`,
                );
                break;
            }
        }

        if (iterResult.done) break;
        processSDKMessage(iterResult.value, state);

        // In streaming mode (AsyncIterable prompt), the iterator stays open
        // after result. We must return here — NOT wait for done — otherwise
        // we'll block forever waiting for the next message from the generator.
        // But first: check if background tasks are active — if so, return
        // early so the caller can fire off the background monitor.
        if (state.sawResult) {
            const runningTasks = [...state.activeTasks.values()].filter(t => t.status === "running");
            if (runningTasks.length > 0) {
                log("INFO", `result with ${runningTasks.length} active background task(s) — returning for monitoring`);
                return {
                    text: state.parts.join("\n\n"),
                    sessionId: state.capturedSessionId,
                    stallRecovered: false,
                    usage: state.usageData,
                    activeTasks: state.activeTasks,
                    query: q,
                    hasBackgroundTasks: true,
                };
            }
            break;
        }
    }

    // Drain any buffered events from the iterator after result.
    // In streaming mode, the subprocess stays alive and may have emitted
    // system messages, compacting events, or additional results after the
    // one we consumed. If we don't drain these, they'll be served as
    // responses to the NEXT message, causing stale/out-of-order replies.
    // SKIP drain when injected messages are pending — those events belong to them.
    if (state.sawResult && !stallDetected && !observer?.hasPendingInjections?.()) {
        let drained = 0;
        // Use a short timeout — buffered events resolve near-instantly,
        // while waiting for new events from the subprocess takes longer.
        // 100ms is enough to drain buffered events without adding latency.
        const DRAIN_TIMEOUT_MS = 100;
        while (true) {
            let drainHandle: ReturnType<typeof setTimeout>;
            const drainTimeout = new Promise<"timeout">(resolve => {
                drainHandle = setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS);
            });
            const winner = await Promise.race([
                iterator.next().then(r => ({ kind: "event" as const, result: r })),
                drainTimeout.then(() => ({ kind: "timeout" as const })),
            ]);
            if (winner.kind === "timeout") break;
            clearTimeout(drainHandle!);
            const r = (winner as { kind: "event"; result: IteratorResult<SDKMessage, void> }).result;
            if (r.done) break;
            drained++;
            // Process to capture any late session_id updates
            if ("session_id" in r.value && r.value.session_id) {
                state.capturedSessionId = r.value.session_id;
            }
        }
        if (drained > 0) {
            log("DEBUG", `Drained ${drained} buffered event(s) after result for session reuse`);
        }
    }

    // Clean up hung process on stall
    if (stallDetected) {
        try {
            await q.interrupt();
        } catch {
            // Best effort — process may already be gone
        }
    }

    return {
        text: state.parts.join("\n\n"),
        sessionId: state.capturedSessionId,
        stallRecovered: stallDetected,
        usage: state.usageData,
        activeTasks: state.activeTasks,
        query: q,
        hasBackgroundTasks: false,
    };
}

// ─── Legacy wrapper for heartbeats/scheduled-tasks/one-shots ───

async function collectQueryResponse(
    q: Query,
    observer?: QueryEventObserver,
): Promise<{ text: string; sessionId: string | undefined; stallRecovered: boolean; usage?: QueryUsageData }> {
    const result = await collectPrimaryResponse(q, observer);
    return {
        text: result.text,
        sessionId: result.sessionId,
        stallRecovered: result.stallRecovered,
        usage: result.usage,
    };
}

// ─── Background task state file management ───

function writeTaskState(messageId: string, threadId: number, tasks: Map<string, BackgroundTaskInfo>): void {
    try {
        const state: BackgroundTaskState = {
            threadId,
            messageId,
            tasks: Object.fromEntries(tasks),
        };
        const taskFile = path.join(QUEUE_TASKS, `${messageId}.json`);
        const tmpFile = taskFile + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
        fs.renameSync(tmpFile, taskFile);
    } catch {
        // Best effort — dashboard visibility is not critical
    }
}

function clearTaskState(messageId: string): void {
    try {
        const taskFile = path.join(QUEUE_TASKS, `${messageId}.json`);
        if (fs.existsSync(taskFile)) fs.unlinkSync(taskFile);
    } catch {
        // Best effort
    }
}

// ─── Background task monitoring (fire-and-forget after end_turn) ───

async function monitorBackgroundTasks(
    q: Query,
    activeTasks: Map<string, BackgroundTaskInfo>,
    threadId: number,
    messageId: string,
): Promise<void> {
    const alertedTaskIds = new Set<string>();
    let lastWrittenTaskJson = "";

    // Write initial task state for dashboard
    writeTaskState(messageId, threadId, activeTasks);
    lastWrittenTaskJson = JSON.stringify(Object.fromEntries(activeTasks));

    const iterator = q[Symbol.asyncIterator]();

    try {
        while (true) {
            // Check for stop signal files
            try {
                for (const [taskId, task] of activeTasks) {
                    if (task.status !== "running") continue;
                    const stopFile = path.join(QUEUE_TASK_STOP, `${taskId}.json`);
                    if (fs.existsSync(stopFile)) {
                        log("INFO", `Stop signal for background task ${taskId} — stopping`);
                        try {
                            await q.stopTask(taskId);
                        } catch (err) {
                            log("WARN", `Failed to stop task ${taskId}: ${toErrorMessage(err)}`);
                        }
                        try { fs.unlinkSync(stopFile); } catch { /* best effort */ }
                    }
                }
            } catch {
                // Best effort stop signal check
            }

            // Check for 2-hour alert threshold
            const now = Date.now();
            for (const [taskId, task] of activeTasks) {
                if (task.status !== "running") continue;
                if (alertedTaskIds.has(taskId)) continue;
                if (now - task.startedAt >= BACKGROUND_TASK_ALERT_MS) {
                    alertedTaskIds.add(taskId);
                    const threads = loadThreads();
                    const threadName = threads[String(threadId)]?.name ?? `Thread ${threadId}`;
                    const elapsed = Math.round((now - task.startedAt) / 60000);
                    const settings = loadSettings();
                    const dashUrl = settings.dashboard_url
                        ? `${settings.dashboard_url.replace(/\/$/, '')}/response/${messageId}`
                        : undefined;
                    const alertMsg = `⚠️ Background task running for ${elapsed} minutes in ${threadName}: "${task.description}"${dashUrl ? `\n\n[View in dashboard](${dashUrl})` : ""}`;

                    // Send alert to master thread (threadId 1)
                    try {
                        const alertData: OutgoingMessage = {
                            channel: "system",
                            threadId: 1,
                            sender: "system",
                            message: alertMsg,
                            originalMessage: "(background task alert)",
                            timestamp: now,
                            messageId: `bg_alert_${taskId}_${now}`,
                            model: "system",
                        };
                        const alertFile = path.join(QUEUE_OUTGOING, `bg_alert_${taskId}_${now}.json`);
                        const tmpFile = alertFile + ".tmp";
                        fs.writeFileSync(tmpFile, JSON.stringify(alertData, null, 2));
                        fs.renameSync(tmpFile, alertFile);
                        log("WARN", `Background task alert: ${task.description} running for ${elapsed}m in thread ${threadId}`);
                    } catch {
                        // Best effort alert
                    }
                }
            }

            // Poll for next event with 5s timeout (to recheck stop signals and alerts)
            let timeoutHandle: ReturnType<typeof setTimeout>;
            const timeoutPromise = new Promise<"timeout">((resolve) => {
                timeoutHandle = setTimeout(() => resolve("timeout"), 5_000);
            });
            const winner = await Promise.race([
                iterator.next().then((r) => ({ kind: "event" as const, result: r })),
                timeoutPromise.then(() => ({ kind: "timeout" as const })),
            ]);

            if (winner.kind === "timeout") {
                continue;
            }
            clearTimeout(timeoutHandle!);

            const iterResult = winner.result;
            if (iterResult.done) break;

            const msg = iterResult.value;

            // Handle task events via shared handler
            applyTaskEvent(msg, activeTasks);
            if (msg.type === "system" && "subtype" in msg && msg.subtype === "task_notification") {
                const taskMsg = msg as SDKTaskNotificationMessage;
                log("INFO", `Background task ${taskMsg.task_id} ${taskMsg.status}: ${taskMsg.summary}`);
            }

            // Capture final usage from result message
            if (msg.type === "result") {
                const result = msg as SDKResultMessage;
                const finalUsage = extractUsageData(result);
                // Update message history with final usage data
                // (The primary response was already logged with partial usage;
                //  we could update it here but appending a correction entry is complex.
                //  For now, log the final usage separately.)
                log("INFO", `Background tasks complete for ${messageId}: cost=$${finalUsage.totalCostUSD.toFixed(4)}`);
            }

            // Update task state file for dashboard (only if changed)
            const currentTaskJson = JSON.stringify(Object.fromEntries(activeTasks));
            if (currentTaskJson !== lastWrittenTaskJson) {
                writeTaskState(messageId, threadId, activeTasks);
                lastWrittenTaskJson = currentTaskJson;
            }

            // Check if all tasks are done
            const stillRunning = [...activeTasks.values()].some(t => t.status === "running");
            if (!stillRunning && msg.type !== "result") {
                // All tasks finished, but we haven't seen the result yet — keep consuming
                continue;
            }
        }
    } catch (err) {
        log("WARN", `Background task monitor error for ${messageId}: ${toErrorMessage(err)}`);
    } finally {
        // Clean up task state file when all monitoring is done
        clearTaskState(messageId);

        // Mark session idle so we can claim it for the summary response.
        // (The .finally() callback in processMessage also marks idle, but
        // this runs first — inside the monitor's own finally block.)
        sessionPool.markIdle(threadId);

        // Push a summary of completed tasks into the session so the model
        // can report results without waiting for the user to ask.
        const completedTasks = [...activeTasks.values()].filter(t => t.status === "completed" || t.status === "failed");
        if (completedTasks.length > 0) {
            const summaryLines = completedTasks.map(t => {
                const status = t.status === "completed" ? "completed" : "FAILED";
                return `- ${t.description}: ${status}${t.summary ? ` — ${t.summary}` : ""}`;
            });
            const summaryPrompt = `[System] Background tasks finished:\n${summaryLines.join("\n")}\n\nPlease review the results and report back to the user.`;

            if (sessionPool.injectMessage(threadId, summaryPrompt)) {
                log("INFO", `Injected background task completion summary into session for thread ${threadId}`);

                // Consume the model's response to the summary
                const claimed = sessionPool.tryClaimSession(threadId,
                    loadThreads()[String(threadId)]?.model ?? "sonnet",
                    loadThreads()[String(threadId)]?.cwd ?? process.cwd());
                if (claimed) {
                    try {
                        const summaryResponse = collectPrimaryResponse(claimed.query);
                        claimed.pushMessage(summaryPrompt);
                        const result = await summaryResponse;
                        const responseText = result.text.trim();

                        if (result.sessionId) {
                            updateThread(threadId, { sessionId: result.sessionId, lastActive: Date.now() });
                        }
                        sessionPool.markIdle(threadId, result.sessionId);

                        if (responseText) {
                            // Log and send the response
                            const bgMessageId = `bg_summary_${threadId}_${Date.now()}`;
                            appendHistory({
                                ts: Date.now(), threadId, channel: "system",
                                sender: "assistant", direction: "out", message: responseText,
                                model: loadThreads()[String(threadId)]?.model ?? "sonnet",
                                source: "system", messageId: bgMessageId,
                                ...(result.usage ? {
                                    costUSD: result.usage.totalCostUSD,
                                    inputTokens: result.usage.inputTokens,
                                    outputTokens: result.usage.outputTokens,
                                    cacheReadInputTokens: result.usage.cacheReadInputTokens,
                                    cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
                                    durationMs: result.usage.durationMs,
                                    durationApiMs: result.usage.durationApiMs,
                                    numTurns: result.usage.numTurns,
                                    modelUsage: result.usage.modelUsage,
                                } : {}),
                            });

                            const outgoing: OutgoingMessage = {
                                channel: "system", threadId, sender: "assistant",
                                message: responseText, originalMessage: "(background task results)",
                                timestamp: Date.now(), messageId: bgMessageId,
                                model: loadThreads()[String(threadId)]?.model ?? "sonnet",
                            };
                            const outFile = path.join(QUEUE_OUTGOING, `bg_summary_${threadId}_${Date.now()}.json`);
                            const tmpFile = outFile + ".tmp";
                            fs.writeFileSync(tmpFile, JSON.stringify(outgoing, null, 2));
                            fs.renameSync(tmpFile, outFile);

                            log("INFO", `Background task summary response ready for thread ${threadId} (${responseText.length} chars)`);
                        }
                    } catch (summaryErr) {
                        log("WARN", `Background task summary response error for thread ${threadId}: ${toErrorMessage(summaryErr)}`);
                        sessionPool.close(threadId);
                    }
                }
            }
        }

        log("INFO", `Background task monitoring ended for ${messageId}`);
    }
}

// ─── Streaming Channel: Event Consumer ───
// Long-running async function per thread. Consumes SDK events from the query
// iterator, posts text blocks via outgoing queue, handles tool use status,
// background tasks, cancel signals, and usage logging. Loops across turns —
// when a new message is pushed into the channel, the SDK processes it and
// emits more events which this consumer handles.

// Active consumers keyed by threadId
const activeConsumers = new Map<number, Promise<void>>();

async function consumeThreadEvents(
    threadId: number,
    q: Query,
    channel: string,
    sender: string,
    model: string,
    messageId: string,
    cwd: string,
): Promise<void> {
    const iterator = q[Symbol.asyncIterator]();
    let streamSeq = 0;
    let accumulated = "";
    let currentAnchorMessageId = messageId;
    let toolCount = 0;
    let currentSessionId: string | undefined;
    let activeTasks = new Map<string, BackgroundTaskInfo>();

    const statusStartTime = Date.now();
    writeStatus(threadId, currentAnchorMessageId, "Thinking", statusStartTime);

    // Status refresh interval — keep ts fresh for staleness detection,
    // update label/preview, and check for cancel signals
    let currentStatusLabel = "Thinking";
    let currentPreview: string | undefined;
    let fullAccumulatedText = "";
    let cancelled = false;
    const cancelFile = path.join(QUEUE_CANCEL, `${currentAnchorMessageId}.json`);

    const statusInterval = setInterval(() => {
        // Check for cancel signal
        const checkFile = path.join(QUEUE_CANCEL, `${currentAnchorMessageId}.json`);
        if (!cancelled && fs.existsSync(checkFile)) {
            cancelled = true;
            currentStatusLabel = "Cancelled";
            try { fs.unlinkSync(checkFile); } catch { /* best effort */ }
            Promise.race([q.interrupt(), new Promise<void>(r => setTimeout(r, 10_000))]).catch(() => {});
            log("INFO", `Cancelled processing for thread ${threadId} (anchor: ${currentAnchorMessageId})`);
        }
        // Check for settings file changes
        invalidateSettingsCacheIfChanged();
        writeStatus(threadId, currentAnchorMessageId, currentStatusLabel, statusStartTime, currentPreview, fullAccumulatedText, currentSessionId);
    }, 2000);

    try {
        while (true) {
            // Liveness: if no events for 5 min, subprocess is likely dead
            let iterResult: IteratorResult<SDKMessage, void> | undefined;
            {
                const eventPromise = iterator.next().then(
                    (r) => ({ kind: "event" as const, result: r }),
                );
                let livenessElapsed = 0;
                while (livenessElapsed < SUBPROCESS_LIVENESS_TIMEOUT_MS) {
                    const remaining = SUBPROCESS_LIVENESS_TIMEOUT_MS - livenessElapsed;
                    const pollMs = Math.min(LIVENESS_POLL_MS, remaining);
                    let livenessHandle: ReturnType<typeof setTimeout>;
                    const livenessPromise = new Promise<"timeout">((resolve) => {
                        livenessHandle = setTimeout(() => resolve("timeout"), pollMs);
                    });
                    const winner = await Promise.race([
                        eventPromise,
                        livenessPromise.then(() => ({ kind: "timeout" as const })),
                    ]);
                    if (winner.kind === "timeout") {
                        livenessElapsed += pollMs;
                        continue;
                    }
                    clearTimeout(livenessHandle!);
                    iterResult = winner.result;
                    break;
                }
                if (livenessElapsed >= SUBPROCESS_LIVENESS_TIMEOUT_MS) {
                    log("WARN", `No events for ${Math.round(livenessElapsed / 1000)}s on thread ${threadId} — exiting consumer`);
                    break;
                }
            }

            if (!iterResult || iterResult.done) break;
            const msg = iterResult.value;

            // Capture session ID
            if ("session_id" in msg && msg.session_id) {
                const isNew = currentSessionId !== msg.session_id;
                currentSessionId = msg.session_id;
                if (isNew) {
                    persistSessionId(threadId, currentSessionId);
                }
            }

            if (msg.type === "assistant") {
                const assistantMsg = msg as SDKAssistantMessage;
                const content = assistantMsg.message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "text" && typeof block.text === "string") {
                            accumulated += (accumulated ? "\n\n" : "") + block.text;
                            fullAccumulatedText += (fullAccumulatedText ? "\n\n" : "") + block.text;
                            currentPreview = fullAccumulatedText.length > 500
                                ? "…" + fullAccumulatedText.slice(-500)
                                : fullAccumulatedText;
                            // Write streaming text block to outgoing queue
                            writeStreamingOutgoing(threadId, channel, sender, model, block.text, streamSeq++, currentAnchorMessageId);
                        }
                        if (block.type === "tool_use" && "name" in block) {
                            toolCount++;
                            currentStatusLabel = `Using ${block.name} [${toolCount}]`;
                        }
                    }
                }
            }

            if (msg.type === "tool_progress") {
                const toolMsg = msg as SDKToolProgressMessage;
                currentStatusLabel = `Using ${toolMsg.tool_name} [${toolCount}]`;
            }

            if (msg.type === "system" && "subtype" in msg && msg.subtype === "status" && "status" in msg && msg.status === "compacting") {
                currentStatusLabel = "Compacting context";
            }

            // Track background tasks
            applyTaskEvent(msg, activeTasks, {
                onTaskStarted(taskId: string, description: string) {
                    currentStatusLabel = `Background: ${description}`;
                    log("INFO", `Background task started: ${taskId} — ${description}`);
                },
                onTaskProgress(_taskId: string, summary: string | undefined) {
                    if (summary) currentStatusLabel = `Background: ${summary.substring(0, 60)}`;
                },
                onTaskCompleted(taskId: string, status: string, summary: string) {
                    log("INFO", `Background task ${taskId} ${status}: ${summary}`);
                },
            });

            if (msg.type === "result") {
                const result = msg as SDKResultMessage;
                const usage = extractUsageData(result);

                // Log and write stream-complete marker
                if (accumulated || streamSeq > 0) {
                    appendHistory({
                        ts: Date.now(), threadId, channel,
                        sender: "assistant", direction: "out",
                        message: accumulated, model,
                        source: "user", messageId: currentAnchorMessageId,
                        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
                        costUSD: usage.totalCostUSD,
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        cacheReadInputTokens: usage.cacheReadInputTokens,
                        cacheCreationInputTokens: usage.cacheCreationInputTokens,
                        durationMs: usage.durationMs,
                        durationApiMs: usage.durationApiMs,
                        numTurns: usage.numTurns,
                        modelUsage: usage.modelUsage,
                    });
                    writeStreamCompleteOutgoing(threadId, channel, sender, model, accumulated, currentAnchorMessageId);
                } else {
                    // Empty response — still write a marker so telegram-client knows the turn ended
                    writeStreamCompleteOutgoing(threadId, channel, sender, model, "", currentAnchorMessageId);
                }

                // Handle background tasks
                const runningTasks = [...activeTasks.values()].filter(t => t.status === "running");
                if (runningTasks.length > 0) {
                    // Fire off background monitoring — the consumer keeps running
                    // to handle task events and eventual completion summary injection
                    sessionPool.markMonitoring(threadId);
                    writeTaskState(currentAnchorMessageId, threadId, activeTasks);
                    const monitor = monitorBackgroundTasks(q, activeTasks, threadId, currentAnchorMessageId);
                    activeBackgroundMonitors.set(threadId, monitor);
                    monitor.finally(() => {
                        activeBackgroundMonitors.delete(threadId);
                        sessionPool.markIdle(threadId, currentSessionId);
                    });
                    log("INFO", `Started background task monitor for thread ${threadId} (${runningTasks.length} task(s))`);
                    // Consumer returns — background monitor takes over the iterator.
                    // Next message will create a new consumer.
                    break;
                }

                // Reset for next turn
                accumulated = "";
                fullAccumulatedText = "";
                currentPreview = undefined;
                streamSeq = 0;
                toolCount = 0;
                clearStatus(threadId);

                // Session is idle between turns — wait for next message push
                sessionPool.markIdle(threadId, currentSessionId);
                if (currentSessionId) {
                    const threadCwd = loadThreads()[String(threadId)]?.cwd;
                    if (threadCwd) syncSessionLog(currentSessionId, threadCwd);
                }

                // Check for cancel
                if (cancelled) {
                    break;
                }
            }
        }
    } catch (err) {
        log("ERROR", `Consumer error for thread ${threadId}: ${toErrorMessage(err)}`);
        // Close the persistent session on error
        sessionPool.close(threadId);
        deleteThreadField(threadId, "sessionId");
    } finally {
        clearInterval(statusInterval);
        clearStatus(threadId);

        if (cancelled) {
            // Write cancellation message
            const cancelText = fullAccumulatedText
                ? `${fullAccumulatedText}\n\n---\n🚫 Processing was cancelled.`
                : "🚫 Processing was cancelled.";
            writeStreamCompleteOutgoing(threadId, channel, sender, model, cancelText, currentAnchorMessageId);
            sessionPool.close(threadId);
        }

        activeConsumers.delete(threadId);
        log("INFO", `Event consumer exited for thread ${threadId}`);
    }
}

// Write a streaming text block to the outgoing queue
function writeStreamingOutgoing(
    threadId: number, channel: string, sender: string, model: string,
    text: string, sequence: number, anchorMessageId: string,
): void {
    const data: OutgoingMessage = {
        channel, threadId, sender, model,
        message: text,
        originalMessage: "(streaming text block)",
        timestamp: Date.now(),
        messageId: anchorMessageId,
        streaming: true,
        streamSequence: sequence,
    };
    const filename = `stream_${threadId}_${anchorMessageId}_${sequence}_${Date.now()}.json`;
    const outFile = path.join(QUEUE_OUTGOING, filename);
    const tmpFile = outFile + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, outFile);
}

// Write a stream-complete marker to the outgoing queue
function writeStreamCompleteOutgoing(
    threadId: number, channel: string, sender: string, model: string,
    accumulatedText: string, anchorMessageId: string,
): void {
    const data: OutgoingMessage = {
        channel, threadId, sender, model,
        message: accumulatedText || "(No response generated)",
        originalMessage: "(stream complete)",
        timestamp: Date.now(),
        messageId: anchorMessageId,
        streamComplete: true,
        accumulatedText,
    };
    const filename = `stream_complete_${threadId}_${anchorMessageId}_${Date.now()}.json`;
    const outFile = path.join(QUEUE_OUTGOING, filename);
    const tmpFile = outFile + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, outFile);
}

// ─── Heartbeat Processing (one-shot, no persistent session) ───

async function processHeartbeat(msg: IncomingMessage): Promise<{ text: string; usage?: QueryUsageData; heartbeatUsageId?: string; heartbeatModel?: string }> {
    const threads = loadThreads();
    const threadKey = String(msg.threadId);
    const threadConfig = threads[threadKey];
    if (!threadConfig) {
        return { text: "[NO_UPDATES]" };
    }

    const dueTier = getDueTier(threadKey);
    const state = loadHeartbeatState();
    const lastReport = state[threadKey]?.lastReport;

    // Parse HEARTBEAT.md sections and inject only relevant tiers into prompt
    let sections: HeartbeatSections | null = null;
    let heartbeatContent: string | null = null;
    try {
        const heartbeatPath = path.join(threadConfig.cwd, "HEARTBEAT.md");
        heartbeatContent = fs.readFileSync(heartbeatPath, "utf8");
        sections = parseHeartbeatSections(heartbeatContent);
    } catch {
        // ENOENT — no HEARTBEAT.md yet, prompt will tell agent to create one
    }

    let heartbeatPrompt = buildHeartbeatPrompt(threadConfig, dueTier, lastReport, sections);

    // Inject timed tasks if any are due (parsed from HEARTBEAT.md in code, not by agent)
    if (heartbeatContent) {
        try {
            const threadState = state[threadKey] || { quick: 0, hourly: 0, daily: 0 };
            const lastRun = new Date(Math.max(threadState.quick, threadState.hourly, threadState.daily) || 0);
            const now = new Date();
            const settings = loadSettings();
            const timedTasks = getTimedTasks(heartbeatContent, lastRun, now, settings.timezone);
            if (timedTasks.length > 0) {
                const timedSection = [
                    "",
                    "## Timed Tasks Due Now",
                    ...timedTasks.map(t => `- ${t}`),
                ].join("\n");
                heartbeatPrompt += timedSection;
            }
        } catch {
            // Timed task parsing is best-effort
        }
    }

    log("INFO", `Heartbeat one-shot for thread ${msg.threadId} (tier: ${dueTier})`);

    // Respect thread-level model override; fall back to budget model or haiku
    const isFireworksModel = threadConfig.model?.includes("fireworks");
    const heartbeatModel = (isFireworksModel && threadConfig.model) || (isBudgetMode() ? BUDGET_MODEL : "haiku");
    const heartbeatUsageId = await setupBudgetProxy(heartbeatModel);
    const stderrLines: string[] = [];
    const q = query({
        prompt: heartbeatPrompt,
        options: {
            model: heartbeatModel,
            cwd: threadConfig.cwd,
            canUseTool: sdkCanUseTool,
            settingSources: ["project", "user"],
            systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: buildThreadPrompt(threadConfig, { threadId: msg.threadId, model: heartbeatModel }),
            },
            mcpServers: {
                borg: createBorgMcpServer(msg.threadId),
            },
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            stderr: (data: string) => { stderrLines.push(data); },
        },
    });

    try {
        const { text, stallRecovered, usage } = await collectQueryResponse(q);
        if (stallRecovered) {
            log("WARN", `Heartbeat stall recovered for thread ${msg.threadId}`);
        }
        const response = text.trim() || "[NO_UPDATES]";

        // Always update state on successful response
        updateHeartbeatState(threadKey, dueTier);

        // Save last non-suppressed report so future heartbeats know what was already reported
        if (!response.includes("[NO_UPDATES]")) {
            saveLastReport(threadKey, response);
        }

        return { text: response, usage, heartbeatUsageId, heartbeatModel };
    } catch (err) {
        const stderrOutput = stderrLines.join("").trim();
        log(
            "ERROR",
            `Heartbeat query error for thread ${msg.threadId}: ${toErrorMessage(err)}` +
                (stderrOutput ? `\n  stderr: ${stderrOutput.slice(0, 2000)}` : ""),
        );
        throw err;
    }
}

// ─── Scheduled Task Processing (one-shot, no persistent session) ───

async function processScheduledTask(task: ScheduledTask): Promise<{ text: string; usage?: QueryUsageData }> {
    const threads = loadThreads();
    const settings = loadSettings();
    const reportThread = threads[String(task.reportThreadId)];
    const threadName = reportThread?.name ?? `Thread ${task.reportThreadId}`;

    const systemPreamble = [
        `You are running as a scheduled task.`,
        `Task: ${task.name}`,
        `Schedule: ${task.cron} (${settings.timezone || "UTC"})`,
        `Your output will be posted to thread "${threadName}" (ID: ${task.reportThreadId}).`,
        `Be concise and actionable. If there's nothing to report, say so briefly.`,
    ].join("\n");

    await setupBudgetProxy(isBudgetMode() ? BUDGET_MODEL : task.model);

    const taskModel = isBudgetMode() ? BUDGET_MODEL : task.model;
    const stderrLines: string[] = [];
    const q = query({
        prompt: task.prompt,
        options: {
            model: taskModel,
            effort: "medium",
            cwd: task.cwd,
            canUseTool: sdkCanUseTool,
            settingSources: ["project", "user"],
            systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: systemPreamble,
            },
            mcpServers: {
                borg: createBorgMcpServer(task.reportThreadId),
            },
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            stderr: (data: string) => { stderrLines.push(data); },
        },
    });

    try {
        const { text, usage } = await collectQueryResponse(q);
        return { text: text.trim() || "[No output]", usage };
    } catch (err) {
        const stderrOutput = stderrLines.join("").trim();
        log(
            "ERROR",
            `Scheduled task "${task.name}" query error: ${toErrorMessage(err)}` +
                (stderrOutput ? `\n  stderr: ${stderrOutput.slice(0, 2000)}` : ""),
        );
        throw err;
    }
}

// ─── One-Shot Query (/do command) ───

async function processOneShot(msg: IncomingMessage): Promise<{ text: string; model: string; usage?: QueryUsageData; budgetUsageId?: string }> {
    const threadId = msg.threadId;
    const oneshotModel = msg.oneshotModel;
    const effectiveModel = isBudgetMode() ? BUDGET_MODEL : (oneshotModel || "haiku");

    log("INFO", `One-shot query for thread ${threadId}: model=${effectiveModel}`);

    const threads = loadThreads();
    const threadConfig = threads[String(threadId)];
    const cwd = threadConfig?.cwd || process.env.DEFAULT_CWD || process.cwd();

    // Inject recent history as background context (not conversation you're part of)
    const historyContext = buildHistoryContext(threadId, threadConfig?.isMaster ?? false);
    const historyBlock = historyContext
        ? `\n\nBelow is recent activity in this thread for background context. You are NOT part of this conversation — this is just to help you understand what's been going on. Do not continue or reply to these messages; focus only on the task you've been given.\n\n${historyContext}`
        : "";

    const systemPreamble = [
        `You are running as an independent one-shot query via /do — you have no conversation history or session state.`,
        `Thread: "${threadConfig?.name ?? `Thread ${threadId}`}"`,
        `Working directory: ${cwd}`,
        `Be concise and direct. This is a quick task — no need for lengthy explanations.`,
    ].join("\n") + historyBlock;

    const budgetUsageId = await setupBudgetProxy(effectiveModel);

    const stderrLines: string[] = [];
    const q = query({
        prompt: msg.message,
        options: {
            model: effectiveModel,
            effort: "medium",
            cwd,
            canUseTool: sdkCanUseTool,
            settingSources: ["project", "user"],
            systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: systemPreamble,
            },
            mcpServers: {
                borg: createBorgMcpServer(threadId),
            },
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            stderr: (data: string) => { stderrLines.push(data); },
        },
    });

    try {
        const { text, usage } = await collectQueryResponse(q);
        return { text: text.trim() || "(No output)", model: effectiveModel, usage, budgetUsageId };
    } catch (err) {
        const stderrOutput = stderrLines.join("").trim();
        log("ERROR", `One-shot query error: ${toErrorMessage(err)}${stderrOutput ? `\n  stderr: ${stderrOutput.slice(0, 2000)}` : ""}`);
        return { text: `One-shot query failed: ${toErrorMessage(err)}`, model: effectiveModel, budgetUsageId };
    }
}

// ─── Process Message (one-shot/heartbeat/scheduled-task/command paths only) ───

async function processMessage(messageFile: string): Promise<void> {
    const filename = path.basename(messageFile);
    const processingFile = path.join(QUEUE_PROCESSING, filename);
    const retryCount = getRetryCount(filename);

    try {
        fs.renameSync(messageFile, processingFile);
    } catch (err) {
        log(
            "ERROR",
            `Failed to move ${filename} to processing: ${toErrorMessage(err)}`,
        );
        return;
    }

    let msg: IncomingMessage;
    try {
        const raw: unknown = JSON.parse(fs.readFileSync(processingFile, "utf8"));
        const parsed = IncomingMessageSchema.safeParse(raw);
        if (!parsed.success) {
            log("ERROR", `Invalid message shape in ${filename}: ${parsed.error.message}`);
            moveToDeadLetter(processingFile, filename);
            return;
        }
        msg = parsed.data;
    } catch (err) {
        log("ERROR", `Failed to parse ${filename}: ${toErrorMessage(err)}`);
        moveToDeadLetter(processingFile, filename);
        return;
    }

    const { channel, threadId, sender, messageId, source } = msg;
    log(
        "INFO",
        `Processing [${channel}] thread=${threadId} from ${sender}: ${msg.message.substring(0, 80)}...`,
    );

    // Log incoming message to history
    appendHistory({
        ts: Date.now(),
        threadId,
        channel,
        sender,
        direction: "in",
        message: msg.message,
        source: source ?? "user",
        sourceThreadId: msg.sourceThreadId,
        messageId,
    });

    let responseText: string;
    let budgetUsageId: string | undefined;
    let effectiveModel: string;
    let usageData: QueryUsageData | undefined;
    let scheduledTaskName: string | undefined;
    let resolvedSessionId: string | undefined;

    try {
        // ─── One-Shot (/do): no session context, user-specified model ───
        if (source === "one-shot") {
            const oneshotResult = await processOneShot(msg);
            effectiveModel = oneshotResult.model;
            responseText = oneshotResult.text;
            usageData = oneshotResult.usage;
            budgetUsageId = oneshotResult.budgetUsageId;
            clearStatus(threadId);
        // ─── Scheduled Task: one-shot, no persistent session ───
        } else if (source === "scheduled-task") {
            const taskId = msg.messageId.match(/^sched_([^_]+)_/)?.[1];
            const task = taskId ? loadTasks().find(t => t.id === taskId) : undefined;
            if (!task) {
                log("WARN", `Scheduled task not found for messageId ${msg.messageId}`);
                clearStatus(threadId);
                if (fs.existsSync(processingFile)) fs.unlinkSync(processingFile);
                return;
            }

            log("INFO", `Running scheduled task "${task.name}" (${task.model})`);
            effectiveModel = isBudgetMode() ? BUDGET_MODEL : task.model;
            scheduledTaskName = task.name;

            try {
                const result = await processScheduledTask(task);
                responseText = result.text;
                usageData = result.usage;
                markTaskComplete(task.id, "success", usageData?.totalCostUSD ?? 0);
            } catch (err) {
                responseText = `Scheduled task "${task.name}" failed: ${toErrorMessage(err)}`;
                markTaskComplete(task.id, "error", 0);
            }

            clearStatus(threadId);
        // ─── Heartbeat: one-shot, skip router and session ───
        } else if (source === "heartbeat") {
            // Defense-in-depth: skip heartbeat for team threads
            const teamCheckThreads = loadThreads();
            const teamCheckConfig = teamCheckThreads[String(threadId)];
            if (teamCheckConfig?.team) {
                log("INFO", `Skipping heartbeat for team thread ${threadId} (team: ${teamCheckConfig.team})`);
                clearStatus(threadId);
                if (fs.existsSync(processingFile)) {
                    fs.unlinkSync(processingFile);
                }
                return;
            }
            const heartbeatResult = await processHeartbeat(msg);
            effectiveModel = heartbeatResult.heartbeatModel ?? (isBudgetMode() ? BUDGET_MODEL : "haiku");
            responseText = heartbeatResult.text;
            usageData = heartbeatResult.usage;
            if (heartbeatResult.heartbeatUsageId) {
                const budgetUsage = readBudgetUsage(heartbeatResult.heartbeatUsageId);
                if (budgetUsage) usageData = budgetUsage;
            }

            // Suppress heartbeat responses with no actionable content
            if (responseText.includes("[NO_UPDATES]")) {
                log(
                    "INFO",
                    `Heartbeat suppressed for thread=${threadId} (no updates)`,
                );
                // Still track usage for suppressed heartbeats
                if (usageData) {
                    appendHistory({
                        ts: Date.now(),
                        threadId,
                        channel,
                        sender: "assistant",
                        direction: "out",
                        message: "[heartbeat:suppressed]",
                        model: effectiveModel,
                        source: "heartbeat",
                        messageId,
                        costUSD: usageData.totalCostUSD,
                        inputTokens: usageData.inputTokens,
                        outputTokens: usageData.outputTokens,
                        cacheReadInputTokens: usageData.cacheReadInputTokens,
                        cacheCreationInputTokens: usageData.cacheCreationInputTokens,
                        durationMs: usageData.durationMs,
                        durationApiMs: usageData.durationApiMs,
                        numTurns: usageData.numTurns,
                        modelUsage: usageData.modelUsage,
                    });
                }
                clearStatus(threadId);
                if (fs.existsSync(processingFile)) {
                    fs.unlinkSync(processingFile);
                }
                return;
            }
        } else {
            // Regular messages are handled by the streaming channel in processQueue.
            // If we get here, it's a regular message that somehow ended up in processMessage
            // (shouldn't happen with the new architecture). Log and skip.
            log("WARN", `Regular message in processMessage — should be handled by streaming channel: thread=${threadId} messageId=${messageId}`);
            effectiveModel = "sonnet";
            responseText = "(Message routed incorrectly — please retry)";
        }
    } catch (error) {
        const errorMsg = toErrorMessage(error);
        log("ERROR", `Processing error for ${filename}: ${errorMsg}`);

        // Detect connection errors (proxy unavailable) and reset proxy availability
        // so subsequent retries fall back to direct API
        if (isBudgetMode() && (
            errorMsg.includes("ECONNREFUSED") ||
            errorMsg.includes("connect ECONNREFUSED") ||
            errorMsg.includes("fetch failed") ||
            errorMsg.includes("connection") ||
            errorMsg.includes("timeout")
        )) {
            log("WARN", "Budget proxy connection error detected, resetting proxy state");
            resetProxyAvailable();
            // Ensure direct API is used on retry by clearing the env var
            if (process.env.ANTHROPIC_BASE_URL?.startsWith(BUDGET_PROXY_URL)) {
                delete process.env.ANTHROPIC_BASE_URL;
            }
        }

        clearStatus(threadId);
        handleRetry(processingFile, filename, retryCount);
        return;
    }

    // ─── Write response to outgoing queue (one-shot paths: scheduled-task, heartbeat, one-shot) ───
    appendHistory({
        ts: Date.now(),
        threadId,
        channel,
        sender: "assistant",
        direction: "out",
        message: responseText,
        model: effectiveModel,
        source: source ?? "user",
        messageId,
        ...(scheduledTaskName ? { scheduledTaskName } : {}),
        ...(usageData ? {
            costUSD: usageData.totalCostUSD,
            inputTokens: usageData.inputTokens,
            outputTokens: usageData.outputTokens,
            cacheReadInputTokens: usageData.cacheReadInputTokens,
            cacheCreationInputTokens: usageData.cacheCreationInputTokens,
            durationMs: usageData.durationMs,
            durationApiMs: usageData.durationApiMs,
            numTurns: usageData.numTurns,
            modelUsage: usageData.modelUsage,
        } : {}),
    });

    const responseData: OutgoingMessage = {
        channel,
        threadId,
        sender: "assistant",
        message: responseText,
        originalMessage: responseText,
        timestamp: Date.now(),
        messageId,
        model: effectiveModel,
        ...(scheduledTaskName ? { scheduledTaskName } : {}),
    };

    const outFile = path.join(QUEUE_OUTGOING, `${messageId}.json`);
    const tmpFile = outFile + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(responseData, null, 2));
    fs.renameSync(tmpFile, outFile);

    // Cleanup processing file
    if (fs.existsSync(processingFile)) {
        fs.unlinkSync(processingFile);
    }
}

// ─── Retry / Dead-Letter Logic ───

function handleRetry(
    processingFile: string,
    filename: string,
    retryCount: number,
): void {
    if (!fs.existsSync(processingFile)) return;

    if (retryCount >= MAX_RETRIES - 1) {
        moveToDeadLetter(processingFile, filename);
        return;
    }

    const newRetry = retryCount + 1;
    const retryFilename = buildRetryFilename(filename, newRetry);
    const retryPath = path.join(QUEUE_INCOMING, retryFilename);

    try {
        // Add retryAfter timestamp for exponential backoff (5s, 15s, 30s)
        const backoffMs = [5_000, 15_000, 30_000][Math.min(newRetry - 1, 2)];
        const retryAfter = Date.now() + backoffMs;
        const content = fs.readFileSync(processingFile, "utf8");
        const data = JSON.parse(content);
        data.retryAfter = retryAfter;
        const tmpFile = retryPath + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
        fs.renameSync(tmpFile, retryPath);
        fs.unlinkSync(processingFile);
        log(
            "WARN",
            `Retry ${newRetry}/${MAX_RETRIES} for ${filename} -> ${retryFilename} (backoff ${backoffMs / 1000}s)`,
        );
    } catch (err) {
        log(
            "ERROR",
            `Failed to move ${filename} back for retry: ${toErrorMessage(err)}`,
        );
        moveToDeadLetter(processingFile, filename);
    }
}

function moveToDeadLetter(filePath: string, filename: string): void {
    try {
        const deadLetterPath = path.join(
            QUEUE_DEAD_LETTER,
            `${Date.now()}_${filename}`,
        );
        fs.renameSync(filePath, deadLetterPath);
        log("ERROR", `Moved to dead-letter: ${filename}`);
    } catch (err) {
        log(
            "ERROR",
            `Failed to move ${filename} to dead-letter: ${toErrorMessage(err)}`,
        );
        try {
            fs.unlinkSync(filePath);
        } catch {
            // Nothing more we can do
        }
    }
}

// ─── Command Queue Processing ───

async function processCommands(): Promise<void> {
    if (!fs.existsSync(QUEUE_COMMANDS)) return;

    const files = fs
        .readdirSync(QUEUE_COMMANDS)
        .filter((f) => f.endsWith(".json"));

    for (const file of files) {
        const filePath = path.join(QUEUE_COMMANDS, file);
        try {
            const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const parsed = CommandMessageSchema.safeParse(raw);
            if (!parsed.success) {
                log("WARN", `Invalid command shape in ${file}: ${parsed.error.message}`);
                fs.unlinkSync(filePath);
                continue;
            }
            const data = parsed.data;

            if (data.command === "reset") {
                sessionPool.close(data.threadId);
                resetThread(data.threadId);
                log("INFO", `Command: reset thread ${data.threadId}`);
            } else if (data.command === "setdir" && data.args?.cwd) {
                sessionPool.close(data.threadId);
                configureThread(data.threadId, { cwd: data.args.cwd });
                log(
                    "INFO",
                    `Command: setdir thread ${data.threadId} -> ${data.args.cwd}`,
                );
            } else {
                log("WARN", `Unknown command: ${data.command}`);
            }

            fs.unlinkSync(filePath);
        } catch (err) {
            log("ERROR", `Failed to process command ${file}: ${toErrorMessage(err)}`);
            try {
                fs.unlinkSync(filePath);
            } catch {
                /* ignore */
            }
        }
    }
}

// ─── Queue Scanning ───

interface QueueFile {
    name: string;
    path: string;
    time: number;
}

async function processQueue(): Promise<void> {
    const maxConcurrent = loadSettings().max_concurrent_sessions;

    if (activeCount >= maxConcurrent) return;
    if (scanning) return;
    scanning = true;

    try {
        await processCommands();

        const files: QueueFile[] = fs
            .readdirSync(QUEUE_INCOMING)
            .filter((f) => f.endsWith(".json"))
            .map((f) => ({
                name: f,
                path: path.join(QUEUE_INCOMING, f),
                time: fs.statSync(path.join(QUEUE_INCOMING, f)).mtimeMs,
            }))
            .sort((a, b) => {
                const aLow = a.name.startsWith('heartbeat_') || a.name.startsWith('sched_');
                const bLow = b.name.startsWith('heartbeat_') || b.name.startsWith('sched_');
                if (aLow && !bLow) return 1;   // heartbeats/tasks go to back
                if (!aLow && bLow) return -1;  // user messages jump ahead
                return a.time - b.time;         // within same priority, FIFO
            });

        if (files.length > 0) {
            log(
                "DEBUG",
                `Found ${files.length} message(s) in queue (active: ${activeCount}/${maxConcurrent})`,
            );
        }

        for (const file of files) {
            if (activeCount >= maxConcurrent) break;

            // Peek at message to get threadId for per-thread serialization
            let msg: IncomingMessage;
            try {
                const raw: unknown = JSON.parse(fs.readFileSync(file.path, "utf8"));
                // Check retry backoff — skip if not ready yet
                if (raw && typeof raw === "object" && "retryAfter" in raw) {
                    const retryAfter = (raw as any).retryAfter;
                    if (typeof retryAfter === "number" && Date.now() < retryAfter) continue;
                }
                const parsed = IncomingMessageSchema.safeParse(raw);
                if (!parsed.success) continue;
                msg = parsed.data;
            } catch {
                continue; // File may have been picked up by a concurrent scan
            }

            // ─── Streaming channel: push into existing session ───
            // If a consumer is running for this thread, push the message into the
            // session channel. The consumer handles it — no separate tracking needed.
            if (activeConsumers.has(msg.threadId)) {
                if (!msg.message.startsWith("/") &&
                    msg.source !== "heartbeat" &&
                    msg.source !== "scheduled-task" &&
                    msg.source !== "one-shot") {
                    const now = formatCurrentTime();
                    const prefix = buildSourcePrefix(msg);
                    const oneShotHint = getRecentOneShotHint(msg.threadId);
                    const pushPrompt = oneShotHint
                        ? `${oneShotHint}\n\n[${now}] ${prefix} ${msg.message}`
                        : `[${now}] ${prefix} ${msg.message}`;
                    if (sessionPool.pushMessage(msg.threadId, pushPrompt)) {
                        // Log incoming to history
                        appendHistory({
                            ts: Date.now(),
                            threadId: msg.threadId,
                            channel: msg.channel,
                            sender: msg.sender,
                            direction: "in",
                            message: msg.message,
                            source: msg.source ?? "user",
                            sourceThreadId: msg.sourceThreadId,
                            messageId: msg.messageId,
                        });
                        // Update the status anchor to the latest user message
                        updateThreadStatusAnchor(QUEUE_STATUS, msg.threadId, msg.messageId);
                        // Delete queue file — message is in the channel now
                        try { fs.unlinkSync(file.path); } catch {}
                        log("INFO", `Pushed message into channel for thread ${msg.threadId} from ${msg.sender}: ${msg.message.substring(0, 60)}`);
                    }
                }
                continue;
            }

            // Only 1 heartbeat can process concurrently — reserve other slots for user messages
            if (msg.source === 'heartbeat' && activeHeartbeatCount >= 1) continue;
            // Only 1 scheduled task at a time
            if (msg.source === 'scheduled-task' && activeScheduledTaskCount >= 1) continue;

            // ─── One-shot paths: dispatch to existing handlers (unchanged) ───
            if (msg.source === "heartbeat" || msg.source === "scheduled-task" || msg.source === "one-shot") {
                // These use their own one-shot query() calls, not the streaming channel
                activeCount++;
                if (msg.source === 'heartbeat') activeHeartbeatCount++;
                if (msg.source === 'scheduled-task') activeScheduledTaskCount++;

                log("INFO", `Dispatching ${msg.source} thread=${msg.threadId} (active: ${activeCount}/${maxConcurrent})`);

                processMessage(file.path).finally(() => {
                    activeCount--;
                    if (msg.source === 'heartbeat') activeHeartbeatCount--;
                    if (msg.source === 'scheduled-task') activeScheduledTaskCount--;
                    void processQueue();
                });
                continue;
            }

            // ─── Commands: dispatch to processMessage for handling ───
            if (msg.message.startsWith("/")) {
                activeCount++;
                log("INFO", `Dispatching command thread=${msg.threadId} (active: ${activeCount}/${maxConcurrent})`);
                processMessage(file.path).finally(() => {
                    activeCount--;
                    void processQueue();
                });
                continue;
            }

            // ─── Coalesce queued messages for the same thread ───
            const coalesced: QueueFile[] = [];
            const hasImage = !!(msg.imagePath || msg.imagePaths?.length);
            if (!msg.audioPath) {
                for (const other of files) {
                    if (other === file) continue;
                    try {
                        const otherRaw: unknown = JSON.parse(fs.readFileSync(other.path, "utf8"));
                        const otherParsed = IncomingMessageSchema.safeParse(otherRaw);
                        if (!otherParsed.success) continue;
                        const otherMsg = otherParsed.data;
                        if (otherMsg.threadId !== msg.threadId) continue;
                        if (otherMsg.message.startsWith("/")) continue;
                        if (otherMsg.audioPath) continue;
                        if (otherMsg.source === "heartbeat" || otherMsg.source === "scheduled-task" || otherMsg.source === "one-shot") continue;
                        const otherHasImage = !!(otherMsg.imagePath || otherMsg.imagePaths?.length);
                        if (hasImage !== otherHasImage) continue;
                        coalesced.push(other);
                        if (otherHasImage) {
                            if (!msg.imagePaths) msg.imagePaths = msg.imagePath ? [msg.imagePath] : [];
                            if (otherMsg.imagePaths?.length) {
                                msg.imagePaths.push(...otherMsg.imagePaths);
                            } else if (otherMsg.imagePath) {
                                msg.imagePaths.push(otherMsg.imagePath);
                            }
                            if (otherMsg.message) {
                                msg.message = msg.message ? msg.message + "\n\n" + otherMsg.message : otherMsg.message;
                            }
                        } else {
                            msg.message = msg.message + "\n\n" + otherMsg.message;
                        }
                    } catch { continue; }
                }

                if (coalesced.length > 0) {
                    try {
                        const tmpFile = file.path + ".tmp";
                        fs.writeFileSync(tmpFile, JSON.stringify(msg, null, 2));
                        fs.renameSync(tmpFile, file.path);
                    } catch { /* proceed with original if rewrite fails */ }
                    for (const cf of coalesced) {
                        try { fs.unlinkSync(cf.path); } catch { /* best effort */ }
                    }
                    log("INFO", `Coalesced ${coalesced.length + 1} messages for thread ${msg.threadId}`);
                }
            }

            // ─── Streaming channel: create session + start consumer ───
            const { channel, threadId, sender, messageId, source } = msg;

            // Log incoming message to history
            appendHistory({
                ts: Date.now(), threadId, channel, sender,
                direction: "in", message: msg.message,
                source: source ?? "user",
                sourceThreadId: msg.sourceThreadId, messageId,
            });

            // Load/create thread config
            const threads = loadThreads();
            const key = String(threadId);
            let threadConfig = threads[key];
            if (!threadConfig) {
                const defaultCwd = process.env.DEFAULT_CWD || process.cwd();
                threadConfig = {
                    name: msg.topicName ?? `Thread ${threadId}`,
                    cwd: defaultCwd, model: "sonnet",
                    isMaster: false, lastActive: Date.now(),
                };
                threads[key] = threadConfig;
                saveThreads(threads);
            } else if (msg.topicName && threadConfig.name === `Thread ${threadId}`) {
                threadConfig.name = msg.topicName;
                saveThreads(threads);
            }
            threads[key].lastActive = Date.now();

            // Determine model
            let effectiveModel: string;
            if (isBudgetMode()) {
                effectiveModel = BUDGET_MODEL;
            } else {
                effectiveModel = threadConfig.model || DEFAULT_THREAD_MODEL;
            }

            // Build prompt
            const now = formatCurrentTime();
            const prefix = buildSourcePrefix(msg);
            const isNewSession = !threadConfig.sessionId;
            const historyContext = isNewSession ? buildHistoryContext(threadId, threadConfig.isMaster) : "";
            const oneShotHint = isNewSession ? "" : getRecentOneShotHint(threadId);
            let fullPrompt: string;
            if (isNewSession) {
                const contextBlock = historyContext ? `\n\n${historyContext}\n\n` : "\n\n";
                fullPrompt = `[${now}]${contextBlock}${prefix} ${msg.message}`;
            } else if (oneShotHint) {
                fullPrompt = `${oneShotHint}\n\n[${now}] ${prefix} ${msg.message}`;
            } else {
                fullPrompt = `[${now}] ${prefix} ${msg.message}`;
            }

            const threadPrompt = buildThreadPrompt(threadConfig, { threadId, model: effectiveModel });
            logPrompt({
                threadId, messageId, model: effectiveModel,
                systemPromptAppend: threadPrompt,
                userMessage: `${prefix} ${msg.message}`,
                historyInjected: isNewSession,
                historyLines: isNewSession ? historyContext.split("\n").length - 1 : 0,
                promptLength: fullPrompt.length,
            });

            // Budget proxy setup
            let budgetUsageId: string | undefined;
            if (isBudgetMode() || effectiveModel.includes("fireworks")) {
                budgetUsageId = crypto.randomUUID();
                const pendingFile = path.join(BORG_DIR, `minimax-usage-${budgetUsageId}.pending`);
                fs.writeFileSync(pendingFile, "");
                process.env.ANTHROPIC_BASE_URL = `${BUDGET_PROXY_URL}/${budgetUsageId}`;
            }

            // Build query options
            const stderrLines: string[] = [];
            const options = await buildQueryOptions(threadId, threadConfig, effectiveModel, stderrLines, msg.message);

            // Try to reuse existing session or create new one.
            // For reused sessions, we need to push the message AFTER the consumer
            // is set up on the iterator — otherwise events get lost.
            let q: Query;
            let needsPush = false;
            const claimed = sessionPool.tryClaimSession(threadId, effectiveModel, threadConfig.cwd);
            if (claimed) {
                q = claimed.query;
                needsPush = true; // Push after consumer starts
            } else {
                // createSession queues firstPrompt in the channel automatically
                q = sessionPool.createSession(threadId, fullPrompt, options, effectiveModel, threadConfig.cwd);
            }

            // Claim active slot
            activeCount++;
            log("INFO", `Dispatching thread=${threadId} via streaming channel (active: ${activeCount}/${maxConcurrent})`);

            // Start the event consumer (fire-and-forget)
            const consumerPromise = consumeThreadEvents(
                threadId, q, channel, sender, effectiveModel, messageId, threadConfig.cwd,
            ).catch(err => {
                log("ERROR", `Consumer error thread ${threadId}: ${toErrorMessage(err)}`);
            }).finally(() => {
                activeCount--;
                activeConsumers.delete(threadId);
                // Clean up budget usage files
                if (budgetUsageId) {
                    const pendingFile = path.join(BORG_DIR, `minimax-usage-${budgetUsageId}.pending`);
                    try { if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile); } catch {}
                }
                void processQueue();
            });
            activeConsumers.set(threadId, consumerPromise);

            // For reused sessions, push the message now. The consumer is already
            // waiting on iterator.next(), so the message flows through immediately.
            if (needsPush && claimed) {
                claimed.pushMessage(fullPrompt);
            }

            // Delete queue file
            try { fs.unlinkSync(file.path); } catch {}
        }
    } catch (error) {
        log("ERROR", `Queue scan error: ${toErrorMessage(error)}`);
    } finally {
        scanning = false;
    }
}

// ─── Graceful Shutdown ───

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log(
        "INFO",
        `Received ${signal}. Shutting down... (${activeCount} active session(s), ${activeConsumers.size} consumer(s), ${activeBackgroundMonitors.size} background monitor(s), ${sessionPool.size} pooled session(s))`,
    );

    clearInterval(queueInterval);
    clearInterval(sessionSyncInterval);
    sessionPool.closeAll();

    try {
        const threads = loadThreads();
        saveThreads(threads);
        log("INFO", "Saved threads.json");
    } catch {
        // Best effort
    }

    log("INFO", "Queue processor shut down.");
    process.exit(0);
}

process.on("SIGINT", () => {
    void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
});

// ─── Startup ───

const startupSettings = loadSettings();
log(
    "INFO",
    `Queue processor started (Agent SDK v1 query API + smart routing, max concurrent: ${startupSettings.max_concurrent_sessions})`,
);
log("INFO", `Watching: ${QUEUE_INCOMING}`);


// fs.watch for near-instant pickup
try {
    fs.watch(QUEUE_INCOMING, { persistent: false }, (_eventType, filename) => {
        if (filename && filename.endsWith(".json")) {
            void processQueue();
        }
    });
    log("INFO", "fs.watch active on incoming queue");
} catch (err) {
    log(
        "WARN",
        `fs.watch unavailable: ${toErrorMessage(err)}. Using interval fallback only.`,
    );
}

// 5-second fallback interval
let queueInterval: ReturnType<typeof setInterval> | undefined;
queueInterval = setInterval(() => {
    void processQueue();
}, 5000);

// Periodic session log sync (for live tailing during long-running queries)
let sessionSyncInterval: ReturnType<typeof setInterval> | undefined;
sessionSyncInterval = setInterval(syncAllActiveSessionLogs, 5000);

// ─── Zone-Filtered Heartbeat Timer ───

const BORG_ZONE = process.env.BORG_ZONE || "core";
const ZONE_CONFIG_PATH = process.env.ZONE_CONFIG_PATH || path.join(SCRIPT_DIR, "zone-config.json");
const HEARTBEAT_PROMPT = "Read HEARTBEAT.md if it exists. Follow it strictly. If nothing needs human attention, reply with exactly [NO_UPDATES].";

function runHeartbeatCycle(): void {
    try {
        const settings = loadSettings();
        const threads = loadThreads();
        const zoneConfig = loadZoneConfig(ZONE_CONFIG_PATH);

        // Get threads assigned to this zone
        const zoneThreadIds = zoneConfig
            ? getThreadsInZone(zoneConfig, BORG_ZONE)
            : Object.keys(threads).map(Number);

        // Filter to non-team threads in this zone
        const eligibleThreads = zoneThreadIds.filter((id) => {
            const config = threads[String(id)];
            return config && !config.team;
        });

        if (eligibleThreads.length === 0) {
            log("DEBUG", `Heartbeat: no eligible threads in zone ${BORG_ZONE}`);
            return;
        }

        const ts = Date.now();
        for (const threadId of eligibleThreads) {
            const messageId = `heartbeat_${threadId}_${Math.floor(ts / 1000)}_${Math.random().toString(36).slice(2, 6)}`;
            const incoming = {
                channel: "heartbeat",
                source: "heartbeat",
                threadId,
                sender: "system",
                senderId: "heartbeat",
                message: HEARTBEAT_PROMPT,
                isReply: false,
                timestamp: ts,
                messageId,
            };

            fs.mkdirSync(QUEUE_INCOMING, { recursive: true });
            const tmp = path.join(QUEUE_INCOMING, `${messageId}.json.tmp`);
            const final_ = path.join(QUEUE_INCOMING, `${messageId}.json`);
            fs.writeFileSync(tmp, JSON.stringify(incoming));
            fs.renameSync(tmp, final_);
        }

        log("INFO", `Heartbeat: queued ${eligibleThreads.length} thread(s) in zone ${BORG_ZONE}`);
    } catch (err) {
        log("ERROR", `Heartbeat cycle failed: ${toErrorMessage(err)}`);
    }
}

// Start heartbeat timer — read interval from settings, default 500s
const heartbeatInterval = (() => {
    try {
        return loadSettings().heartbeat_interval || 500;
    } catch {
        return 500;
    }
})();
log("INFO", `Heartbeat timer started (interval: ${heartbeatInterval}s, zone: ${BORG_ZONE})`);
setInterval(runHeartbeatCycle, heartbeatInterval * 1000);

// ─── Scheduled Tasks Timer ───

function runScheduledTasksCycle(): void {
    try {
        const dueTasks = getDueTasks();
        if (dueTasks.length === 0) return;

        const ts = Date.now();
        fs.mkdirSync(QUEUE_INCOMING, { recursive: true });
        for (const task of dueTasks) {
            const messageId = `sched_${task.id}_${Math.floor(ts / 1000)}_${Math.random().toString(36).slice(2, 6)}`;
            const incoming = {
                channel: "scheduled-task",
                source: "scheduled-task",
                threadId: task.reportThreadId,
                sender: "system",
                senderId: "scheduler",
                message: task.prompt,
                isReply: false,
                timestamp: ts,
                messageId,
            };
            const tmp = path.join(QUEUE_INCOMING, `${messageId}.json.tmp`);
            const final_ = path.join(QUEUE_INCOMING, `${messageId}.json`);
            fs.writeFileSync(tmp, JSON.stringify(incoming));
            fs.renameSync(tmp, final_);
            // Mark queued immediately so next cycle won't re-detect this task
            markTaskQueued(task.id);
        }

        log("INFO", `Scheduled tasks: queued ${dueTasks.length} due task(s)`);
    } catch (err) {
        log("ERROR", `Scheduled tasks cycle failed: ${toErrorMessage(err)}`);
    }
}

log("INFO", "Scheduled tasks timer started (interval: 60s)");
setInterval(runScheduledTasksCycle, 60_000);

// Initial queue drain on startup
void processQueue();
