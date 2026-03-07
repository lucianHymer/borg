/**
 * In-process MCP tools for cross-thread communication.
 * Uses the Agent SDK's createSdkMcpServer — runs in the queue processor process.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import {
    formatBytes,
    getAllContainers,
    OS_RESERVE_BYTES,
    validateAndUpdateMemory,
    listDevContainers,
    findNextAvailablePort,
    parseDevName,
    resolveUniqueName,
    findContainerByName,
    createDevContainer as createDevContainerFn,
    startContainer,
    stopDevContainer,
    deleteDevContainer,
    formatSSHConfig,
} from "./docker-client.js";
import { parseMeminfo, parseCpuPercent, getDiskUsage, countQueueFiles } from "./host-metrics.js";
import { loadThreads, loadSettings, formatHumanTime, configureThread, saveThreads } from "./session-manager.js";
import { toErrorMessage, parseSSHPublicKey, parseDevEmail } from "./types.js";
import { logCorrection, ROUTING_LOG, mergeCorrectionsOntoDecisions } from "./routing-logger.js";
import { readRecentJsonl } from "./jsonl-reader.js";

const PROJECT_DIR = path.resolve(__dirname, "..");
const BORG_DIR = path.join(PROJECT_DIR, ".borg");
const QUEUE_INCOMING = path.join(BORG_DIR, "queue/incoming");
const QUEUE_OUTGOING = path.join(BORG_DIR, "queue/outgoing");
const DOCKER_PROXY_URL = process.env.DOCKER_PROXY_URL || "http://docker-proxy:2375";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "localhost";
const DEV_NETWORK = process.env.DEV_NETWORK || "borg_dev";
const COMPOSE_PROJECT = String(process.env["COMPOSE_PROJECT"] ?? "");

// ─── Message Model Lookup (for correction validation) ───

const MESSAGE_MODELS_FILE = path.join(BORG_DIR, "message-models.json");

function lookupMessageModel(messageId: number): { model: string; threadId: number } | undefined {
    try {
        const data = fs.readFileSync(MESSAGE_MODELS_FILE, "utf8");
        const raw = JSON.parse(data) as Record<string, unknown>;
        const entry = raw[String(messageId)];
        if (typeof entry === "string") return { model: entry, threadId: 0 };
        if (entry && typeof entry === "object" && "model" in entry) {
            return entry as { model: string; threadId: number };
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function textContent(text: string) {
    return { type: "text" as const, text };
}

/**
 * Create an MCP server bound to a specific source thread.
 * Each query gets its own instance so cross-thread messages carry the correct sourceThreadId.
 */
export function createBorgMcpServer(sourceThreadId: number) {
    const sendMessage = tool(
        "send_message",
        "Send a message to another Borg thread (Telegram forum topic). The message will appear in that thread and be processed by its agent.",
        { targetThreadId: z.number(), message: z.string() },
        async ({ targetThreadId, message }) => {
            if (targetThreadId === sourceThreadId) {
                return {
                    content: [textContent("Cannot send a message to your own thread")],
                    isError: true,
                };
            }

            let threads: ReturnType<typeof loadThreads>;
            try {
                threads = loadThreads();
            } catch {
                return { content: [textContent("Could not read threads.json")], isError: true };
            }

            if (!threads[String(targetThreadId)]) {
                const available = Object.entries(threads).map(([id, t]) => `${id}: ${t.name}`).join(", ");
                return {
                    content: [textContent(`Thread ${targetThreadId} not found. Available: ${available}`)],
                    isError: true,
                };
            }

            const ts = Date.now();
            const id = `cross_${ts}_${Math.random().toString(36).slice(2, 6)}`;
            const sourceName = threads[String(sourceThreadId)]?.name ?? `Thread ${sourceThreadId}`;

            // Write to incoming queue so the target agent processes it
            const incoming = {
                channel: "telegram",
                source: "cross-thread",
                threadId: targetThreadId,
                sourceThreadId,
                sender: sourceName,
                message,
                timestamp: ts,
                messageId: id,
            };

            fs.mkdirSync(QUEUE_INCOMING, { recursive: true });
            const inTmp = path.join(QUEUE_INCOMING, `${id}.json.tmp`);
            const inFinal = path.join(QUEUE_INCOMING, `${id}.json`);
            fs.writeFileSync(inTmp, JSON.stringify(incoming));
            fs.renameSync(inTmp, inFinal);

            // Write to outgoing queue so it appears in the Telegram topic
            const outgoing = {
                channel: "telegram",
                targetThreadId,
                sourceThreadId: currentThreadId,
                sender: sourceName,
                message,
                originalMessage: "",
                timestamp: ts,
                messageId: `${id}_tg`,
                model: "",
            };

            fs.mkdirSync(QUEUE_OUTGOING, { recursive: true });
            const outTmp = path.join(QUEUE_OUTGOING, `${id}_tg.json.tmp`);
            const outFinal = path.join(QUEUE_OUTGOING, `${id}_tg.json`);
            fs.writeFileSync(outTmp, JSON.stringify(outgoing));
            fs.renameSync(outTmp, outFinal);

            const targetName = threads[String(targetThreadId)].name;
            return { content: [textContent(`Message sent to thread ${targetThreadId} (${targetName})`)] };
        },
    );

    const listThreads = tool(
        "list_threads",
        "List all active Borg threads (Telegram forum topics) with their IDs and names.",
        {},
        async () => {
            try {
                const threads = loadThreads();
                const lines = Object.entries(threads).map(([id, t]) => {
                    const parts = [`Thread ${id}: ${t.name}`];
                    if (t.isMaster) parts.push("(master)");
                    if (t.team) parts.push(`team=${t.team}`);
                    if (t.role) parts.push(`role=${t.role}`);
                    if (t.cwd) parts.push(`cwd=${t.cwd}`);
                    if (Number(id) === sourceThreadId) parts.push("(you)");
                    return parts.join(" ");
                });
                return { content: [textContent(lines.join("\n"))] };
            } catch {
                return { content: [textContent("No threads.json found — no active threads")], isError: true };
            }
        },
    );

    const queryKnowledgeBase = tool(
        "query_knowledge_base",
        "Read a file from the master thread's knowledge base (context.md, decisions.md, active-projects.md)",
        { filename: z.enum(["context.md", "decisions.md", "active-projects.md"]) },
        async ({ filename }) => {
            try {
                const masterConfig = loadThreads()["1"];
                if (!masterConfig?.cwd) {
                    return {
                        content: [textContent("Master thread (thread 1) not found or has no cwd configured")],
                        isError: true,
                    };
                }
                const filePath = path.join(masterConfig.cwd, filename);
                const content = fs.readFileSync(filePath, "utf-8");
                return { content: [textContent(content)] };
            } catch (err) {
                const msg = toErrorMessage(err);
                return {
                    content: [textContent(`Could not read knowledge base file "${filename}": ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    // ─── Container & system tools (read-only ones available to all threads) ───

    const getContainerStats = tool(
        "get_container_stats",
        "Get memory usage stats for all containers (infra + dev) with category tags. Returns container names, memory usage, limits, CPU count, uptime, and idle status.",
        {},
        async () => {
            try {
                const containers = await getAllContainers(DOCKER_PROXY_URL, COMPOSE_PROJECT);

                if (containers.length === 0) {
                    return {
                        content: [textContent("No containers found")],
                    };
                }

                const lines = containers.map(c => {
                    const parts: string[] = [c.name + ":"];
                    parts.push(c.status);
                    parts.push("| " + c.category);
                    if (c.sshPort) parts.push(`| port ${c.sshPort}`);
                    if (c.status === "running") {
                        if (c.memory.unlimited) {
                            parts.push("| no limit");
                        } else {
                            const usageMB = (c.memory.usage / (1024 * 1024)).toFixed(0);
                            const limitMB = (c.memory.limit / (1024 * 1024)).toFixed(0);
                            const pct = c.memory.limit > 0 ? ((c.memory.usage / c.memory.limit) * 100).toFixed(1) : "?";
                            parts.push(`| ${usageMB}MB / ${limitMB}MB (${pct}%)`);
                        }
                    } else {
                        if (c.memory.unlimited) {
                            parts.push("| no limit");
                        } else {
                            const limitMB = (c.memory.limit / (1024 * 1024)).toFixed(0);
                            parts.push(`| ${limitMB}MB allocated`);
                        }
                    }
                    parts.push(`| ${c.cpus.toFixed(1)} CPUs`);
                    if (c.status === "running") {
                        parts.push(`| ${c.uptime}`);
                        if (c.idle) parts.push("(idle)");
                    }
                    return parts.join(" ");
                });

                return { content: [textContent(lines.join("\n"))] };
            } catch (err) {
                const msg = toErrorMessage(err);
                return {
                    content: [textContent(`Failed to get container stats: ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    const updateContainerMemory = tool(
        "update_container_memory",
        "Update memory limit for a container. Limit in bytes. Snaps to 64MB increments, validates total allocation against host capacity, and warns about OOM risks.",
        { containerName: z.string(), memoryLimitBytes: z.number() },
        async ({ containerName, memoryLimitBytes }) => {
            try {
                // Search all containers (infra + dev)
                const containers = await getAllContainers(DOCKER_PROXY_URL, COMPOSE_PROJECT);
                const match = containers.find(c => c.name === containerName);

                if (!match) {
                    return {
                        content: [textContent(`Container "${containerName}" not found`)],
                        isError: true,
                    };
                }

                // Validate and apply the update with full safety checks
                const hostTotal = parseMeminfo().totalBytes;
                const result = await validateAndUpdateMemory(
                    DOCKER_PROXY_URL,
                    match.id,
                    memoryLimitBytes,
                    hostTotal,
                    COMPOSE_PROJECT,
                );

                const parts = [`Updated ${result.name} memory limit: ${formatBytes(result.oldLimit)} -> ${formatBytes(result.newLimit)}`];
                if (result.warning) {
                    parts.push(`WARNING: ${result.warning}`);
                }

                return { content: [textContent(parts.join("\n"))] };
            } catch (err) {
                const msg = toErrorMessage(err);
                return {
                    content: [textContent(`Failed to update container memory: ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    const getHostMemory = tool(
        "get_host_memory",
        "Get host machine memory information: total, available, OS reserve, and max allocatable for containers. Use this before making container memory allocation decisions.",
        {},
        async () => {
            try {
                const { totalBytes } = parseMeminfo();
                const maxAllocatable = totalBytes - OS_RESERVE_BYTES;

                // Get all containers for breakdown
                const containers = await getAllContainers(DOCKER_PROXY_URL, COMPOSE_PROJECT);
                let infraAlloc = 0, devAlloc = 0;
                let infraCount = 0, devCount = 0, unlimitedCount = 0;
                for (const c of containers) {
                    if (c.memory.unlimited) { unlimitedCount++; continue; }
                    if (c.category === "infra") { infraAlloc += c.memory.limit; infraCount++; }
                    else { devAlloc += c.memory.limit; devCount++; }
                }

                const lines = [
                    `Total Memory:       ${formatBytes(totalBytes)}`,
                    `OS Reserve:         ${formatBytes(OS_RESERVE_BYTES)}`,
                    `Infra Allocated:    ${formatBytes(infraAlloc)} (${infraCount} container${infraCount !== 1 ? "s" : ""}${unlimitedCount > 0 ? `, ${unlimitedCount} unlimited` : ""})`,
                    `Dev Allocated:      ${formatBytes(devAlloc)} (${devCount} container${devCount !== 1 ? "s" : ""})`,
                    `Available Budget:   ${formatBytes(Math.max(0, maxAllocatable - infraAlloc - devAlloc))}`,
                ];

                return { content: [textContent(lines.join("\n"))] };
            } catch (err) {
                const msg = toErrorMessage(err);
                return {
                    content: [textContent(`Failed to read host memory: ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    const getSystemStatus = tool(
        "get_system_status",
        "Get system status overview: CPU usage, RAM usage, disk usage, load averages, and message queue depths. Use this for infrastructure health monitoring.",
        {},
        async () => {
            try {
                const cpuPercent = parseCpuPercent();
                const { totalBytes, availableBytes } = parseMeminfo();
                const usedBytes = totalBytes - availableBytes;
                const disk = getDiskUsage(BORG_DIR);
                const loadAvg = os.loadavg();

                const queueIncoming = countQueueFiles(QUEUE_INCOMING);
                const queueOutgoing = countQueueFiles(QUEUE_OUTGOING);
                const queueProcessing = countQueueFiles(path.join(BORG_DIR, "queue/processing"));
                const queueDeadLetter = countQueueFiles(path.join(BORG_DIR, "queue/dead-letter"));

                const lines = [
                    `== CPU ==`,
                    `Usage: ${cpuPercent}%`,
                    ``,
                    `== Memory ==`,
                    `Used: ${formatBytes(usedBytes)} / ${formatBytes(totalBytes)} (${totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0}%)`,
                    `Available: ${formatBytes(availableBytes)}`,
                    ``,
                    `== Disk ==`,
                    `Used: ${disk.usedGB}GB / ${disk.totalGB}GB (available: ${disk.availGB}GB)`,
                    ``,
                    `== Load Averages ==`,
                    `1m: ${loadAvg[0].toFixed(2)}  5m: ${loadAvg[1].toFixed(2)}  15m: ${loadAvg[2].toFixed(2)}`,
                    ``,
                    `== Queue Depths ==`,
                    `Incoming:    ${queueIncoming}`,
                    `Outgoing:    ${queueOutgoing}`,
                    `Processing:  ${queueProcessing}`,
                    `Dead Letter: ${queueDeadLetter}`,
                ];

                return { content: [textContent(lines.join("\n"))] };
            } catch (err) {
                const msg = toErrorMessage(err);
                return {
                    content: [textContent(`Failed to get system status: ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    // ─── Container Lifecycle Tools (master-only) ───

    const createDevContainerTool = tool(
        "create_dev_container",
        "Create a new dev container for a developer. Accepts name (lowercase alphanumeric, e.g. 'alice'), email, and SSH public key (paste the full key starting with ssh-ed25519 or ssh-rsa). Auto-assigns an SSH port from 2201-2299 and a unique container name (dev-alice). Returns SSH config snippet the developer can paste into ~/.ssh/config. The container gets 2GB RAM, 2 CPUs, and credential broker access. If the name is taken, a suffix is auto-incremented (dev-alice-2). IMPORTANT: Always confirm the developer's details before calling this tool.",
        {
            name: z.string().describe("Developer name (lowercase, alphanumeric + hyphens)"),
            email: z.string().describe("Developer email (for git config — must match their GitHub account for commit attribution)"),
            sshPublicKey: z.string().describe("SSH public key (ed25519, RSA, or ECDSA)"),
        },
        async ({ name, email, sshPublicKey }) => {
            try {
                const parsedName = parseDevName(name);
                const parsedEmail = parseDevEmail(email);
                const parsedKey = parseSSHPublicKey(sshPublicKey);

                const containers = await listDevContainers(DOCKER_PROXY_URL);
                const port = findNextAvailablePort(containers);
                const containerName = resolveUniqueName(containers, parsedName);

                const result = await createDevContainerFn(
                    { name: containerName, email: parsedEmail, sshPublicKey: parsedKey },
                    { port, networkName: DEV_NETWORK, publicHost: PUBLIC_HOST, dockerBaseUrl: DOCKER_PROXY_URL },
                );

                // Two-phase error handling: distinguish create-failed from start-failed
                try {
                    await startContainer(DOCKER_PROXY_URL, result.containerId);
                } catch (startErr) {
                    return {
                        content: [textContent(
                            `Container ${result.name} created but failed to start: ${toErrorMessage(startErr)}. ` +
                            `Use start_dev_container to retry.`,
                        )],
                        isError: true,
                    };
                }

                const keyType = sshPublicKey.trim().split(/\s+/)[0];
                const sshConfig = formatSSHConfig(result, keyType);
                return {
                    content: [textContent(
                        `Container ${result.name} created and running on port ${result.port}.\n\nSSH config:\n\`\`\`\n${sshConfig}\n\`\`\``,
                    )],
                };
            } catch (err) {
                return {
                    content: [textContent(`Failed to create container: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const stopDevContainerTool = tool(
        "stop_dev_container",
        "Stop a running dev container by name (e.g., 'dev-alice'). This is reversible — use start_dev_container to restart it. The container's data and port assignment are preserved. Use this for idle containers to free resources.",
        {
            name: z.string().describe("Container name (e.g., 'dev-alice')"),
        },
        async ({ name }) => {
            try {
                const container = await findContainerByName(DOCKER_PROXY_URL, name);
                await stopDevContainer(DOCKER_PROXY_URL, container.Id);
                return { content: [textContent(`Stopped ${name}.`)] };
            } catch (err) {
                return {
                    content: [textContent(`Failed: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const startDevContainerTool = tool(
        "start_dev_container",
        "Start a stopped dev container by name (e.g., 'dev-alice'). The container resumes with its existing data and port assignment. SSH access becomes available after a few seconds.",
        {
            name: z.string().describe("Container name (e.g., 'dev-alice')"),
        },
        async ({ name }) => {
            try {
                const container = await findContainerByName(DOCKER_PROXY_URL, name);
                await startContainer(DOCKER_PROXY_URL, container.Id);
                return { content: [textContent(`Started ${name}.`)] };
            } catch (err) {
                return {
                    content: [textContent(`Failed: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const deleteDevContainerTool = tool(
        "delete_dev_container",
        "Permanently delete a dev container by name (e.g., 'dev-alice'). This is IRREVERSIBLE — all data inside the container is lost and the port is freed. Stops the container first if running. Only works on containers with the borg.type=dev-container label. IMPORTANT: Always confirm with the user before calling this tool.",
        {
            name: z.string().describe("Container name (e.g., 'dev-alice')"),
        },
        async ({ name }) => {
            try {
                const container = await findContainerByName(DOCKER_PROXY_URL, name);
                await deleteDevContainer(DOCKER_PROXY_URL, container.Id);
                const portInfo = container.port ? ` Port ${container.port} is now available.` : "";
                return { content: [textContent(`Deleted ${name}.${portInfo}`)] };
            } catch (err) {
                return {
                    content: [textContent(`Failed: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const getRoutingDecisions = tool(
        "get_routing_decisions",
        "Get recent routing decisions from the routing log. Returns tier, model, confidence, signals, prompt text, and any user corrections.",
        {
            n: z.number().optional().describe("Number of entries (default 50, max 200)"),
            threadId: z.number().optional().describe("Filter by thread ID"),
            correctionsOnly: z.boolean().optional().describe("Only return entries with user corrections"),
        },
        async ({ n = 50, threadId, correctionsOnly }) => {
            try {
                const raw = readRecentJsonl<Record<string, unknown>>(ROUTING_LOG, Math.min(n, 200));
                const decisions = mergeCorrectionsOntoDecisions(raw);

                let filtered = decisions;
                if (threadId !== undefined) {
                    filtered = filtered.filter(d => d.threadId === threadId);
                }
                if (correctionsOnly) {
                    filtered = filtered.filter(d => d.userCorrection !== undefined);
                }

                return { content: [textContent(JSON.stringify(filtered, null, 2))] };
            } catch (err) {
                return {
                    content: [textContent(`Failed to read routing decisions: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const logRoutingCorrection = tool(
        "log_routing_correction",
        "Log a routing correction for a message that was routed to the wrong model. Master-only.",
        {
            messageId: z.number().describe("Telegram message ID of the misrouted response"),
            correctedModel: z.enum(["haiku", "sonnet", "opus"]).describe("The model that should have handled this"),
        },
        async ({ messageId, correctedModel }) => {
            try {
                const stored = lookupMessageModel(messageId);
                if (!stored) {
                    return { content: [textContent("Message not found in model cache (may be pruned)")] };
                }
                if (correctedModel === stored.model) {
                    return { content: [textContent("Same model — not a correction")] };
                }
                logCorrection({
                    ts: Date.now(),
                    type: "correction",
                    messageId,
                    threadId: stored.threadId || undefined,
                    originalModel: stored.model,
                    correctedModel,
                }, ROUTING_LOG);
                return { content: [textContent(`Correction logged: ${stored.model} → ${correctedModel}`)] };
            } catch (err) {
                return {
                    content: [textContent(`Failed to log correction: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const getCurrentTime = tool(
        "get_current_time",
        "Get the current date and time. Use this instead of guessing the time.",
        {
            timezone: z.string().optional()
                .describe("IANA timezone (e.g., 'America/New_York'). Defaults to bot timezone."),
        },
        async ({ timezone }) => {
            try {
                const settings = loadSettings();
                const tz = timezone || settings.timezone;
                const now = new Date();
                const human = formatHumanTime(tz, now);
                return {
                    content: [textContent(JSON.stringify({
                        iso: now.toISOString(),
                        human,
                        timezone: tz,
                        epoch_ms: now.getTime(),
                    }))],
                };
            } catch (err) {
                return {
                    content: [textContent(`Failed to get current time: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const getElapsedTime = tool(
        "get_elapsed_time",
        "Calculate how much time has passed since a timestamp. Use this instead of doing date math yourself.",
        {
            since: z.string()
                .describe("ISO 8601 timestamp (e.g., '2026-02-17T14:30:00Z') or epoch milliseconds as string (e.g., '1708185600000')"),
        },
        async ({ since }) => {
            try {
                const parsed = /^\d+$/.test(since) ? Number(since) : new Date(since).getTime();
                if (isNaN(parsed) || !isFinite(parsed)) {
                    return { content: [textContent("Invalid timestamp format. Use ISO 8601 or epoch milliseconds.")], isError: true };
                }
                const now = Date.now();
                const diffMs = now - parsed;
                const absMinutes = Math.floor(Math.abs(diffMs) / 60000);
                const totalHours = Math.floor(absMinutes / 60);
                const totalDays = Math.floor(totalHours / 24);

                const parts: string[] = [];
                if (totalDays > 0) parts.push(`${totalDays}d`);
                if (totalHours % 24 > 0) parts.push(`${totalHours % 24}h`);
                if (absMinutes % 60 > 0 || parts.length === 0) parts.push(`${absMinutes % 60}m`);
                const human = (diffMs < 0 ? "in " : "") + parts.join(" ") + (diffMs >= 0 ? " ago" : "");

                return {
                    content: [textContent(JSON.stringify({
                        elapsed_ms: Math.abs(diffMs),
                        total_minutes: absMinutes,
                        total_hours: totalHours,
                        total_days: totalDays,
                        human,
                        is_future: diffMs < 0,
                    }))],
                };
            } catch (err) {
                return {
                    content: [textContent(`Failed to calculate elapsed time: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const createThread = tool(
        "create_thread",
        "Create a new Telegram forum topic and register it as a Borg thread. Available to all threads. For team threads, you MUST first create a git worktree and pass its absolute path as the cwd parameter — see borg-teams skill for worktree setup instructions.",
        {
            name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9\-_\s]+$/)
                .describe("Topic name (alphanumeric, hyphens, underscores, spaces)"),
            team: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).optional()
                .describe("Team identifier (lowercase alphanumeric + hyphens)"),
            role: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).optional()
                .describe("Agent role (lowercase alphanumeric + hyphens)"),
            cwd: z.string().optional()
                .describe("Working directory for the thread. REQUIRED for team threads — set this to the absolute path of the team's git worktree (e.g., /absolute/path/.borg/worktrees/{team-name}). All team members must share the same cwd for proper isolation."),
            initialMessage: z.string().optional()
                .describe("First message to send to the new thread"),
        },
        async ({ name, team, role, cwd, initialMessage }) => {
            try {
                const settings = loadSettings();
                const threads = loadThreads();

                // Check for duplicate thread names
                const existing = Object.entries(threads).find(([, t]) => t.name === name);
                if (existing) {
                    return {
                        content: [textContent(`Thread "${name}" already exists (ID: ${existing[0]}). Use a different name.`)],
                        isError: true,
                    };
                }

                // Resource limits
                const totalThreads = Object.keys(threads).length;
                if (totalThreads >= 50) {
                    return {
                        content: [textContent("Maximum of 50 threads reached. Remove some threads first.")],
                        isError: true,
                    };
                }
                if (team) {
                    const teamCount = Object.values(threads).filter(t => t.team === team).length;
                    if (teamCount >= 10) {
                        return {
                            content: [textContent(`Team "${team}" already has 10 threads (maximum). Remove some first.`)],
                            isError: true,
                        };
                    }
                }

                // Create forum topic via direct Telegram HTTP API
                const response = await fetch(
                    `https://api.telegram.org/bot${settings.telegram_bot_token}/createForumTopic`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            chat_id: settings.telegram_chat_id,
                            name,
                        }),
                    }
                );

                if (!response.ok) {
                    const errBody = await response.text();
                    return {
                        content: [textContent(`Telegram API error creating topic: ${errBody}`)],
                        isError: true,
                    };
                }

                const result = await response.json() as { ok: boolean; result?: { message_thread_id: number } };
                if (!result.ok || !result.result) {
                    return {
                        content: [textContent("Telegram API returned unexpected response")],
                        isError: true,
                    };
                }

                const threadId = result.result.message_thread_id;

                // Register in threads.json
                configureThread(threadId, {
                    name,
                    cwd: cwd || (process.env.DEFAULT_CWD || process.cwd()),
                    model: "sonnet",
                    isMaster: false,
                    lastActive: Date.now(),
                    ...(team ? { team } : {}),
                    ...(role ? { role } : {}),
                });

                // Send initial message if provided
                if (initialMessage) {
                    const ts = Date.now();
                    const msgId = `init_${threadId}_${ts}`;
                    const incoming = {
                        channel: "telegram",
                        source: "cross-thread",
                        threadId,
                        sourceThreadId,
                        sender: threads[String(sourceThreadId)]?.name ?? `Thread ${sourceThreadId}`,
                        message: initialMessage,
                        timestamp: ts,
                        messageId: msgId,
                    };
                    fs.mkdirSync(QUEUE_INCOMING, { recursive: true });
                    const tmpPath = path.join(QUEUE_INCOMING, `${msgId}.json.tmp`);
                    const finalPath = path.join(QUEUE_INCOMING, `${msgId}.json`);
                    fs.writeFileSync(tmpPath, JSON.stringify(incoming));
                    fs.renameSync(tmpPath, finalPath);
                }

                const parts = [`Created thread "${name}" (ID: ${threadId})`];
                if (team) parts.push(`team=${team}`);
                if (role) parts.push(`role=${role}`);
                return { content: [textContent(parts.join(", "))] };
            } catch (err) {
                return {
                    content: [textContent(`Failed to create thread: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    // ─── Thread & Team Management Tools ───

    const configureThreadTool = tool(
        "configure_thread",
        "Update team metadata for an existing thread.",
        {
            threadId: z.number().describe("Thread ID to configure"),
            team: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).optional()
                .describe("Team identifier"),
            role: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).optional()
                .describe("Agent role"),
        },
        async ({ threadId, team, role }) => {
            try {
                const threads = loadThreads();
                if (!threads[String(threadId)]) {
                    return { content: [textContent(`Thread ${threadId} not found`)], isError: true };
                }
                configureThread(threadId, {
                    ...(team !== undefined ? { team } : {}),
                    ...(role !== undefined ? { role } : {}),
                });
                return { content: [textContent(`Updated thread ${threadId}: team=${team ?? "(unchanged)"}, role=${role ?? "(unchanged)"}`)] };
            } catch (err) {
                return { content: [textContent(`Failed: ${toErrorMessage(err)}`)], isError: true };
            }
        },
    );

    const disbandTeam = tool(
        "disband_team",
        "Remove team metadata from all threads in a team. Topics remain but lose team association.",
        { team: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).describe("Team name to disband") },
        async ({ team }) => {
            try {
                const threads = loadThreads();
                const teamThreads = Object.entries(threads).filter(([, t]) => t.team === team);
                if (teamThreads.length === 0) {
                    return { content: [textContent(`No threads found in team "${team}"`)], isError: true };
                }
                // Batch update — single read/write cycle
                for (const [id] of teamThreads) {
                    delete threads[id].team;
                    delete threads[id].role;
                }
                saveThreads(threads);
                return { content: [textContent(`Disbanded team "${team}": removed team metadata from ${teamThreads.length} thread(s)`)] };
            } catch (err) {
                return { content: [textContent(`Failed: ${toErrorMessage(err)}`)], isError: true };
            }
        },
    );

    const deleteThread = tool(
        "delete_thread",
        "Permanently delete a Telegram forum topic and unregister it from Borg. This is IRREVERSIBLE — the topic and its message history will be deleted from Telegram. IMPORTANT: Always confirm with the user before calling this tool.",
        { threadId: z.number().describe("Thread ID to delete") },
        async ({ threadId }) => {
            try {
                // Prevent deleting the master thread
                if (threadId === 1) {
                    return {
                        content: [textContent("Cannot delete the master thread (thread 1)")],
                        isError: true,
                    };
                }

                const threads = loadThreads();
                if (!threads[String(threadId)]) {
                    return {
                        content: [textContent(`Thread ${threadId} not found in threads.json`)],
                        isError: true,
                    };
                }

                const settings = loadSettings();

                // Delete the forum topic via Telegram API
                const response = await fetch(
                    `https://api.telegram.org/bot${settings.telegram_bot_token}/deleteForumTopic`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            chat_id: settings.telegram_chat_id,
                            message_thread_id: threadId,
                        }),
                    }
                );

                if (!response.ok) {
                    const errBody = await response.text();
                    return {
                        content: [textContent(`Telegram API error deleting topic: ${errBody}`)],
                        isError: true,
                    };
                }

                const result = await response.json() as { ok: boolean };
                if (!result.ok) {
                    return {
                        content: [textContent("Telegram API returned unexpected response")],
                        isError: true,
                    };
                }

                // Remove from threads.json
                const threadName = threads[String(threadId)].name;
                delete threads[String(threadId)];
                saveThreads(threads);

                return {
                    content: [textContent(`Deleted thread ${threadId} ("${threadName}") from Telegram and unregistered from Borg`)],
                };
            } catch (err) {
                return {
                    content: [textContent(`Failed to delete thread: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    // Build tool list: base tools + read-only monitoring for all threads, mutating tools for master only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous tool schemas require type erasure
    const tools: Array<ReturnType<typeof tool<any>>> = [
        sendMessage, listThreads, queryKnowledgeBase,
        getContainerStats, getSystemStatus, getHostMemory,
        getRoutingDecisions,
        getCurrentTime, getElapsedTime,
        createThread, configureThreadTool, disbandTeam, deleteThread,
    ];
    if (sourceThreadId === 1) {
        tools.push(
            updateContainerMemory,
            createDevContainerTool, stopDevContainerTool, startDevContainerTool, deleteDevContainerTool,
            logRoutingCorrection,
        );
    }

    return createSdkMcpServer({
        name: "borg",
        version: "1.0.0",
        tools,
    });
}
