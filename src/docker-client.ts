/**
 * Shared Docker API client for Borg.
 * Provides typed Docker API access, container listing, and memory validation.
 * All functions accept a baseUrl parameter — no hardcoded Docker endpoint.
 */

import { ValidationError, type SSHPublicKey, type DevName, type DevEmail } from "./types.js";

// ─── Constants ───

/**
 * Reserved for Linux kernel, systemd, and base system services.
 * On a headless Proxmox VM, kernel + system services use ~200-500MB.
 * Previously 2GB when infra containers were untracked.
 */
export const OS_RESERVE_BYTES = 512 * 1024 * 1024;
export const MIN_MEMORY_BYTES = 64 * 1024 * 1024; // 64MB floor (docker-proxy's current limit)
export const MEMORY_SNAP_BYTES = 64 * 1024 * 1024; // 64MB snap increment

export type ContainerCategory = "infra" | "dev";

// ─── Docker API Types ───

export interface DockerContainer {
    Id: string;
    Names: string[];
    State: string;
    Status: string;
    Labels: Record<string, string>;
    Created: number;
    HostConfig?: { NanoCpus?: number };
}

export interface DockerContainerInspect {
    Id: string;
    Name: string;
    State: { Status: string; StartedAt: string; Pid: number };
    Config?: { Labels?: Record<string, string> };
    HostConfig: {
        Memory: number;
        MemorySwap: number;
        NanoCpus: number;
        PortBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    };
}

export interface DockerStats {
    memory_stats: { usage: number; limit: number };
    pids_stats: { current: number };
}

export interface ContainerInfo {
    id: string;
    name: string;
    status: string;
    memory: { usage: number; limit: number; usagePercent: number; unlimited: boolean };
    cpus: number;
    uptime: string;
    idle: boolean;
    sshPort?: number;
    category: ContainerCategory;
}

// ─── Result type for memory validation ───

export interface MemoryUpdateResult {
    id: string;
    name: string;
    oldLimit: number;
    newLimit: number;
    warning?: string;
}

// ─── Validation ───

/**
 * Validate that a string is a legitimate Docker container ID.
 * Docker container IDs are 12-64 character lowercase hex strings.
 * This rejects path traversal characters, slashes, and any non-hex input.
 */
export function isValidContainerId(id: string): boolean {
    return /^[a-f0-9]{12,64}$/i.test(id);
}

// ─── Helpers ───

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + "GB";
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + "MB";
    return bytes + "B";
}

export function formatUptime(startedAt: string): string {
    const started = new Date(startedAt).getTime();
    if (isNaN(started)) return "unknown";
    const diffMs = Date.now() - started;
    const days = Math.floor(diffMs / 86400000);
    const hours = Math.floor((diffMs % 86400000) / 3600000);
    if (days > 0) return `${days}d ${hours}h`;
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// ─── Docker API Fetch Helpers ───

export async function fetchDockerJson<T>(baseUrl: string, urlPath: string, method = "GET", body?: unknown): Promise<T> {
    const url = `${baseUrl}${urlPath}`;
    const opts: RequestInit = {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
    };
    const resp = await fetch(url, opts);
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Docker API ${method} ${urlPath}: ${resp.status} ${text}`);
    }
    return (await resp.json()) as T;
}

export async function fetchDockerStats(baseUrl: string, containerId: string): Promise<DockerStats> {
    // stream=false returns a single stats snapshot
    const url = `${baseUrl}/containers/${containerId}/stats?stream=false`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
        throw new Error(`Docker stats ${containerId}: ${resp.status}`);
    }
    return (await resp.json()) as DockerStats;
}

// ─── Container Listing ───

/**
 * Merge two Docker container lists by ID, deduplicating.
 */
function mergeContainers(a: DockerContainer[], b: DockerContainer[]): DockerContainer[] {
    const seen = new Set<string>();
    const result: DockerContainer[] = [];
    for (const c of [...a, ...b]) {
        if (!seen.has(c.Id)) {
            seen.add(c.Id);
            result.push(c);
        }
    }
    return result;
}

/**
 * Fetch all relevant containers: infra (compose project) + dev containers.
 * Two parallel filtered Docker API queries, merged and deduplicated.
 * Internal helper — both getAllContainers() and getContainerMemoryLimits() delegate here.
 */
async function fetchRelevantContainers(
    baseUrl: string,
    composeProject: string,
): Promise<DockerContainer[]> {
    const [composeResult, devResult] = await Promise.allSettled([
        composeProject
            ? fetchDockerJson<DockerContainer[]>(
                baseUrl,
                `/containers/json?all=true&filters=${encodeURIComponent(
                    JSON.stringify({ label: [`com.docker.compose.project=${composeProject}`] }),
                )}`,
            )
            : Promise.resolve([] as DockerContainer[]),
        fetchDockerJson<DockerContainer[]>(
            baseUrl,
            `/containers/json?all=true&filters=${encodeURIComponent(
                JSON.stringify({ label: ["borg.type=dev-container"] }),
            )}`,
        ),
    ]);
    return mergeContainers(
        composeResult.status === "fulfilled" ? composeResult.value : [],
        devResult.status === "fulfilled" ? devResult.value : [],
    );
}

/**
 * Get all relevant containers: infra (compose project) + dev containers.
 * Two parallel filtered Docker API queries (push filtering to Docker API).
 */
export async function getAllContainers(
    baseUrl: string,
    composeProject: string,
): Promise<ContainerInfo[]> {
    const relevant = await fetchRelevantContainers(baseUrl, composeProject);

    // Parallel inspect + stats (two-level Promise.allSettled)
    const settled = await Promise.allSettled(
        relevant.map(async (c) => {
            const name = (c.Names[0] || "").replace(/^\//, "");
            let usage = 0;
            let limit = 0;
            let cpus = 0;
            let uptime = "";
            let idle = true;
            let sshPort: number | undefined;
            let isUnlimited = false;

            const [inspectResult, statsResult] = await Promise.allSettled([
                fetchDockerJson<DockerContainerInspect>(baseUrl, `/containers/${c.Id}/json`),
                c.State === "running"
                    ? fetchDockerStats(baseUrl, c.Id)
                    : Promise.resolve(null),
            ]);

            if (inspectResult.status === "fulfilled") {
                const inspect = inspectResult.value;
                // Determine "unlimited" from inspect, NOT stats
                // Docker stats returns host total RAM for unlimited containers on cgroups v2
                isUnlimited = inspect.HostConfig.Memory === 0;
                limit = isUnlimited ? 0 : inspect.HostConfig.Memory;
                cpus = inspect.HostConfig.NanoCpus ? inspect.HostConfig.NanoCpus / 1e9 : 0;
                uptime = inspect.State.StartedAt ? formatUptime(inspect.State.StartedAt) : "";
                const portBindings = inspect.HostConfig?.PortBindings?.["22/tcp"];
                if (portBindings?.[0]?.HostPort) {
                    sshPort = parseInt(portBindings[0].HostPort, 10);
                }
            }

            if (statsResult.status === "fulfilled" && statsResult.value) {
                const stats = statsResult.value;
                usage = stats.memory_stats?.usage || 0;
                // Only use stats limit for non-unlimited containers (stats returns host total for unlimited)
                if (!isUnlimited && stats.memory_stats?.limit) limit = stats.memory_stats.limit;
                // Consider container idle if only 1-2 processes (init + sshd)
                idle = (stats.pids_stats?.current || 0) <= 2;
            }

            const category: ContainerCategory =
                c.Labels["borg.type"] === "dev-container" ? "dev" : "infra";

            return {
                id: c.Id,
                name,
                status: c.State,
                memory: {
                    usage,
                    limit,
                    usagePercent: limit > 0 ? Math.round((usage / limit) * 1000) / 10 : 0,
                    unlimited: isUnlimited,
                },
                cpus: Math.round(cpus * 10) / 10,
                uptime,
                idle,
                sshPort,
                category,
            } satisfies ContainerInfo;
        }),
    );

    // Collect fulfilled results, skip containers where the entire mapping failed
    const results: ContainerInfo[] = [];
    for (const result of settled) {
        if (result.status === "fulfilled") {
            results.push(result.value);
        }
    }

    // Sort: infra by memory usage desc, then dev by memory usage desc
    results.sort((a, b) => {
        if (a.category !== b.category) return a.category === "infra" ? -1 : 1;
        return b.memory.usage - a.memory.usage;
    });
    return results;
}

/**
 * Get dev containers only. Delegates to getAllContainers to prevent code duplication.
 */
export async function getDevContainers(baseUrl: string): Promise<ContainerInfo[]> {
    const composeProject = process.env.COMPOSE_PROJECT || "";
    const all = await getAllContainers(baseUrl, composeProject);
    return all.filter(c => c.category === "dev");
}

// ─── Lightweight Container Memory Query ───

/**
 * Get memory limits for all relevant containers (infra + dev) using only list + parallel inspect.
 * No stats calls — much faster than getAllContainers() for allocation validation.
 * Excludes unlimited containers (Memory === 0) from results.
 */
async function getContainerMemoryLimits(
    baseUrl: string,
    composeProject: string,
): Promise<Array<{ id: string; memoryLimit: number }>> {
    const relevant = await fetchRelevantContainers(baseUrl, composeProject);

    const settled = await Promise.allSettled(
        relevant.map(async (c) => {
            const inspect = await fetchDockerJson<DockerContainerInspect>(
                baseUrl,
                `/containers/${c.Id}/json`,
            );
            return { id: c.Id, memoryLimit: inspect.HostConfig.Memory || 0 };
        }),
    );

    const results: Array<{ id: string; memoryLimit: number }> = [];
    for (const result of settled) {
        if (result.status === "fulfilled") {
            results.push(result.value);
        }
    }
    // Exclude unlimited containers from budget
    return results.filter(c => c.memoryLimit > 0);
}

// ─── Memory Validation & Update ───

/**
 * Validate and update a container's memory limit with full safety checks:
 * - Snap to 64MB increments
 * - Enforce minimum memory limit (64MB)
 * - Self-modification guards for dashboard and docker-proxy
 * - Directional validation: allow decreases when over-budget, block increases
 * - Warn if new limit is below or close to current usage (OOM risk)
 */
export async function validateAndUpdateMemory(
    baseUrl: string,
    containerId: string,
    newLimitBytes: number,
    hostTotalBytes: number,
    composeProject: string,
): Promise<MemoryUpdateResult> {
    // Container ID validation (defense-in-depth)
    if (!isValidContainerId(containerId)) {
        throw new ValidationError("Invalid container ID format");
    }

    // Minimum memory check
    if (newLimitBytes < MIN_MEMORY_BYTES) {
        throw new ValidationError(`Limit too low. Minimum is ${formatBytes(MIN_MEMORY_BYTES)}`);
    }

    // Snap to 64MB increment
    const snappedLimit = Math.round(newLimitBytes / MEMORY_SNAP_BYTES) * MEMORY_SNAP_BYTES;

    // Inspect the container
    const inspect = await fetchDockerJson<DockerContainerInspect>(
        baseUrl,
        `/containers/${containerId}/json`,
    );
    const containerName = (inspect.Name || "").replace(/^\//, "");
    const oldLimit = inspect.HostConfig.Memory || 0;

    // Server-side self-modification guards
    const serviceName = inspect.Config?.Labels?.["com.docker.compose.service"] || "";
    if (serviceName === "docker-proxy" && snappedLimit < 64 * 1024 * 1024) {
        throw new ValidationError(`Docker-proxy minimum is 64MB. Use 'docker update' from CLI for lower values.`);
    }

    // Read current memory usage for OOM warning
    let currentUsage = 0;
    if (inspect.State.Status === "running") {
        try {
            const stats = await fetchDockerStats(baseUrl, containerId);
            currentUsage = stats.memory_stats?.usage || 0;
        } catch {
            // Can't read stats — proceed with caution
        }
    }

    // Dashboard guard: must be above MAX(current usage * 1.5, 128MB)
    if (serviceName === "dashboard" && snappedLimit < Math.max(currentUsage * 1.5, 128 * 1024 * 1024)) {
        throw new ValidationError(
            `Dashboard minimum is MAX(current usage x 1.5, 128MB). ` +
            `Current usage: ${formatBytes(currentUsage)}. Use 'docker update' from CLI for lower values.`,
        );
    }

    // Directional validation: allow decreases when over-budget, block increases
    const allLimits = await getContainerMemoryLimits(baseUrl, composeProject);
    const otherContainersTotal = allLimits
        .filter(c => c.id !== containerId)
        .reduce((sum, c) => sum + c.memoryLimit, 0);
    const maxAllocatable = hostTotalBytes - OS_RESERVE_BYTES;
    const newTotal = otherContainersTotal + snappedLimit;
    const isIncrease = snappedLimit > oldLimit;

    if (isIncrease && newTotal > maxAllocatable) {
        throw new ValidationError(
            `Cannot increase: total allocation would be ${formatBytes(newTotal)}, ` +
            `exceeding max ${formatBytes(maxAllocatable)} ` +
            `(host ${formatBytes(hostTotalBytes)} - ${formatBytes(OS_RESERVE_BYTES)} OS reserve)`,
        );
    }

    // Log warning if applying while over-budget
    if (newTotal > maxAllocatable) {
        console.warn(`Memory update applied while over-budget: ${containerName} ` +
            `${formatBytes(oldLimit)} → ${formatBytes(snappedLimit)}, ` +
            `total ${formatBytes(newTotal)} / max ${formatBytes(maxAllocatable)}`);
    }

    // OOM warning checks
    let warning: string | undefined;
    if (snappedLimit < currentUsage) {
        warning = `New limit (${formatBytes(snappedLimit)}) is below current usage (${formatBytes(currentUsage)}). Docker may OOM-kill this container immediately.`;
    } else if (currentUsage > 0 && snappedLimit < currentUsage * 1.25) {
        warning = `New limit (${formatBytes(snappedLimit)}) is close to current usage (${formatBytes(currentUsage)}). The container may be OOM-killed under load.`;
    }

    // Apply the update: MemorySwap at 1.25x Memory gives swap headroom for kernel overhead
    await fetchDockerJson(
        baseUrl,
        `/containers/${containerId}/update`,
        "POST",
        { Memory: snappedLimit, MemorySwap: Math.round(snappedLimit * 1.25) },
    );

    return {
        id: containerId,
        name: containerName,
        oldLimit,
        newLimit: snappedLimit,
        warning,
    };
}

// ─── Dev Container Lifecycle ───

const DEV_PORT_MIN = 2201;
const DEV_PORT_MAX = 2299;

/** Lightweight container listing for port scanning and name resolution. */
export async function listDevContainers(baseUrl: string): Promise<Array<{
    Names: string[];
    Ports: Array<{ PublicPort?: number }>;
    Id: string;
    State: string;
    Labels: Record<string, string>;
}>> {
    return fetchDockerJson(
        baseUrl,
        '/containers/json?all=true&filters={"label":["borg.type=dev-container"]}',
    );
}

/** Find the next available SSH port in the 2201-2299 range. */
export function findNextAvailablePort(
    containers: Array<{ Ports: Array<{ PublicPort?: number }> }>,
): number {
    const occupied = new Set<number>();
    for (const c of containers) {
        for (const p of c.Ports || []) {
            if (p.PublicPort && p.PublicPort >= DEV_PORT_MIN && p.PublicPort <= DEV_PORT_MAX) {
                occupied.add(p.PublicPort);
            }
        }
    }
    for (let port = DEV_PORT_MIN; port <= DEV_PORT_MAX; port++) {
        if (!occupied.has(port)) return port;
    }
    throw new ValidationError(`All ports in range ${DEV_PORT_MIN}-${DEV_PORT_MAX} are occupied.`);
}

// Re-export parseDevName from types.ts for backward compat
export { parseDevName } from "./types.js";

/**
 * Resolve a unique container name. If "dev-alice" exists, try "dev-alice-2", "dev-alice-3", etc.
 */
export function resolveUniqueName(
    containers: Array<{ Names: string[] }>,
    name: DevName,
): string {
    const existingNames = new Set(
        containers.flatMap(c => c.Names.map(n => n.replace(/^\//, ""))),
    );
    const baseName = `dev-${name}`;
    if (!existingNames.has(baseName)) return baseName;

    for (let i = 2; i <= 99; i++) {
        const candidate = `${baseName}-${i}`;
        if (!existingNames.has(candidate)) return candidate;
    }
    throw new ValidationError(`Cannot find unique name for "${name}" (tried up to 99 suffixes).`);
}

/** Find a container by name among dev containers. Throws if not found. */
export async function findContainerByName(
    baseUrl: string,
    name: string,
): Promise<{ Id: string; State: string; port?: number; Labels: Record<string, string> }> {
    const containers = await listDevContainers(baseUrl);
    for (const c of containers) {
        const containerName = (c.Names[0] || "").replace(/^\//, "");
        if (containerName === name) {
            const port = c.Ports?.find(
                p => p.PublicPort && p.PublicPort >= DEV_PORT_MIN && p.PublicPort <= DEV_PORT_MAX,
            )?.PublicPort;
            return { Id: c.Id, State: c.State, port, Labels: c.Labels };
        }
    }
    throw new ValidationError(`Container "${name}" not found among dev containers.`);
}

// ─── Container CRUD ───

export interface DevContainerUserInput {
    name: string;
    email: DevEmail;
    sshPublicKey: SSHPublicKey;
}

export interface DevContainerInfraConfig {
    port: number;
    networkName: string;
    publicHost: string;
    dockerBaseUrl: string;
}

export interface CreateContainerResult {
    containerId: string;
    name: string;
    port: number;
    host: string;
}

export async function createDevContainer(
    input: DevContainerUserInput,
    config: DevContainerInfraConfig,
): Promise<CreateContainerResult> {
    const containerSpec = {
        Image: "borg-dev",
        Hostname: input.name,
        Env: [
            `PROVISION_SSH_KEY=${input.sshPublicKey}`,
            `PROVISION_NAME=${input.name}`,
            `PROVISION_EMAIL=${input.email}`,
        ],
        ExposedPorts: { "22/tcp": {} },
        Labels: {
            "borg.type": "dev-container",
            "borg.created-by": "mcp-tool",
            "borg.created-at": new Date().toISOString(),
            "borg.dev-name": input.name,
            "borg.dev-email": input.email,
        },
        HostConfig: {
            Memory: 2 * 1024 * 1024 * 1024,
            MemorySwap: Math.round(2 * 1024 * 1024 * 1024 * 1.25),
            NanoCPUs: 2_000_000_000,
            PidsLimit: 256,
            CapDrop: ["NET_RAW"],
            Binds: [
                "/secrets/github-installations.json:/secrets/github-installations.json:ro",
                "/secrets/broker-env.sh:/etc/profile.d/broker-env.sh:ro",
            ],
            PortBindings: {
                "22/tcp": [{ HostIp: "0.0.0.0", HostPort: String(config.port) }],
            },
            RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
            LogConfig: {
                Type: "json-file",
                Config: { "max-size": "10m", "max-file": "3" },
            },
        },
        NetworkingConfig: {
            EndpointsConfig: { [config.networkName]: {} },
        },
    };

    const result = await fetchDockerJson<{ Id: string; Warnings: string[] }>(
        config.dockerBaseUrl,
        `/containers/create?name=${encodeURIComponent(input.name)}`,
        "POST",
        containerSpec,
    );

    return {
        containerId: result.Id,
        name: input.name,
        port: config.port,
        host: config.publicHost,
    };
}

/** Start a container by ID. Returns when the container is started. */
export async function startContainer(baseUrl: string, containerId: string): Promise<void> {
    if (!isValidContainerId(containerId)) {
        throw new ValidationError("Invalid container ID.");
    }
    const resp = await fetch(`${baseUrl}/containers/${containerId}/start`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
    });
    // 204 = started, 304 = already running — both OK
    if (resp.status !== 204 && resp.status !== 304) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Start container ${containerId}: ${resp.status} ${text}`);
    }
}

/** Stop a container by ID. */
export async function stopDevContainer(baseUrl: string, containerId: string): Promise<void> {
    if (!isValidContainerId(containerId)) {
        throw new ValidationError("Invalid container ID.");
    }
    const resp = await fetch(`${baseUrl}/containers/${containerId}/stop`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
    });
    // 204 = stopped, 304 = already stopped — both OK
    if (resp.status !== 204 && resp.status !== 304) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Stop container ${containerId}: ${resp.status} ${text}`);
    }
}

/**
 * Delete a container by ID. Verifies borg.type=dev-container label first.
 * Always uses force=true (stops running containers before deletion).
 */
export async function deleteDevContainer(
    baseUrl: string,
    containerId: string,
): Promise<void> {
    if (!isValidContainerId(containerId)) {
        throw new ValidationError("Invalid container ID.");
    }

    // Safety: verify this is a dev container
    const inspect = await fetchDockerJson<DockerContainerInspect>(
        baseUrl,
        `/containers/${containerId}/json`,
    );
    if (inspect.Config?.Labels?.["borg.type"] !== "dev-container") {
        throw new ValidationError("Refusing to delete: container does not have borg.type=dev-container label.");
    }

    const resp = await fetch(`${baseUrl}/containers/${containerId}?force=true`, {
        method: "DELETE",
        signal: AbortSignal.timeout(30_000),
    });
    if (resp.status !== 204) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Delete container ${containerId}: ${resp.status} ${text}`);
    }
}

/**
 * Format an SSH config snippet for a newly created container.
 */
export function formatSSHConfig(result: CreateContainerResult, keyType?: string): string {
    let identityFile = "~/.ssh/id_ed25519";
    if (keyType === "ssh-rsa") identityFile = "~/.ssh/id_rsa";
    else if (keyType?.startsWith("ecdsa-sha2-")) identityFile = "~/.ssh/id_ecdsa";
    else if (keyType?.startsWith("sk-ecdsa-sha2-")) identityFile = "~/.ssh/id_ecdsa_sk";
    else if (keyType?.startsWith("sk-ssh-ed25519")) identityFile = "~/.ssh/id_ed25519_sk";
    return [
        `Host borg-${result.name.replace(/^dev-/, "")}`,
        `  HostName ${result.host}`,
        `  Port ${result.port}`,
        `  User dev`,
        `  IdentityFile ${identityFile}`,
        `  ServerAliveInterval 30`,
        `  ServerAliveCountMax 5`,
    ].join("\n");
}
