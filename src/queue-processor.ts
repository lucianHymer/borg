#!/usr/bin/env node
/**
 * Queue Processor - Agent SDK v1 query() API
 *
 * Processes messages from all channels (Telegram, CLI, heartbeat, cross-thread, etc.)
 * one at a time via a file-based queue. Each thread gets its own persistent session
 * via the resume mechanism. Smart routing selects the cheapest model per message.
 */

import fs from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
    SDKAssistantMessage,
    SDKResultMessage,
    SDKToolProgressMessage,
    SDKMessage,
    Options,
    Query,
    CanUseTool as SDKCanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import { toErrorMessage, isValidSessionId, TASK_LISTS_FILENAME } from "./types.js";
import type { IncomingMessage, OutgoingMessage, TaskListMapping } from "./types.js";
import {
    appendHistory,
    buildHistoryContext,
} from "./message-history.js";
import { createBorgMcpServer } from "./mcp-tools.js";
import { loadZoneConfig, getThreadsInZone } from "./zone-config.js";
import { transcribe, cleanupAudioFile, ensureModels, AUDIO_INCOMING_DIR } from "./audio.js";
import { IMAGES_INCOMING_DIR } from "./images.js";
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
import { loadTasks, getDueTasks, markTaskComplete } from "./scheduled-tasks.js";
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

function writeStatus(messageId: string, label: string, startTs: number, preview?: string): void {
    try {
        const statusFile = path.join(QUEUE_STATUS, `${messageId}.json`);
        const tmpFile = statusFile + ".tmp";
        const data: Record<string, unknown> = { label, ts: Date.now(), startTs };
        if (preview) data.preview = preview;
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

    // Resume existing session if available
    if (threadConfig.sessionId) {
        opts.resume = threadConfig.sessionId;
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
    onToolUse?(toolName: string): void;
    onToolProgress?(toolName: string, elapsedSeconds: number): void;
    onCompacting?(): void;
    onStallDetected?(): void;
    onTextContent?(text: string): void;
}

// If we see end_turn with content and no active subagents, and total elapsed time
// since end_turn exceeds this window, assume the CLI process is hung and return.
// Uses absolute time (not per-event) to handle background tasks that emit
// tool_progress events indefinitely after end_turn.
const END_TURN_STALL_TIMEOUT_MS = 90_000; // 90 seconds
// Short poll interval: once end_turn is seen, don't wait forever for each event
const POST_END_TURN_POLL_MS = 5_000; // 5 seconds per event poll

async function collectQueryResponse(
    q: Query,
    observer?: QueryEventObserver,
): Promise<{ text: string; sessionId: string | undefined; stallRecovered: boolean; usage?: QueryUsageData }> {
    const parts: string[] = [];
    let capturedSessionId: string | undefined;
    let usageData: QueryUsageData | undefined;

    // ─── Stall detection state ───
    let sawEndTurn = false;
    let endTurnSeenAt = 0; // absolute timestamp when end_turn was first seen
    let stallDetected = false;

    const iterator = q[Symbol.asyncIterator]();

    while (true) {
        let iterResult: IteratorResult<SDKMessage, void>;

        if (sawEndTurn && parts.length > 0) {
            // Check absolute time since end_turn (not reset by incoming events)
            const elapsed = Date.now() - endTurnSeenAt;
            if (elapsed >= END_TURN_STALL_TIMEOUT_MS) {
                stallDetected = true;
                observer?.onStallDetected?.();
                log(
                    "WARN",
                    `end_turn stall detected after ${Math.round(elapsed / 1000)}s — returning collected response (${parts.join("").length} chars)`,
                );
                break;
            }
            // Short poll: don't wait the full remaining time per event, so we can
            // re-check the absolute deadline even if tool_progress keeps arriving
            const remaining = END_TURN_STALL_TIMEOUT_MS - elapsed;
            const pollTimeout = Math.min(POST_END_TURN_POLL_MS, remaining);
            const timeoutPromise = new Promise<"timeout">((resolve) => {
                setTimeout(() => resolve("timeout"), pollTimeout);
            });
            const winner = await Promise.race([
                iterator.next().then((r) => ({ kind: "event" as const, result: r })),
                timeoutPromise.then(() => ({ kind: "timeout" as const })),
            ]);
            if (winner.kind === "timeout") {
                // Don't break yet — loop back and check absolute deadline
                continue;
            }
            iterResult = winner.result;
        } else {
            iterResult = await iterator.next();
        }

        if (iterResult.done) break;
        const msg = iterResult.value;

        // Always capture the latest session_id (it may change after compaction)
        if ("session_id" in msg && msg.session_id) {
            capturedSessionId = msg.session_id;
        }

        if (msg.type === "assistant") {
            const assistantMsg = msg as SDKAssistantMessage;
            const content = assistantMsg.message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === "text" && typeof block.text === "string") {
                        parts.push(block.text);
                        observer?.onTextContent?.(block.text);
                    }
                    if (block.type === "tool_use" && "name" in block) {
                        observer?.onToolUse?.(block.name);
                    }
                }
            }
            // Track end_turn on top-level assistant messages (not from subagents)
            const stopReason = assistantMsg.message?.stop_reason;
            if (stopReason === "end_turn" && assistantMsg.parent_tool_use_id === null) {
                if (!sawEndTurn) {
                    endTurnSeenAt = Date.now();
                }
                sawEndTurn = true;
            } else if (stopReason === "tool_use") {
                sawEndTurn = false;
                endTurnSeenAt = 0;
            }
        }

        if (msg.type === "tool_progress") {
            const toolMsg = msg as SDKToolProgressMessage;
            observer?.onToolProgress?.(
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
            observer?.onCompacting?.();
        }

        if (msg.type === "result") {
            const result = msg as SDKResultMessage;
            if (
                result.subtype === "success" &&
                "result" in result &&
                typeof result.result === "string"
            ) {
                if (parts.length === 0) {
                    parts.push(result.result);
                }
            }

            // Capture usage data from both success and error result subtypes
            usageData = {
                totalCostUSD: result.total_cost_usd,
                inputTokens: result.usage.input_tokens,
                outputTokens: result.usage.output_tokens,
                cacheReadInputTokens: result.usage.cache_read_input_tokens ?? 0,
                cacheCreationInputTokens: result.usage.cache_creation_input_tokens ?? 0,
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
    }

    // Clean up hung process on stall
    if (stallDetected) {
        try {
            await q.interrupt();
        } catch {
            // Best effort — process may already be gone
        }
    }

    return { text: parts.join("\n\n"), sessionId: capturedSessionId, stallRecovered: stallDetected, usage: usageData };
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

    // ─── Validate audioPath is within the allowed directory ───
    if (msg.audioPath) {
        const resolved = path.resolve(msg.audioPath);
        if (!resolved.startsWith(AUDIO_INCOMING_DIR + "/") && resolved !== AUDIO_INCOMING_DIR) {
            throw new Error(`audioPath outside allowed directory: ${resolved}`);
        }
    }

    // ─── Validate imagePath(s) are within the allowed directory ───
    const allImagePaths = [
        ...(msg.imagePath ? [msg.imagePath] : []),
        ...(msg.imagePaths ?? []),
    ];
    for (const ip of allImagePaths) {
        const resolved = path.resolve(ip);
        if (!resolved.startsWith(IMAGES_INCOMING_DIR + "/") && resolved !== IMAGES_INCOMING_DIR) {
            throw new Error(`imagePath outside allowed directory: ${resolved}`);
        }
    }

    // ─── Voice Message: STT transcription ───
    function writeSttErrorAndBail(userMessage: string, originalLabel: string): void {
        const errorData: OutgoingMessage = {
            channel,
            threadId,
            sender,
            message: userMessage,
            originalMessage: originalLabel,
            timestamp: Date.now(),
            messageId,
            model: "haiku",
        };
        const errorFile = path.join(QUEUE_OUTGOING, `${channel}_${messageId}_${Date.now()}.json`);
        const tmpFile = errorFile + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(errorData, null, 2));
        fs.renameSync(tmpFile, errorFile);
        clearStatus(messageId);
        if (msg.audioPath) cleanupAudioFile(msg.audioPath);
        if (fs.existsSync(processingFile)) fs.unlinkSync(processingFile);
    }

    if (msg.audioPath && !msg.message) {
        try {
            writeStatus(messageId, "Listening", Date.now());
            await ensureModels();
            const transcript = await transcribe(msg.audioPath);
            if (!transcript) {
                writeSttErrorAndBail(
                    "Couldn't transcribe your voice message — no speech detected. Please try again or send as text.",
                    "(voice message — empty transcript)",
                );
                return;
            }
            msg.message = transcript;
            log("INFO", `STT transcript (${msg.voiceDuration}s): ${transcript.substring(0, 120)}...`);

            // Store transcript in voice cache for "Your Text"/"Your Summary" buttons
            if (msg.telegramMessageId) {
                const { storeVoiceTranscript } = await import("./voice-cache.js");
                storeVoiceTranscript(String(msg.telegramMessageId), transcript);
                log("INFO", `Stored voice transcript for message ${msg.telegramMessageId}`);
            }

            cleanupAudioFile(msg.audioPath);
            // Update the processing file so retries don't re-attempt STT on a deleted audio file
            delete msg.audioPath;
            fs.writeFileSync(processingFile, JSON.stringify(msg, null, 2));
        } catch (err) {
            log("ERROR", `STT failed for thread ${threadId}: ${toErrorMessage(err)}`);
            writeSttErrorAndBail(
                "Couldn't transcribe your voice message — the transcription service may be unavailable. Please try again or send as text.",
                "(voice message — STT error)",
            );
            return;
        }
    }

    // ─── Photo Message: Add Read tool instruction ───
    // Collect all image paths (single imagePath or multiple imagePaths from media group)
    const imagesToProcess = msg.imagePaths?.length ? msg.imagePaths : (msg.imagePath ? [msg.imagePath] : []);
    if (imagesToProcess.length > 0) {
        const instructions = imagesToProcess.map(
            (p, i) => imagesToProcess.length > 1
                ? `[Image ${i + 1} received: ${p}]\n\nPlease view this image using the Read tool.`
                : `[Image received: ${p}]\n\nPlease analyze this image using the Read tool.`
        );
        const imageInstruction = instructions.join("\n\n");
        if (msg.message) {
            msg.message = `${imageInstruction}\n\nCaption: ${msg.message}`;
        } else {
            msg.message = imageInstruction;
        }
        log("INFO", `Image message: ${imagesToProcess.length} image(s) — ${imagesToProcess.join(", ")}`);
    }

    // Log incoming message to history (after STT and image instruction so they're captured)
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

            // ─── Send query ───
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

            const q = query({ prompt: fullPrompt, options });

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

            // Cancel-aware: race collectQueryResponse against a cancel timeout
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
                    writeStatus(messageId, currentStatusLabel, statusStartTime, currentPreview);
                    try { fs.unlinkSync(cancelFile); } catch { /* best effort */ }
                    // Race interrupt() against a 10s timeout — if the SDK subprocess
                    // hangs (e.g. waiting on a background task), we can't block this
                    // callback forever or the cancel timeout never gets scheduled and
                    // the processing slot is permanently stuck.
                    const interruptTimeout = new Promise<void>((r) => setTimeout(r, 10_000));
                    Promise.race([q.interrupt(), interruptTimeout]).catch(() => { /* process may be gone */ });
                    log("INFO", `Cancelled processing for ${messageId}`);
                    // Safety net: if collectQueryResponse doesn't return within 30s
                    // after interrupt, resolve the cancel timeout to unblock the race
                    setTimeout(() => {
                        cancelTimeoutResolve?.();
                    }, 30_000);
                    return;
                }
                // Check for settings file changes (e.g., /budget_on from telegram-client)
                invalidateSettingsCacheIfChanged();
                writeStatus(messageId, currentStatusLabel, statusStartTime, currentPreview);
            }, 2000);

            // Observer callbacks set intent; the interval handles all file writes
            let toolUseCount = 0;
            const observer: QueryEventObserver = {
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
            };

            try {
                const queryPromise = collectQueryResponse(q, observer);

                const result = await Promise.race([
                    queryPromise.then((r) => ({ kind: "response" as const, ...r })),
                    cancelTimeoutPromise.then(() => ({ kind: "cancel-timeout" as const })),
                ]);

                clearInterval(statusInterval);

                if (result.kind === "cancel-timeout") {
                    log("WARN", `Cancel timeout: collectQueryResponse did not return within 30s after interrupt for ${messageId}`);
                    responseText = fullAccumulatedText
                        ? `${fullAccumulatedText}\n\n---\n🚫 Processing was cancelled.`
                        : "🚫 Processing was cancelled.";
                    clearStatus(messageId);
                } else if (cancelled) {
                    // Cancelled but collectQueryResponse returned normally
                    responseText = fullAccumulatedText
                        ? `${fullAccumulatedText}\n\n---\n🚫 Processing was cancelled.`
                        : "🚫 Processing was cancelled.";
                    clearStatus(messageId);
                    usageData = result.usage;
                    if (result.sessionId) {
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
                    }

                    // Persist session ID for future resume (atomic to avoid clobbering team/role)
                    if (result.sessionId) {
                        updateThread(threadId, {
                            sessionId: result.sessionId,
                            lastActive: Date.now(),
                        });
                        const cwd = loadThreads()[String(threadId)]?.cwd;
                        if (cwd) syncSessionLog(result.sessionId, cwd);
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
                resetThread(data.threadId);
                log("INFO", `Command: reset thread ${data.threadId}`);
            } else if (data.command === "setdir" && data.args?.cwd) {
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

            // Only one message per thread at a time (SDK sessions aren't concurrent)
            if (activeThreads.has(msg.threadId)) continue;

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
        `Received ${signal}. Shutting down... (${activeCount} active session(s))`,
    );

    clearInterval(queueInterval);
    clearInterval(sessionSyncInterval);

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

// Ensure Speaches models are installed (fire-and-forget, cached across restarts)
ensureModels().catch(() => {});

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
