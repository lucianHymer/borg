/**
 * Thread Status — Per-thread processing status for Telegram display.
 *
 * Status is per-thread, not per-message. At any time, a thread has at most
 * one active status indicator anchored to the latest user message. When a
 * new message arrives (injected or dispatched), the anchor migrates so the
 * status indicator appears below the user's latest message in Telegram.
 *
 * This module is pure filesystem I/O with no Telegram or SDK dependencies,
 * making it trivially testable.
 */

import fs from "node:fs";
import path from "node:path";

// ─── Types ───

export interface ThreadStatusData {
    threadId: number;
    /** Current processing state: "Thinking", "Using Bash [3]", "Queued", "Cancelled", etc. */
    label: string;
    /** When processing started (for elapsed time display) */
    startTs: number;
    /** Last update timestamp (for staleness detection) */
    ts: number;
    /** Queue messageId of the latest user message — determines where the status msg appears in Telegram */
    anchorMessageId: string;
    /** Truncated tail of accumulated response text */
    preview?: string;
    /** Full accumulated response text (for dashboard live view) */
    fullText?: string;
    /** Session ID (for dashboard session log lookup) */
    sessionId?: string;
}

// ─── File naming ───

function statusFileName(threadId: number): string {
    return `thread_${threadId}.json`;
}

function statusFilePath(statusDir: string, threadId: number): string {
    return path.join(statusDir, statusFileName(threadId));
}

// ─── Write ───

/**
 * Write or overwrite the status file for a thread.
 * Uses atomic write (tmp + rename) to prevent partial reads.
 * Best-effort — never throws.
 */
export function writeThreadStatus(statusDir: string, data: ThreadStatusData): void {
    try {
        fs.mkdirSync(statusDir, { recursive: true });
        const filePath = statusFilePath(statusDir, data.threadId);
        const tmpPath = filePath + ".tmp";
        fs.writeFileSync(tmpPath, JSON.stringify(data));
        fs.renameSync(tmpPath, filePath);
    } catch {
        // Status updates are best-effort — never crash the process
    }
}

// ─── Read ───

/**
 * Read the current status for a thread. Returns null if no status file
 * exists or if the file is corrupt/unreadable.
 */
export function readThreadStatus(statusDir: string, threadId: number): ThreadStatusData | null {
    try {
        const filePath = statusFilePath(statusDir, threadId);
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw) as ThreadStatusData;
        // Minimal validation
        if (typeof data.threadId !== "number" || typeof data.label !== "string" || typeof data.anchorMessageId !== "string") {
            return null;
        }
        return data;
    } catch {
        return null;
    }
}

// ─── Clear ───

/**
 * Remove the status file for a thread. Called when the response is complete.
 * Best-effort — never throws.
 */
export function clearThreadStatus(statusDir: string, threadId: number): void {
    try {
        const filePath = statusFilePath(statusDir, threadId);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        // Best-effort cleanup
    }
}

// ─── Update anchor ───

/**
 * Update the anchor messageId for a thread's status. Used when a new user
 * message is injected mid-turn — the status indicator should migrate to
 * appear below the latest user message. Preserves all other fields.
 *
 * If no status file exists for the thread, creates a new one with "Queued" label.
 */
export function updateThreadStatusAnchor(
    statusDir: string,
    threadId: number,
    newAnchorMessageId: string,
): void {
    try {
        const existing = readThreadStatus(statusDir, threadId);
        if (existing) {
            existing.anchorMessageId = newAnchorMessageId;
            existing.ts = Date.now();
            writeThreadStatus(statusDir, existing);
        } else {
            // No existing status — create a "Queued" status so the user gets immediate feedback
            writeThreadStatus(statusDir, {
                threadId,
                label: "Queued",
                startTs: Date.now(),
                ts: Date.now(),
                anchorMessageId: newAnchorMessageId,
            });
        }
    } catch {
        // Best-effort
    }
}

// ─── Scan ───

/**
 * List all thread IDs that have active status files.
 * Used by telegram-client to discover which threads need status display.
 */
export function listActiveThreadStatuses(statusDir: string): number[] {
    try {
        if (!fs.existsSync(statusDir)) return [];
        return fs.readdirSync(statusDir)
            .filter(f => f.startsWith("thread_") && f.endsWith(".json") && !f.endsWith(".tmp"))
            .map(f => parseInt(f.replace("thread_", "").replace(".json", ""), 10))
            .filter(n => Number.isFinite(n));
    } catch {
        return [];
    }
}
