/**
 * Image infrastructure — download, validation, cleanup.
 * Images are downloaded to .borg/images/incoming/ and referenced in queue messages.
 */

import fs from "fs";
import path from "path";

// ─── Config ───

const SCRIPT_DIR = path.resolve(__dirname, "..");
const IMAGES_DIR = path.join(SCRIPT_DIR, ".borg/images");
const IMAGES_INCOMING_DIR = path.join(IMAGES_DIR, "incoming");
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Ensure image directories exist
[IMAGES_DIR, IMAGES_INCOMING_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ─── Cleanup ───

/**
 * Delete a single image file safely (logs error, doesn't throw).
 */
export function cleanupImageFile(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error(`[images] Failed to cleanup ${filePath}:`, err);
    }
}

/**
 * Periodic sweep to delete orphaned image files older than MAX_AGE_MS.
 */
function cleanupOldImages(): void {
    const now = Date.now();
    for (const dir of [IMAGES_DIR, IMAGES_INCOMING_DIR]) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const filePath = path.join(dir, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) {
                    fs.unlinkSync(filePath);
                    console.log(`[images] Cleaned up old file: ${file}`);
                }
            } catch (err) {
                console.error(`[images] Error checking ${file}:`, err);
            }
        }
    }
}

/**
 * Start periodic cleanup (call once at startup).
 */
export function startPeriodicCleanup(): void {
    setInterval(cleanupOldImages, CLEANUP_INTERVAL_MS);
    console.log("[images] Periodic cleanup started (every 15 minutes)");
}

export { IMAGES_DIR, IMAGES_INCOMING_DIR };
