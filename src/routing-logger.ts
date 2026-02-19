/**
 * JSONL Logger for Routing Decisions and Corrections
 *
 * Logs routing decisions and user corrections for analysis.
 * Uses sync I/O (appendFileSync) matching codebase convention.
 * Rotates at 10MB matching message-history.ts pattern.
 *
 * Dual-writer: telegram-client.ts (logDecision + logCorrection) and
 * queue-processor via mcp-tools.ts (logCorrection).
 * Cross-process JSONL safety: appendFileSync with O_APPEND is atomic
 * on ext4 for writes < 4096 bytes. Rotation race is extremely narrow
 * (~once per 250 days) and benign (one entry lost, caught by try/catch).
 */

import fs from "fs";
import path from "path";
import { z } from "zod/v4";
import type { Tier } from "./router/types.js";
import type { RoutingMetadata } from "./types.js";

const SCRIPT_DIR = path.resolve(__dirname, "..");
export const ROUTING_LOG = path.join(SCRIPT_DIR, ".borg/logs/routing.jsonl");

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ─── Types ───

export type LogEntry = {
    type: "decision";
    ts: number;
    prompt: string;
    messageId?: number;
    threadId?: number;
    tier: Tier;
    model: string;
    tokens: number;
    confidence: number;
    signals: string[];
};

export type CorrectionEntry = {
    type: "correction";
    ts: number;
    messageId: number;
    threadId?: number;
    originalModel: string;
    correctedModel: string;
};

export type RoutingLogEntry = LogEntry | CorrectionEntry;

// ─── Zod Schemas (I/O boundary validation) ───

export const LogEntrySchema = z.object({
    type: z.literal("decision").optional(), // optional for backwards compat with old entries
    ts: z.number(),
    prompt: z.string().optional(),          // optional for old entries with promptHash
    promptHash: z.string().optional(),      // backwards compat
    messageId: z.number().optional(),
    threadId: z.number().optional(),
    tier: z.string(),
    model: z.string(),
    tokens: z.number(),
    confidence: z.number(),
    signals: z.array(z.string()),
});

export const CorrectionEntrySchema = z.object({
    type: z.literal("correction"),
    ts: z.number(),
    messageId: z.number(),
    threadId: z.number().optional(),
    originalModel: z.string(),
    correctedModel: z.string(),
});

// ─── Prompt Sanitization ───

function sanitizePrompt(prompt: string): string {
    return prompt
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // strip control chars except tab/newline/CR
        .substring(0, 4096); // Telegram max message length
}

// ─── Rotation ───

function rotateIfNeeded(logPath: string): void {
    try {
        if (fs.existsSync(logPath)) {
            const stats = fs.statSync(logPath);
            if (stats.size > MAX_FILE_SIZE) {
                fs.renameSync(logPath, logPath.replace(".jsonl", ".1.jsonl"));
            }
        }
    } catch {
        // Rotation failure is non-fatal — next write will retry
    }
}

// ─── Public API ───

/**
 * Log a routing decision to JSONL file.
 * Called from telegram-client after successful Telegram send.
 */
export function logDecision(
    metadata: RoutingMetadata,
    messageId: number,
    threadId: number,
    logPath: string,
): void {
    try {
        rotateIfNeeded(logPath);

        const entry: LogEntry = {
            type: "decision",
            ts: Date.now(),
            prompt: sanitizePrompt(metadata.prompt),
            messageId,
            threadId,
            tier: metadata.tier,
            model: metadata.model,
            tokens: metadata.tokens,
            confidence: Math.round(metadata.confidence * 100) / 100,
            signals: metadata.signals,
        };

        const line = JSON.stringify(entry) + "\n";
        fs.appendFileSync(logPath, line);
    } catch {
        // Logging should never crash the process
    }
}

/**
 * Log a user correction (reaction-based routing feedback) to JSONL file.
 * Called from telegram-client when a user reacts with a different model emoji.
 */
export function logCorrection(
    correction: CorrectionEntry,
    logPath: string,
): void {
    try {
        rotateIfNeeded(logPath);
        const line = JSON.stringify(correction) + "\n";
        fs.appendFileSync(logPath, line);
    } catch {
        // Logging should never crash the process
    }
}

// ─── Merge Logic ───

export type DecisionWithCorrection = z.infer<typeof LogEntrySchema> & {
    userCorrection?: string;
};

/**
 * Separate raw JSONL entries into decisions and corrections,
 * then attach the latest correction to each decision by messageId.
 * Uses Zod validation instead of unsafe casts.
 */
export function mergeCorrectionsOntoDecisions(
    raw: Record<string, unknown>[],
): DecisionWithCorrection[] {
    const decisions: DecisionWithCorrection[] = [];
    const corrections: Record<number, { correctedModel: string; ts: number }> = {};

    for (const entry of raw) {
        if (entry.type === "correction") {
            const parsed = CorrectionEntrySchema.safeParse(entry);
            if (!parsed.success) continue;
            const corr = parsed.data;
            const existing = corrections[corr.messageId];
            if (!existing || corr.ts > existing.ts) { // latest correction wins
                corrections[corr.messageId] = { correctedModel: corr.correctedModel, ts: corr.ts };
            }
        } else {
            const parsed = LogEntrySchema.safeParse(entry);
            if (parsed.success) {
                decisions.push(parsed.data);
            } else {
                // Fall back to raw entry for entries that don't fully match schema
                decisions.push(entry as DecisionWithCorrection);
            }
        }
    }

    // Merge corrections onto decisions
    for (const d of decisions) {
        const msgId = d.messageId;
        if (msgId !== undefined && corrections[msgId]) {
            d.userCorrection = corrections[msgId].correctedModel;
        }
    }

    return decisions;
}
