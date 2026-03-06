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
    Options,
    Query,
    CanUseTool as SDKCanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import { route, DEFAULT_ROUTING_CONFIG, maxTier } from "./router/index.js";
import type { Tier, RoutingDecision } from "./router/index.js";
import { toErrorMessage, isValidSessionId, TASK_LISTS_FILENAME } from "./types.js";
import type { IncomingMessage, OutgoingMessage, TaskListMapping } from "./types.js";
import {
    appendHistory,
    buildHistoryContext,
} from "./message-history.js";
import { createBorgMcpServer } from "./mcp-tools.js";
import { transcribe, cleanupAudioFile, ensureModels, AUDIO_INCOMING_DIR } from "./audio.js";
import type { MessageSource, MessageHistoryEntry } from "./message-history.js";
import {
    loadThreads,
    saveThreads,
    loadSettings,
    resetThread,
    configureThread,
    buildThreadPrompt,
    buildHeartbeatPrompt,
    formatHumanTime,
    getTimedTasks,
} from "./session-manager.js";
import type { ThreadConfig, HeartbeatTier } from "./session-manager.js";
import { z } from "zod/v4";

// ─── Zod Schemas for Queue Messages ───

const MessageSourceSchema = z.enum(["user", "cross-thread", "heartbeat", "cli", "system"]);

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
const QUEUE_STATUS = path.join(BORG_DIR, "status");
const LOG_FILE = path.join(BORG_DIR, "logs/queue.log");
const PROMPTS_LOG = path.join(BORG_DIR, "logs/prompts.jsonl");
const PROMPTS_LOG_BACKUP = path.join(BORG_DIR, "logs/prompts.1.jsonl");
const MAX_PROMPTS_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const SESSIONS_DIR = path.join(BORG_DIR, "sessions");
const TASK_LISTS_FILE = path.join(BORG_DIR, TASK_LISTS_FILENAME);

// ─── Ensure queue directories exist ───

[
    QUEUE_INCOMING,
    QUEUE_OUTGOING,
    QUEUE_PROCESSING,
    QUEUE_DEAD_LETTER,
    QUEUE_COMMANDS,
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

const TIER_TO_MODEL: Record<Tier, string> = {
    SIMPLE: "haiku",
    MEDIUM: "sonnet",
    COMPLEX: "sonnet",
};

const MODEL_TO_TIER: Record<string, Tier> = {
    haiku: "SIMPLE",
    sonnet: "MEDIUM",
    opus: "COMPLEX",
};

function modelToTier(model: string): Tier {
    return MODEL_TO_TIER[model] ?? "MEDIUM";
}

function tierToModel(tier: Tier): string {
    return TIER_TO_MODEL[tier];
}

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
    };
    return prefixMap[msg.source ?? "user"];
}

// ─── Status File Helpers ───

function writeStatus(messageId: string, label: string, startTs: number): void {
    try {
        const statusFile = path.join(QUEUE_STATUS, `${messageId}.json`);
        const tmpFile = statusFile + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify({ label, ts: Date.now(), startTs }));
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

function buildQueryOptions(
    threadId: number,
    threadConfig: ThreadConfig,
    effectiveModel: string,
    stderrLines?: string[],
): Options {
    // Enable SDK task tracking
    const taskListId = getTaskListId(threadId, threadConfig);
    process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId;
    process.env.CLAUDE_CODE_ENABLE_TASKS = "true";

    // Update task-lists mapping so telegram-client can find which threads use which task list
    updateTaskListMapping(threadId, taskListId, threadConfig.team);

    const opts: Options = {
        model: effectiveModel,
        cwd: threadConfig.cwd,
        canUseTool: sdkCanUseTool,
        settingSources: ["project"],
        systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: buildThreadPrompt(threadConfig),
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

    // Resume existing session if available
    if (threadConfig.sessionId) {
        opts.resume = threadConfig.sessionId;
    }

    return opts;
}

// ─── Collect full response text from query stream ───

interface QueryEventObserver {
    onToolUse?(toolName: string): void;
    onToolProgress?(toolName: string, elapsedSeconds: number): void;
    onCompacting?(): void;
}

async function collectQueryResponse(
    q: Query,
    observer?: QueryEventObserver,
): Promise<{ text: string; sessionId: string | undefined }> {
    const parts: string[] = [];
    let capturedSessionId: string | undefined;

    for await (const msg of q) {
        // Always capture the latest session_id (it may change after compaction)
        if ("session_id" in msg && msg.session_id) {
            capturedSessionId = msg.session_id;
        }

        if (msg.type === "assistant") {
            const content = (msg as SDKAssistantMessage).message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === "text" && typeof block.text === "string") {
                        parts.push(block.text);
                    }
                    if (block.type === "tool_use" && "name" in block) {
                        observer?.onToolUse?.(block.name);
                    }
                }
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
        }
    }

    return { text: parts.join(""), sessionId: capturedSessionId };
}

// ─── Heartbeat Processing (one-shot, no persistent session) ───

async function processHeartbeat(msg: IncomingMessage): Promise<string> {
    const threads = loadThreads();
    const threadKey = String(msg.threadId);
    const threadConfig = threads[threadKey];
    if (!threadConfig) {
        return "[NO_UPDATES]";
    }

    const dueTier = getDueTier(threadKey);
    const state = loadHeartbeatState();
    const lastReport = state[threadKey]?.lastReport;
    let heartbeatPrompt = buildHeartbeatPrompt(threadConfig, dueTier, lastReport);

    // Inject timed tasks if any are due
    try {
        const heartbeatPath = path.join(threadConfig.cwd, "HEARTBEAT.md");
        const heartbeatContent = fs.readFileSync(heartbeatPath, "utf8");
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
        // Timed task parsing is best-effort (ENOENT when no HEARTBEAT.md)
    }

    log("INFO", `Heartbeat one-shot for thread ${msg.threadId} (tier: ${dueTier})`);

    const stderrLines: string[] = [];
    const q = query({
        prompt: heartbeatPrompt,
        options: {
            model: "haiku",
            cwd: threadConfig.cwd,
            canUseTool: sdkCanUseTool,
            settingSources: ["project"],
            systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: buildThreadPrompt(threadConfig),
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
        const { text } = await collectQueryResponse(q);
        const response = text.trim() || "[NO_UPDATES]";

        // Always update state on successful response
        updateHeartbeatState(threadKey, dueTier);

        // Save last non-suppressed report so future heartbeats know what was already reported
        if (!response.includes("[NO_UPDATES]")) {
            saveLastReport(threadKey, response);
        }

        return response;
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

// ─── Route a message to the right model ───

function routeMessage(
    msg: IncomingMessage,
): { effectiveModel: string; decision: RoutingDecision } {
    // Route on current message only — history context was inflating scores,
    // making model selection "sticky" even for simple follow-ups.
    // Reply-to stickiness (isReply + replyToModel → maxTier below) already
    // handles "continuing a complex conversation" intentionally.
    const decision = route(msg.message, undefined, {
        config: DEFAULT_ROUTING_CONFIG,
    });

    let effectiveTier: Tier;

    if (msg.isReply && msg.replyToModel) {
        const originalTier = modelToTier(msg.replyToModel);
        effectiveTier = maxTier(originalTier, decision.tier);
    } else {
        effectiveTier = decision.tier;
    }

    const effectiveModel = tierToModel(effectiveTier);

    return { effectiveModel, decision };
}

// ─── Process a Single Message ───

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

    // Log incoming message to history (after STT so voice transcripts are captured)
    appendHistory({
        ts: Date.now(),
        threadId,
        channel,
        sender,
        direction: "in",
        message: msg.message,
        source: source ?? "user",
        sourceThreadId: msg.sourceThreadId,
    });

    let responseText: string;
    let effectiveModel: string;
    let routingResult: { effectiveModel: string; decision: RoutingDecision } | undefined;

    try {
        // ─── Heartbeat: one-shot, skip router and session ───
        if (source === "heartbeat") {
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
            effectiveModel = "haiku";
            responseText = await processHeartbeat(msg);

            // Suppress heartbeat responses with no actionable content
            if (responseText.includes("[NO_UPDATES]")) {
                log(
                    "INFO",
                    `Heartbeat suppressed for thread=${threadId} (no updates)`,
                );
                clearStatus(messageId);
                if (fs.existsSync(processingFile)) {
                    fs.unlinkSync(processingFile);
                }
                return;
            }
        } else {
            // ─── Route the message ───
            routingResult = routeMessage(msg);
            effectiveModel = routingResult.effectiveModel;

            log(
                "INFO",
                `Routed thread=${threadId}: tier=${routingResult.decision.tier} model=${effectiveModel} ` +
                    `confidence=${routingResult.decision.confidence.toFixed(2)} signals=[${routingResult.decision.signals.join(", ")}]`,
            );

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
                    model: effectiveModel,
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

            // ─── Build the full prompt ───
            const now = formatCurrentTime();
            const prefix = buildSourcePrefix(msg);
            const isNewSession = !threadConfig.sessionId;
            const threadPrompt = buildThreadPrompt(threadConfig);
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
            const options = buildQueryOptions(threadId, threadConfig, effectiveModel, stderrLines);
            const q = query({ prompt: fullPrompt, options });

            // Write initial status; the telegram-client computes elapsed time from startTs
            const statusStartTime = Date.now();
            let currentStatusLabel = "Thinking";
            writeStatus(messageId, currentStatusLabel, statusStartTime);

            // Refresh the status file every 2 seconds to keep ts fresh (for staleness detection)
            // and to pick up label changes from the observer callbacks
            const statusInterval = setInterval(() => {
                writeStatus(messageId, currentStatusLabel, statusStartTime);
            }, 2000);

            // Observer callbacks set intent; the interval handles all file writes
            const observer: QueryEventObserver = {
                onToolUse(toolName: string) {
                    currentStatusLabel = `Using ${toolName}`;
                },
                onToolProgress(toolName: string) {
                    currentStatusLabel = `Using ${toolName}`;
                },
                onCompacting() {
                    currentStatusLabel = "Compacting context";
                },
            };

            try {
                const { text, sessionId: newSessionId } = await collectQueryResponse(
                    q,
                    observer,
                );
                clearInterval(statusInterval);
                responseText = text.trim();

                // Persist session ID for future resume
                if (newSessionId) {
                    const freshThreads = loadThreads();
                    const freshKey = String(threadId);
                    if (freshThreads[freshKey]) {
                        freshThreads[freshKey].sessionId = newSessionId;
                        freshThreads[freshKey].model = effectiveModel;
                        freshThreads[freshKey].lastActive = Date.now();
                        saveThreads(freshThreads);
                        syncSessionLog(newSessionId, freshThreads[freshKey].cwd);
                    }
                }
            } catch (queryErr) {
                clearInterval(statusInterval);
                const stderrOutput = stderrLines.join("").trim();
                log(
                    "ERROR",
                    `Query error for thread ${threadId}: ${toErrorMessage(queryErr)}` +
                        (stderrOutput ? `\n  stderr: ${stderrOutput.slice(0, 2000)}` : ""),
                );

                // Clear stale sessionId on error so retries start a fresh session
                const freshThreads = loadThreads();
                const freshKey = String(threadId);
                if (freshThreads[freshKey]) {
                    delete freshThreads[freshKey].sessionId;
                    saveThreads(freshThreads);
                }

                throw queryErr;
            }
        }

        // Fallback for empty responses
        if (!responseText) {
            responseText = "(No response generated)";
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
            ...(source !== "heartbeat" && routingResult ? {
                routingMetadata: {
                    tier: routingResult.decision.tier,
                    model: effectiveModel,
                    confidence: routingResult.decision.confidence,
                    signals: routingResult.decision.signals,
                    tokens: routingResult.decision.estimatedTokens,
                    prompt: msg.message,
                },
            } : {}),
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
        log("ERROR", `Processing error for ${filename}: ${toErrorMessage(error)}`);
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
        fs.renameSync(processingFile, retryPath);
        log(
            "WARN",
            `Retry ${newRetry}/${MAX_RETRIES} for ${filename} -> ${retryFilename}`,
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
                const aHB = a.name.startsWith('heartbeat_');
                const bHB = b.name.startsWith('heartbeat_');
                if (aHB && !bHB) return 1;   // heartbeats go to back
                if (!aHB && bHB) return -1;  // user messages jump ahead
                return a.time - b.time;      // within same priority, FIFO
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

            // Claim the slot
            activeCount++;
            activeThreads.add(msg.threadId);
            if (msg.source === 'heartbeat') activeHeartbeatCount++;

            log(
                "INFO",
                `Dispatching thread=${msg.threadId} (active: ${activeCount}/${maxConcurrent})`,
            );

            // Fire off processing — don't await, allow parallel execution
            processMessage(file.path).finally(() => {
                activeCount--;
                activeThreads.delete(msg.threadId);
                if (msg.source === 'heartbeat') activeHeartbeatCount--;
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

// Initial queue drain on startup
void processQueue();
