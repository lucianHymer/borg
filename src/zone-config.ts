/**
 * Zone Configuration — loads and validates zone-config.json.
 * Used by infra to determine cross-zone routing decisions.
 * Zone containers read this read-only to know their own zone membership.
 */

import fs from "fs";
import { z } from "zod/v4";
import { writeJsonFileSafe } from "./types.js";

// ─── Schema ───

export const ZoneConfigSchema = z.object({
    zones: z.record(
        z.string(), // zone name (e.g. "core", "perimeter")
        z.object({ threads: z.array(z.number().int().positive()) }),
    ),
    defaults: z.object({
        newThread: z.string(),
    }),
});

export type ZoneConfig = z.infer<typeof ZoneConfigSchema>;
export type ZoneName = string;

// ─── Cache ───

let cachedConfig: ZoneConfig | null = null;
let cachedMtime: number = 0;

/**
 * Load zone-config.json with mtime-based caching.
 * Returns null if the file doesn't exist (zones not yet configured).
 */
export function loadZoneConfig(configPath: string): ZoneConfig | null {
    try {
        const stat = fs.statSync(configPath);
        if (cachedConfig && stat.mtimeMs === cachedMtime) {
            return cachedConfig;
        }
        const raw = fs.readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);
        const config = ZoneConfigSchema.parse(parsed);

        // Validate: no thread appears in multiple zones
        const seen = new Map<number, string>();
        for (const [zoneName, zone] of Object.entries(config.zones)) {
            for (const threadId of zone.threads) {
                const existing = seen.get(threadId);
                if (existing) {
                    throw new Error(
                        `Thread ${threadId} appears in both "${existing}" and "${zoneName}" zones`,
                    );
                }
                seen.set(threadId, zoneName);
            }
        }

        // Validate: default zone exists
        if (!config.zones[config.defaults.newThread]) {
            throw new Error(
                `Default zone "${config.defaults.newThread}" is not defined in zones`,
            );
        }

        cachedConfig = config;
        cachedMtime = stat.mtimeMs;
        return config;
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }
}

/**
 * Get the zone a thread belongs to. Returns the default zone if the thread
 * isn't explicitly listed in any zone.
 */
export function getThreadZone(config: ZoneConfig, threadId: number): ZoneName {
    for (const [zoneName, zone] of Object.entries(config.zones)) {
        if (zone.threads.includes(threadId)) {
            return zoneName;
        }
    }
    return config.defaults.newThread;
}

/**
 * Check whether two threads are in the same zone.
 */
export function isSameZone(config: ZoneConfig, threadA: number, threadB: number): boolean {
    return getThreadZone(config, threadA) === getThreadZone(config, threadB);
}

/**
 * Get all thread IDs in a specific zone.
 */
export function getThreadsInZone(config: ZoneConfig, zoneName: ZoneName): number[] {
    return config.zones[zoneName]?.threads ?? [];
}

/**
 * Add a thread to a zone. Removes it from any other zone first.
 * Returns the updated config (does NOT save to disk).
 */
export function addThreadToZone(config: ZoneConfig, threadId: number, zoneName: ZoneName): ZoneConfig {
    if (!config.zones[zoneName]) {
        throw new Error(`Zone "${zoneName}" does not exist`);
    }

    // Remove from all zones first
    for (const zone of Object.values(config.zones)) {
        zone.threads = zone.threads.filter(id => id !== threadId);
    }

    config.zones[zoneName].threads.push(threadId);
    return config;
}

/**
 * Remove a thread from all zones (e.g. on thread deletion).
 * Returns the updated config (does NOT save to disk).
 */
export function removeThreadFromZones(config: ZoneConfig, threadId: number): ZoneConfig {
    for (const zone of Object.values(config.zones)) {
        zone.threads = zone.threads.filter(id => id !== threadId);
    }
    return config;
}

/**
 * Save zone-config.json (bind-mounted single file — must preserve inode).
 */
export function saveZoneConfig(configPath: string, config: ZoneConfig): void {
    writeJsonFileSafe(configPath, config);
    // Invalidate cache so next load picks up the new file
    cachedConfig = null;
    cachedMtime = 0;
}

/** Clear the in-memory cache (useful for tests). */
export function clearZoneConfigCache(): void {
    cachedConfig = null;
    cachedMtime = 0;
}
