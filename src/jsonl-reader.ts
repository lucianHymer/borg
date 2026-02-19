/**
 * Shared JSONL reader for tail-reading recent entries.
 * Used by dashboard.ts and mcp-tools.ts.
 */

import fs from "fs";

/**
 * Read the last N entries from a JSONL file (reads from end).
 * Reads up to 256KB from the tail, skips truncated first line if mid-file.
 */
export function readRecentJsonl<T = unknown>(filePath: string, n: number): T[] {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    const TAIL_BYTES = Math.min(256 * 1024, stat.size); // 256KB max
    const fd = fs.openSync(filePath, "r");
    try {
        const buf = Buffer.alloc(TAIL_BYTES);
        const readStart = Math.max(0, stat.size - TAIL_BYTES);
        fs.readSync(fd, buf, 0, TAIL_BYTES, readStart);
        const content = buf.toString("utf8");
        const lines = content.split("\n").filter(l => l.trim());
        // Skip first line if we started mid-file (likely truncated)
        if (readStart > 0 && lines.length > 0) lines.shift();

        const entries: T[] = [];
        for (const line of lines) {
            try {
                entries.push(JSON.parse(line) as T);
            } catch {
                /* skip malformed */
            }
        }
        return entries.slice(-n);
    } finally {
        fs.closeSync(fd);
    }
}
