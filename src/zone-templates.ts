/**
 * Zone Templates — loads and validates zone-templates.json.
 * Templates describe container build recipes (image, memory, networks, mounts, env)
 * used by the dashboard supervisor when creating dynamic zone containers.
 * Also owns zone-name validation: reserved-name set and the AD5 name regex.
 */

import fs from "fs";
import { z } from "zod/v4";

// ─── Schema ───

const ZoneTemplateBindMountSchema = z.object({
    type: z.literal("bind"),
    source: z.string().min(1),
    target: z.string().min(1),
    readonly: z.boolean().optional(),
});

const ZoneTemplateVolumeMountSchema = z.object({
    type: z.literal("volume"),
    name: z.string().min(1),
    target: z.string().min(1),
    readonly: z.boolean().optional(),
});

export const ZoneTemplateMountSchema = z.discriminatedUnion("type", [
    ZoneTemplateBindMountSchema,
    ZoneTemplateVolumeMountSchema,
]);

export const ZoneTemplateSchema = z.object({
    _description: z.string().optional(),
    image: z.string().min(1),
    memory: z.string().min(1),
    networks: z.array(z.string().min(1)),
    mounts: z.array(ZoneTemplateMountSchema),
    env: z.record(z.string(), z.string()),
});

export const ZoneTemplatesSchema = z.record(z.string(), ZoneTemplateSchema);

export type ZoneTemplateMount = z.infer<typeof ZoneTemplateMountSchema>;
export type ZoneTemplate = z.infer<typeof ZoneTemplateSchema>;
export type ZoneTemplates = z.infer<typeof ZoneTemplatesSchema>;

// ─── Constants (AD5) ───

/** Lowercase alphanumeric + hyphen, 2–31 chars total, must start non-dash. */
export const ZONE_NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,30}$/;

/** Names that clash with compose services or filesystem conventions. */
export const RESERVED_ZONE_NAMES = new Set([
    "infra",
    "dashboard",
    "broker",
    "init",
    "cloudflared",
    "speaches",
    "docker-proxy",
    "archived",
]);

/**
 * Whether a string is a legal zone name. Checks the regex, reserved-name set,
 * and the "no leading dot" filesystem-hidden convention.
 */
export function isValidZoneName(name: string): boolean {
    if (typeof name !== "string") return false;
    if (name.startsWith(".")) return false;
    if (!ZONE_NAME_REGEX.test(name)) return false;
    if (RESERVED_ZONE_NAMES.has(name)) return false;
    return true;
}

// ─── Cache ───

let cachedTemplates: ZoneTemplates | null = null;
let cachedMtime: number = 0;

/**
 * Load zone-templates.json with mtime-based caching.
 * Throws if the file does not exist or fails schema validation —
 * unlike loadZoneConfig (which returns null on missing), templates are required
 * for any dynamic-zone container creation to succeed.
 */
export function loadZoneTemplates(templatesPath: string): ZoneTemplates {
    const stat = fs.statSync(templatesPath);
    if (cachedTemplates && stat.mtimeMs === cachedMtime) {
        return cachedTemplates;
    }
    const raw = fs.readFileSync(templatesPath, "utf-8");
    const parsed = JSON.parse(raw);
    const templates = ZoneTemplatesSchema.parse(parsed);

    cachedTemplates = templates;
    cachedMtime = stat.mtimeMs;
    return templates;
}

/**
 * Look up a template by name. Throws with a clear message listing the available
 * template names if the requested one is missing.
 */
export function resolveTemplate(templates: ZoneTemplates, name: string): ZoneTemplate {
    const t = templates[name];
    if (!t) {
        const available = Object.keys(templates).join(", ");
        throw new Error(`Unknown zone template: "${name}". Available: ${available}`);
    }
    return t;
}

/** Clear the in-memory cache (useful for tests). */
export function clearZoneTemplatesCache(): void {
    cachedTemplates = null;
    cachedMtime = 0;
}
