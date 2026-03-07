/**
 * Voice transcript cache for user voice messages.
 * Stores STT transcripts keyed by Telegram message ID.
 */

import fs from "node:fs";
import path from "node:path";

const SCRIPT_DIR = path.resolve(__dirname, "..");
const VOICE_CACHE_FILE = path.join(SCRIPT_DIR, ".borg/voice-transcripts.json");

export interface VoiceTranscriptEntry {
    transcript: string;
    ts: number;  // Unix epoch timestamp
}

let voiceCacheCache: Record<string, VoiceTranscriptEntry> | null = null;

/**
 * Load voice transcript cache from disk.
 * Caches in memory for performance.
 */
function loadVoiceCache(): Record<string, VoiceTranscriptEntry> {
    if (voiceCacheCache) return voiceCacheCache;
    try {
        const data = fs.readFileSync(VOICE_CACHE_FILE, "utf8");
        voiceCacheCache = JSON.parse(data) as Record<string, VoiceTranscriptEntry>;
        return voiceCacheCache;
    } catch {
        voiceCacheCache = {};
        return voiceCacheCache;
    }
}

/**
 * Save voice transcript cache to disk with atomic write.
 * Prunes to 1000 most recent entries before saving.
 */
function saveVoiceCache(cache: Record<string, VoiceTranscriptEntry>): void {
    // Prune to last 1000 entries by timestamp
    const keys = Object.keys(cache);
    if (keys.length > 1000) {
        const sorted = keys.sort((a, b) => {
            const tsA = cache[a]?.ts ?? 0;
            const tsB = cache[b]?.ts ?? 0;
            return tsB - tsA; // newest first
        });
        const pruned: Record<string, VoiceTranscriptEntry> = {};
        for (const key of sorted.slice(0, 1000)) {
            pruned[key] = cache[key]!;
        }
        voiceCacheCache = pruned;
    } else {
        voiceCacheCache = cache;
    }

    const tmpPath = `${VOICE_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(voiceCacheCache, null, 2), "utf8");
    fs.renameSync(tmpPath, VOICE_CACHE_FILE);
}

/**
 * Store a voice transcript in the cache.
 * @param telegramMessageId - Telegram message ID as string
 * @param transcript - Full STT transcript text
 */
export function storeVoiceTranscript(telegramMessageId: string, transcript: string): void {
    const cache = loadVoiceCache();
    cache[telegramMessageId] = {
        transcript,
        ts: Date.now(),
    };
    saveVoiceCache(cache);
}

/**
 * Retrieve a voice transcript from the cache.
 * @param telegramMessageId - Telegram message ID as string
 * @returns Transcript text or undefined if not found/pruned
 */
export function getVoiceTranscript(telegramMessageId: string): string | undefined {
    const cache = loadVoiceCache();
    return cache[telegramMessageId]?.transcript;
}
