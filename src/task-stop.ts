/**
 * Task Stop — sole legitimate writer to the dashboard's `.borg-zones-rw` mount.
 *
 * The dashboard container mounts `.borg-zones` twice:
 *   - `.borg-zones:/app/.borg-zones:ro` — read-only, for inspecting any zone.
 *   - `.borg-zones:/app/.borg-zones-rw`  — read-write, scoped BY CONVENTION
 *     to writing task-stop signals only.
 *
 * Nothing at the OS level enforces that scope — any handler that touched the
 * raw `TASK_STOP_BASE` env var could write anywhere under the rw mount and
 * silently sidestep the read-only intent. This module is the only place that
 * reads the env var. Handlers call `writeTaskStopSignal(zone, taskId, payload)`
 * and validation (zone name + taskId charset) is centralized here.
 */

import fs from "fs";
import path from "path";
import { ZONE_NAME_REGEX } from "./zone-templates.js";

/** Same charset as dashboard's SAFE_ID — keep in sync if either changes. */
const SAFE_TASK_ID = /^[a-zA-Z0-9_\-]+$/;

/**
 * Atomically write a task-stop signal file for the given zone/task.
 * The file lands at `<TASK_STOP_BASE>/<zone>/queue/task-stop/<taskId>.json`.
 *
 * Throws if TASK_STOP_BASE is unset, the zone name fails the path-safety
 * regex (must match ZONE_NAME_REGEX and not start with a dot — no path
 * traversal possible), or the taskId contains anything outside
 * `[a-zA-Z0-9_-]`. Unlike isValidZoneName(), this does NOT reject reserved
 * names: system zones (core/perimeter/infra) are legitimate task-stop
 * targets even though they cannot be created as dashboard zones.
 *
 * Reads TASK_STOP_BASE lazily on each call so tests (and theoretically
 * runtime env updates) take effect without re-importing the module.
 */
export function writeTaskStopSignal(zone: string, taskId: string, payload: object): void {
    const TASK_STOP_BASE = process.env.TASK_STOP_BASE;
    if (!TASK_STOP_BASE) {
        throw new Error("TASK_STOP_BASE env var not set");
    }
    if (typeof zone !== "string" || zone.startsWith(".") || !ZONE_NAME_REGEX.test(zone)) {
        throw new Error(`Invalid zone name: ${zone}`);
    }
    if (!SAFE_TASK_ID.test(taskId)) {
        throw new Error(`Invalid taskId: ${taskId}`);
    }

    const dir = path.join(TASK_STOP_BASE, zone, "queue", "task-stop");
    fs.mkdirSync(dir, { recursive: true });

    const finalPath = path.join(dir, `${taskId}.json`);
    const tmpPath = finalPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    fs.renameSync(tmpPath, finalPath);
}
