/**
 * Scheduled Tasks — Durable cron-based task scheduling.
 * Tasks persist in .borg/scheduled-tasks.json and survive restarts.
 * Execution is one-shot (no session resume) to avoid cache entanglement.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Cron } from "croner";
import { loadSettings } from "./session-manager.js";

// ─── Types ───

export interface ScheduledTask {
    id: string;
    name: string;
    prompt: string;
    model: string;              // "haiku", "sonnet[1m]", "opus[1m]", etc.
    cron: string;               // 5-field cron expression (evaluated in user timezone)
    cwd: string;
    reportThreadId: number;     // thread where results are posted
    enabled: boolean;
    recurring: boolean;         // false = auto-delete after first run
    createdAt: number;          // epoch ms
    lastRunTs?: number;
    lastResult?: "success" | "error";
    lastCostUSD?: number;
}

interface TaskStore {
    tasks: ScheduledTask[];
}

// ─── Model Aliases ───

/** Maps short model names to SDK model strings */
export const MODEL_MAP: Record<string, string> = { haiku: "haiku", sonnet: "sonnet", opus: "opus[1m]" };

// ─── File Paths ───

const SCRIPT_DIR = path.resolve(__dirname, "..");
const BORG_DIR = path.join(SCRIPT_DIR, ".borg");
const TASKS_FILE = path.join(BORG_DIR, "scheduled-tasks.json");

// ─── mtime-cached reads ───

let cachedTasks: ScheduledTask[] | null = null;
let cachedMtime = 0;

export function loadTasks(): ScheduledTask[] {
    try {
        const stat = fs.statSync(TASKS_FILE);
        if (cachedTasks && stat.mtimeMs === cachedMtime) return cachedTasks;
        const data: TaskStore = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
        cachedTasks = data.tasks ?? [];
        cachedMtime = stat.mtimeMs;
        return cachedTasks;
    } catch {
        cachedTasks = [];
        return [];
    }
}

function saveTasks(tasks: ScheduledTask[]): void {
    fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
    const tmp = TASKS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
    fs.renameSync(tmp, TASKS_FILE);
    cachedTasks = tasks;
    try {
        cachedMtime = fs.statSync(TASKS_FILE).mtimeMs;
    } catch { /* best effort */ }
}

// ─── CRUD ───

export function addTask(input: Omit<ScheduledTask, "id" | "createdAt">): ScheduledTask {
    const tasks = loadTasks();
    const task: ScheduledTask = {
        ...input,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
    };
    tasks.push(task);
    saveTasks(tasks);
    return task;
}

export function updateTask(id: string, updates: Partial<Omit<ScheduledTask, "id" | "createdAt">>): ScheduledTask | null {
    const tasks = loadTasks();
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return null;
    tasks[idx] = { ...tasks[idx], ...updates };
    saveTasks(tasks);
    return tasks[idx];
}

export function deleteTask(id: string): boolean {
    const tasks = loadTasks();
    const filtered = tasks.filter(t => t.id !== id);
    if (filtered.length === tasks.length) return false;
    saveTasks(filtered);
    return true;
}

// ─── Scheduling ───

function getTimezone(): string {
    try {
        return loadSettings().timezone || "UTC";
    } catch {
        return "UTC";
    }
}

export function getNextRun(task: ScheduledTask): Date | null {
    try {
        const cron = new Cron(task.cron, { timezone: getTimezone() });
        return cron.nextRun() ?? null;
    } catch {
        return null;
    }
}

/**
 * Get tasks that are due for execution.
 * A task is due if the most recent scheduled fire time (according to cron)
 * is after the task's lastRunTs (or createdAt if never run).
 */
export function getDueTasks(): ScheduledTask[] {
    const tasks = loadTasks();
    const tz = getTimezone();
    const now = new Date();
    const due: ScheduledTask[] = [];

    for (const task of tasks) {
        if (!task.enabled) continue;

        try {
            const cron = new Cron(task.cron, { timezone: tz });
            // Get the previous scheduled time (most recent fire time before now)
            const prevRuns = cron.previousRuns(1, now);
            if (prevRuns.length === 0) continue;

            const lastScheduled = prevRuns[0].getTime();
            const lastRan = task.lastRunTs ?? task.createdAt;

            // Task is due if the last scheduled time is after when we last ran it
            if (lastScheduled > lastRan) {
                due.push(task);
            }
        } catch {
            // Invalid cron expression — skip
        }
    }

    return due;
}

/**
 * Mark a task as queued. Sets lastRunTs immediately so getDueTasks()
 * won't re-detect it while it's still executing.
 */
export function markTaskQueued(id: string): void {
    if (!loadTasks().find(t => t.id === id)) return;
    updateTask(id, { lastRunTs: Date.now() });
}

/**
 * Mark a task as completed. Updates lastResult and lastCostUSD.
 * Auto-deletes non-recurring tasks.
 */
export function markTaskComplete(id: string, result: "success" | "error", costUSD: number): void {
    if (!loadTasks().find(t => t.id === id)) return;

    const task = updateTask(id, {
        lastResult: result,
        lastCostUSD: costUSD,
    });

    // Auto-delete one-shot tasks
    if (task && !task.recurring) {
        deleteTask(id);
    }
}

/**
 * Validate a cron expression. Returns null if valid, error message if invalid.
 */
export function validateCron(expression: string): string | null {
    try {
        new Cron(expression, { timezone: getTimezone() });
        return null;
    } catch (err) {
        return String(err instanceof Error ? err.message : err);
    }
}
