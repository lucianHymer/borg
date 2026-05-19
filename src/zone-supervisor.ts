/**
 * Zone Supervisor — Docker API client for dynamic zone containers.
 *
 * Talks to docker-proxy via `fetch` to create, delete, and inspect zone
 * containers. Used by the dashboard (zone CRUD) and at cold-boot
 * (ensureZoneContainersExist) to recover any zones whose containers are
 * missing.
 *
 * System zones (core, perimeter, infra) are compose-managed and are NOT
 * touched by this supervisor — they have different container names and
 * different lifecycle semantics.
 *
 * Per AD3 (plan doc): ensure-exists only creates fully-absent containers.
 * It does NOT start stopped containers — that would override user intent
 * (e.g. a deliberately-paused zone).
 */

import { loadZoneConfig } from "./zone-config.js";
import { loadZoneTemplates, resolveTemplate, type ZoneTemplate, type ZoneTemplateMount } from "./zone-templates.js";

// ─── Types ───

export interface CreateZoneOpts {
    zoneName: string;
    template: "trusted" | "untrusted";
    /** Explicit env overrides — primarily for tests. Production reads process.env. */
    envOverrides?: Record<string, string>;
    /**
     * Explicit path to zone-templates.json. Wins over ZONE_TEMPLATES_PATH env
     * var and the hardcoded default. Used by ensureZoneContainersExist to
     * guarantee the same templates file validated upfront is the one loaded
     * per-zone (otherwise env/default could point elsewhere).
     */
    zoneTemplatesPath?: string;
}

export interface ZoneContainerInfo {
    name: string;
    id: string;
    status: "running" | "created" | "exited" | "missing";
}

export interface EnsureResult {
    created: string[];
    alreadyPresent: string[];
    failed: Array<{ zone: string; error: string }>;
}

export interface EnsureOpts {
    zoneConfigPath: string;
    zoneTemplatesPath: string;
    /** Override retry delay for tests. Production uses 1000ms. */
    retryDelayMs?: number;
    /** Override max retries for tests. Production uses 30. */
    maxRetries?: number;
}

interface DockerMount {
    Type: "bind" | "volume";
    Source: string;
    Target: string;
    ReadOnly?: boolean;
}

interface ContainerSpec {
    Image: string;
    HostConfig: {
        Init: boolean;
        RestartPolicy: { Name: string };
        StopTimeout: number;
        Memory: number;
        Mounts: DockerMount[];
        NetworkMode: string;
    };
    Env: string[];
}

interface RetryOpts {
    maxRetries?: number;
    retryDelayMs?: number;
}

// ─── Constants ───

const SYSTEM_ZONES = new Set(["core", "perimeter", "infra"]);

const REQUIRED_ENV_VARS = [
    "WORKSPACE_ROOT",
    "WORKSPACE_HOST_BASE",
    "BROKER_SECRET",
    "PUBLIC_HOST",
    "CLAUDE_CREDENTIALS",
    "BORG_REPO_ROOT",
    "DOCKER_PROXY_URL",
] as const;

const DEFAULT_MAX_RETRIES = 30;
const DEFAULT_RETRY_DELAY_MS = 1000;

// ─── Logging ───

function logInfo(msg: string): void {
    console.log(`[zone-supervisor] ${msg}`);
}

function logError(msg: string): void {
    console.error(`[zone-supervisor] ${msg}`);
}

// ─── Helpers ───

function containerNameFor(zoneName: string): string {
    return `borg-zone-${zoneName}`;
}

function getEnv(name: string, overrides?: Record<string, string>): string | undefined {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
        return overrides[name];
    }
    return process.env[name];
}

function requireEnv(name: string, overrides?: Record<string, string>): string {
    const v = getEnv(name, overrides);
    if (v === undefined || v === "") {
        throw new Error(
            `Missing required env var "${name}" — needed for zone container creation`,
        );
    }
    return v;
}

/**
 * Parse a memory string like "4G", "512M", "1024K" (case-insensitive) into bytes.
 * Throws on unknown formats.
 */
export function parseMemory(spec: string): number {
    const m = spec.trim().match(/^(\d+)\s*([gGmMkK])$/);
    if (!m) {
        throw new Error(`Invalid memory spec: "${spec}" (expected e.g. "4G", "512M", "1024K")`);
    }
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const multiplier = unit === "g" ? 1024 * 1024 * 1024
        : unit === "m" ? 1024 * 1024
        : 1024;
    return n * multiplier;
}

/**
 * Substitute placeholders in a string. Recognises:
 *   ${WORKSPACE_ROOT}, ${WORKSPACE_HOST_BASE}, ${BROKER_SECRET},
 *   ${PUBLIC_HOST}, ${CLAUDE_CREDENTIALS}, ${BORG_REPO_ROOT}
 *   {ZONE}  (no dollar; curly braces only)
 */
function substitutePlaceholders(
    value: string,
    zoneName: string,
    overrides?: Record<string, string>,
): string {
    let out = value;
    for (const name of REQUIRED_ENV_VARS) {
        const token = "${" + name + "}";
        if (out.includes(token)) {
            out = out.split(token).join(requireEnv(name, overrides));
        }
    }
    if (out.includes("{ZONE}")) {
        out = out.split("{ZONE}").join(zoneName);
    }
    return out;
}

/**
 * Convert a template mount (bind|volume) into the Docker API Mount shape,
 * substituting placeholders in source paths/volume names.
 */
function templateMountToDocker(
    m: ZoneTemplateMount,
    zoneName: string,
    overrides?: Record<string, string>,
): DockerMount {
    if (m.type === "bind") {
        return {
            Type: "bind",
            Source: substitutePlaceholders(m.source, zoneName, overrides),
            Target: m.target,
            ReadOnly: m.readonly ?? false,
        };
    }
    return {
        Type: "volume",
        Source: substitutePlaceholders(m.name, zoneName, overrides),
        Target: m.target,
        ReadOnly: m.readonly ?? false,
    };
}

/**
 * Build the full Docker create-container spec for a dynamic zone.
 * Merges the base spec with the template's mounts (appended) and env (overlay).
 * All placeholders are substituted before this returns.
 */
function buildSpec(
    zoneName: string,
    template: ZoneTemplate,
    overrides?: Record<string, string>,
): ContainerSpec {
    const repoRoot = requireEnv("BORG_REPO_ROOT", overrides);
    const workspaceRoot = requireEnv("WORKSPACE_ROOT", overrides);
    const workspaceHostBase = requireEnv("WORKSPACE_HOST_BASE", overrides);

    // Base mounts (per plan AD7 + spec contract)
    const baseMounts: DockerMount[] = [
        { Type: "bind", Source: `${repoRoot}/.borg-zones/${zoneName}`, Target: "/app/.borg" },
        { Type: "bind", Source: `${workspaceHostBase}/workspace-${zoneName}`, Target: workspaceRoot },
        { Type: "bind", Source: `${repoRoot}/threads.json`, Target: "/app/threads.json" },
        { Type: "bind", Source: `${repoRoot}/zone-config.json`, Target: "/app/zone-config.json" },
        { Type: "bind", Source: `${repoRoot}/settings.json`, Target: "/app/settings.json" },
    ];

    // Template mounts (with placeholder substitution)
    const templateMounts = template.mounts.map(m => templateMountToDocker(m, zoneName, overrides));

    // Base env
    const baseEnv: Record<string, string> = {
        NODE_ENV: "production",
        BORG_ZONE: zoneName,
        ZONE_CONFIG_PATH: "/app/zone-config.json",
        DEFAULT_CWD: workspaceRoot,
    };

    // Overlay template env (template keys override base if conflict; usually they don't)
    const templateEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(template.env)) {
        templateEnv[k] = substitutePlaceholders(v, zoneName, overrides);
    }
    const mergedEnv: Record<string, string> = { ...baseEnv, ...templateEnv };

    const envArray = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);

    if (template.networks.length === 0) {
        throw new Error(
            `Template for zone "${zoneName}" declares no networks; need at least one primary network`,
        );
    }

    return {
        Image: template.image,
        HostConfig: {
            Init: true,
            RestartPolicy: { Name: "on-failure" },
            StopTimeout: 30,
            Memory: parseMemory(template.memory),
            Mounts: [...baseMounts, ...templateMounts],
            NetworkMode: template.networks[0],
        },
        Env: envArray,
    };
}

// ─── Retry helper for docker-proxy boot race ───

function isConnectionRefusedError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const e = err as NodeJS.ErrnoException & { cause?: unknown };
    if (e.code === "ECONNREFUSED") return true;
    // fetch wraps the underlying network error in `cause`
    const cause = e.cause;
    if (cause && typeof cause === "object" && "code" in cause) {
        const c = (cause as NodeJS.ErrnoException).code;
        if (c === "ECONNREFUSED" || c === "ENOTFOUND" || c === "EAI_AGAIN") return true;
    }
    // Some fetch implementations surface a generic "fetch failed" TypeError
    if (e.name === "TypeError" && /fetch failed/i.test(e.message)) return true;
    return false;
}

async function sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run a fetch (or any async fn) with retry on connection-refused errors only.
 * HTTP status errors (4xx/5xx) are NOT retried — those are meaningful.
 */
async function fetchWithRetry<T>(
    fn: () => Promise<T>,
    opts: RetryOpts = {},
): Promise<T> {
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isConnectionRefusedError(err)) {
                throw err;
            }
            if (attempt >= maxRetries) {
                break;
            }
            logInfo(
                `docker-proxy unreachable (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${retryDelayMs}ms`,
            );
            await sleep(retryDelayMs);
        }
    }
    throw lastErr;
}

// ─── HTTP helpers ───

interface DockerErrorBody {
    message?: string;
}

async function dockerFetch(
    url: string,
    init: RequestInit,
    retryOpts: RetryOpts,
): Promise<Response> {
    return fetchWithRetry(() => fetch(url, init), retryOpts);
}

async function readErrorMessage(resp: Response): Promise<string> {
    try {
        const text = await resp.text();
        if (!text) return `HTTP ${resp.status}`;
        try {
            const parsed = JSON.parse(text) as DockerErrorBody;
            return parsed.message ? `HTTP ${resp.status}: ${parsed.message}` : `HTTP ${resp.status}: ${text}`;
        } catch {
            return `HTTP ${resp.status}: ${text}`;
        }
    } catch {
        return `HTTP ${resp.status}`;
    }
}

// ─── Public API ───

/**
 * Create + start a container for a new dynamic zone.
 * Rolls back (deletes the container) on partial failure during network attach or start.
 */
export async function createZoneContainer(opts: CreateZoneOpts): Promise<ZoneContainerInfo> {
    const { zoneName, template: templateName, envOverrides } = opts;
    const dockerUrl = requireEnv("DOCKER_PROXY_URL", envOverrides);
    const containerName = containerNameFor(zoneName);

    // Load + resolve template
    const templatesPath = opts.zoneTemplatesPath
        ?? getEnv("ZONE_TEMPLATES_PATH", envOverrides)
        ?? "/app/zone-templates.json";
    let template: ZoneTemplate;
    try {
        const templates = loadZoneTemplates(templatesPath);
        template = resolveTemplate(templates, templateName);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Failed to create zone "${zoneName}" at step "load-template": ${reason}`,
        );
    }

    // Build the spec (validates env presence)
    let spec: ContainerSpec;
    try {
        spec = buildSpec(zoneName, template, envOverrides);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Failed to create zone "${zoneName}" at step "build-spec": ${reason}`,
        );
    }

    const retryOpts: RetryOpts = {};

    // Step 1: create
    logInfo(`creating container ${containerName} (template=${templateName})`);
    const createUrl = `${dockerUrl}/containers/create?name=${encodeURIComponent(containerName)}`;
    let containerId: string;
    {
        const resp = await dockerFetch(createUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(spec),
        }, retryOpts);
        if (!resp.ok) {
            const reason = await readErrorMessage(resp);
            throw new Error(
                `Failed to create zone "${zoneName}" at step "create": ${reason}`,
            );
        }
        const body = await resp.json() as { Id: string };
        containerId = body.Id;
        if (!containerId) {
            throw new Error(
                `Failed to create zone "${zoneName}" at step "create": docker returned no Id`,
            );
        }
    }

    // Step 2: attach secondary networks (if any)
    const secondaryNetworks = template.networks.slice(1);
    for (const net of secondaryNetworks) {
        logInfo(`attaching secondary network "${net}" to ${containerName}`);
        const attachUrl = `${dockerUrl}/networks/${encodeURIComponent(net)}/connect`;
        const resp = await dockerFetch(attachUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ Container: containerId }),
        }, retryOpts);
        if (!resp.ok) {
            const reason = await readErrorMessage(resp);
            // Rollback
            await rollbackDelete(dockerUrl, containerId, retryOpts);
            throw new Error(
                `Failed to create zone "${zoneName}" at step "attach-network": ${reason}`,
            );
        }
    }

    // Step 3: start
    logInfo(`starting container ${containerName}`);
    {
        const startUrl = `${dockerUrl}/containers/${containerId}/start`;
        const resp = await dockerFetch(startUrl, { method: "POST" }, retryOpts);
        // 204 = success; 304 = already started (treat as success)
        if (!resp.ok && resp.status !== 304) {
            const reason = await readErrorMessage(resp);
            await rollbackDelete(dockerUrl, containerId, retryOpts);
            throw new Error(
                `Failed to create zone "${zoneName}" at step "start": ${reason}`,
            );
        }
    }

    logInfo(`zone "${zoneName}" container ${containerId.slice(0, 12)} running`);
    return { name: containerName, id: containerId, status: "running" };
}

/** Best-effort rollback delete after a partial create. Swallows errors. */
async function rollbackDelete(
    dockerUrl: string,
    containerId: string,
    retryOpts: RetryOpts,
): Promise<void> {
    try {
        const url = `${dockerUrl}/containers/${containerId}?force=true`;
        await dockerFetch(url, { method: "DELETE" }, retryOpts);
        logInfo(`rolled back container ${containerId.slice(0, 12)}`);
    } catch (err) {
        logError(
            `rollback delete of ${containerId.slice(0, 12)} failed: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}

/**
 * Stop + remove a dynamic zone's container. Best-effort — no throw if missing.
 * Looks up the container ID first because docker-proxy's DELETE regex
 * (/containers/[a-f0-9]+.*) requires a hex ID, not a name.
 */
export async function deleteZoneContainer(zoneName: string): Promise<void> {
    const dockerUrl = requireEnv("DOCKER_PROXY_URL");
    const containerName = containerNameFor(zoneName);
    const retryOpts: RetryOpts = {};

    // Step 1: look up the container ID via /containers/{name}/json
    const inspectUrl = `${dockerUrl}/containers/${encodeURIComponent(containerName)}/json`;
    const inspectResp = await dockerFetch(inspectUrl, { method: "GET" }, retryOpts);
    if (inspectResp.status === 404) {
        logInfo(`delete: zone "${zoneName}" container already absent`);
        return;
    }
    if (!inspectResp.ok) {
        const reason = await readErrorMessage(inspectResp);
        throw new Error(`Failed to inspect zone "${zoneName}" for delete: ${reason}`);
    }
    const inspect = await inspectResp.json() as { Id: string };
    const containerId = inspect.Id;

    // Step 2: stop (graceful, t=30s). 204 = stopped; 304 = already stopped.
    const stopUrl = `${dockerUrl}/containers/${containerId}/stop?t=30`;
    const stopResp = await dockerFetch(stopUrl, { method: "POST" }, retryOpts);
    if (!stopResp.ok && stopResp.status !== 304) {
        // 404 here means the container vanished mid-flight — that's fine, continue.
        if (stopResp.status !== 404) {
            const reason = await readErrorMessage(stopResp);
            logError(`stop of zone "${zoneName}" failed (continuing to delete): ${reason}`);
        }
    }

    // Step 3: remove. 404 is fine (race condition).
    const deleteUrl = `${dockerUrl}/containers/${containerId}`;
    const deleteResp = await dockerFetch(deleteUrl, { method: "DELETE" }, retryOpts);
    if (!deleteResp.ok && deleteResp.status !== 404) {
        const reason = await readErrorMessage(deleteResp);
        throw new Error(`Failed to delete zone "${zoneName}": ${reason}`);
    }

    logInfo(`deleted zone "${zoneName}" container`);
}

/**
 * Inspect the current state of a dynamic zone's container by name.
 * Returns status "missing" with empty id if the container does not exist.
 */
export async function getZoneContainerStatus(zoneName: string): Promise<ZoneContainerInfo> {
    const dockerUrl = requireEnv("DOCKER_PROXY_URL");
    const containerName = containerNameFor(zoneName);
    const retryOpts: RetryOpts = {};

    const url = `${dockerUrl}/containers/${encodeURIComponent(containerName)}/json`;
    const resp = await dockerFetch(url, { method: "GET" }, retryOpts);

    if (resp.status === 404) {
        return { name: containerName, id: "", status: "missing" };
    }
    if (!resp.ok) {
        const reason = await readErrorMessage(resp);
        throw new Error(`Failed to inspect zone "${zoneName}": ${reason}`);
    }

    const body = await resp.json() as { Id: string; State: { Running: boolean; Status: string } };
    const state = body.State;
    let status: ZoneContainerInfo["status"];
    if (state.Running === true) {
        status = "running";
    } else if (state.Status === "created") {
        status = "created";
    } else if (state.Status === "exited") {
        status = "exited";
    } else {
        // Defensive fallback for other states (paused, restarting, dead, removing).
        status = "missing";
    }
    return { name: containerName, id: body.Id, status };
}

/**
 * Cold-boot recovery: for each non-system zone in zone-config with a template,
 * create its container if absent. Does NOT start stopped containers — that
 * would override user intent (e.g. a deliberately-paused zone).
 */
export async function ensureZoneContainersExist(opts: EnsureOpts): Promise<EnsureResult> {
    const result: EnsureResult = { created: [], alreadyPresent: [], failed: [] };

    const config = loadZoneConfig(opts.zoneConfigPath);
    if (!config) {
        logInfo("ensure: no zone-config.json present — nothing to do");
        return result;
    }

    // Validate templates load (so we fail fast rather than per-zone)
    try {
        loadZoneTemplates(opts.zoneTemplatesPath);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`ensure: failed to load zone-templates.json: ${reason}`);
    }

    for (const [zoneName, zone] of Object.entries(config.zones)) {
        if (SYSTEM_ZONES.has(zoneName)) {
            continue;
        }
        if (!zone.template) {
            // Defensive: only dynamic zones (with template) are managed.
            logInfo(`ensure: zone "${zoneName}" has no template — skipping`);
            continue;
        }

        let status: ZoneContainerInfo;
        try {
            status = await getZoneContainerStatus(zoneName);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            result.failed.push({ zone: zoneName, error: reason });
            logError(`ensure: status check for "${zoneName}" failed: ${reason}`);
            continue;
        }

        if (status.status === "missing") {
            try {
                await createZoneContainer({
                    zoneName,
                    template: zone.template,
                    zoneTemplatesPath: opts.zoneTemplatesPath,
                });
                result.created.push(zoneName);
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                result.failed.push({ zone: zoneName, error: reason });
                logError(`ensure: create for "${zoneName}" failed: ${reason}`);
            }
        } else {
            // Per AD3: do NOT start stopped containers.
            result.alreadyPresent.push(zoneName);
            logInfo(`ensure: zone "${zoneName}" already present (status=${status.status})`);
        }
    }

    return result;
}
