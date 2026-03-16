#!/usr/bin/env node
/**
 * Telegram Client - grammY-based Telegram bot for Borg
 * Handles incoming messages, commands, and outgoing queue polling.
 */

import fs from "fs";
import path from "path";
import { Bot, Context, API_CONSTANTS, InlineKeyboard, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import {
    loadThreads,
    saveThreads,
    loadSettings,
    resetThread,
    configureThread,
    SHARED_SETTINGS_FILE,
} from "./session-manager.js";
import type { ThreadConfig, ThreadsMap, Settings } from "./session-manager.js";
import type { OutgoingMessage, TaskListMapping, MessageModelEntry, PendingApproval } from "./types.js";
import { toErrorMessage, TASK_LISTS_FILENAME } from "./types.js";
import { RoutingMetadataSchema } from "./types.js";
import { logDecision, logCorrection, ROUTING_LOG } from "./routing-logger.js";
import { cleanupAudioFile, startPeriodicCleanup, ensureModels, distillForSpeech, synthesize, isAvailable } from "./audio.js";
import { startPeriodicCleanup as startImageCleanup } from "./images.js";
import { toTelegramMarkdownV2, escapeMarkdownV2 } from "./markdown-v2.js";
import { loadZoneConfig, getThreadZone, isSameZone } from "./zone-config.js";

// ─── Constants ───

const SCRIPT_DIR = path.resolve(__dirname, "..");
const ZONE_CONFIG_PATH = process.env.ZONE_CONFIG_PATH || path.join(SCRIPT_DIR, "zone-config.json");

// Infra's own storage — telegram-client always runs in the infra container
const BORG_INFRA_DIR = path.join(SCRIPT_DIR, ".borg-infra");
const QUEUE_DEAD_LETTER = path.join(BORG_INFRA_DIR, "queue/dead-letter");
const LOG_FILE = path.join(BORG_INFRA_DIR, "logs/telegram.log");
const MESSAGE_MODELS_FILE = path.join(BORG_INFRA_DIR, "message-models.json");
const MARKDOWN_PARSE_FAILURES = path.join(BORG_INFRA_DIR, "markdown-parse-failures.jsonl");

// Zone status directories — queue-processors write status files to their zone's dir
const ZONE_STATUS_DIRS = [
    path.join(SCRIPT_DIR, ".borg-core/status"),
    path.join(SCRIPT_DIR, ".borg-perimeter/status"),
];

/**
 * Get the pending queue directory (infra owns all cross-zone approvals).
 */
function getPendingQueueDirs(): string[] {
    return [path.join(SCRIPT_DIR, ".borg-infra/queue/pending")];
}

/**
 * Find a pending approval file by ID across all pending dirs.
 * Returns the full path to the .json file, or null if not found.
 */
function findPendingFile(pendingId: string): string | null {
    for (const dir of getPendingQueueDirs()) {
        const filePath = path.join(dir, `${pendingId}.json`);
        if (fs.existsSync(filePath)) return filePath;
    }
    return null;
}

/**
 * Resolve the incoming queue path for a target zone.
 */
function resolveZoneIncoming(targetZone: string): string {
    return path.join(SCRIPT_DIR, `.borg-${targetZone}/queue/incoming`);
}

/**
 * Resolve the outgoing queue path for a target zone.
 */
function resolveZoneOutgoing(targetZone: string): string {
    return path.join(SCRIPT_DIR, `.borg-${targetZone}/queue/outgoing`);
}

/**
 * Resolve the incoming queue path for a specific thread by looking up its zone.
 */
function resolveIncomingForThread(threadId: number): string {
    try {
        const config = loadZoneConfig(ZONE_CONFIG_PATH);
        if (!config) return resolveZoneIncoming("core");
        const zone = getThreadZone(config, threadId);
        return resolveZoneIncoming(zone);
    } catch {
        return resolveZoneIncoming("core");
    }
}

/**
 * Resolve the cancel queue directory for a thread's zone.
 */
function resolveZoneCancelDir(threadId: number): string {
    try {
        const config = loadZoneConfig(ZONE_CONFIG_PATH);
        if (!config) return path.join(SCRIPT_DIR, ".borg-core/queue/cancel");
        const zone = getThreadZone(config, threadId);
        return path.join(SCRIPT_DIR, `.borg-${zone}/queue/cancel`);
    } catch {
        return path.join(SCRIPT_DIR, ".borg-core/queue/cancel");
    }
}

/**
 * Resolve the processing queue directory for a thread's zone.
 */
function resolveZoneProcessingDir(threadId: number): string {
    try {
        const config = loadZoneConfig(ZONE_CONFIG_PATH);
        if (!config) return path.join(SCRIPT_DIR, ".borg-core/queue/processing");
        const zone = getThreadZone(config, threadId);
        return path.join(SCRIPT_DIR, `.borg-${zone}/queue/processing`);
    } catch {
        return path.join(SCRIPT_DIR, ".borg-core/queue/processing");
    }
}

/**
 * Resolve the audio incoming directory for a thread's zone.
 * Voice/image files must be written to the target zone's dir so queue-processor can read them.
 */
function resolveZoneAudioIncoming(threadId: number): string {
    try {
        const config = loadZoneConfig(ZONE_CONFIG_PATH);
        if (!config) return path.join(SCRIPT_DIR, ".borg-core/audio/incoming");
        const zone = getThreadZone(config, threadId);
        return path.join(SCRIPT_DIR, `.borg-${zone}/audio/incoming`);
    } catch {
        return path.join(SCRIPT_DIR, ".borg-core/audio/incoming");
    }
}

/**
 * Resolve the images incoming directory for a thread's zone.
 */
function resolveZoneImagesIncoming(threadId: number): string {
    try {
        const config = loadZoneConfig(ZONE_CONFIG_PATH);
        if (!config) return path.join(SCRIPT_DIR, ".borg-core/images/incoming");
        const zone = getThreadZone(config, threadId);
        return path.join(SCRIPT_DIR, `.borg-${zone}/images/incoming`);
    } catch {
        return path.join(SCRIPT_DIR, ".borg-core/images/incoming");
    }
}

/**
 * Get all outgoing queue directories to poll (one per zone).
 */
function getOutgoingQueueDirs(): string[] {
    return [
        path.join(SCRIPT_DIR, ".borg-core/queue/outgoing"),
        path.join(SCRIPT_DIR, ".borg-perimeter/queue/outgoing"),
    ];
}
const DEDUP_WINDOW_MS = 10_000; // 10 seconds
const TASK_LISTS_FILE = path.join(SCRIPT_DIR, ".borg", TASK_LISTS_FILENAME);
const TASK_PINS_FILE = path.join(SCRIPT_DIR, ".borg/task-pins.json");
const CLAUDE_TASKS_DIR = path.join(process.env.HOME || "/root", ".claude/tasks");
const TASK_POLL_INTERVAL = 2000; // 2 seconds

// Track directory mtimes to avoid re-reading unchanged directories
const taskDirMtimes = new Map<string, number>();
// Track last pinned content hash per thread to avoid unnecessary updates
const lastPinnedContent = new Map<number, string>();

// ─── Message Deduplication ───

/** Track last message per (threadId, senderId) for dedup */
const lastMessages = new Map<string, { text: string; ts: number }>();

function isDuplicate(threadId: number, senderId: string, text: string): boolean {
    const key = `${threadId}:${senderId}`;
    const now = Date.now();
    const prev = lastMessages.get(key);
    // Always update the tracker
    lastMessages.set(key, { text, ts: now });
    return !!prev && prev.text === text && (now - prev.ts) < DEDUP_WINDOW_MS;
}

// ─── Ensure Directories Exist ───

[QUEUE_DEAD_LETTER, ...ZONE_STATUS_DIRS, path.dirname(LOG_FILE), path.dirname(MESSAGE_MODELS_FILE)].forEach(
    (dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    },
);

// ─── Logger ───

function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

/** Log MarkdownV2 parse failures for later analysis and converter improvement */
function logMarkdownParseFailure(originalText: string, convertedText: string, errorMessage: string, context?: Record<string, unknown>): void {
    const entry = {
        ts: Date.now(),
        originalText,
        convertedText,
        errorMessage,
        ...context,
    };
    try {
        fs.appendFileSync(MARKDOWN_PARSE_FAILURES, JSON.stringify(entry) + "\n");
        log("WARN", `MarkdownV2 parse failure logged (${originalText.slice(0, 30)}...)`);
    } catch (err) {
        log("ERROR", `Failed to log MarkdownV2 parse failure: ${toErrorMessage(err)}`);
    }
}

// ─── Message Model Tracking ───

let messageModelsCache: Record<string, MessageModelEntry> | null = null;

function loadMessageModels(): Record<string, MessageModelEntry> {
    if (messageModelsCache) return messageModelsCache;
    try {
        const data = fs.readFileSync(MESSAGE_MODELS_FILE, "utf8");
        const raw = JSON.parse(data) as Record<string, unknown>;
        // Normalize on load: old string values → {model, threadId: 0}
        let needsRewrite = false;
        const normalized: Record<string, MessageModelEntry> = {};
        for (const [key, value] of Object.entries(raw)) {
            if (typeof value === "string") {
                normalized[key] = { model: value, threadId: 0 };
                needsRewrite = true;
            } else if (value && typeof value === "object" && "model" in value) {
                normalized[key] = value as MessageModelEntry;
            }
        }
        messageModelsCache = normalized;
        if (needsRewrite) {
            saveMessageModels(normalized);
        }
        return messageModelsCache;
    } catch {
        messageModelsCache = {} as Record<string, MessageModelEntry>;
        return messageModelsCache;
    }
}

function saveMessageModels(models: Record<string, MessageModelEntry>): void {
    // Prune to last 200 entries (reduced from 1000 since fullText can be large)
    const keys = Object.keys(models);
    if (keys.length > 200) {
        const toRemove = keys.slice(0, keys.length - 200);
        for (const key of toRemove) {
            delete models[key];
        }
    }
    const tmp = MESSAGE_MODELS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(models, null, 2));
    fs.renameSync(tmp, MESSAGE_MODELS_FILE);
    messageModelsCache = models;
}

function storeMessageModel(messageId: number, model: string, threadId: number, fullText?: string): void {
    const models = loadMessageModels();
    models[String(messageId)] = { model, threadId, fullText };
    saveMessageModels(models);
}

function lookupMessageModel(messageId: number): MessageModelEntry | undefined {
    const models = loadMessageModels();
    return models[String(messageId)];
}

// ─── Topic Name Cache ───

const topicNames = new Map<number, string>();

// ─── Pending Messages ───

interface PendingMessage {
    ctx?: Context;          // present for user messages, absent for cross-thread
    chatId: number;
    threadId: number;
    telegramMessageId: number;
    statusMessageId?: number;
    lastStatusText?: string;
    lastStatusLabel?: string;   // base label for change detection
    lastPreview?: string;       // last preview text shown
    lastEditTs?: number;        // last Telegram edit timestamp for throttling
}

const pendingMessages = new Map<string, PendingMessage>();
const telegramToQueueId = new Map<number, string>(); // Telegram message_id → queue messageId
const listenInFlight = new Set<number>(); // track message IDs being processed for TTS
const voiceButtonsInFlight = new Set<string>(); // track voice button callbacks being processed

// ─── Message Splitting ───

function splitMessage(text: string, maxLength = 4096): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
        if (splitIndex <= 0) splitIndex = remaining.lastIndexOf("\n", maxLength);
        if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(" ", maxLength);
        if (splitIndex <= 0) splitIndex = maxLength;

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).replace(/^\n+/, "");
    }

    return chunks;
}

// ─── Reply Keyboard Builder ───

function buildReplyKeyboard(botMessageId: number, replyToMessageId?: number, replyToVoice?: boolean): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    // Add voice transcript buttons if replying to a voice message
    if (replyToVoice && replyToMessageId) {
        keyboard.text("📝 Your Text", `voice_full:${replyToMessageId}`);
        keyboard.text("📋 Your Summary", `voice_summary:${replyToMessageId}`);
    }

    // Always add Listen button for bot response
    keyboard.text("🔊 Listen", `listen:${botMessageId}`);

    return keyboard;
}

// ─── Task Watcher ───

type TaskPins = Record<string, number>; // threadId string → telegram messageId

let cachedTaskPins: TaskPins | null = null;
let taskPinsMtime = 0;

function loadTaskPins(): TaskPins {
    try {
        const mtime = fs.statSync(TASK_PINS_FILE).mtimeMs;
        if (cachedTaskPins && mtime === taskPinsMtime) return cachedTaskPins;
        cachedTaskPins = JSON.parse(fs.readFileSync(TASK_PINS_FILE, "utf8"));
        taskPinsMtime = mtime;
        return cachedTaskPins!;
    } catch {
        return cachedTaskPins ?? {};
    }
}

function saveTaskPins(pins: TaskPins): void {
    const tmp = TASK_PINS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(pins, null, 2));
    fs.renameSync(tmp, TASK_PINS_FILE);
    cachedTaskPins = pins;
    taskPinsMtime = Date.now();
}

interface TaskFile {
    id: string;
    subject: string;
    status: string; // "pending" | "in_progress" | "completed"
    owner?: string;
}

function readTasksFromDir(dirPath: string): TaskFile[] {
    try {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".json"));
        const tasks: TaskFile[] = [];
        for (const file of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), "utf8"));
                if (data.id && data.subject && data.status) {
                    tasks.push({ id: data.id, subject: data.subject, status: data.status, owner: data.owner });
                }
            } catch { /* skip unparseable */ }
        }
        return tasks.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    } catch {
        return [];
    }
}

function formatTaskMessage(tasks: TaskFile[], timezone: string): string {
    const pending = tasks.filter(t => t.status === "pending");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const completed = tasks.filter(t => t.status === "completed");

    const lines: string[] = ["Open Tasks", "──────────"];
    for (const t of inProgress) {
        lines.push(`🔄 ${t.subject}`);
    }
    for (const t of pending) {
        lines.push(`⬚ ${t.subject}`);
    }
    lines.push("──────────");
    lines.push(`✅ ${completed.length} done · 🔄 ${inProgress.length} in progress · ⬚ ${pending.length} pending`);
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false });
    lines.push(`Updated: ${timeStr}`);
    return lines.join("\n");
}

// ─── Bot Setup ───

const settings = loadSettings();
const bot = new Bot<Context>(settings.telegram_bot_token);

// ─── Helpers ───

/** Send a message to the correct forum topic, using ctx if available or bot API directly */
async function sendInThread(
    pending: PendingMessage,
    text: string,
    parseMode?: "MarkdownV2",
): Promise<{ message_id: number }> {
    const threadId = getThreadOpt(pending);
    if (pending.ctx) {
        return pending.ctx.reply(text, { message_thread_id: threadId, parse_mode: parseMode });
    }
    return bot.api.sendMessage(pending.chatId, text, { message_thread_id: threadId, parse_mode: parseMode });
}

/** Resolve the Telegram message_thread_id for a pending message */
function getThreadOpt(pending: PendingMessage): number | undefined {
    return pending.ctx?.msg?.message_thread_id
        ?? (pending.threadId !== 1 ? pending.threadId : undefined);
}

bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

// ─── Topic Name Tracking ───

bot.on("message:forum_topic_created", (ctx) => {
    const threadId = ctx.msg.message_thread_id;
    const name = ctx.msg.forum_topic_created.name;
    if (threadId && name) {
        topicNames.set(threadId, name);
        log("INFO", `Topic name cached: thread ${threadId} = "${name}"`);
    }
});

bot.on("message:forum_topic_edited", (ctx) => {
    const threadId = ctx.msg.message_thread_id;
    const name = ctx.msg.forum_topic_edited.name;
    if (threadId && name) {
        topicNames.set(threadId, name);
        configureThread(threadId, { name });
        log("INFO", `Topic name updated: thread ${threadId} = "${name}"`);
    }
});

// ─── Commands ───

// /compact resets the session; recent message history is automatically injected on next message.
// Currently an alias for /clear — may add summarization in the future.
for (const cmd of ["clear", "compact"] as const) {
    bot.command(cmd, async (ctx) => {
        if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
        const threadId = ctx.msg.message_thread_id ?? 1;
        resetThread(threadId);
        await ctx.reply("Session reset. Recent message history will be available on next message.", {
            message_thread_id: ctx.msg.message_thread_id,
        });
        log("INFO", `Thread ${threadId} ${cmd} by ${ctx.from?.first_name ?? "unknown"}`);
    });
}

bot.command("setdir", async (ctx) => {
    if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
    const threadId = ctx.msg.message_thread_id ?? 1;
    const dir = ctx.match?.trim();

    if (!dir) {
        await ctx.reply("Usage: /setdir <path>", {
            message_thread_id: ctx.msg.message_thread_id,
        });
        return;
    }

    configureThread(threadId, { cwd: dir });
    await ctx.reply(`Working directory set to: ${dir}`, {
        message_thread_id: ctx.msg.message_thread_id,
    });
    log("INFO", `Thread ${threadId} cwd set to ${dir} by ${ctx.from?.first_name ?? "unknown"}`);
});

// /model <haiku|sonnet|opus> — switch the thread's sticky model and reset session
const VALID_MODEL_ARGS: Record<string, string> = {
    haiku: "haiku",
    sonnet: "sonnet",
    opus: "opus[1m]",
};
bot.command("model", async (ctx) => {
    if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
    const threadId = ctx.msg.message_thread_id ?? 1;
    const arg = ctx.match?.trim().toLowerCase();

    if (!arg || !VALID_MODEL_ARGS[arg]) {
        const current = loadThreads()[String(threadId)]?.model ?? "sonnet";
        await ctx.reply(
            `Current model: ${current}\nUsage: /model <haiku|sonnet|opus>`,
            { message_thread_id: ctx.msg.message_thread_id },
        );
        return;
    }

    const newModel = VALID_MODEL_ARGS[arg];
    configureThread(threadId, { model: newModel });
    resetThread(threadId); // Clear session so new model starts fresh with full cache
    await ctx.reply(
        `Model set to ${newModel}. Session reset — recent history will be injected on next message.`,
        { message_thread_id: ctx.msg.message_thread_id },
    );
    log("INFO", `Thread ${threadId} model set to ${newModel} by ${ctx.from?.first_name ?? "unknown"}`);
});

// /do <haiku|sonnet|opus> <message> — one-shot query, no session context
bot.command("do", async (ctx) => {
    if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
    const threadId = ctx.msg.message_thread_id ?? 1;
    const args = ctx.match?.trim();

    if (!args) {
        await ctx.reply("Usage: /do <haiku|sonnet|opus> <message>\nDefaults to haiku if no model specified.", {
            message_thread_id: ctx.msg.message_thread_id,
        });
        return;
    }

    // Parse: first word may be a model, rest is the message
    const firstSpace = args.indexOf(" ");
    const firstWord = firstSpace > 0 ? args.slice(0, firstSpace).toLowerCase() : args.toLowerCase();
    let model: string;
    let message: string;

    if (VALID_MODEL_ARGS[firstWord] && firstSpace > 0) {
        model = VALID_MODEL_ARGS[firstWord];
        message = args.slice(firstSpace + 1).trim();
    } else {
        // No model specified — default to haiku, entire args is the message
        model = "haiku";
        message = args;
    }

    if (!message) {
        await ctx.reply("Usage: /do <haiku|sonnet|opus> <message>", {
            message_thread_id: ctx.msg.message_thread_id,
        });
        return;
    }

    const messageId = `oneshot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const topicName = topicNames.get(threadId);
    const queueData = {
        channel: "telegram",
        source: "one-shot" as const,
        threadId,
        sender: ctx.from?.first_name ?? "user",
        senderId: String(ctx.from?.id ?? ""),
        message,
        topicName,
        timestamp: Date.now(),
        messageId,
        oneshotModel: model,
    };

    const incomingDir = resolveIncomingForThread(threadId);
    fs.mkdirSync(incomingDir, { recursive: true });
    const queueFile = path.join(incomingDir, `telegram_${messageId}.json`);
    const tmpFile = queueFile + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(queueData, null, 2));
    fs.renameSync(tmpFile, queueFile);

    // No pendingMessage registration — response will arrive via fallback path (direct send)

    const modelLabel = model.replace("[1m]", "");
    await ctx.reply(`⚡ Running with ${modelLabel}...`, {
        message_thread_id: ctx.msg.message_thread_id,
    });
    log("INFO", `One-shot /do command: thread=${threadId} model=${model} message="${message.slice(0, 100)}"`);
});

// /budget_on and /budget_off toggle budget mode (cheap model via Fireworks)
// Writes to shared settings.json at project root - accessible by all zone containers
for (const cmd of ["budget_on", "budget_off"] as const) {
    bot.command(cmd, async (ctx) => {
        if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
        const isOn = cmd === "budget_on";
        const currentSettings = loadSettings();
        currentSettings.budgetMode = isOn;
        // Write to shared settings.json at project root (accessible by all zones)
        try {
            fs.writeFileSync(SHARED_SETTINGS_FILE, JSON.stringify(currentSettings, null, 2));
        } catch (err) {
            log("ERROR", `Failed to write shared settings.json: ${toErrorMessage(err)}`);
            await ctx.reply(`❌ Failed to save budget mode setting: ${toErrorMessage(err)}`, {
                message_thread_id: ctx.msg?.message_thread_id,
            });
            return;
        }
        await ctx.reply(isOn ? "💰 Budget mode enabled" : "💰 Budget mode disabled", {
            message_thread_id: ctx.msg?.message_thread_id,
        });
        log("INFO", `Budget mode ${isOn ? "enabled" : "disabled"} by ${ctx.from?.first_name ?? "unknown"}`);
    });
}

// /compact_team resets all team sessions; an alias for /clear_team.
for (const cmd of ["clear_team", "compact_team"] as const) {
    bot.command(cmd, async (ctx) => {
        if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
        const threadId = ctx.msg?.message_thread_id ?? 1;
        const threads = loadThreads();
        const config = threads[String(threadId)];
        if (!config?.team) {
            await ctx.reply("This thread isn't part of a team.", {
                message_thread_id: ctx.msg?.message_thread_id,
            });
            return;
        }
        const teamThreads = Object.entries(threads).filter(([, t]) => t.team === config.team);
        for (const [id] of teamThreads) {
            resetThread(Number(id));
            // Send notification to each team thread (except the invoking thread)
            const tid = Number(id);
            if (tid !== threadId && tid !== 1) {
                bot.api.sendMessage(settings.telegram_chat_id, `🔄 Session cleared by /${cmd}`, {
                    message_thread_id: tid,
                }).catch(() => {});
            }
        }
        await ctx.reply(toTelegramMarkdownV2(`Reset ${teamThreads.length} session(s) in team **${config.team}**. Recent history available on next message.`), {
            message_thread_id: ctx.msg?.message_thread_id,
            parse_mode: "MarkdownV2",
        });
        log("INFO", `Team ${config.team} ${cmd} by ${ctx.from?.first_name ?? "unknown"} (${teamThreads.length} threads)`);
    });
}

// /clear_all resets all thread sessions.
bot.command("clear_all", async (ctx) => {
    if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
    const invokerThreadId = ctx.msg?.message_thread_id ?? 1;
    const threads = loadThreads();
    const allThreadIds = Object.keys(threads).map(Number);
    for (const tid of allThreadIds) {
        resetThread(tid);
        // Send notification to each thread (except the invoking thread)
        if (tid !== invokerThreadId && tid !== 1) {
            bot.api.sendMessage(settings.telegram_chat_id, `🔄 Session cleared by /clear_all`, {
                message_thread_id: tid,
            }).catch(() => {});
        }
    }
    await ctx.reply(`Reset ${allThreadIds.length} session(s). Recent history available on next message.`, {
        message_thread_id: ctx.msg?.message_thread_id,
    });
    log("INFO", `clear_all by ${ctx.from?.first_name ?? "unknown"} (${allThreadIds.length} threads)`);
});

bot.command("status", async (ctx) => {
    if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
    const threads = loadThreads();
    const lines: string[] = ["Active threads:"];

    for (const [id, config] of Object.entries(threads)) {
        const lastActive = config.lastActive
            ? new Date(config.lastActive).toLocaleString()
            : "never";
        lines.push(
            `  Thread ${id} (${config.name}): model=${config.model}, cwd=${config.cwd}, last=${lastActive}`,
        );
    }

    await ctx.reply(lines.join("\n"), {
        message_thread_id: ctx.msg.message_thread_id,
    });
});

// ─── Message Handler ───

bot.on("message:text").filter(
    (ctx) => ctx.from.id !== bot.botInfo.id,
    async (ctx) => {
        const threadId = ctx.msg.message_thread_id ?? 1;
        const isReplyToBot = ctx.msg.reply_to_message?.from?.id === bot.botInfo.id;
        const replyToText = isReplyToBot ? ctx.msg.reply_to_message?.text : undefined;
        const stored = isReplyToBot && ctx.msg.reply_to_message
            ? lookupMessageModel(ctx.msg.reply_to_message.message_id)
            : undefined;
        const replyToModel = stored?.model;

        // Restrict to configured chat ID
        if (String(ctx.chat.id) !== settings.telegram_chat_id) return;

        // Deduplicate: skip if same sender + thread + text within window
        if (isDuplicate(threadId, String(ctx.from.id), ctx.message.text)) {
            log("INFO", `Dedup: skipping duplicate from ${ctx.from.first_name} in thread ${threadId}`);
            return;
        }

        const messageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const topicName = topicNames.get(threadId);
        const queueData = {
            channel: "telegram",
            source: "user" as const,
            threadId,
            sender: ctx.from.first_name,
            senderId: String(ctx.from.id),
            message: ctx.message.text,
            isReply: isReplyToBot,
            replyToText,
            replyToModel,
            topicName,
            timestamp: Date.now(),
            messageId,
        };

        const incomingDir = resolveIncomingForThread(threadId);
        fs.mkdirSync(incomingDir, { recursive: true });
        const queueFile = path.join(incomingDir, `telegram_${messageId}.json`);
        const tmpFile = queueFile + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(queueData, null, 2));
        fs.renameSync(tmpFile, queueFile);

        pendingMessages.set(messageId, {
            ctx,
            chatId: ctx.chat.id,
            threadId,
            telegramMessageId: ctx.msg.message_id,
        });
        telegramToQueueId.set(ctx.msg.message_id, messageId);

        // React with 👀 to acknowledge we've seen the message
        try {
            await bot.api.setMessageReaction(ctx.chat.id, ctx.msg.message_id,
                [{ type: "emoji", emoji: "👀" as any }]);
        } catch {
            // Reactions may not be available — silently ignore
        }

        log(
            "INFO",
            `Queued message from ${ctx.from.first_name} in thread ${threadId}: ${ctx.message.text.substring(0, 80)}`,
        );
    },
);

// ─── Broadcast Group Listener ───

bot.on("message:text").filter(
    (ctx) => {
        // Only listen to the broadcast group (not the main Borg chat)
        if (!settings.broadcast_chat_id) return false;
        if (String(ctx.chat.id) !== settings.broadcast_chat_id) return false;
        // Ignore our own messages
        if (ctx.from.id === bot.botInfo.id) return false;
        return true;
    },
    async (ctx) => {
        const broadcastText = ctx.message.text;
        log("INFO", `Broadcast received: ${broadcastText.substring(0, 80)}`);

        // Fan-out to mainThread:true threads in core zone only
        const threads = loadThreads();
        const zoneConfig = loadZoneConfig(ZONE_CONFIG_PATH);
        const mainThreads = Object.entries(threads).filter(([id, t]) => {
            if (!t.mainThread) return false;
            // Only include core zone threads for broadcast
            if (zoneConfig) {
                return getThreadZone(zoneConfig, Number(id)) === "core";
            }
            return true; // no zone config = all mainThread threads
        });

        if (mainThreads.length === 0) {
            log("INFO", "Broadcast received but no eligible mainThread threads — skipping fan-out");
            return;
        }

        for (const [threadIdStr] of mainThreads) {
            const threadId = Number(threadIdStr);
            const messageId = `broadcast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const queueData = {
                channel: "telegram",
                source: "broadcast" as const,
                threadId,
                sender: ctx.from.first_name ?? "Broadcast",
                senderId: String(ctx.from.id),
                message: broadcastText,
                timestamp: Date.now(),
                messageId,
            };

            const broadcastIncoming = resolveIncomingForThread(threadId);
            fs.mkdirSync(broadcastIncoming, { recursive: true });
            const queueFile = path.join(broadcastIncoming, `broadcast_${messageId}.json`);
            const tmpFile = queueFile + ".tmp";
            fs.writeFileSync(tmpFile, JSON.stringify(queueData, null, 2));
            fs.renameSync(tmpFile, queueFile);

            log("INFO", `Broadcast fan-out to mainThread ${threadId}`);
        }
    },
);

// ─── Voice Message Handler ───

bot.on("message:voice").filter(
    (ctx) => ctx.from.id !== bot.botInfo.id,
    async (ctx) => {
        const threadId = ctx.msg.message_thread_id ?? 1;
        if (String(ctx.chat.id) !== settings.telegram_chat_id) return;

        const duration = ctx.msg.voice.duration;

        // Reject voice messages over 5 minutes
        if (duration > 300) {
            await ctx.reply("Voice messages over 5 minutes aren't supported. Please keep it under 5 minutes or send as text.", {
                message_thread_id: ctx.msg.message_thread_id,
            });
            return;
        }

        // Fetch file metadata (needed for size check and dedup)
        const file = await ctx.getFile();

        // Reject oversized voice files (Telegram allows up to 20MB)
        if (file.file_size && file.file_size > 10 * 1024 * 1024) {
            await ctx.reply("Voice file too large (max 10MB). Please send a shorter message or use text.", {
                message_thread_id: ctx.msg.message_thread_id,
            });
            return;
        }

        // Deduplicate using file_unique_id for reliable content identity
        if (isDuplicate(threadId, String(ctx.from.id), `voice_${file.file_unique_id}`)) {
            log("INFO", `Dedup: skipping duplicate voice from ${ctx.from.first_name} in thread ${threadId}`);
            return;
        }

        // Download the voice file — write to the target zone's audio dir so queue-processor can read it
        const fileUrl = `https://api.telegram.org/file/bot${settings.telegram_bot_token}/${file.file_path}`;
        const messageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const zoneAudioDir = resolveZoneAudioIncoming(threadId);
        if (!fs.existsSync(zoneAudioDir)) fs.mkdirSync(zoneAudioDir, { recursive: true });
        const oggPath = path.join(zoneAudioDir, `${messageId}.ogg`);
        // Queue-processor sees /app/.borg/audio/incoming/ (its own zone mount), not /app/.borg-{zone}/
        const canonicalAudioPath = path.join(SCRIPT_DIR, ".borg/audio/incoming", `${messageId}.ogg`);

        try {
            const res = await fetch(fileUrl);
            if (!res.ok) throw new Error(`Download failed: ${res.status}`);
            const buffer = Buffer.from(await res.arrayBuffer());
            const tmpPath = oggPath + ".tmp";
            fs.writeFileSync(tmpPath, buffer);
            fs.renameSync(tmpPath, oggPath);
        } catch (err) {
            log("ERROR", `Failed to download voice file: ${toErrorMessage(err)}`);
            await ctx.reply("Couldn't download your voice message. Please try again.", {
                message_thread_id: ctx.msg.message_thread_id,
            });
            return;
        }

        // Check reply-to-bot context (same as text handler)
        const isReplyToBot = ctx.msg.reply_to_message?.from?.id === bot.botInfo.id;
        const stored = isReplyToBot && ctx.msg.reply_to_message
            ? lookupMessageModel(ctx.msg.reply_to_message.message_id)
            : undefined;
        const replyToModel = stored?.model;
        const replyToText = isReplyToBot ? ctx.msg.reply_to_message?.text : undefined;

        const topicName = topicNames.get(threadId);
        const queueData = {
            channel: "telegram",
            source: "user" as const,
            threadId,
            sender: ctx.from.first_name,
            senderId: String(ctx.from.id),
            message: "",  // empty — queue-processor fills after STT
            audioPath: canonicalAudioPath,
            voiceDuration: duration,
            isReply: isReplyToBot,
            replyToText,
            replyToModel,
            topicName,
            timestamp: Date.now(),
            messageId,
            telegramMessageId: ctx.msg.message_id,
        };

        const incomingDir = resolveIncomingForThread(threadId);
        fs.mkdirSync(incomingDir, { recursive: true });
        const queueFile = path.join(incomingDir, `telegram_${messageId}.json`);
        const tmpFile = queueFile + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(queueData, null, 2));
        fs.renameSync(tmpFile, queueFile);

        pendingMessages.set(messageId, {
            ctx,
            chatId: ctx.chat.id,
            threadId,
            telegramMessageId: ctx.msg.message_id,
        });
        telegramToQueueId.set(ctx.msg.message_id, messageId);

        // React with 👀 to acknowledge
        try {
            await bot.api.setMessageReaction(ctx.chat.id, ctx.msg.message_id,
                [{ type: "emoji", emoji: "👀" as any }]);
        } catch {
            // Reactions may not be available
        }

        log("INFO", `Queued voice message (${duration}s) from ${ctx.from.first_name} in thread ${threadId}`);
    },
);

// ─── Photo Message Handler (with media group buffering) ───

// Buffer for media group photos — Telegram sends each photo in an album as a separate update
// with the same media_group_id. We collect them for 800ms then emit one queue message.
interface MediaGroupEntry {
    threadId: number;
    ctx: any; // first photo's context (used for reply info, pending message)
    sender: string;
    senderId: string;
    caption: string;
    imagePaths: string[];       // zone-local paths (for download verification)
    canonicalPaths: string[];   // canonical /app/.borg/ paths (for queue message)
    isReplyToBot: boolean;
    replyToModel?: string;
    replyToText?: string;
    topicName?: string;
    telegramMessageIds: number[];
    timer: ReturnType<typeof setTimeout>;
}
const mediaGroupBuffer = new Map<string, MediaGroupEntry>();

function flushMediaGroup(groupId: string): void {
    const group = mediaGroupBuffer.get(groupId);
    if (!group) return;
    mediaGroupBuffer.delete(groupId);
    clearTimeout(group.timer);

    const messageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const queueData = {
        channel: "telegram",
        source: "user" as const,
        threadId: group.threadId,
        sender: group.sender,
        senderId: group.senderId,
        message: group.caption,
        imagePaths: group.canonicalPaths,
        isReply: group.isReplyToBot,
        replyToText: group.replyToText,
        replyToModel: group.replyToModel,
        topicName: group.topicName,
        timestamp: Date.now(),
        messageId,
    };

    const incomingDir = resolveIncomingForThread(group.threadId);
    fs.mkdirSync(incomingDir, { recursive: true });
    const queueFile = path.join(incomingDir, `telegram_${messageId}.json`);
    const tmpFile = queueFile + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(queueData, null, 2));
    fs.renameSync(tmpFile, queueFile);

    // Register pending message using the first photo's context
    pendingMessages.set(messageId, {
        ctx: group.ctx,
        chatId: group.ctx.chat.id,
        threadId: group.threadId,
        telegramMessageId: group.telegramMessageIds[0],
    });
    for (const tmId of group.telegramMessageIds) {
        telegramToQueueId.set(tmId, messageId);
    }

    log("INFO", `Queued media group (${group.canonicalPaths.length} photos) from ${group.sender} in thread ${group.threadId}`);
}

bot.on("message:photo").filter(
    (ctx) => ctx.from.id !== bot.botInfo.id,
    async (ctx) => {
        const threadId = ctx.msg.message_thread_id ?? 1;
        if (String(ctx.chat.id) !== settings.telegram_chat_id) return;

        // Get the largest photo (last in array)
        const photo = ctx.msg.photo[ctx.msg.photo.length - 1];

        // Fetch file metadata
        const file = await ctx.getFile();

        // Reject oversized images (Claude Read tool limit)
        if (file.file_size && file.file_size > 5 * 1024 * 1024) {
            await ctx.reply("Image too large (max 5MB). Please send a smaller image.", {
                message_thread_id: ctx.msg.message_thread_id,
            });
            return;
        }

        // Deduplicate using file_unique_id
        if (isDuplicate(threadId, String(ctx.from.id), `photo_${file.file_unique_id}`)) {
            log("INFO", `Dedup: skipping duplicate photo from ${ctx.from.first_name} in thread ${threadId}`);
            return;
        }

        // Download the image file — write to the target zone's images dir so queue-processor can read it
        const fileUrl = `https://api.telegram.org/file/bot${settings.telegram_bot_token}/${file.file_path}`;
        const photoId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Determine file extension from path (e.g., "photos/file_123.jpg")
        const ext = path.extname(file.file_path || ".jpg") || ".jpg";
        const zoneImagesDir = resolveZoneImagesIncoming(threadId);
        if (!fs.existsSync(zoneImagesDir)) fs.mkdirSync(zoneImagesDir, { recursive: true });
        const imagePath = path.join(zoneImagesDir, `${photoId}${ext}`);
        // Queue-processor sees /app/.borg/images/incoming/ (its own zone mount)
        const canonicalImagePath = path.join(SCRIPT_DIR, ".borg/images/incoming", `${photoId}${ext}`);

        try {
            const res = await fetch(fileUrl);
            if (!res.ok) throw new Error(`Download failed: ${res.status}`);
            const buffer = Buffer.from(await res.arrayBuffer());
            const tmpPath = imagePath + ".tmp";
            fs.writeFileSync(tmpPath, buffer);
            fs.renameSync(tmpPath, imagePath);
        } catch (err) {
            log("ERROR", `Failed to download image file: ${toErrorMessage(err)}`);
            await ctx.reply("Couldn't download your image. Please try again.", {
                message_thread_id: ctx.msg.message_thread_id,
            });
            return;
        }

        // React with 👀 to acknowledge
        try {
            await bot.api.setMessageReaction(ctx.chat.id, ctx.msg.message_id,
                [{ type: "emoji", emoji: "👀" as any }]);
        } catch {
            // Reactions may not be available
        }

        const mediaGroupId = ctx.msg.media_group_id;

        // ─── Media group: buffer and flush after 800ms ───
        if (mediaGroupId) {
            const existing = mediaGroupBuffer.get(mediaGroupId);
            if (existing) {
                // Add to existing group
                existing.imagePaths.push(imagePath);
                existing.canonicalPaths.push(canonicalImagePath);
                existing.telegramMessageIds.push(ctx.msg.message_id);
                // Use caption from any photo that has one
                if (!existing.caption && ctx.msg.caption) existing.caption = ctx.msg.caption;
                // Reset timer
                clearTimeout(existing.timer);
                existing.timer = setTimeout(() => flushMediaGroup(mediaGroupId), 1500);
                log("INFO", `Added photo to media group ${mediaGroupId} (${existing.canonicalPaths.length} so far)`);
                return;
            }

            // First photo in group — start buffering
            const isReplyToBot = ctx.msg.reply_to_message?.from?.id === bot.botInfo.id;
            const stored = isReplyToBot && ctx.msg.reply_to_message
                ? lookupMessageModel(ctx.msg.reply_to_message.message_id)
                : undefined;

            const entry: MediaGroupEntry = {
                threadId,
                ctx,
                sender: ctx.from.first_name,
                senderId: String(ctx.from.id),
                caption: ctx.msg.caption || "",
                imagePaths: [imagePath],
                canonicalPaths: [canonicalImagePath],
                isReplyToBot,
                replyToModel: stored?.model,
                replyToText: isReplyToBot ? ctx.msg.reply_to_message?.text : undefined,
                topicName: topicNames.get(threadId),
                telegramMessageIds: [ctx.msg.message_id],
                timer: setTimeout(() => flushMediaGroup(mediaGroupId), 1500),
            };
            mediaGroupBuffer.set(mediaGroupId, entry);
            log("INFO", `Started media group ${mediaGroupId} from ${ctx.from.first_name} in thread ${threadId}`);
            return;
        }

        // ─── Single photo (no media group) — queue immediately ───
        const messageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Check reply-to-bot context (same as text/voice handler)
        const isReplyToBot = ctx.msg.reply_to_message?.from?.id === bot.botInfo.id;
        const stored = isReplyToBot && ctx.msg.reply_to_message
            ? lookupMessageModel(ctx.msg.reply_to_message.message_id)
            : undefined;
        const replyToModel = stored?.model;
        const replyToText = isReplyToBot ? ctx.msg.reply_to_message?.text : undefined;

        // Use caption if provided, otherwise empty (queue-processor will add instruction)
        const caption = ctx.msg.caption || "";

        const topicName = topicNames.get(threadId);
        const queueData = {
            channel: "telegram",
            source: "user" as const,
            threadId,
            sender: ctx.from.first_name,
            senderId: String(ctx.from.id),
            message: caption,
            imagePath: canonicalImagePath,
            isReply: isReplyToBot,
            replyToText,
            replyToModel,
            topicName,
            timestamp: Date.now(),
            messageId,
        };

        const incomingDir = resolveIncomingForThread(threadId);
        fs.mkdirSync(incomingDir, { recursive: true });
        const queueFile = path.join(incomingDir, `telegram_${messageId}.json`);
        const tmpFile = queueFile + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(queueData, null, 2));
        fs.renameSync(tmpFile, queueFile);

        pendingMessages.set(messageId, {
            ctx,
            chatId: ctx.chat.id,
            threadId,
            telegramMessageId: ctx.msg.message_id,
        });
        telegramToQueueId.set(ctx.msg.message_id, messageId);

        log("INFO", `Queued photo message from ${ctx.from.first_name} in thread ${threadId} (${file.file_size} bytes)`);
    },
);

// ─── Edited Message Handler ───

bot.on("edited_message:text", async (ctx) => {
    const editedMsg = ctx.editedMessage;
    if (!editedMsg || ctx.from.id === bot.botInfo.id) return;

    const telegramMsgId = editedMsg.message_id;
    const queueMessageId = telegramToQueueId.get(telegramMsgId);
    if (!queueMessageId) return; // Not a tracked message — ignore silently

    const newText = editedMsg.text?.trim() ?? "";
    const threadId = editedMsg.message_thread_id ?? 1;

    // Check if it's still queued (file in incoming/)
    const incomingDir = resolveIncomingForThread(threadId);
    const queueFile = path.join(incomingDir, `telegram_${queueMessageId}.json`);
    if (fs.existsSync(queueFile)) {
        if (newText === "") {
            // Empty edit = delete the queued message
            try {
                fs.unlinkSync(queueFile);
                pendingMessages.delete(queueMessageId);
                telegramToQueueId.delete(telegramMsgId);
                log("INFO", `Deleted queued message ${queueMessageId} (edited to empty)`);
                await bot.api.setMessageReaction(ctx.chat!.id, telegramMsgId,
                    [{ type: "emoji", emoji: "👌" as any }]).catch(() => {});
            } catch {
                log("WARN", `Failed to delete queued message file for ${queueMessageId}`);
            }
        } else {
            // Rewrite the queue file with updated text
            try {
                const raw = JSON.parse(fs.readFileSync(queueFile, "utf8"));
                raw.message = newText;
                const tmpFile = queueFile + ".tmp";
                fs.writeFileSync(tmpFile, JSON.stringify(raw, null, 2));
                fs.renameSync(tmpFile, queueFile);
                log("INFO", `Updated queued message ${queueMessageId}: ${newText.substring(0, 80)}`);
                await bot.api.setMessageReaction(ctx.chat!.id, telegramMsgId,
                    [{ type: "emoji", emoji: "✍" as any }]).catch(() => {});
            } catch {
                log("WARN", `Failed to rewrite queued message file for ${queueMessageId}`);
            }
        }
        return;
    }

    // Check if it's currently processing
    const processingDir = resolveZoneProcessingDir(threadId);
    const processingFile = path.join(processingDir, `telegram_${queueMessageId}.json`);
    if (fs.existsSync(processingFile)) {
        const pending = pendingMessages.get(queueMessageId);
        if (pending) {
            let originalText = "";
            try {
                const raw = JSON.parse(fs.readFileSync(processingFile, "utf8"));
                originalText = raw.message ?? "";
            } catch { /* best effort */ }

            const warning = originalText
                ? `⚠️ Edit received but already processing. Original text was:\n\n${originalText}`
                : `⚠️ Edit received but already processing.`;

            const threadOpt = getThreadOpt(pending);
            await bot.api.sendMessage(
                pending.chatId,
                warning,
                {
                    message_thread_id: threadOpt,
                    reply_parameters: { message_id: telegramMsgId },
                },
            ).catch(() => {});
        }
        return;
    }

    // Already done — ignore silently
});

// ─── Model Reaction Emoji (single source of truth) ───

// ⚡ haiku (fast), ✍ sonnet (writing), 🔥 opus (fire), 🤡 budget mode (minimax via Fireworks)
const MODEL_REACTIONS: Record<string, string> = {
    haiku: "⚡",
    sonnet: "✍",
    opus: "🔥",
    "accounts/fireworks/models/minimax-m2p5": "🤡",
};

// Derived: emoji → model reverse map
const EMOJI_TO_MODEL: Record<string, string> = Object.fromEntries(
    Object.entries(MODEL_REACTIONS).map(([model, emoji]) => [emoji, model]),
);

// Derived: valid model names for validation
const VALID_MODELS = new Set(Object.keys(MODEL_REACTIONS));

async function reactWithModel(chatId: string | number, messageId: number, model?: string): Promise<void> {
    if (!model) return;
    const baseModel = model.replace("[1m]", "");
    const emoji = MODEL_REACTIONS[baseModel];
    if (!emoji) return;
    try {
        await bot.api.setMessageReaction(chatId, messageId,
            [{ type: "emoji", emoji: emoji as any }]);
    } catch (err) {
        log("WARN", `Failed to set reaction ${emoji} on message ${messageId}: ${toErrorMessage(err)}`);
    }
}

// ─── Outgoing Queue Polling ───

let outgoingPollActive = false;
let statusPollActive = false;

async function pollOutgoingQueue(): Promise<void> {
    if (outgoingPollActive) return;
    outgoingPollActive = true;
    try {
        // In infra mode, poll all zone outgoing queues; in single-container, just one
        const outgoingDirs = getOutgoingQueueDirs();
        const allFiles: Array<{ file: string; filePath: string }> = [];
        for (const dir of outgoingDirs) {
            if (!fs.existsSync(dir)) continue;
            const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
            for (const file of files) {
                allFiles.push({ file, filePath: path.join(dir, file) });
            }
        }

        for (const { file, filePath } of allFiles) {

            try {
                const data: OutgoingMessage = JSON.parse(fs.readFileSync(filePath, "utf8"));

                let firstSentId: number | undefined;

                if (data.crossThread && data.targetThreadId && data.sourceThreadId) {
                    // Cross-thread message: infra handles zone routing
                    const zoneConfig = loadZoneConfig(ZONE_CONFIG_PATH);
                    const crossZone = zoneConfig && !isSameZone(zoneConfig, data.sourceThreadId, data.targetThreadId);

                    if (crossZone) {
                        // Cross-zone: write to pending queue + show approval keyboard, then skip display
                        const sourceZone = getThreadZone(zoneConfig!, data.sourceThreadId);
                        const targetZone = getThreadZone(zoneConfig!, data.targetThreadId);
                        const pendingId = data.messageId.replace(/_tg$/, "");
                        const threads = loadThreads();
                        const sourceName = data.sender || threads[String(data.sourceThreadId)]?.name || `Thread ${data.sourceThreadId}`;
                        const targetName = threads[String(data.targetThreadId)]?.name || `Thread ${data.targetThreadId}`;

                        const pending: PendingApproval = {
                            id: pendingId,
                            sourceThreadId: data.sourceThreadId,
                            targetThreadId: data.targetThreadId,
                            sourceZone,
                            targetZone,
                            senderName: sourceName,
                            targetName,
                            message: data.message,
                            timestamp: data.timestamp,
                        };

                        // Write pending file to infra's pending queue
                        const pendingDir = path.join(SCRIPT_DIR, ".borg-infra/queue/pending");
                        fs.mkdirSync(pendingDir, { recursive: true });
                        const pendTmp = path.join(pendingDir, `${pendingId}.json.tmp`);
                        const pendFinal = path.join(pendingDir, `${pendingId}.json`);
                        fs.writeFileSync(pendTmp, JSON.stringify(pending));
                        fs.renameSync(pendTmp, pendFinal);

                        // Show approval keyboard in master thread
                        const chatId = settings.telegram_chat_id;
                        const preview = data.message.length > 200
                            ? data.message.substring(0, 200) + "..."
                            : data.message;
                        const approvalText = [
                            `🔒 *Cross\\-zone message pending approval*`,
                            ``,
                            `*From:* ${escapeMarkdownV2(sourceName)}`,
                            `*To:* ${escapeMarkdownV2(targetName)}`,
                            ``,
                            `${escapeMarkdownV2(preview)}`,
                        ].join("\n");
                        const keyboard = new InlineKeyboard()
                            .text("✅ Approve", `zone_approve:${pendingId}`)
                            .text("❌ Reject", `zone_reject:${pendingId}`);

                        try {
                            const sent = await bot.api.sendMessage(chatId, approvalText, {
                                parse_mode: "MarkdownV2",
                                reply_markup: keyboard,
                            });
                            try {
                                pending.telegramMessageId = sent.message_id;
                                const tmp2 = pendFinal + ".tmp";
                                fs.writeFileSync(tmp2, JSON.stringify(pending));
                                fs.renameSync(tmp2, pendFinal);
                            } catch { /* non-fatal */ }
                            log("INFO", `Cross-zone approval keyboard shown for ${pendingId} (${sourceZone} → ${targetZone})`);
                        } catch (err) {
                            log("ERROR", `Failed to show cross-zone approval: ${toErrorMessage(err)}`);
                        }

                        // Done — delete outgoing file and skip Telegram display
                        try { fs.unlinkSync(filePath); } catch { /* already processed */ }
                        continue;
                    }

                    // Same zone: deliver to target zone's incoming queue, then fall through to display
                    const incomingId = data.messageId.replace(/_tg$/, "");
                    const targetZone = zoneConfig ? getThreadZone(zoneConfig, data.targetThreadId) : "core";
                    const targetIncoming = resolveZoneIncoming(targetZone);

                    const incoming = {
                        channel: "telegram",
                        source: "cross-thread",
                        threadId: data.targetThreadId,
                        sourceThreadId: data.sourceThreadId,
                        sender: data.sender,
                        message: data.message,
                        timestamp: data.timestamp,
                        messageId: incomingId,
                    };

                    fs.mkdirSync(targetIncoming, { recursive: true });
                    const inTmp = path.join(targetIncoming, `${incomingId}.json.tmp`);
                    const inFinal = path.join(targetIncoming, `${incomingId}.json`);
                    fs.writeFileSync(inTmp, JSON.stringify(incoming));
                    fs.renameSync(inTmp, inFinal);
                }

                if (data.targetThreadId) {
                    // Cross-thread message: post to the target topic
                    const chatId = settings.telegram_chat_id;

                    // Convert GFM markdown to Telegram MarkdownV2, with optional cross-thread indicator
                    let markdownV2Text = toTelegramMarkdownV2(data.message);
                    if (data.sourceThreadId) {
                        const threads = loadThreads();
                        const sourceThread = threads[String(data.sourceThreadId)];
                        const sourceThreadName = sourceThread?.name || `thread ${data.sourceThreadId}`;
                        // Build indicator directly in MarkdownV2 (escape dynamic parts to avoid italic/special char issues)
                        const indicator = `📨 _From ${escapeMarkdownV2(data.sender || "unknown")} in ${escapeMarkdownV2(sourceThreadName)}_`;
                        markdownV2Text = `${indicator}\n\n${markdownV2Text}`;
                    }
                    const chunks = splitMessage(markdownV2Text);

                    const threadOpt = data.targetThreadId !== 1
                        ? { message_thread_id: data.targetThreadId }
                        : {};

                    // Register pending message BEFORE sending to ensure typing indicator
                    // and status updates work immediately when queue-processor starts work.
                    // We'll update with the actual Telegram message ID after sending.
                    const chatIdNum = Number(chatId);
                    const incomingId = data.messageId.replace(/_tg$/, "");
                    if (Number.isFinite(chatIdNum)) {
                        pendingMessages.set(incomingId, {
                            chatId: chatIdNum,
                            threadId: data.targetThreadId,
                            telegramMessageId: -1, // Temporary - will be updated below
                        });
                    }

                    for (const chunk of chunks) {
                        const sent = await bot.api.sendMessage(chatId, chunk, { ...threadOpt, parse_mode: "MarkdownV2" });
                        if (!firstSentId) {
                            firstSentId = sent.message_id;
                            // Store full text ONLY for multi-segment messages, on the first segment
                            if (data.model && chunks.length > 1) {
                                storeMessageModel(sent.message_id, data.model, data.targetThreadId, data.message);
                                await reactWithModel(chatId, sent.message_id, data.model);
                            } else if (data.model) {
                                storeMessageModel(sent.message_id, data.model, data.targetThreadId);
                                await reactWithModel(chatId, sent.message_id, data.model);
                            }
                        } else if (data.model) {
                            storeMessageModel(sent.message_id, data.model, data.targetThreadId);
                            await reactWithModel(chatId, sent.message_id, data.model);
                        }
                    }

                    // Update pending message with actual Telegram message ID
                    if (firstSentId && Number.isFinite(chatIdNum)) {
                        const pending = pendingMessages.get(incomingId);
                        if (pending) {
                            pending.telegramMessageId = firstSentId;
                        }
                    }

                    log(
                        "INFO",
                        `Cross-thread message sent to thread ${data.targetThreadId} (${chunks.length} chunk(s))`,
                    );
                } else {
                    // Standard response: find the pending message and reply
                    const pending = pendingMessages.get(data.messageId);

                    if (pending) {
                        // Delete status file FIRST to prevent pollStatusFiles from overwriting final response
                        try {
                            const statusFile = findStatusFile(data.messageId);
                            if (statusFile) fs.unlinkSync(statusFile);
                        } catch { /* may not exist */ }

                        // Convert Claude's GFM output to Telegram MarkdownV2
                        const markdownV2Response = toTelegramMarkdownV2(data.message);
                        const chunks = splitMessage(markdownV2Response);

                        // Delete the silent status message so the final response
                        // arrives as a fresh message with a normal notification
                        if (pending.statusMessageId) {
                            try {
                                await bot.api.deleteMessage(pending.chatId, pending.statusMessageId);
                            } catch { /* may already be deleted */ }
                        }

                        // Send all chunks as new messages, replying to the user's original
                        const replyParams = pending.telegramMessageId > 0
                            ? { reply_parameters: { message_id: pending.telegramMessageId } }
                            : {};
                        for (let i = 0; i < chunks.length; i++) {
                            const opts: Record<string, unknown> = {
                                message_thread_id: getThreadOpt(pending),
                                parse_mode: "MarkdownV2" as const,
                                ...(i === 0 ? replyParams : {}),
                            };
                            const sent = await bot.api.sendMessage(
                                pending.chatId,
                                chunks[i],
                                opts,
                            );
                            if (i === 0) {
                                firstSentId = sent.message_id;
                                if (data.model) {
                                    storeMessageModel(sent.message_id, data.model, data.threadId, data.message);
                                    await reactWithModel(pending.chatId, sent.message_id, data.model);
                                }
                            } else if (data.model) {
                                storeMessageModel(sent.message_id, data.model, data.threadId);
                            }
                        }

                        // Add buttons to the first response message (user-facing only)
                        if (firstSentId) {
                            try {
                                const keyboard = buildReplyKeyboard(firstSentId, data.replyToMessageId, data.replyToVoice);
                                await bot.api.editMessageReplyMarkup(pending.chatId, firstSentId, {
                                    reply_markup: keyboard,
                                });
                            } catch { /* Buttons are best-effort */ }
                        }

                        telegramToQueueId.delete(pending.telegramMessageId);
                        pendingMessages.delete(data.messageId);
                        log(
                            "INFO",
                            `Response sent to ${data.sender} in thread ${pending.threadId} (${chunks.length} chunk(s))`,
                        );
                    } else {
                        log(
                            "WARN",
                            `No pending message found for messageId ${data.messageId}, sending to chat directly`,
                        );

                        // Fallback: send to the configured chat, routing to the correct thread
                        const chatId = settings.telegram_chat_id;
                        // Frame scheduled task output for human readability
                        const messageToSend = data.scheduledTaskName
                            ? `**Scheduled task "${data.scheduledTaskName}"**\n\n${data.message}`
                            : data.message;
                        const markdownV2Fallback = toTelegramMarkdownV2(messageToSend);
                        const chunks = splitMessage(markdownV2Fallback);
                        const threadOpt = data.threadId && data.threadId !== 1
                            ? { message_thread_id: data.threadId }
                            : {};

                        for (const chunk of chunks) {
                            const sent = await bot.api.sendMessage(chatId, chunk, { ...threadOpt, parse_mode: "MarkdownV2" });
                            if (!firstSentId) {
                                firstSentId = sent.message_id;
                                // Store full text ONLY for multi-segment messages, on the first segment
                                if (data.model && chunks.length > 1) {
                                    storeMessageModel(sent.message_id, data.model, data.threadId, data.message);
                                    await reactWithModel(chatId, sent.message_id, data.model);
                                } else if (data.model) {
                                    storeMessageModel(sent.message_id, data.model, data.threadId);
                                    await reactWithModel(chatId, sent.message_id, data.model);
                                }
                            } else if (data.model) {
                                storeMessageModel(sent.message_id, data.model, data.threadId);
                                await reactWithModel(chatId, sent.message_id, data.model);
                            }
                        }

                        if (firstSentId) {
                            try {
                                const keyboard = buildReplyKeyboard(firstSentId, data.replyToMessageId, data.replyToVoice);
                                await bot.api.editMessageReplyMarkup(settings.telegram_chat_id, firstSentId, {
                                    reply_markup: keyboard,
                                });
                            } catch { /* Buttons are best-effort */ }
                        }
                    }
                }

                // Log routing decision (only on successful send with routing metadata)
                if (data.routingMetadata && firstSentId) {
                    const parsed = RoutingMetadataSchema.safeParse(data.routingMetadata);
                    if (parsed.success) {
                        try {
                            logDecision(parsed.data, firstSentId, data.threadId, ROUTING_LOG);
                        } catch (err) {
                            log("ERROR", `Failed to log routing decision: ${err}`);
                        }
                    }
                }

                // Delete the queue file after processing
                fs.unlinkSync(filePath);
            } catch (err) {
                const errMsg = toErrorMessage(err);
                log("ERROR", `Failed to process outgoing file ${file}: ${errMsg}`);

                // Classify the error and handle accordingly
                if (errMsg.includes("can't parse entities")) {
                    // Bad markdown — retry without parse_mode (plain text fallback)
                    log("INFO", `Retrying ${file} as plain text (stripping markdown)...`);
                    try {
                        const data: OutgoingMessage = JSON.parse(fs.readFileSync(filePath, "utf8"));
                        // Log the failure for later analysis (to improve the converter)
                        const converted = toTelegramMarkdownV2(data.message);
                        logMarkdownParseFailure(data.message, converted, errMsg, {
                            messageId: data.messageId,
                            threadId: data.targetThreadId,
                            source: "response", // could be "response", "transcript", "summary"
                        });
                        const chatId = settings.telegram_chat_id;
                        const threadId = data.targetThreadId || data.threadId;
                        const threadOpt = threadId && threadId !== 1
                            ? { message_thread_id: threadId }
                            : {};

                        let messageText = data.message;
                        if (data.sourceThreadId) {
                            const threads = loadThreads();
                            const sourceThread = threads[String(data.sourceThreadId)];
                            const sourceThreadName = sourceThread?.name || `thread ${data.sourceThreadId}`;
                            messageText = `📨 From ${data.sender} in ${sourceThreadName}\n\n${data.message}`;
                        }

                        const chunks = splitMessage(messageText);
                        for (const chunk of chunks) {
                            await bot.api.sendMessage(chatId, chunk, threadOpt);
                        }

                        fs.unlinkSync(filePath);
                        log("INFO", `Plain text fallback succeeded for ${file}`);
                    } catch (retryErr) {
                        log("ERROR", `Plain text retry also failed for ${file}: ${toErrorMessage(retryErr)}`);
                        moveToDeadLetter(filePath, file);
                    }
                } else if (
                    errMsg.includes("message thread not found") ||
                    errMsg.includes("chat not found") ||
                    errMsg.includes("bot was blocked") ||
                    errMsg.includes("400:")
                ) {
                    // Permanent failure — dead-letter immediately
                    moveToDeadLetter(filePath, file);
                } else {
                    // Transient failure — track retries via a simple counter file
                    const retryFile = `${filePath}.retries`;
                    let retries = 0;
                    try {
                        retries = parseInt(fs.readFileSync(retryFile, "utf8"), 10) || 0;
                    } catch { /* no retry file yet */ }
                    retries++;
                    if (retries >= 3) {
                        moveToDeadLetter(filePath, file);
                        try { fs.unlinkSync(retryFile); } catch { /* ignore */ }
                    } else {
                        fs.writeFileSync(retryFile, String(retries));
                        log("WARN", `Transient failure for ${file}, retry ${retries}/3`);
                    }
                }
            }
        }
    } catch (err) {
        log("ERROR", `Outgoing queue poll error: ${toErrorMessage(err)}`);
    } finally {
        outgoingPollActive = false;
    }
}

function moveToDeadLetter(filePath: string, filename: string): void {
    try {
        const deadLetterPath = path.join(QUEUE_DEAD_LETTER, `${Date.now()}_${filename}`);
        fs.renameSync(filePath, deadLetterPath);
        log("WARN", `Moved to dead-letter: ${filename}`);
    } catch (moveErr) {
        log("ERROR", `Failed to move ${filename} to dead-letter: ${toErrorMessage(moveErr)}`);
        try { fs.unlinkSync(filePath); } catch { /* last resort */ }
    }
}

// ─── Pending Message Cleanup ───

function cleanupPendingMessages(): void {
    const now = Date.now();
    const timeout = 24 * 60 * 60 * 1000; // 24 hours

    for (const [messageId, pending] of pendingMessages) {
        // User messages: "{ts}_{rand}", cross-thread: "cross_{ts}_{rand}"
        const parts = messageId.split("_");
        const tsStr = messageId.startsWith("cross_") ? parts[1] : parts[0];
        const timestamp = parseInt(tsStr, 10);

        if (!Number.isFinite(timestamp) || now - timestamp > timeout) {
            // Delete Telegram status message if it exists
            if (pending.statusMessageId) {
                bot.api.deleteMessage(pending.chatId, pending.statusMessageId).catch(() => {});
            }
            // Delete status file if it exists
            try {
                const statusFile = findStatusFile(messageId);
                if (statusFile) fs.unlinkSync(statusFile);
            } catch { /* best effort */ }

            telegramToQueueId.delete(pending.telegramMessageId);
            pendingMessages.delete(messageId);
            log("DEBUG", `Cleaned up stale pending message: ${messageId}`);
        }
    }
}

/**
 * Find a status file by messageId across all zone status directories.
 * Returns the full path if found, null otherwise.
 */
function findStatusFile(messageId: string): string | null {
    for (const dir of ZONE_STATUS_DIRS) {
        const filePath = path.join(dir, `${messageId}.json`);
        if (fs.existsSync(filePath)) return filePath;
    }
    return null;
}

// ─── Status File Polling ───

async function pollStatusFiles(): Promise<void> {
    if (statusPollActive) return;
    statusPollActive = true;
    try {
    for (const [messageId, pending] of pendingMessages) {
        const statusFile = findStatusFile(messageId);

        let statusData: { label: string; ts: number; startTs: number; preview?: string };
        try {
            if (!statusFile) continue;
            statusData = JSON.parse(fs.readFileSync(statusFile, "utf8"));
            if (!statusData.label || !statusData.startTs) continue; // invalid format
        } catch {
            continue; // File may be mid-write or already deleted
        }

        // Compute elapsed time from processing start
        const elapsed = Math.round((Date.now() - statusData.startTs) / 1000);

        // Detect stalled processing (queue processor refreshes every 2s during SDK work;
        // STT/Listening has no refresh interval so use a longer threshold)
        const stalledThreshold = statusData.label === "Listening" ? 180_000 : 15_000;
        const isStale = Date.now() - statusData.ts > stalledThreshold;
        let statusLine = isStale
            ? `🕐 ${statusData.label}... — stalled`
            : `🕐 ${statusData.label}... (${elapsed}s)`;

        // Append preview text from latest assistant message (if available)
        const previewText = statusData.preview;
        let displayText: string;
        if (previewText) {
            // Truncate preview for Telegram message limits — show tail (latest text)
            const maxPreview = 500;
            const truncated = previewText.length > maxPreview
                ? "…" + previewText.slice(-maxPreview)
                : previewText;
            displayText = `${statusLine}\n\n💬 ${truncated}\n\n[still processing...]`;
        } else {
            displayText = statusLine;
        }

        // Check if anything changed (status line, preview, or stale state)
        const previewChanged = previewText !== pending.lastPreview;
        const labelChanged = statusData.label !== pending.lastStatusLabel;
        const timeSinceLastEdit = Date.now() - (pending.lastEditTs ?? 0);

        // Skip if nothing has changed
        if (displayText === pending.lastStatusText) continue;

        // Throttle: label/preview changes edit immediately, timer-only throttle to 20s
        if (!labelChanged && !previewChanged && !isStale && timeSinceLastEdit < 20_000) continue;

        const cancelKeyboard = statusData.label !== "Cancelled"
            ? new InlineKeyboard().text("✕ Cancel", `cancel:${messageId}`)
            : undefined;

        try {
            if (pending.statusMessageId) {
                // Edit existing status message
                await bot.api.editMessageText(
                    pending.chatId,
                    pending.statusMessageId,
                    displayText,
                    {
                        reply_markup: cancelKeyboard,
                    },
                );
            } else {
                // Send new status message as reply to original
                const replyOpts = pending.telegramMessageId > 0
                    ? { reply_parameters: { message_id: pending.telegramMessageId } }
                    : {};
                const sent = await bot.api.sendMessage(
                    pending.chatId,
                    displayText,
                    {
                        message_thread_id: getThreadOpt(pending),
                        reply_markup: cancelKeyboard,
                        disable_notification: true,
                        ...replyOpts,
                    },
                );
                pending.statusMessageId = sent.message_id;
            }
            pending.lastStatusText = displayText;
            pending.lastStatusLabel = statusData.label;
            pending.lastPreview = previewText;
            pending.lastEditTs = Date.now();
        } catch {
            // editMessageText may fail if message was deleted or content unchanged — ignore
        }
    }
    } finally {
        statusPollActive = false;
    }
}

// ─── Typing Indicator ───

// Telegram's typing action expires after ~5 seconds.
// Re-send every 4 seconds for all messages still being processed.
async function sendTypingForPending(): Promise<void> {
    for (const [, pending] of pendingMessages) {
        try {
            await bot.api.sendChatAction(pending.chatId, "typing", {
                message_thread_id: getThreadOpt(pending),
            });
        } catch {
            // Ignore errors — bot may not have started yet or chat may be unavailable
        }
    }
}

// ─── Reaction-Based Routing Feedback ───

bot.on("message_reaction", async (ctx) => {
    // Filter: correct chat
    if (!ctx.chat || String(ctx.chat.id) !== settings.telegram_chat_id) return;

    // Note: bot self-reactions do NOT trigger this handler (Telegram API guarantee)

    const messageId = ctx.messageReaction.message_id;
    const reactions = ctx.reactions();

    // Find model emoji in newly added reactions
    let correctedModel: string | undefined;
    for (const emoji of reactions.emojiAdded) {
        if (EMOJI_TO_MODEL[emoji]) {
            correctedModel = EMOJI_TO_MODEL[emoji];
            break;
        }
    }
    if (!correctedModel) return; // non-model emoji, ignore

    // Look up original model
    const stored = lookupMessageModel(messageId);
    if (!stored) {
        log("DEBUG", `Reaction on message ${messageId} — model entry not found (pruned or non-bot)`);
        return;
    }

    // Filter: must be different model (same model = not a correction)
    if (correctedModel === stored.model) return;

    // Validate model values before logging
    if (!VALID_MODELS.has(stored.model)) return;

    // Log correction
    logCorrection({
        ts: Date.now(),
        type: "correction",
        messageId,
        threadId: stored.threadId || undefined, // omit if 0 (unknown)
        originalModel: stored.model,
        correctedModel,
    }, ROUTING_LOG);

    log("INFO", `Routing correction: ${stored.model} → ${correctedModel} (msg ${messageId})`);
});

// ─── On-Demand TTS via Inline Keyboard ───

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // ─── Cancel Button (abort running SDK process) ───
    if (data.startsWith("cancel:")) {
        const queueMessageId = data.replace("cancel:", "");
        const pending = pendingMessages.get(queueMessageId);
        if (!pending) {
            await ctx.answerCallbackQuery({ text: "Processing already finished" });
            return;
        }

        // Write cancel signal file to the correct zone's cancel dir
        const cancelDir = resolveZoneCancelDir(pending.threadId);
        fs.mkdirSync(cancelDir, { recursive: true });
        const cancelFile = path.join(cancelDir, `${queueMessageId}.json`);
        const tmpFile = cancelFile + ".tmp";
        try {
            fs.writeFileSync(tmpFile, JSON.stringify({ ts: Date.now() }));
            fs.renameSync(tmpFile, cancelFile);
            await ctx.answerCallbackQuery({ text: "Cancelling..." });
            log("INFO", `Cancel signal written for ${queueMessageId} (thread ${pending.threadId})`);
        } catch {
            await ctx.answerCallbackQuery({ text: "Failed to cancel" });
        }
        return;
    }

    // ─── Listen Button (TTS of bot response) ───
    if (data.startsWith("listen:")) {
        const messageId = parseInt(data.replace("listen:", ""), 10);
        if (!Number.isFinite(messageId)) {
            await ctx.answerCallbackQuery({ text: "Invalid message reference" });
            return;
        }

        // Prevent duplicate processing
        if (listenInFlight.has(messageId)) {
            await ctx.answerCallbackQuery({ text: "Already generating voice..." });
            return;
        }

        // Try to get full text from cache first (for multi-segment messages)
        const messageModel = lookupMessageModel(messageId);
        const fullText = messageModel?.fullText || ctx.callbackQuery.message?.text;

        if (!fullText) {
            await ctx.answerCallbackQuery({ text: "❌ Message text not found" });
            return;
        }

        // Extract message context before async work
        const chatId = ctx.callbackQuery.message!.chat.id;  // safe: message exists (we got text from it or cache)
        const threadOpt = ctx.callbackQuery.message!.message_thread_id;

        listenInFlight.add(messageId);

        try {
            // Show loading feedback
            // Warn if message model exists but fullText is missing (cache eviction/old message)
            const isCacheEvicted = messageModel && !messageModel.fullText;
            if (isCacheEvicted) {
                await ctx.answerCallbackQuery({
                    text: "⚠️ Full text not available (message too old), playing first segment only",
                    show_alert: true
                });
            } else {
                await ctx.answerCallbackQuery({ text: "Generating voice..." });
            }

            // Check if Speaches is available
            const available = await isAvailable();
            if (!available) {
                await ctx.answerCallbackQuery({ text: "Voice service unavailable", show_alert: true });
                return;
            }

            // Send a placeholder status message
            const statusMsg = await ctx.api.sendMessage(chatId, "🎙 Dictating...", {
                message_thread_id: threadOpt,
                reply_parameters: { message_id: messageId },
            });

            // Distill long text into speech-friendly form
            const speechText = await distillForSpeech(fullText);

            // Synthesize speech
            const audioPath = await synthesize(speechText, settings.tts_voice, settings.tts_speed);

            // Replace the placeholder with voice
            try {
                await ctx.api.deleteMessage(chatId, statusMsg.message_id);
            } catch { /* best effort */ }
            await ctx.api.sendVoice(chatId, new InputFile(fs.createReadStream(audioPath)), {
                message_thread_id: threadOpt,
                reply_parameters: { message_id: messageId },
            });

            // Remove the Listen button
            try {
                await ctx.editMessageReplyMarkup({ reply_markup: undefined });
            } catch { /* message may have been edited already */ }

            // Clean up audio file
            cleanupAudioFile(audioPath);

            log("INFO", `TTS voice reply sent for message ${messageId}`);
        } catch (err) {
            log("ERROR", `TTS callback failed for message ${messageId}: ${toErrorMessage(err)}`);
            // Try to notify user of the error
            try {
                await ctx.answerCallbackQuery({ text: "Couldn't generate voice. Try again later.", show_alert: true });
            } catch { /* callback may have already been answered */ }
        } finally {
            listenInFlight.delete(messageId);
        }
        return;
    }

    // ─── Voice Full Button (full transcript of user's voice message) ───
    if (data.startsWith("voice_full:")) {
        const voiceMessageId = data.replace("voice_full:", "");

        // Prevent duplicate processing
        if (voiceButtonsInFlight.has(voiceMessageId)) {
            await ctx.answerCallbackQuery({ text: "Processing..." });
            return;
        }

        voiceButtonsInFlight.add(voiceMessageId);

        try {
            const { getVoiceTranscript } = await import("./voice-cache.js");
            const transcript = getVoiceTranscript(voiceMessageId);

            if (!transcript) {
                await ctx.answerCallbackQuery({
                    text: "Transcript not available (may have been pruned after 1000 messages)",
                    show_alert: true
                });
                return;
            }

            // Answer the callback query first
            await ctx.answerCallbackQuery({ text: "Sending transcript..." });

            // Send transcript as a reply
            const chatId = ctx.callbackQuery.message!.chat.id;
            const threadOpt = ctx.callbackQuery.message!.message_thread_id;
            const fullText = toTelegramMarkdownV2(`**Full Text:**\n${transcript}`);
            const chunks = splitMessage(fullText);

            for (let i = 0; i < chunks.length; i++) {
                await ctx.api.sendMessage(chatId, chunks[i], {
                    message_thread_id: threadOpt,
                    parse_mode: "MarkdownV2",
                    // Reply to original voice message on first chunk
                    ...(i === 0 ? { reply_parameters: { message_id: Number(voiceMessageId) } } : {}),
                });
            }

            log("INFO", `Sent full transcript for voice message ${voiceMessageId}`);
        } catch (err) {
            log("ERROR", `Voice full callback failed for message ${voiceMessageId}: ${toErrorMessage(err)}`);
            try {
                await ctx.answerCallbackQuery({ text: "Error retrieving transcript", show_alert: true });
            } catch { /* callback may have already been answered */ }
        } finally {
            voiceButtonsInFlight.delete(voiceMessageId);
        }
        return;
    }

    // ─── Voice Summary Button (sonnet-summarized user transcript) ───
    if (data.startsWith("voice_summary:")) {
        const voiceMessageId = data.replace("voice_summary:", "");

        // Prevent duplicate processing
        if (voiceButtonsInFlight.has(voiceMessageId)) {
            await ctx.answerCallbackQuery({ text: "Processing..." });
            return;
        }

        voiceButtonsInFlight.add(voiceMessageId);

        try {
            const { getVoiceTranscript } = await import("./voice-cache.js");
            const transcript = getVoiceTranscript(voiceMessageId);

            if (!transcript) {
                await ctx.answerCallbackQuery({
                    text: "Transcript not available (may have been pruned after 1000 messages)",
                    show_alert: true
                });
                return;
            }

            // Answer the callback query first
            await ctx.answerCallbackQuery({ text: "Generating summary..." });

            // Distill transcript into summary
            const { distillForReading } = await import("./audio.js");
            const summary = await distillForReading(transcript);

            // Send summary as a reply
            const chatId = ctx.callbackQuery.message!.chat.id;
            const threadOpt = ctx.callbackQuery.message!.message_thread_id;

            await ctx.api.sendMessage(chatId, toTelegramMarkdownV2(`**Summary:**\n${summary}`), {
                message_thread_id: threadOpt,
                parse_mode: "MarkdownV2",
                reply_parameters: { message_id: Number(voiceMessageId) },
            });

            log("INFO", `Sent summary for voice message ${voiceMessageId}`);
        } catch (err) {
            log("ERROR", `Voice summary callback failed for message ${voiceMessageId}: ${toErrorMessage(err)}`);
            try {
                await ctx.answerCallbackQuery({ text: "Error generating summary", show_alert: true });
            } catch { /* callback may have already been answered */ }
        } finally {
            voiceButtonsInFlight.delete(voiceMessageId);
        }
        return;
    }

    // ─── Cross-Zone Approval ───
    if (data.startsWith("zone_approve:") || data.startsWith("zone_reject:")) {
        const isApprove = data.startsWith("zone_approve:");
        const pendingId = data.replace(/^zone_(approve|reject):/, "");
        const pendingFile = findPendingFile(pendingId);
        if (!pendingFile) {
            await ctx.answerCallbackQuery({ text: "This approval has already been handled", show_alert: true });
            return;
        }
        const processingFile = pendingFile.replace(/\.json$/, ".processing");

        try {
            // Atomic claim: rename to .processing to prevent double-delivery race
            try {
                fs.renameSync(pendingFile, processingFile);
            } catch {
                await ctx.answerCallbackQuery({ text: "This approval has already been handled", show_alert: true });
                return;
            }

            const pending: PendingApproval = JSON.parse(fs.readFileSync(processingFile, "utf8"));

            if (isApprove) {
                // Resolve target zone's queue paths (zone-aware for infra container)
                const targetIncoming = resolveZoneIncoming(pending.targetZone);
                const targetOutgoing = resolveZoneOutgoing(pending.targetZone);

                // Deliver the message: write to target zone's incoming queue
                const incoming = {
                    channel: "telegram",
                    source: "cross-thread" as const,
                    threadId: pending.targetThreadId,
                    sourceThreadId: pending.sourceThreadId,
                    sender: pending.senderName,
                    message: pending.message,
                    timestamp: Date.now(),
                    messageId: pending.id,
                };

                fs.mkdirSync(targetIncoming, { recursive: true });
                const inTmp = path.join(targetIncoming, `${pending.id}.json.tmp`);
                const inFinal = path.join(targetIncoming, `${pending.id}.json`);
                fs.writeFileSync(inTmp, JSON.stringify(incoming));
                fs.renameSync(inTmp, inFinal);

                // Also write outgoing for display in target thread
                const outgoing = {
                    channel: "telegram",
                    targetThreadId: pending.targetThreadId,
                    sourceThreadId: pending.sourceThreadId,
                    sender: pending.senderName,
                    message: pending.message,
                    originalMessage: "",
                    timestamp: Date.now(),
                    messageId: `${pending.id}_approved_tg`,
                    model: "",
                };

                fs.mkdirSync(targetOutgoing, { recursive: true });
                const outTmp = path.join(targetOutgoing, `${pending.id}_approved_tg.json.tmp`);
                const outFinal = path.join(targetOutgoing, `${pending.id}_approved_tg.json`);
                fs.writeFileSync(outTmp, JSON.stringify(outgoing));
                fs.renameSync(outTmp, outFinal);

                // Remove processing file
                try { fs.unlinkSync(processingFile); } catch { /* best effort */ }

                // Update the approval message
                await ctx.answerCallbackQuery({ text: "Message approved and delivered" });
                try {
                    await ctx.editMessageText(
                        `✅ *Approved* — message from ${escapeMarkdownV2(pending.senderName)} delivered to ${escapeMarkdownV2(pending.targetName)}`,
                        { parse_mode: "MarkdownV2" },
                    );
                } catch { /* best effort */ }

                log("INFO", `Cross-zone message ${pendingId} approved: ${pending.sourceZone} → ${pending.targetZone}`);
            } else {
                // Resolve sender zone's incoming queue for rejection notice
                const senderIncoming = resolveZoneIncoming(pending.sourceZone);

                // Reject: notify sender
                const rejection = {
                    channel: "telegram",
                    source: "system" as const,
                    threadId: pending.sourceThreadId,
                    sender: "System",
                    message: `Your cross-zone message to thread ${pending.targetThreadId} (${pending.targetName}) was rejected by a human reviewer.`,
                    timestamp: Date.now(),
                    messageId: `${pending.id}_rejected`,
                };

                fs.mkdirSync(senderIncoming, { recursive: true });
                const rejTmp = path.join(senderIncoming, `${pending.id}_rejected.json.tmp`);
                const rejFinal = path.join(senderIncoming, `${pending.id}_rejected.json`);
                fs.writeFileSync(rejTmp, JSON.stringify(rejection));
                fs.renameSync(rejTmp, rejFinal);

                // Remove processing file
                try { fs.unlinkSync(processingFile); } catch { /* best effort */ }

                // Update the approval message
                await ctx.answerCallbackQuery({ text: "Message rejected" });
                try {
                    await ctx.editMessageText(
                        `❌ *Rejected* — message from ${escapeMarkdownV2(pending.senderName)} to ${escapeMarkdownV2(pending.targetName)} was rejected`,
                        { parse_mode: "MarkdownV2" },
                    );
                } catch { /* best effort */ }

                log("INFO", `Cross-zone message ${pendingId} rejected: ${pending.sourceZone} → ${pending.targetZone}`);
            }
        } catch (err) {
            // On error, try to move back from processing to pending for retry
            try { fs.renameSync(processingFile, pendingFile); } catch { /* may already be gone */ }
            log("ERROR", `Zone approval callback failed for ${pendingId}: ${toErrorMessage(err)}`);
            try {
                await ctx.answerCallbackQuery({ text: "Error processing approval", show_alert: true });
            } catch { /* callback may have already been answered */ }
        }
        return;
    }
});

// ─── Task Pin Polling ───

async function pollTaskUpdates(): Promise<void> {
    try {
        // Read the mapping file written by queue-processor
        let mapping: TaskListMapping = {};
        try {
            mapping = JSON.parse(fs.readFileSync(TASK_LISTS_FILE, "utf8"));
        } catch {
            return; // No mapping yet
        }

        const pins = loadTaskPins();
        let pinsChanged = false;

        for (const [taskListId, info] of Object.entries(mapping)) {
            const taskDir = path.join(CLAUDE_TASKS_DIR, taskListId);

            // Check mtime to avoid re-reading unchanged directories
            try {
                const mtime = fs.statSync(taskDir).mtimeMs;
                if (taskDirMtimes.get(taskListId) === mtime) continue;
                taskDirMtimes.set(taskListId, mtime);
            } catch {
                continue; // Directory doesn't exist yet
            }

            const tasks = readTasksFromDir(taskDir);
            if (tasks.length === 0) continue;

            const content = formatTaskMessage(tasks, settings.timezone);

            // Update pinned message in each thread that uses this task list
            for (const threadId of info.threadIds) {
                // Skip if content hasn't changed for this thread
                if (lastPinnedContent.get(threadId) === content) continue;

                const pinKey = String(threadId);

                try {
                    if (pins[pinKey]) {
                        // Update existing pinned message
                        await bot.api.editMessageText(
                            settings.telegram_chat_id,
                            pins[pinKey],
                            content,
                        );
                    } else {
                        // Create new pinned message
                        const msg = await bot.api.sendMessage(
                            settings.telegram_chat_id,
                            content,
                            { message_thread_id: threadId },
                        );
                        await bot.api.pinChatMessage(
                            settings.telegram_chat_id,
                            msg.message_id,
                            { disable_notification: true },
                        );
                        pins[pinKey] = msg.message_id;
                        pinsChanged = true;
                    }
                    lastPinnedContent.set(threadId, content);
                } catch (err) {
                    // "message is not modified" is expected when content is the same
                    const errMsg = err instanceof Error ? err.message : String(err);
                    if (!errMsg.includes("message is not modified")) {
                        log("WARN", `Task pin update failed for thread ${threadId}: ${errMsg}`);
                    }
                }
            }
        }

        if (pinsChanged) {
            saveTaskPins(pins);
        }
    } catch (err) {
        // Task polling is best-effort
        log("WARN", `Task poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// ─── Error Handler ───

bot.catch((err) => {
    log("ERROR", `Bot error: ${err.message}`);
});

// ─── Graceful Shutdown ───

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

// ─── Cross-Zone Pending Approval Reminder ───

let lastReminderDate = "";

async function checkPendingApprovalReminder(): Promise<void> {
    // Only send once per day
    const today = new Date().toISOString().slice(0, 10);
    if (today === lastReminderDate) return;

    const pendingDirs = getPendingQueueDirs();
    const pendingItems: Array<PendingApproval & { age: string }> = [];
    for (const dir of pendingDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
        for (const file of files) {
            try {
                const data: PendingApproval = JSON.parse(
                    fs.readFileSync(path.join(dir, file), "utf8"),
                );
                const ageMs = Date.now() - data.timestamp;
                const ageHours = Math.floor(ageMs / 3600000);
                const age = ageHours < 24 ? `${ageHours}h` : `${Math.floor(ageHours / 24)}d`;
                pendingItems.push({ ...data, age });
            } catch { /* skip malformed files */ }
        }
    }

    if (pendingItems.length === 0) return;

    const chatId = settings.telegram_chat_id;
    const lines = [
        `🔒 *${pendingItems.length} cross\\-zone message\\(s\\) pending approval:*`,
        "",
    ];

    for (const item of pendingItems) {
        const preview = item.message.length > 80
            ? item.message.substring(0, 80) + "..."
            : item.message;
        let line = `• ${escapeMarkdownV2(item.senderName)} → ${escapeMarkdownV2(item.targetName)} \\(${escapeMarkdownV2(item.age)} ago\\): ${escapeMarkdownV2(preview)}`;
        if (item.telegramMessageId) {
            // Add deep link to the approval message
            line += ` [→ approve](https://t.me/c/${chatId.replace("-100", "")}/${item.telegramMessageId})`;
        }
        lines.push(line);
    }

    try {
        // Send to master thread — find it from threads.json
        const threads = loadThreads();
        const masterEntry = Object.entries(threads).find(([, t]) => t.isMaster);
        const masterThreadId = masterEntry ? Number(masterEntry[0]) : undefined;
        const threadOpt = masterThreadId && masterThreadId !== 1
            ? { message_thread_id: masterThreadId }
            : {};

        await bot.api.sendMessage(chatId, lines.join("\n"), {
            parse_mode: "MarkdownV2",
            ...threadOpt,
        });
        lastReminderDate = today;
        log("INFO", `Sent daily reminder for ${pendingItems.length} pending cross-zone approval(s)`);
    } catch (err) {
        log("ERROR", `Failed to send pending approval reminder: ${toErrorMessage(err)}`);
    }
}

// ─── Start ───

// Poll outgoing queue every 1 second
setInterval(pollOutgoingQueue, 1000);

// Send typing indicator every 4 seconds for pending messages
setInterval(sendTypingForPending, 4000);

// Clean up stale pending messages every 60 seconds
setInterval(cleanupPendingMessages, 60_000);

// Poll status files every 2 seconds for tool use visibility
setInterval(pollStatusFiles, 2000);

// Start periodic audio file cleanup
startPeriodicCleanup();

// Start periodic image file cleanup
startImageCleanup();

// Check for pending cross-zone approvals every hour (sends daily reminder)
setInterval(checkPendingApprovalReminder, 3600_000);
// Also check shortly after startup
setTimeout(checkPendingApprovalReminder, 30_000);

// Ensure Speaches models are installed (fire-and-forget, cached across restarts)
ensureModels().catch(() => {});

bot.start({
    allowed_updates: [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, "message_reaction"],
    onStart: async () => {
        await bot.api.setMyCommands([
            { command: "clear", description: "Reset session (recent history preserved)" },
            { command: "compact", description: "Reset session (recent history preserved)" },
            { command: "model", description: "Set thread model: /model <haiku|sonnet|opus>" },
            { command: "setdir", description: "Set working directory for this thread" },
            { command: "budget_on", description: "Enable budget mode (cheap model)" },
            { command: "budget_off", description: "Disable budget mode" },
            { command: "status", description: "Show all active threads and their status" },
            { command: "clear_team", description: "Reset all team member sessions" },
            { command: "compact_team", description: "Reset all team member sessions" },
            { command: "do", description: "One-shot query: /do [haiku|sonnet|opus] <message>" },
            { command: "clear_all", description: "Reset all thread sessions" },
        ]);
        // Start task watcher
        setInterval(() => { pollTaskUpdates().catch(() => {}); }, TASK_POLL_INTERVAL);
        log("INFO", "Task watcher started");

        log("INFO", "Borg Telegram bot started");
    },
});
