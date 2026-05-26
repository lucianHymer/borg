/**
 * Zone Lock — file-based mutex backed by O_EXCL, used to serialize mutations
 * to zone-config.json (create/delete zone, move thread) across processes.
 * Held briefly (milliseconds-to-seconds) during dashboard write operations.
 * Synchronous by design — matches the sync style of zone-config.ts and avoids
 * promise-handling complexity for a short-duration critical section.
 */

import fs from "fs";

export interface ZoneLockHandle {
    release(): void;
}

export interface AcquireOptions {
    /** Number of retry attempts before throwing. Default 30. */
    retries?: number;
    /** Milliseconds to wait between retries. Default 100 (so default total wait ~3s). */
    retryDelayMs?: number;
    /** If the existing lock file is older than this, treat it as abandoned and
     * force-take it. Default 30_000 (30s). */
    staleMs?: number;
}

const DEFAULT_RETRIES = 30;
const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_STALE_MS = 30_000;

/**
 * Synchronously sleep for `ms` milliseconds.
 * Uses Atomics.wait on a SharedArrayBuffer for a true blocking sleep —
 * avoids the busy-CPU spin a `while (Date.now() < deadline)` loop would create.
 */
function sleepSync(ms: number): void {
    if (ms <= 0) return;
    // 4-byte SAB holding an Int32; we wait on offset 0 for value 0, which will
    // never become anything else within the same process — so wait returns
    // "timed-out" after exactly `ms` ms. No CPU spin.
    const sab = new SharedArrayBuffer(4);
    const i32 = new Int32Array(sab);
    Atomics.wait(i32, 0, 0, ms);
}

/**
 * Acquire a file-based exclusive lock at `lockPath`.
 *
 * Behavior:
 * 1. Try `fs.openSync(lockPath, "wx")` (O_EXCL — fails if file exists).
 * 2. On EEXIST: if the existing lock file is older than `staleMs`,
 *    unlink it and retry the create. Otherwise, sleep `retryDelayMs` and retry.
 * 3. After `retries` exhausted, throw with a clear message including the
 *    lockPath and the staleness of the lock file.
 * 4. On success, write PID + timestamp to the lock file (debug aid) and
 *    return a handle whose `release()` unlinks the file (idempotent).
 */
export function acquireZoneConfigLock(
    lockPath: string,
    opts: AcquireOptions = {},
): ZoneLockHandle {
    const retries = opts.retries ?? DEFAULT_RETRIES;
    const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;

    let attempts = 0;
    // We allow `retries` retries on top of the initial attempt, so the total
    // tries is retries + 1. Loop until acquired or throw.
    while (true) {
        try {
            const fd = fs.openSync(lockPath, "wx");
            // Write debug info — PID and ISO timestamp — so an operator who
            // finds a stale lock file can identify the dead process.
            const payload = JSON.stringify({
                pid: process.pid,
                acquiredAt: new Date().toISOString(),
            });
            fs.writeSync(fd, payload);
            fs.closeSync(fd);

            let released = false;
            return {
                release() {
                    if (released) return;
                    released = true;
                    try {
                        fs.unlinkSync(lockPath);
                    } catch (err: unknown) {
                        if (
                            err instanceof Error &&
                            "code" in err &&
                            (err as NodeJS.ErrnoException).code === "ENOENT"
                        ) {
                            // Already gone — warn but don't throw. Common if
                            // a stale-lock-takeover replaced our file.
                            console.warn(
                                `[zone-lock] release() called but lock file already gone: ${lockPath}`,
                            );
                            return;
                        }
                        throw err;
                    }
                },
            };
        } catch (err: unknown) {
            const code = err instanceof Error && "code" in err
                ? (err as NodeJS.ErrnoException).code
                : undefined;
            if (code !== "EEXIST") {
                throw err;
            }

            // Lock exists — check staleness.
            let ageMs: number | null = null;
            try {
                const stat = fs.statSync(lockPath);
                ageMs = Date.now() - stat.mtimeMs;
            } catch {
                // Lock file vanished between open() and stat() — fine, retry
                // the open immediately.
                ageMs = null;
            }

            if (ageMs !== null && ageMs > staleMs) {
                // Force-take: unlink and immediately retry without counting
                // this as a retry attempt.
                try {
                    fs.unlinkSync(lockPath);
                } catch (unlinkErr: unknown) {
                    if (
                        !(unlinkErr instanceof Error) ||
                        !("code" in unlinkErr) ||
                        (unlinkErr as NodeJS.ErrnoException).code !== "ENOENT"
                    ) {
                        throw unlinkErr;
                    }
                    // ENOENT — someone else won the race; continue and retry.
                }
                continue;
            }

            // Not stale yet — count this as a retry and wait.
            if (attempts >= retries) {
                const ageDesc = ageMs === null ? "unknown" : `${ageMs}ms`;
                throw new Error(
                    `Failed to acquire zone-config lock at ${lockPath} after ${retries} retries ` +
                    `(lock held for ${ageDesc}, staleMs threshold ${staleMs}ms)`,
                );
            }
            attempts++;
            sleepSync(retryDelayMs);
        }
    }
}
