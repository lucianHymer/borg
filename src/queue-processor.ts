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
const activeThreads = new Set<number>();
let scanning = false;
let activeHeartbeatCount = 0;
let activeScheduledTaskCount = 0;

// Background task monitors that run independently after end_turn
const activeBackgroundMonitors = new Map<number, Promise<void>>();

// Messages injected mid-turn into running sessions (threadId → queued messageIds)
const injectedMessageIds = new Map<number, string[]>();

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

// ─── Status File Helpers ───

function writeStatus(messageId: string, label: string, startTs: number, preview?: string, fullText?: string, sessionId?: string): void {
    try {
        const statusFile = path.join(QUEUE_STATUS, `${messageId}.json`);
        const tmpFile = statusFile + ".tmp";
        const data: Record<string, unknown> = { label, ts: Date.now(), startTs };
        if (preview) data.preview = preview;
        if (fullText) data.fullText = fullText;
        if (sessionId) data.sessionId = sessionId;
        fs.writeFileSync(tmpFile, JSON.stringify(data));
        fs.renameSync(tmpFile, statusFile);
    } catch {
        // Status updates are best-effort — never crash the process
    }
}

function clearStatus(messageId: string): void {
    try {
        const statusFile = path.join(QUEUE_STATUS, `${messageId}.json`);
        if (fs.existsSync(statusFile)) {
            fs.unlinkSync(statusFile);
        }
    } catch {
        // Best-effort cleanup
    }
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
}

// Stall detection: if no active background tasks and end_turn seen, wait this long
// before giving up. With active background tasks, we wait indefinitely.
const END_TURN_STALL_TIMEOUT_MS = 90_000; // 90 seconds
const POST_END_TURN_POLL_MS = 5_000; // 5 seconds per event poll

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
        let iterResult: IteratorResult<SDKMessage, void>;

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
            iterResult = await iterator.next();
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
    if (state.sawResult && !stallDetected) {
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

// ─── Process a Single Message ───

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

// ─── Process Message ───

// ─── Slurp: scan queue for next message on a given thread ───

function slurpNextMessage(threadId: number): { file: string; msg: IncomingMessage } | null {
    if (!fs.existsSync(QUEUE_INCOMING)) return null;

    const files = fs.readdirSync(QUEUE_INCOMING)
        .filter(f => f.endsWith(".json"))
        .map(f => ({ name: f, path: path.join(QUEUE_INCOMING, f) }));

    // Find messages for this thread, apply coalescing
    let primary: { name: string; path: string; msg: IncomingMessage } | null = null;
    const coalesced: { name: string; path: string }[] = [];

    for (const file of files) {
        try {
            const raw: unknown = JSON.parse(fs.readFileSync(file.path, "utf8"));
            // Skip if retry backoff not ready
            if (raw && typeof raw === "object" && "retryAfter" in raw) {
                const retryAfter = (raw as any).retryAfter;
                if (typeof retryAfter === "number" && Date.now() < retryAfter) continue;
            }
            const parsed = IncomingMessageSchema.safeParse(raw);
            if (!parsed.success) continue;
            const msg = parsed.data;
            if (msg.threadId !== threadId) continue;
            // Skip commands, heartbeats, scheduled tasks — only slurp user messages
            if (msg.message.startsWith("/")) continue;
            if (msg.source === "heartbeat" || msg.source === "scheduled-task" || msg.source === "one-shot") continue;

            if (!primary) {
                primary = { ...file, msg };
            } else {
                // Coalesce additional messages
                primary.msg.message += "\n\n" + msg.message;
                coalesced.push(file);
            }
        } catch { continue; }
    }

    if (!primary) return null;

    // Rewrite primary file with coalesced text if needed
    if (coalesced.length > 0) {
        try {
            const tmpFile = primary.path + ".tmp";
            fs.writeFileSync(tmpFile, JSON.stringify(primary.msg, null, 2));
            fs.renameSync(tmpFile, primary.path);
        } catch { /* proceed with original */ }
        for (const cf of coalesced) {
            try { fs.unlinkSync(cf.path); } catch {}
        }
        log("INFO", `Slurp: coalesced ${coalesced.length + 1} messages for thread ${threadId}`);
    }

    return { file: primary.path, msg: primary.msg };
}

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
            clearStatus(messageId);
        // ─── Scheduled Task: one-shot, no persistent session ───
        } else if (source === "scheduled-task") {
            const taskId = msg.messageId.match(/^sched_([^_]+)_/)?.[1];
            const task = taskId ? loadTasks().find(t => t.id === taskId) : undefined;
            if (!task) {
                log("WARN", `Scheduled task not found for messageId ${msg.messageId}`);
                clearStatus(messageId);
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

            clearStatus(messageId);
        // ─── Heartbeat: one-shot, skip router and session ───
        } else if (source === "heartbeat") {
            // Defense-in-depth: skip heartbeat for team threads
            const teamCheckThreads = loadThreads();
            const teamCheckConfig = teamCheckThreads[String(threadId)];
            if (teamCheckConfig?.team) {
                log("INFO", `Skipping heartbeat for team thread ${threadId} (team: ${teamCheckConfig.team})`);
                clearStatus(messageId);
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
                clearStatus(messageId);
                if (fs.existsSync(processingFile)) {
                    fs.unlinkSync(processingFile);
                }
                return;
            }
        } else {
            // ─── Load thread config ───
            const threads = loadThreads();
            const key = String(threadId);
            let threadConfig = threads[key];

            if (!threadConfig) {
                const defaultCwd =
                    process.env.DEFAULT_CWD || process.cwd();
                threadConfig = {
                    name: msg.topicName ?? `Thread ${threadId}`,
                    cwd: defaultCwd,
                    model: "sonnet",
                    isMaster: false,
                    lastActive: Date.now(),
                };
                threads[key] = threadConfig;
                saveThreads(threads);
            } else if (msg.topicName && threadConfig.name === `Thread ${threadId}`) {
                // Backfill topic name for threads created before name tracking
                threadConfig.name = msg.topicName;
                saveThreads(threads);
            }

            // Update lastActive
            threads[key].lastActive = Date.now();

            // ─── Sticky model: use thread's configured model (set via /model command) ───
            // Budget mode overrides thread model; otherwise use thread config or default
            if (isBudgetMode()) {
                effectiveModel = BUDGET_MODEL;
            } else {
                effectiveModel = threadConfig.model || DEFAULT_THREAD_MODEL;
            }

            log("INFO", `Thread ${threadId}: model=${effectiveModel}`);

            // ─── Build the full prompt ───
            const now = formatCurrentTime();
            const prefix = buildSourcePrefix(msg);
            const isNewSession = !threadConfig.sessionId;
            const threadPrompt = buildThreadPrompt(threadConfig, { threadId, model: effectiveModel });
            const historyContext = isNewSession
                ? buildHistoryContext(threadId, threadConfig.isMaster)
                : "";
            let fullPrompt: string;
            if (isNewSession) {
                const contextBlock = historyContext
                    ? `\n\n${historyContext}\n\n`
                    : "\n\n";
                fullPrompt = `[${now}]${contextBlock}${prefix} ${msg.message}`;
            } else {
                fullPrompt = `[${now}] ${prefix} ${msg.message}`;
            }

            // ─── Log assembled prompt ───
            logPrompt({
                threadId,
                messageId,
                model: effectiveModel,
                systemPromptAppend: threadPrompt,
                userMessage: `${prefix} ${msg.message}`,
                historyInjected: isNewSession,
                historyLines: isNewSession ? historyContext.split("\n").length - 1 : 0,
                promptLength: fullPrompt.length,
            });

            // ─── Send query (persistent session or new) ───
            const stderrLines: string[] = [];
            const options = await buildQueryOptions(threadId, threadConfig, effectiveModel, stderrLines, msg.message);

            // Create pending usage file for budget mode or thread-level Fireworks model correlation
            if (isBudgetMode() || effectiveModel.includes("fireworks")) {
                budgetUsageId = crypto.randomUUID();
                const pendingFile = path.join(BORG_DIR, `minimax-usage-${budgetUsageId}.pending`);
                fs.writeFileSync(pendingFile, "");
                // Embed UUID in base URL path — proxy extracts it from the request URL
                process.env.ANTHROPIC_BASE_URL = `${BUDGET_PROXY_URL}/${budgetUsageId}`;
            }

            // Try to reuse an existing persistent session, or create a new one.
            // The session pool uses AsyncIterable prompt mode — the generator
            // stays open between turns, keeping the SDK subprocess alive.
            let q: Query;
            let pushReusedMessage: (() => void) | null = null;
            const claimed = sessionPool.tryClaimSession(threadId, effectiveModel, threadConfig.cwd);
            if (claimed) {
                q = claimed.query;
                // DON'T push the message yet — the consumer (collectPrimaryResponse)
                // must be set up first, otherwise the SDK processes the message and
                // emits events before anyone is consuming them.
                pushReusedMessage = () => claimed.pushMessage(fullPrompt);
            } else {
                q = sessionPool.createSession(threadId, fullPrompt, options, effectiveModel, threadConfig.cwd);
            }

            // Write initial status; the telegram-client computes elapsed time from startTs
            const statusStartTime = Date.now();
            let currentStatusLabel = "Thinking";
            writeStatus(messageId, currentStatusLabel, statusStartTime);

            // Refresh the status file every 2 seconds to keep ts fresh (for staleness detection)
            // and to pick up label changes and preview text from the observer callbacks.
            // Also checks for cancel signal files written by telegram-client.
            let currentPreview: string | undefined;
            let fullAccumulatedText = "";
            let cancelled = false;
            const cancelFile = path.join(QUEUE_CANCEL, `${messageId}.json`);

            // Cancel-aware: race collectPrimaryResponse against a cancel timeout
            // so we're guaranteed to resolve even if the SDK hangs after interrupt()
            let cancelTimeoutResolve: (() => void) | undefined;
            const cancelTimeoutPromise = new Promise<"cancel-timeout">((resolve) => {
                cancelTimeoutResolve = () => resolve("cancel-timeout");
            });

            const statusInterval = setInterval(async () => {
                // Check for cancel signal
                if (!cancelled && fs.existsSync(cancelFile)) {
                    cancelled = true;
                    currentStatusLabel = "Cancelled";
                    writeStatus(messageId, currentStatusLabel, statusStartTime, currentPreview, fullAccumulatedText);
                    try { fs.unlinkSync(cancelFile); } catch { /* best effort */ }
                    // Race interrupt() against a 10s timeout — if the SDK subprocess
                    // hangs (e.g. waiting on a background task), we can't block this
                    // callback forever or the cancel timeout never gets scheduled and
                    // the processing slot is permanently stuck.
                    const interruptTimeout = new Promise<void>((r) => setTimeout(r, 10_000));
                    Promise.race([q.interrupt(), interruptTimeout]).catch(() => { /* process may be gone */ });
                    log("INFO", `Cancelled processing for ${messageId}`);
                    // Safety net: if collectPrimaryResponse doesn't return within 30s
                    // after interrupt, resolve the cancel timeout to unblock the race
                    setTimeout(() => {
                        cancelTimeoutResolve?.();
                    }, 30_000);
                    return;
                }
                // Check for settings file changes (e.g., /budget_on from telegram-client)
                invalidateSettingsCacheIfChanged();
                writeStatus(messageId, currentStatusLabel, statusStartTime, currentPreview, fullAccumulatedText, currentSessionId);
            }, 2000);

            // Observer callbacks set intent; the interval handles all file writes
            let toolUseCount = 0;
            let currentSessionId: string | undefined;
            const observer: QueryEventObserver = {
                onSessionId(sessionId: string) {
                    currentSessionId = sessionId;
                    persistSessionId(threadId, sessionId);
                },
                onToolUse(toolName: string) {
                    toolUseCount++;
                    currentStatusLabel = `Using ${toolName} [${toolUseCount}]`;
                },
                onToolProgress(toolName: string) {
                    currentStatusLabel = `Using ${toolName} [${toolUseCount}]`;
                },
                onCompacting() {
                    currentStatusLabel = "Compacting context";
                },
                onStallDetected() {
                    currentStatusLabel = "Stall recovered";
                },
                onTextContent(text: string) {
                    // Full text for cancel responses; truncated preview for status display
                    fullAccumulatedText += (fullAccumulatedText ? "\n\n" : "") + text;
                    currentPreview = fullAccumulatedText.length > 500
                        ? "…" + fullAccumulatedText.slice(-500)
                        : fullAccumulatedText;
                },
                onTaskStarted(taskId: string, description: string) {
                    currentStatusLabel = `Background: ${description}`;
                    log("INFO", `Background task started: ${taskId} — ${description}`);
                },
                onTaskProgress(taskId: string, summary: string | undefined) {
                    if (summary) {
                        currentStatusLabel = `Background: ${summary.substring(0, 60)}`;
                    }
                },
                onTaskCompleted(taskId: string, status: string, summary: string) {
                    log("INFO", `Background task ${taskId} ${status}: ${summary}`);
                },
            };

            try {
                // Start consumer FIRST — it calls iterator.next() and blocks waiting for events.
                const queryPromise = collectPrimaryResponse(q, observer);

                // NOW push the message for reused sessions. The consumer is already
                // waiting on iterator.next(), so when the generator yields the message
                // and the SDK processes it, events flow directly to the consumer.
                if (pushReusedMessage) {
                    pushReusedMessage();
                    pushReusedMessage = null;
                }

                const result = await Promise.race([
                    queryPromise.then((r) => ({ kind: "response" as const, ...r })),
                    cancelTimeoutPromise.then(() => ({ kind: "cancel-timeout" as const })),
                ]);

                clearInterval(statusInterval);

                if (result.kind === "cancel-timeout") {
                    log("WARN", `Cancel timeout: collectPrimaryResponse did not return within 30s after interrupt for ${messageId}`);
                    responseText = fullAccumulatedText
                        ? `${fullAccumulatedText}\n\n---\n🚫 Processing was cancelled.`
                        : "🚫 Processing was cancelled.";
                    clearStatus(messageId);
                    // Interrupt kills the subprocess — session is no longer reusable
                    sessionPool.close(threadId);
                } else if (cancelled) {
                    // Cancelled but collectPrimaryResponse returned normally
                    responseText = fullAccumulatedText
                        ? `${fullAccumulatedText}\n\n---\n🚫 Processing was cancelled.`
                        : "🚫 Processing was cancelled.";
                    clearStatus(messageId);
                    // Interrupt kills the subprocess — session is no longer reusable
                    sessionPool.close(threadId);
                    usageData = result.usage;
                    if (result.sessionId) {
                        resolvedSessionId = result.sessionId;
                        updateThread(threadId, {
                            sessionId: result.sessionId,
                            lastActive: Date.now(),
                        });
                    }
                } else {
                    usageData = result.usage;
                    responseText = result.text.trim();

                    if (result.stallRecovered) {
                        responseText += `\n\n---\n⚠️ _Stall recovered: session hung after end\\_turn (${END_TURN_STALL_TIMEOUT_MS / 1000}s timeout). Response above may be incomplete._`;
                        // Stall recovery calls interrupt() which kills the subprocess
                        sessionPool.close(threadId);
                    }

                    // Persist session ID for future resume (atomic to avoid clobbering team/role)
                    if (result.sessionId) {
                        resolvedSessionId = result.sessionId;
                        updateThread(threadId, {
                            sessionId: result.sessionId,
                            lastActive: Date.now(),
                        });
                        const cwd = loadThreads()[String(threadId)]?.cwd;
                        if (cwd) syncSessionLog(result.sessionId, cwd);
                    }

                    // Fire off background task monitoring if there are active tasks
                    if (result.hasBackgroundTasks) {
                        sessionPool.markMonitoring(threadId);
                        const monitor = monitorBackgroundTasks(
                            result.query,
                            result.activeTasks,
                            threadId,
                            messageId,
                        );
                        activeBackgroundMonitors.set(threadId, monitor);
                        monitor.finally(() => {
                            activeBackgroundMonitors.delete(threadId);
                            // Session returns to idle after background tasks complete
                            sessionPool.markIdle(threadId, result.sessionId);
                        });
                        log("INFO", `Started background task monitor for thread ${threadId} (${result.activeTasks.size} task(s))`);
                    } else {
                        // No background tasks — session is ready for next message
                        sessionPool.markIdle(threadId, result.sessionId);
                    }
                }
            } catch (queryErr) {
                clearInterval(statusInterval);

                if (cancelled) {
                    // Cancelled — include partial response so user can see what was generated
                    responseText = fullAccumulatedText
                        ? `${fullAccumulatedText}\n\n---\n🚫 Processing was cancelled.`
                        : "🚫 Processing was cancelled.";
                    clearStatus(messageId);
                } else {
                    const stderrOutput = stderrLines.join("").trim();
                    log(
                        "ERROR",
                        `Query error for thread ${threadId}: ${toErrorMessage(queryErr)}` +
                            (stderrOutput ? `\n  stderr: ${stderrOutput.slice(0, 2000)}` : ""),
                    );

                    // Close the persistent session on error
                    sessionPool.close(threadId);

                    // Clear stale sessionId on error so retries start a fresh session (atomic)
                    deleteThreadField(threadId, "sessionId");

                    throw queryErr;
                }
            } finally {
                // Clean up pending usage file regardless of success or error
                // This prevents orphaned .pending files when queries fail
                if (budgetUsageId) {
                    const pendingFile = path.join(BORG_DIR, `minimax-usage-${budgetUsageId}.pending`);
                    try {
                        if (fs.existsSync(pendingFile)) {
                            fs.unlinkSync(pendingFile);
                            log("DEBUG", `Cleaned up pending file: ${pendingFile}`);
                        }
                    } catch {
                        // Best effort cleanup — don't throw, query may already be failing
                    }
                    // Clean up correlation env var to prevent stale correlation on next query
                }
            }
        }

        // Fallback for empty responses
        if (!responseText) {
            responseText = "(No response generated)";
        }

        // Read budget mode usage from correlation file if applicable
        if (budgetUsageId) {
            const budgetUsage = readBudgetUsage(budgetUsageId);
            if (budgetUsage) {
                usageData = budgetUsage;
            }
        }

        // ─── Log outgoing message to history ───
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
            ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
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

        // ─── Write response to outgoing queue ───
        const responseData: OutgoingMessage = {
            channel,
            threadId,
            sender,
            message: responseText,
            originalMessage: msg.message,
            timestamp: Date.now(),
            messageId,
            model: effectiveModel,
            ...(msg.telegramMessageId && msg.voiceDuration ? {
                replyToMessageId: msg.telegramMessageId,
                replyToVoice: true,
            } : {}),
            ...(scheduledTaskName ? { scheduledTaskName } : {}),
        };

        const responseFile =
            channel === "heartbeat"
                ? path.join(QUEUE_OUTGOING, `${messageId}.json`)
                : path.join(
                        QUEUE_OUTGOING,
                        `${channel}_${messageId}_${Date.now()}.json`,
                    );

        const tmpFile = responseFile + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(responseData, null, 2));
        fs.renameSync(tmpFile, responseFile);

        clearStatus(messageId);

        log(
            "INFO",
            `Response ready [${channel}] thread=${threadId} model=${effectiveModel} (${responseText.length} chars)`,
        );

        // Clean up processing file
        if (fs.existsSync(processingFile)) {
            fs.unlinkSync(processingFile);
        }

        // ─── Slurp: check for queued messages that arrived while we were processing ───
        // If the session is idle and there are more messages for this thread,
        // consume them immediately instead of releasing the thread slot.
        // Messages stay in the file queue until we're ready, preserving
        // edit/delete and coalescing behavior.
        if (source !== "heartbeat" && source !== "scheduled-task" && source !== "one-shot") {
            while (sessionPool.getState(threadId) === "idle") {
                const nextMsg = slurpNextMessage(threadId);
                if (!nextMsg) break;

                const { file: nextFile, msg: nextMsgData } = nextMsg;
                const nextFilename = path.basename(nextFile);
                const nextProcessingFile = path.join(QUEUE_PROCESSING, nextFilename);

                try {
                    fs.renameSync(nextFile, nextProcessingFile);
                } catch {
                    break; // File may have been picked up by someone else
                }

                log("INFO", `Slurp: consuming queued message for thread ${threadId} from ${nextMsgData.sender}`);

                // Build prompt for the slurped message
                const slurpNow = formatCurrentTime();
                const slurpPrefix = buildSourcePrefix(nextMsgData);
                const slurpPrompt = `[${slurpNow}] ${slurpPrefix} ${nextMsgData.message}`;
                const slurpMessageId = nextMsgData.messageId;

                // Log incoming
                appendHistory({
                    ts: Date.now(),
                    threadId,
                    channel: nextMsgData.channel,
                    sender: nextMsgData.sender,
                    direction: "in",
                    message: nextMsgData.message,
                    source: nextMsgData.source ?? "user",
                    sourceThreadId: nextMsgData.sourceThreadId,
                    messageId: slurpMessageId,
                });

                // Push into session and collect response
                const slurpThreads = loadThreads();
                const slurpCwd = slurpThreads[String(threadId)]?.cwd ?? process.cwd();
                const claimed = sessionPool.tryClaimSession(threadId, effectiveModel, slurpCwd);
                if (!claimed) break; // Session gone (model changed, etc.)

                const slurpStartTime = Date.now();
                let slurpStatusLabel = "Thinking";
                let slurpPreview: string | undefined;
                let slurpFullText = "";
                let slurpSessionId: string | undefined;
                let slurpToolCount = 0;
                writeStatus(slurpMessageId, slurpStatusLabel, slurpStartTime);

                // Periodic status refresh so telegram-client's pollStatusFiles (2s)
                // can pick up the status message — without this, fast responses
                // could complete before the first poll tick ever sees the file.
                const slurpStatusInterval = setInterval(() => {
                    writeStatus(slurpMessageId, slurpStatusLabel, slurpStartTime, slurpPreview, slurpFullText, slurpSessionId);
                }, 2000);

                const slurpObserver: QueryEventObserver = {
                    onSessionId(sid: string) {
                        slurpSessionId = sid;
                        persistSessionId(threadId, sid);
                    },
                    onToolUse(toolName: string) {
                        slurpToolCount++;
                        slurpStatusLabel = `Using ${toolName} [${slurpToolCount}]`;
                    },
                    onTextContent(text: string) {
                        slurpFullText += (slurpFullText ? "\n\n" : "") + text;
                        slurpPreview = slurpFullText.length > 500
                            ? "…" + slurpFullText.slice(-500)
                            : slurpFullText;
                    },
                };

                const slurpPromise = collectPrimaryResponse(claimed.query, slurpObserver);
                claimed.pushMessage(slurpPrompt);

                try {
                    const slurpResult = await slurpPromise;
                    clearInterval(slurpStatusInterval);
                    const slurpText = slurpResult.text.trim() || "(No response generated)";

                    if (slurpResult.sessionId) {
                        updateThread(threadId, { sessionId: slurpResult.sessionId, lastActive: Date.now() });
                    }

                    // Handle background tasks from slurped message
                    if (slurpResult.hasBackgroundTasks) {
                        sessionPool.markMonitoring(threadId);
                        const monitor = monitorBackgroundTasks(
                            slurpResult.query, slurpResult.activeTasks, threadId, slurpMessageId,
                        );
                        activeBackgroundMonitors.set(threadId, monitor);
                        monitor.finally(() => {
                            activeBackgroundMonitors.delete(threadId);
                            sessionPool.markIdle(threadId, slurpResult.sessionId);
                        });
                    } else {
                        sessionPool.markIdle(threadId, slurpResult.sessionId);
                    }

                    // Log and write outgoing
                    appendHistory({
                        ts: Date.now(), threadId, channel: nextMsgData.channel,
                        sender: "assistant", direction: "out", message: slurpText,
                        model: effectiveModel, source: nextMsgData.source ?? "user",
                        messageId: slurpMessageId,
                        ...(slurpResult.usage ? {
                            costUSD: slurpResult.usage.totalCostUSD,
                            inputTokens: slurpResult.usage.inputTokens,
                            outputTokens: slurpResult.usage.outputTokens,
                            cacheReadInputTokens: slurpResult.usage.cacheReadInputTokens,
                            cacheCreationInputTokens: slurpResult.usage.cacheCreationInputTokens,
                            durationMs: slurpResult.usage.durationMs,
                            durationApiMs: slurpResult.usage.durationApiMs,
                            numTurns: slurpResult.usage.numTurns,
                            modelUsage: slurpResult.usage.modelUsage,
                        } : {}),
                    });

                    const slurpOutgoing: OutgoingMessage = {
                        channel: nextMsgData.channel, threadId, sender: nextMsgData.sender,
                        message: slurpText, originalMessage: nextMsgData.message,
                        timestamp: Date.now(), messageId: slurpMessageId, model: effectiveModel,
                    };
                    const slurpOutFile = path.join(QUEUE_OUTGOING, `${nextMsgData.channel}_${slurpMessageId}_${Date.now()}.json`);
                    const slurpTmp = slurpOutFile + ".tmp";
                    fs.writeFileSync(slurpTmp, JSON.stringify(slurpOutgoing, null, 2));
                    fs.renameSync(slurpTmp, slurpOutFile);

                    clearStatus(slurpMessageId);
                    log("INFO", `Slurp response ready thread=${threadId} model=${effectiveModel} (${slurpText.length} chars)`);
                } catch (slurpErr) {
                    clearInterval(slurpStatusInterval);
                    log("WARN", `Slurp error for thread ${threadId}: ${toErrorMessage(slurpErr)}`);
                    clearStatus(slurpMessageId);
                    // Put the message back for normal processing
                    try { fs.renameSync(nextProcessingFile, nextFile); } catch {}
                    sessionPool.close(threadId);
                    break;
                } finally {
                    if (fs.existsSync(nextProcessingFile)) {
                        try { fs.unlinkSync(nextProcessingFile); } catch {}
                    }
                }
            }

            // ─── Consume responses from messages injected mid-turn ───
            // These were pushed into the channel by processQueue while we were
            // processing. The SDK queued them and their responses are in the iterator.
            const pendingInjectedIds = injectedMessageIds.get(threadId) ?? [];
            if (pendingInjectedIds.length > 0 && sessionPool.getState(threadId) === "idle") {
                injectedMessageIds.delete(threadId);
                log("INFO", `Consuming ${pendingInjectedIds.length} injected message response(s) for thread ${threadId}`);

                for (let i = 0; i < pendingInjectedIds.length; i++) {
                    const injMessageId = pendingInjectedIds[i];
                    const claimed = sessionPool.tryClaimSession(threadId, effectiveModel,
                        loadThreads()[String(threadId)]?.cwd ?? process.cwd());
                    if (!claimed) break;

                    const injStartTime = Date.now();
                    let injStatusLabel = "Thinking";
                    let injToolCount = 0;
                    writeStatus(injMessageId, injStatusLabel, injStartTime);

                    const injStatusInterval = setInterval(() => {
                        writeStatus(injMessageId, injStatusLabel, injStartTime);
                    }, 2000);

                    const injObserver: QueryEventObserver = {
                        onToolUse(toolName: string) {
                            injToolCount++;
                            injStatusLabel = `Using ${toolName} [${injToolCount}]`;
                        },
                        onTextContent() {},
                    };

                    const injPromise = collectPrimaryResponse(claimed.query, injObserver);
                    // Don't push — message was already injected into the channel
                    try {
                        const injResult = await injPromise;
                        clearInterval(injStatusInterval);
                        const injText = injResult.text.trim() || "(No response generated)";

                        if (injResult.sessionId) {
                            updateThread(threadId, { sessionId: injResult.sessionId, lastActive: Date.now() });
                        }

                        if (injResult.hasBackgroundTasks) {
                            sessionPool.markMonitoring(threadId);
                            const monitor = monitorBackgroundTasks(
                                injResult.query, injResult.activeTasks, threadId, injMessageId,
                            );
                            activeBackgroundMonitors.set(threadId, monitor);
                            monitor.finally(() => {
                                activeBackgroundMonitors.delete(threadId);
                                sessionPool.markIdle(threadId, injResult.sessionId);
                            });
                        } else {
                            sessionPool.markIdle(threadId, injResult.sessionId);
                        }

                        // Write response to outgoing — use original messageId so
                        // telegram-client can match it to the pendingMessages entry
                        appendHistory({
                            ts: Date.now(), threadId, channel,
                            sender: "assistant", direction: "out", message: injText,
                            model: effectiveModel, source: source ?? "user",
                            messageId: injMessageId,
                            ...(injResult.usage ? {
                                costUSD: injResult.usage.totalCostUSD,
                                inputTokens: injResult.usage.inputTokens,
                                outputTokens: injResult.usage.outputTokens,
                                cacheReadInputTokens: injResult.usage.cacheReadInputTokens,
                                cacheCreationInputTokens: injResult.usage.cacheCreationInputTokens,
                                durationMs: injResult.usage.durationMs,
                                durationApiMs: injResult.usage.durationApiMs,
                                numTurns: injResult.usage.numTurns,
                                modelUsage: injResult.usage.modelUsage,
                            } : {}),
                        });

                        const injOutgoing: OutgoingMessage = {
                            channel, threadId, sender,
                            message: injText, originalMessage: "(injected mid-turn)",
                            timestamp: Date.now(),
                            messageId: injMessageId,
                            model: effectiveModel,
                        };
                        const injFile = path.join(QUEUE_OUTGOING, `${channel}_${injMessageId}_${Date.now()}.json`);
                        const injTmp = injFile + ".tmp";
                        fs.writeFileSync(injTmp, JSON.stringify(injOutgoing, null, 2));
                        fs.renameSync(injTmp, injFile);

                        clearStatus(injMessageId);
                        log("INFO", `Injected response ready thread=${threadId} (${injText.length} chars)`);
                    } catch (injErr) {
                        clearInterval(injStatusInterval);
                        clearStatus(injMessageId);
                        log("WARN", `Injected response error for thread ${threadId}: ${toErrorMessage(injErr)}`);
                        sessionPool.close(threadId);
                        break;
                    }
                }
            }
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

        clearStatus(messageId);
        handleRetry(processingFile, filename, retryCount);
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
                if (!parsed.success) continue; // Skip malformed messages — processMessage will handle them
                msg = parsed.data;
            } catch {
                continue; // File may have been picked up by a concurrent scan
            }

            // If thread is busy, inject the message into the running session.
            // The SDK queues it and processes it after the current turn completes.
            // The slurp loop in processMessage consumes the response.
            if (activeThreads.has(msg.threadId)) {
                if (!msg.message.startsWith("/") &&
                    msg.source !== "heartbeat" &&
                    msg.source !== "scheduled-task" &&
                    msg.source !== "one-shot") {
                    const now = formatCurrentTime();
                    const prefix = buildSourcePrefix(msg);
                    const injectPrompt = `[${now}] ${prefix} ${msg.message}`;
                    if (sessionPool.injectMessage(msg.threadId, injectPrompt)) {
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
                        // Track messageId so the consume loop can write proper status files
                        const ids = injectedMessageIds.get(msg.threadId) ?? [];
                        ids.push(msg.messageId);
                        injectedMessageIds.set(msg.threadId, ids);
                        // Delete queue file — message is in the channel now
                        try { fs.unlinkSync(file.path); } catch {}
                        log("INFO", `Injected message into running session for thread ${msg.threadId} from ${msg.sender}: ${msg.message.substring(0, 60)}`);
                    }
                }
                continue;
            }

            // Only 1 heartbeat can process concurrently — reserve other slots for user messages
            if (msg.source === 'heartbeat' && activeHeartbeatCount >= 1) continue;
            // Only 1 scheduled task at a time
            if (msg.source === 'scheduled-task' && activeScheduledTaskCount >= 1) continue;

            // Coalesce: grab other queued messages for the same thread
            // Skip command messages (starting with /), non-user sources, and voice messages
            const coalesced: QueueFile[] = [];
            const hasImage = !!(msg.imagePath || msg.imagePaths?.length);
            if (!msg.message.startsWith("/") && !msg.audioPath) {
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
                        const otherHasImage = !!(otherMsg.imagePath || otherMsg.imagePaths?.length);
                        // Don't mix image and non-image messages in coalescing
                        if (hasImage !== otherHasImage) continue;
                        coalesced.push(other);
                        if (otherHasImage) {
                            // Merge image paths into imagePaths array
                            if (!msg.imagePaths) msg.imagePaths = msg.imagePath ? [msg.imagePath] : [];
                            if (otherMsg.imagePaths?.length) {
                                msg.imagePaths.push(...otherMsg.imagePaths);
                            } else if (otherMsg.imagePath) {
                                msg.imagePaths.push(otherMsg.imagePath);
                            }
                            // Merge captions
                            if (otherMsg.message) {
                                msg.message = msg.message ? msg.message + "\n\n" + otherMsg.message : otherMsg.message;
                            }
                        } else {
                            // Append text to primary message
                            msg.message = msg.message + "\n\n" + otherMsg.message;
                        }
                    } catch { continue; }
                }

                if (coalesced.length > 0) {
                    // Rewrite primary queue file with coalesced text
                    try {
                        const tmpFile = file.path + ".tmp";
                        fs.writeFileSync(tmpFile, JSON.stringify(msg, null, 2));
                        fs.renameSync(tmpFile, file.path);
                    } catch { /* proceed with original if rewrite fails */ }

                    // Delete coalesced files
                    for (const cf of coalesced) {
                        try { fs.unlinkSync(cf.path); } catch { /* best effort */ }
                    }

                    log("INFO", `Coalesced ${coalesced.length + 1} messages for thread ${msg.threadId}`);
                }
            }

            // Claim the slot
            activeCount++;
            activeThreads.add(msg.threadId);
            if (msg.source === 'heartbeat') activeHeartbeatCount++;
            if (msg.source === 'scheduled-task') activeScheduledTaskCount++;

            log(
                "INFO",
                `Dispatching thread=${msg.threadId} (active: ${activeCount}/${maxConcurrent})`,
            );

            // Fire off processing — don't await, allow parallel execution
            processMessage(file.path).finally(() => {
                activeCount--;
                activeThreads.delete(msg.threadId);
                if (msg.source === 'heartbeat') activeHeartbeatCount--;
                if (msg.source === 'scheduled-task') activeScheduledTaskCount--;
                // Re-scan queue for more work
                void processQueue();
            });
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
        `Received ${signal}. Shutting down... (${activeCount} active session(s), ${activeBackgroundMonitors.size} background monitor(s), ${sessionPool.size} pooled session(s))`,
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
