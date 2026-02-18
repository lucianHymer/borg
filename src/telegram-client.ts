#!/usr/bin/env node
/**
 * Telegram Client - grammY-based Telegram bot for Borg
 * Handles incoming messages, commands, and outgoing queue polling.
 */

import fs from "fs";
import path from "path";
import { Bot, Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import {
    loadThreads,
    saveThreads,
    loadSettings,
    resetThread,
    configureThread,
} from "./session-manager.js";
import type { ThreadConfig, ThreadsMap, Settings } from "./session-manager.js";
import type { OutgoingMessage } from "./types.js";
import { toErrorMessage } from "./types.js";

// ─── Constants ───

const SCRIPT_DIR = path.resolve(__dirname, "..");
const QUEUE_INCOMING = path.join(SCRIPT_DIR, ".borg/queue/incoming");
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, ".borg/queue/outgoing");
const LOG_FILE = path.join(SCRIPT_DIR, ".borg/logs/telegram.log");
const MESSAGE_MODELS_FILE = path.join(SCRIPT_DIR, ".borg/message-models.json");
const QUEUE_STATUS = path.join(SCRIPT_DIR, ".borg/status");

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

let messageModelsCache: Record<string, string> | null = null;

function loadMessageModels(): Record<string, string> {
    if (messageModelsCache) return messageModelsCache;
    try {
        const data = fs.readFileSync(MESSAGE_MODELS_FILE, "utf8");
        messageModelsCache = JSON.parse(data) as Record<string, string>;
        return messageModelsCache;
    } catch {
        messageModelsCache = {};
        return messageModelsCache;
    }
}

function saveMessageModels(models: Record<string, string>): void {
    // Prune to last 1000 entries
    const keys = Object.keys(models);
    if (keys.length > 1000) {
        const toRemove = keys.slice(0, keys.length - 1000);
        for (const key of toRemove) {
            delete models[key];
        }
    }
    const tmp = MESSAGE_MODELS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(models, null, 2));
    fs.renameSync(tmp, MESSAGE_MODELS_FILE);
    messageModelsCache = models;
}

function storeMessageModel(messageId: number, model: string): void {
    const models = loadMessageModels();
    models[String(messageId)] = model;
    saveMessageModels(models);
}

function lookupMessageModel(messageId: number): string | undefined {
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
        const replyToModel =
            isReplyToBot && ctx.msg.reply_to_message
                ? lookupMessageModel(ctx.msg.reply_to_message.message_id)
                : undefined;

        // Restrict to configured chat ID
        if (String(ctx.chat.id) !== settings.telegram_chat_id) return;

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

// ─── Model Reaction Emoji ───

// ⚡ haiku (fast), ✍ sonnet (writing), 🔥 opus (fire)
const MODEL_REACTIONS: Record<string, string> = {
    haiku: "⚡",
    sonnet: "✍",
    opus: "🔥",
};

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

async function pollOutgoingQueue(): Promise<void> {
    try {
        if (!fs.existsSync(QUEUE_OUTGOING)) return;

        const files = fs
            .readdirSync(QUEUE_OUTGOING)
            .filter((f) => f.endsWith(".json"));

        for (const file of files) {
            const filePath = path.join(QUEUE_OUTGOING, file);

            try {
                const data: OutgoingMessage = JSON.parse(fs.readFileSync(filePath, "utf8"));

                if (data.targetThreadId) {
                    // Cross-thread message: post to the target topic
                    const chatId = settings.telegram_chat_id;
                    const chunks = splitMessage(data.message);
                    let firstSentId: number | undefined;

                    for (const chunk of chunks) {
                        const sent = await bot.api.sendMessage(chatId, chunk, {
                            message_thread_id: data.targetThreadId,
                        });
                        if (!firstSentId) firstSentId = sent.message_id;
                        if (data.model) {
                            storeMessageModel(sent.message_id, data.model);
                            await reactWithModel(chatId, sent.message_id, data.model);
                        }
                    }

                    // Register pending message so status updates and final response are tracked.
                    // The incoming queue message uses the base ID (without _tg suffix).
                    const chatIdNum = Number(chatId);
                    if (firstSentId && Number.isFinite(chatIdNum)) {
                        const incomingId = data.messageId.replace(/_tg$/, "");
                        pendingMessages.set(incomingId, {
                            chatId: chatIdNum,
                            threadId: data.targetThreadId,
                            telegramMessageId: firstSentId,
                        });
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
                        let firstSentId: number | undefined;

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
                                storeMessageModel(firstSentId, data.model);
                                await reactWithModel(pending.chatId, firstSentId, data.model);
                            }
                            // Send remaining chunks as new messages
                            for (let i = 1; i < chunks.length; i++) {
                                const sent = await sendInThread(pending, chunks[i]);
                                if (data.model) {
                                    storeMessageModel(sent.message_id, data.model);
                                }
                            }
                        } else {
                            // No status message or edit failed — send all chunks normally
                            for (const chunk of chunks) {
                                const sent = await sendInThread(pending, chunk);
                                if (data.model) {
                                    storeMessageModel(sent.message_id, data.model);
                                    await reactWithModel(pending.chatId, sent.message_id, data.model);
                                }
                            }
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
                            if (data.model) {
                                storeMessageModel(sent.message_id, data.model);
                                await reactWithModel(chatId, sent.message_id, data.model);
                            }
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
                const sent = await bot.api.sendMessage(
                    pending.chatId,
                    displayText,
                    {
                        message_thread_id: getThreadOpt(pending),
                        reply_parameters: { message_id: pending.telegramMessageId },
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

bot.start({
    onStart: async () => {
        await bot.api.setMyCommands([
            { command: "reset", description: "Reset the current thread session" },
            { command: "setdir", description: "Set working directory for this thread" },
            { command: "status", description: "Show all active threads and their status" },
        ]);
        log("INFO", "Borg Telegram bot started");
    },
});
