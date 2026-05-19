/**
 * Zone Configuration — loads and validates zone-config.json.
 * Used by infra to determine cross-zone routing decisions.
 * Zone containers read this read-only to know their own zone membership.
 */

import fs from "fs";
import path from "path";
import { z } from "zod/v4";
import { writeJsonFileSafe } from "./types.js";

// ─── Schema ───

export const ZoneConfigSchema = z.object({
    zones: z.record(
        z.string(), // zone name (e.g. "core", "perimeter")
        z.object({
            threads: z.array(z.number().int().positive()),
            template: z.enum(["trusted", "untrusted"]).optional(),
        }),
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

// ─── Zone directory enumeration ───

/**
 * List per-zone directories of the form `{zonesRoot}/{zone}/{subpath}` for
 * every zone declared in zone-config.json. Used by infra to discover all
 * zones at runtime instead of hardcoding zone names.
 *
 * Returns an empty array if the config file is missing or unreadable; callers
 * decide whether that should be treated as fatal. Backed by `loadZoneConfig`'s
 * mtime cache, so calling per poll is cheap.
 *
 * @param configPath  Path to zone-config.json.
 * @param zonesRoot   Filesystem path that contains the per-zone directories
 *                    (e.g. `/app/.borg-zones`).
 * @param subpath     Sub-path within each zone dir (e.g. `"status"` or
 *                    `"queue/outgoing"`). Pass `""` to get the zone roots.
 */
export function listZoneDirs(configPath: string, zonesRoot: string, subpath: string): string[] {
    const config = loadZoneConfig(configPath);
    if (!config) return [];
    return Object.keys(config.zones).map((zone) =>
        subpath ? path.join(zonesRoot, zone, subpath) : path.join(zonesRoot, zone),
    );
}

/**
 * Like `listZoneDirs` but returns `{zone, dir}` pairs so callers can attribute
 * results back to the originating zone.
 */
export function listZoneDirsWithNames(
    configPath: string,
    zonesRoot: string,
    subpath: string,
): Array<{ zone: ZoneName; dir: string }> {
    const config = loadZoneConfig(configPath);
    if (!config) return [];
    return Object.keys(config.zones).map((zone) => ({
        zone,
        dir: subpath ? path.join(zonesRoot, zone, subpath) : path.join(zonesRoot, zone),
    }));
}

/**
 * Build a `{zonesRoot}/{zone}/{subpath}` path for a single zone. Pure path
 * construction — does not consult zone-config, does not validate that the
 * zone exists. Callers that need validation should look the zone up in
 * zone-config first.
 *
 * @param zone        Zone name (e.g. `"core"`).
 * @param zonesRoot   Filesystem path containing the per-zone directories.
 * @param subpath     Sub-path within the zone dir (e.g. `"queue/incoming"`).
 *                    Pass `""` to get the zone root.
 */
export function resolveZoneSubdir(zone: ZoneName, zonesRoot: string, subpath: string): string {
    return subpath ? path.join(zonesRoot, zone, subpath) : path.join(zonesRoot, zone);
}
