import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { acquireZoneConfigLock } from "../zone-lock.js";

const TEMP_DIR = path.join("/tmp", `zone-lock-test-${process.pid}`);
const LOCK_PATH = path.join(TEMP_DIR, "zone-config.lock");

beforeEach(() => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
});

afterEach(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("acquireZoneConfigLock — happy path", () => {
    it("returns a handle when the lock file doesn't exist", () => {
        const handle = acquireZoneConfigLock(LOCK_PATH);
        expect(handle).toBeDefined();
        expect(typeof handle.release).toBe("function");
        handle.release();
    });

    it("creates the lock file at the given path on acquire", () => {
        expect(fs.existsSync(LOCK_PATH)).toBe(false);
        const handle = acquireZoneConfigLock(LOCK_PATH);
        expect(fs.existsSync(LOCK_PATH)).toBe(true);
        handle.release();
    });

    it("writes PID and timestamp to the lock file", () => {
        const handle = acquireZoneConfigLock(LOCK_PATH);
        const contents = fs.readFileSync(LOCK_PATH, "utf-8");
        const parsed = JSON.parse(contents);
        expect(parsed.pid).toBe(process.pid);
        expect(typeof parsed.acquiredAt).toBe("string");
        // ISO timestamp parses to a valid date
        expect(Number.isNaN(Date.parse(parsed.acquiredAt))).toBe(false);
        handle.release();
    });
});

describe("acquireZoneConfigLock — contention", () => {
    it("throws after retries when the lock is already held", () => {
        // Simulate held lock with a manual write
        fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: 99999, acquiredAt: new Date().toISOString() }));

        // Use tight retries so the test is fast
        let caught: Error | null = null;
        try {
            acquireZoneConfigLock(LOCK_PATH, { retries: 2, retryDelayMs: 10, staleMs: 60_000 });
        } catch (err) {
            caught = err as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message).toContain(LOCK_PATH);
        expect(caught!.message.toLowerCase()).toContain("acquire");
    });

    it("respects custom retries/retryDelayMs (throws within expected window)", () => {
        fs.writeFileSync(LOCK_PATH, "x");

        const start = Date.now();
        let caught: Error | null = null;
        try {
            // 2 retries * 10ms each = ~20ms, plus a bit of overhead.
            acquireZoneConfigLock(LOCK_PATH, { retries: 2, retryDelayMs: 10, staleMs: 60_000 });
        } catch (err) {
            caught = err as Error;
        }
        const elapsed = Date.now() - start;
        expect(caught).not.toBeNull();
        // Loose upper bound — generous for CI jitter — but it definitely shouldn't
        // burn through the default 3-second wait.
        expect(elapsed).toBeLessThan(500);
    });
});

describe("acquireZoneConfigLock — release semantics", () => {
    it("release() removes the lock file", () => {
        const handle = acquireZoneConfigLock(LOCK_PATH);
        expect(fs.existsSync(LOCK_PATH)).toBe(true);
        handle.release();
        expect(fs.existsSync(LOCK_PATH)).toBe(false);
    });

    it("after release(), a new acquire succeeds", () => {
        const h1 = acquireZoneConfigLock(LOCK_PATH);
        h1.release();
        const h2 = acquireZoneConfigLock(LOCK_PATH);
        expect(fs.existsSync(LOCK_PATH)).toBe(true);
        h2.release();
    });

    it("release() is idempotent — calling twice does not throw", () => {
        const handle = acquireZoneConfigLock(LOCK_PATH);
        handle.release();
        expect(() => handle.release()).not.toThrow();
    });

    it("release() does not throw if the lock file was externally removed", () => {
        const handle = acquireZoneConfigLock(LOCK_PATH);
        // Simulate external removal (e.g., stale-takeover by another process)
        fs.unlinkSync(LOCK_PATH);
        expect(() => handle.release()).not.toThrow();
    });
});

describe("acquireZoneConfigLock — stale lock recovery", () => {
    it("force-takes a stale lock (older than staleMs)", () => {
        // Write a lock file and backdate its mtime
        fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: 99999, acquiredAt: "ancient" }));
        const oldTime = new Date(Date.now() - 60_000); // 60s old
        fs.utimesSync(LOCK_PATH, oldTime, oldTime);

        // staleMs=1000 → 60s old should be force-taken on first try
        const handle = acquireZoneConfigLock(LOCK_PATH, { retries: 0, retryDelayMs: 10, staleMs: 1000 });
        // After takeover, our own PID is in the file
        const parsed = JSON.parse(fs.readFileSync(LOCK_PATH, "utf-8"));
        expect(parsed.pid).toBe(process.pid);
        handle.release();
    });

    it("does NOT force-take a fresh lock that is younger than staleMs", () => {
        fs.writeFileSync(LOCK_PATH, "fresh");
        // Lock just written → mtime is "now" → not stale
        let caught: Error | null = null;
        try {
            acquireZoneConfigLock(LOCK_PATH, { retries: 1, retryDelayMs: 5, staleMs: 60_000 });
        } catch (err) {
            caught = err as Error;
        }
        expect(caught).not.toBeNull();
        // Lock file still has the original "fresh" content
        expect(fs.readFileSync(LOCK_PATH, "utf-8")).toBe("fresh");
    });
});
