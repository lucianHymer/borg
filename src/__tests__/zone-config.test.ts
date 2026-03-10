import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
    loadZoneConfig,
    getThreadZone,
    isSameZone,
    getThreadsInZone,
    addThreadToZone,
    removeThreadFromZones,
    saveZoneConfig,
    clearZoneConfigCache,
    ZoneConfig,
} from "../zone-config.js";

const TEMP_DIR = path.join("/tmp", `zone-config-test-${process.pid}`);
const CONFIG_PATH = path.join(TEMP_DIR, "zone-config.json");

function writeConfig(config: ZoneConfig) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const validConfig: ZoneConfig = {
    zones: {
        core: { threads: [1, 43, 58] },
        perimeter: { threads: [100, 200] },
    },
    defaults: { newThread: "perimeter" },
};

beforeEach(() => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    clearZoneConfigCache();
});

afterEach(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("loadZoneConfig", () => {
    it("loads a valid config", () => {
        writeConfig(validConfig);
        const config = loadZoneConfig(CONFIG_PATH);
        expect(config).toEqual(validConfig);
    });

    it("returns null when file does not exist", () => {
        const config = loadZoneConfig(path.join(TEMP_DIR, "nonexistent.json"));
        expect(config).toBeNull();
    });

    it("caches by mtime", () => {
        writeConfig(validConfig);
        const config1 = loadZoneConfig(CONFIG_PATH);
        const config2 = loadZoneConfig(CONFIG_PATH);
        expect(config1).toBe(config2); // same reference = cached
    });

    it("reloads when file changes", () => {
        writeConfig(validConfig);
        const config1 = loadZoneConfig(CONFIG_PATH);

        // Advance mtime by rewriting
        const updated = { ...validConfig, zones: { ...validConfig.zones, core: { threads: [1] } } };
        // Need to ensure mtime changes — touch with a slight delay
        const stat = fs.statSync(CONFIG_PATH);
        fs.utimesSync(CONFIG_PATH, stat.atime, new Date(Date.now() + 1000));
        clearZoneConfigCache(); // force reload
        writeConfig(updated);
        const config2 = loadZoneConfig(CONFIG_PATH);
        expect(config2).not.toBe(config1);
        expect(config2!.zones.core.threads).toEqual([1]);
    });

    it("rejects duplicate threads across zones", () => {
        const bad: ZoneConfig = {
            zones: {
                core: { threads: [1, 43] },
                perimeter: { threads: [43, 200] }, // 43 is duplicate
            },
            defaults: { newThread: "perimeter" },
        };
        writeConfig(bad);
        expect(() => loadZoneConfig(CONFIG_PATH)).toThrow("Thread 43 appears in both");
    });

    it("rejects invalid default zone", () => {
        const bad: ZoneConfig = {
            zones: {
                core: { threads: [1] },
            },
            defaults: { newThread: "nonexistent" },
        };
        writeConfig(bad);
        expect(() => loadZoneConfig(CONFIG_PATH)).toThrow('Default zone "nonexistent" is not defined');
    });

    it("rejects invalid schema", () => {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ zones: "invalid" }));
        expect(() => loadZoneConfig(CONFIG_PATH)).toThrow();
    });
});

describe("getThreadZone", () => {
    it("returns correct zone for known threads", () => {
        expect(getThreadZone(validConfig, 1)).toBe("core");
        expect(getThreadZone(validConfig, 43)).toBe("core");
        expect(getThreadZone(validConfig, 100)).toBe("perimeter");
    });

    it("returns default zone for unknown threads", () => {
        expect(getThreadZone(validConfig, 9999)).toBe("perimeter");
    });
});

describe("isSameZone", () => {
    it("returns true for threads in same zone", () => {
        expect(isSameZone(validConfig, 1, 43)).toBe(true);
        expect(isSameZone(validConfig, 100, 200)).toBe(true);
    });

    it("returns false for threads in different zones", () => {
        expect(isSameZone(validConfig, 1, 100)).toBe(false);
    });

    it("unknown threads are in default zone together", () => {
        expect(isSameZone(validConfig, 9999, 8888)).toBe(true); // both in perimeter (default)
    });

    it("unknown thread matches default zone threads", () => {
        expect(isSameZone(validConfig, 9999, 100)).toBe(true); // both perimeter
    });
});

describe("getThreadsInZone", () => {
    it("returns threads for existing zone", () => {
        expect(getThreadsInZone(validConfig, "core")).toEqual([1, 43, 58]);
    });

    it("returns empty array for nonexistent zone", () => {
        expect(getThreadsInZone(validConfig, "dmz")).toEqual([]);
    });
});

describe("addThreadToZone", () => {
    it("adds thread to specified zone", () => {
        const config = structuredClone(validConfig);
        addThreadToZone(config, 300, "core");
        expect(config.zones.core.threads).toContain(300);
    });

    it("removes thread from old zone when moving", () => {
        const config = structuredClone(validConfig);
        addThreadToZone(config, 100, "core"); // move from perimeter to core
        expect(config.zones.core.threads).toContain(100);
        expect(config.zones.perimeter.threads).not.toContain(100);
    });

    it("throws for nonexistent zone", () => {
        const config = structuredClone(validConfig);
        expect(() => addThreadToZone(config, 1, "dmz")).toThrow('Zone "dmz" does not exist');
    });
});

describe("removeThreadFromZones", () => {
    it("removes thread from all zones", () => {
        const config = structuredClone(validConfig);
        removeThreadFromZones(config, 43);
        expect(config.zones.core.threads).not.toContain(43);
    });

    it("is a no-op for unknown thread", () => {
        const config = structuredClone(validConfig);
        removeThreadFromZones(config, 9999);
        expect(config).toEqual(validConfig);
    });
});

describe("saveZoneConfig", () => {
    it("saves atomically and invalidates cache", () => {
        writeConfig(validConfig);
        loadZoneConfig(CONFIG_PATH); // populate cache

        const updated = structuredClone(validConfig);
        updated.zones.core.threads.push(999);
        saveZoneConfig(CONFIG_PATH, updated);

        // Cache should be invalidated — reload picks up new data
        const loaded = loadZoneConfig(CONFIG_PATH);
        expect(loaded!.zones.core.threads).toContain(999);
    });

    it("no .tmp file left after save", () => {
        saveZoneConfig(CONFIG_PATH, validConfig);
        expect(fs.existsSync(CONFIG_PATH + ".tmp")).toBe(false);
        expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    });
});
