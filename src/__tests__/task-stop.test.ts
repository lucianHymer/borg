import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { writeTaskStopSignal } from "../task-stop.js";

const TEMP_DIR = path.join(os.tmpdir(), `task-stop-test-${process.pid}`);

describe("writeTaskStopSignal", () => {
    beforeAll(() => {
        process.env.TASK_STOP_BASE = TEMP_DIR;
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    });

    beforeEach(() => {
        if (fs.existsSync(TEMP_DIR)) {
            fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(TEMP_DIR, { recursive: true });
        process.env.TASK_STOP_BASE = TEMP_DIR;
    });

    afterAll(() => {
        if (fs.existsSync(TEMP_DIR)) {
            fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        }
        delete process.env.TASK_STOP_BASE;
    });

    it("writes a task-stop signal file at <base>/<zone>/queue/task-stop/<taskId>.json", () => {
        writeTaskStopSignal("core", "task-abc123", { ts: 12345 });
        const expected = path.join(TEMP_DIR, "core", "queue", "task-stop", "task-abc123.json");
        expect(fs.existsSync(expected)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(expected, "utf8"));
        expect(parsed).toEqual({ ts: 12345 });
    });

    it("does not leave a stray .tmp file behind on success", () => {
        writeTaskStopSignal("perimeter", "t1", { ts: 1 });
        const dir = path.join(TEMP_DIR, "perimeter", "queue", "task-stop");
        const files = fs.readdirSync(dir);
        expect(files).toEqual(["t1.json"]);
    });

    it("creates the directory tree if it doesn't exist", () => {
        const dir = path.join(TEMP_DIR, "fresh-zone", "queue", "task-stop");
        expect(fs.existsSync(dir)).toBe(false);
        writeTaskStopSignal("fresh-zone", "t1", { ts: 1 });
        expect(fs.existsSync(dir)).toBe(true);
    });

    it("throws when TASK_STOP_BASE is unset", () => {
        delete process.env.TASK_STOP_BASE;
        expect(() => writeTaskStopSignal("core", "t1", {})).toThrow(/TASK_STOP_BASE env var not set/);
    });

    it("throws on path-traversal in the zone name", () => {
        expect(() => writeTaskStopSignal("../evil", "t1", {})).toThrow(/Invalid zone name/);
        expect(() => writeTaskStopSignal("..", "t1", {})).toThrow(/Invalid zone name/);
        expect(() => writeTaskStopSignal("foo/bar", "t1", {})).toThrow(/Invalid zone name/);
        expect(() => writeTaskStopSignal(".hidden", "t1", {})).toThrow(/Invalid zone name/);
    });

    it("rejects empty / malformed zone names", () => {
        expect(() => writeTaskStopSignal("", "t1", {})).toThrow(/Invalid zone name/);
        expect(() => writeTaskStopSignal("Foo", "t1", {})).toThrow(/Invalid zone name/);
        expect(() => writeTaskStopSignal("-bad", "t1", {})).toThrow(/Invalid zone name/);
    });

    it("allows reserved-name zones (system zones are legitimate task-stop targets)", () => {
        // Reserved names like "infra" pass the path-safety regex, even though
        // they can't be created as dashboard zones. Task-stop writes target
        // existing zones found by scanning .borg-zones/, so the only safety
        // requirement is that the name be filesystem-safe.
        expect(() => writeTaskStopSignal("infra", "t1", { ts: 1 })).not.toThrow();
    });

    it("rejects unsafe taskIds (path separators, dots, traversal)", () => {
        expect(() => writeTaskStopSignal("core", "../escape", {})).toThrow(/Invalid taskId/);
        expect(() => writeTaskStopSignal("core", "foo/bar", {})).toThrow(/Invalid taskId/);
        expect(() => writeTaskStopSignal("core", "foo.bar", {})).toThrow(/Invalid taskId/);
        expect(() => writeTaskStopSignal("core", "", {})).toThrow(/Invalid taskId/);
        expect(() => writeTaskStopSignal("core", "has space", {})).toThrow(/Invalid taskId/);
    });

    it("accepts valid taskIds with letters, digits, underscores, hyphens", () => {
        expect(() => writeTaskStopSignal("core", "abc-123_XYZ", { ts: 1 })).not.toThrow();
        const expected = path.join(TEMP_DIR, "core", "queue", "task-stop", "abc-123_XYZ.json");
        expect(fs.existsSync(expected)).toBe(true);
    });
});
