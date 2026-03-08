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
} from "./session-manager.js";
import type { ThreadConfig, ThreadsMap, Settings } from "./session-manager.js";
import type { OutgoingMessage, TaskListMapping, MessageModelEntry } from "./types.js";
import { toErrorMessage, TASK_LISTS_FILENAME } from "./types.js";
import { RoutingMetadataSchema } from "./types.js";
import { logDecision, logCorrection, ROUTING_LOG } from "./routing-logger.js";
import { AUDIO_INCOMING_DIR, cleanupAudioFile, startPeriodicCleanup, ensureModels, distillForSpeech, synthesize, isAvailable } from "./audio.js";

// ─── Constants ───

const SCRIPT_DIR = path.resolve(__dirname, "..");
const QUEUE_INCOMING = path.join(SCRIPT_DIR, ".borg/queue/incoming");
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, ".borg/queue/outgoing");
const LOG_FILE = path.join(SCRIPT_DIR, ".borg/logs/telegram.log");
const MESSAGE_MODELS_FILE = path.join(SCRIPT_DIR, ".borg/message-models.json");
const QUEUE_STATUS = path.join(SCRIPT_DIR, ".borg/status");
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

[QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_STATUS, path.dirname(LOG_FILE), path.dirname(MESSAGE_MODELS_FILE)].forEach(
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
    lastEditTs?: number;        // last Telegram edit timestamp for throttling
}

const pendingMessages = new Map<string, PendingMessage>();
const listenInFlight = new Set<number>(); // track message IDs being processed for TTS

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
): Promise<{ message_id: number }> {
    const threadId = getThreadOpt(pending);
    if (pending.ctx) {
        return pending.ctx.reply(text, { message_thread_id: threadId });
    }
    return bot.api.sendMessage(pending.chatId, text, { message_thread_id: threadId });
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

bot.command("reset", async (ctx) => {
    if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
    const threadId = ctx.msg.message_thread_id ?? 1;
    resetThread(threadId);
    await ctx.reply("Session reset! Starting fresh.", {
        message_thread_id: ctx.msg.message_thread_id,
    });
    log("INFO", `Thread ${threadId} reset by ${ctx.from?.first_name ?? "unknown"}`);
});

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

async function queueTeamCommand(ctx: Context, command: string): Promise<void> {
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
        const msgId = `${command}_${id}_${Date.now()}`;
        const queueData = {
            channel: "telegram",
            source: "system",
            threadId: Number(id),
            sender: ctx.from?.first_name ?? "system",
            message: `/${command}`,
            timestamp: Date.now(),
            messageId: msgId,
        };
        const tmpFile = path.join(QUEUE_INCOMING, `${msgId}.json.tmp`);
        fs.writeFileSync(tmpFile, JSON.stringify(queueData));
        fs.renameSync(tmpFile, path.join(QUEUE_INCOMING, `${msgId}.json`));
    }
    await ctx.reply(`Queued /${command} to ${teamThreads.length} thread(s) in team **${config.team}**`, {
        message_thread_id: ctx.msg?.message_thread_id,
        parse_mode: "Markdown",
    });
    log("INFO", `Team ${config.team} ${command} queued by ${ctx.from?.first_name ?? "unknown"} (${teamThreads.length} threads)`);
}

bot.command("clear_team", (ctx) => queueTeamCommand(ctx, "clear"));
bot.command("compact_team", (ctx) => queueTeamCommand(ctx, "compact"));

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

        const queueFile = path.join(QUEUE_INCOMING, `telegram_${messageId}.json`);
        const tmpFile = queueFile + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(queueData, null, 2));
        fs.renameSync(tmpFile, queueFile);

        pendingMessages.set(messageId, {
            ctx,
            chatId: ctx.chat.id,
            threadId,
            telegramMessageId: ctx.msg.message_id,
        });

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

        // Download the voice file
        const fileUrl = `https://api.telegram.org/file/bot${settings.telegram_bot_token}/${file.file_path}`;
        const messageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const oggPath = path.join(AUDIO_INCOMING_DIR, `${messageId}.ogg`);

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
            audioPath: oggPath,
            voiceDuration: duration,
            isReply: isReplyToBot,
            replyToText,
            replyToModel,
            topicName,
            timestamp: Date.now(),
            messageId,
        };

        const queueFile = path.join(QUEUE_INCOMING, `telegram_${messageId}.json`);
        const tmpFile = queueFile + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(queueData, null, 2));
        fs.renameSync(tmpFile, queueFile);

        pendingMessages.set(messageId, {
            ctx,
            chatId: ctx.chat.id,
            threadId,
            telegramMessageId: ctx.msg.message_id,
        });

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

// ─── Model Reaction Emoji (single source of truth) ───

// ⚡ haiku (fast), ✍ sonnet (writing), 🔥 opus (fire)
const MODEL_REACTIONS: Record<string, string> = {
    haiku: "⚡",
    sonnet: "✍",
    opus: "🔥",
};

// Derived: emoji → model reverse map
const EMOJI_TO_MODEL: Record<string, string> = Object.fromEntries(
    Object.entries(MODEL_REACTIONS).map(([model, emoji]) => [emoji, model]),
);

// Derived: valid model names for validation
const VALID_MODELS = new Set(Object.keys(MODEL_REACTIONS));

async function reactWithModel(chatId: string | number, messageId: number, model?: string): Promise<void> {
    if (!model) return;
    const emoji = MODEL_REACTIONS[model];
    if (!emoji) return;
    try {
        await bot.api.setMessageReaction(chatId, messageId,
            [{ type: "emoji", emoji: emoji as any }]);
    } catch {
        // Reactions may not be available in all groups — silently ignore
    }
}

// ─── Outgoing Queue Polling ───

let outgoingPollActive = false;

async function pollOutgoingQueue(): Promise<void> {
    if (outgoingPollActive) return;
    outgoingPollActive = true;
    try {
        if (!fs.existsSync(QUEUE_OUTGOING)) return;

        const files = fs
            .readdirSync(QUEUE_OUTGOING)
            .filter((f) => f.endsWith(".json"));

        for (const file of files) {
            const filePath = path.join(QUEUE_OUTGOING, file);

            try {
                const data: OutgoingMessage = JSON.parse(fs.readFileSync(filePath, "utf8"));

                let firstSentId: number | undefined;

                if (data.targetThreadId) {
                    // Cross-thread message: post to the target topic
                    const chatId = settings.telegram_chat_id;
                    const chunks = splitMessage(data.message);

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
                        const sent = await bot.api.sendMessage(chatId, chunk, threadOpt);
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
                            const statusFile = path.join(QUEUE_STATUS, `${data.messageId}.json`);
                            fs.unlinkSync(statusFile);
                        } catch { /* may not exist */ }

                        const chunks = splitMessage(data.message);

                        if (pending.statusMessageId && chunks.length > 0) {
                            // Edit the status message in-place with the first chunk
                            try {
                                await bot.api.editMessageText(
                                    pending.chatId,
                                    pending.statusMessageId,
                                    chunks[0],
                                );
                                firstSentId = pending.statusMessageId;
                            } catch {
                                // Status message may have been deleted — send normally instead
                                firstSentId = undefined;
                            }
                        }

                        if (firstSentId) {
                            // First chunk was edited in-place — store model and react
                            if (data.model) {
                                // Store full text ONLY for multi-segment messages
                                const fullText = chunks.length > 1 ? data.message : undefined;
                                storeMessageModel(firstSentId, data.model, data.threadId, fullText);
                                await reactWithModel(pending.chatId, firstSentId, data.model);
                            }
                            // Send remaining chunks as new messages
                            for (let i = 1; i < chunks.length; i++) {
                                const sent = await sendInThread(pending, chunks[i]);
                                if (data.model) {
                                    storeMessageModel(sent.message_id, data.model, data.threadId);
                                }
                            }
                        } else {
                            // No status message or edit failed — send all chunks normally
                            for (const chunk of chunks) {
                                const sent = await sendInThread(pending, chunk);
                                if (!firstSentId) {
                                    firstSentId = sent.message_id;
                                    // Store full text ONLY for multi-segment messages, on the first segment
                                    if (data.model && chunks.length > 1) {
                                        storeMessageModel(sent.message_id, data.model, data.threadId, data.message);
                                        await reactWithModel(pending.chatId, sent.message_id, data.model);
                                    } else if (data.model) {
                                        storeMessageModel(sent.message_id, data.model, data.threadId);
                                        await reactWithModel(pending.chatId, sent.message_id, data.model);
                                    }
                                } else if (data.model) {
                                    storeMessageModel(sent.message_id, data.model, data.threadId);
                                    await reactWithModel(pending.chatId, sent.message_id, data.model);
                                }
                            }
                        }

                        // Add Listen button to the first response message (user-facing only)
                        if (firstSentId) {
                            try {
                                await bot.api.editMessageReplyMarkup(pending.chatId, firstSentId, {
                                    reply_markup: new InlineKeyboard().text("🔊 Listen", `listen:${firstSentId}`),
                                });
                            } catch { /* Listen button is best-effort */ }
                        }

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
                        const chunks = splitMessage(data.message);
                        const threadOpt = data.threadId && data.threadId !== 1
                            ? { message_thread_id: data.threadId }
                            : {};

                        for (const chunk of chunks) {
                            const sent = await bot.api.sendMessage(chatId, chunk, threadOpt);
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
                                await bot.api.editMessageReplyMarkup(settings.telegram_chat_id, firstSentId, {
                                    reply_markup: new InlineKeyboard().text("🔊 Listen", `listen:${firstSentId}`),
                                });
                            } catch { /* Listen button is best-effort */ }
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
                log("ERROR", `Failed to process outgoing file ${file}: ${toErrorMessage(err)}`);
            }
        }
    } catch (err) {
        log("ERROR", `Outgoing queue poll error: ${toErrorMessage(err)}`);
    } finally {
        outgoingPollActive = false;
    }
}

// ─── Pending Message Cleanup ───

function cleanupPendingMessages(): void {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes

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
                const statusFile = path.join(QUEUE_STATUS, `${messageId}.json`);
                if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile);
            } catch { /* best effort */ }

            pendingMessages.delete(messageId);
            log("DEBUG", `Cleaned up stale pending message: ${messageId}`);
        }
    }
}

// ─── Status File Polling ───

async function pollStatusFiles(): Promise<void> {
    for (const [messageId, pending] of pendingMessages) {
        const statusFile = path.join(QUEUE_STATUS, `${messageId}.json`);

        let statusData: { label: string; ts: number; startTs: number };
        try {
            if (!fs.existsSync(statusFile)) continue;
            statusData = JSON.parse(fs.readFileSync(statusFile, "utf8"));
            if (!statusData.label || !statusData.startTs) continue; // invalid format
        } catch {
            continue; // File may be mid-write or already deleted
        }

        // Compute elapsed time from processing start
        const elapsed = Math.round((Date.now() - statusData.startTs) / 1000);

        // Detect stalled processing (queue processor should write every 2s)
        const isStale = Date.now() - statusData.ts > 15_000;
        const displayText = isStale
            ? `🕐 ${statusData.label}... — stalled`
            : `🕐 ${statusData.label}... (${elapsed}s)`;

        // Skip if display text hasn't changed
        if (displayText === pending.lastStatusText) continue;

        // Label changes: edit immediately. Timer-only changes: throttle to every 20s.
        const labelChanged = statusData.label !== pending.lastStatusLabel;
        const timeSinceLastEdit = Date.now() - (pending.lastEditTs ?? 0);
        if (!labelChanged && !isStale && timeSinceLastEdit < 20_000) continue;

        try {
            if (pending.statusMessageId) {
                // Edit existing status message
                await bot.api.editMessageText(
                    pending.chatId,
                    pending.statusMessageId,
                    displayText,
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
                        ...replyOpts,
                    },
                );
                pending.statusMessageId = sent.message_id;
            }
            pending.lastStatusText = displayText;
            pending.lastStatusLabel = statusData.label;
            pending.lastEditTs = Date.now();
        } catch {
            // editMessageText may fail if message was deleted or content unchanged — ignore
        }
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
    if (!data.startsWith("listen:")) return;

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
        // If we're falling back to first segment (cache miss on multi-segment), warn user
        const isFirstSegmentOnly = !messageModel?.fullText && ctx.callbackQuery.message?.text;
        if (isFirstSegmentOnly) {
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

// Ensure Speaches models are installed (fire-and-forget, cached across restarts)
ensureModels().catch(() => {});

bot.start({
    allowed_updates: [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, "message_reaction"],
    onStart: async () => {
        await bot.api.setMyCommands([
            { command: "reset", description: "Reset the current thread session" },
            { command: "setdir", description: "Set working directory for this thread" },
            { command: "status", description: "Show all active threads and their status" },
            { command: "clear_team", description: "Clear all team member sessions" },
            { command: "compact_team", description: "Compact all team member sessions" },
        ]);
        // Start task watcher
        setInterval(() => { pollTaskUpdates().catch(() => {}); }, TASK_POLL_INTERVAL);
        log("INFO", "Task watcher started");

        log("INFO", "Borg Telegram bot started");
    },
});
