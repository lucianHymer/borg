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

// ─── Cross-Zone Routing Logic Tests ───

describe("cross-zone routing decisions", () => {
    it("core→core is same zone (no approval needed)", () => {
        expect(isSameZone(validConfig, 1, 43)).toBe(true);
        expect(isSameZone(validConfig, 1, 58)).toBe(true);
    });

    it("perimeter→perimeter is same zone (no approval needed)", () => {
        expect(isSameZone(validConfig, 100, 200)).toBe(true);
    });

    it("core→perimeter requires approval", () => {
        expect(isSameZone(validConfig, 1, 100)).toBe(false);
    });

    it("perimeter→core requires approval", () => {
        expect(isSameZone(validConfig, 100, 1)).toBe(false);
    });

    it("new thread (unknown) → core requires approval if default is perimeter", () => {
        // Thread 9999 not in any zone → defaults to perimeter
        expect(isSameZone(validConfig, 9999, 1)).toBe(false);
    });

    it("new thread → new thread is same zone (both default to perimeter)", () => {
        expect(isSameZone(validConfig, 9999, 8888)).toBe(true);
    });

    it("no zone config means no cross-zone (loadZoneConfig returns null)", () => {
        const config = loadZoneConfig(path.join(TEMP_DIR, "nonexistent.json"));
        expect(config).toBeNull();
        // Caller should treat null as "no zones = deliver directly"
    });
});

describe("broadcast filtering (core-only)", () => {
    const broadcastConfig: ZoneConfig = {
        zones: {
            core: { threads: [1, 43] },
            perimeter: { threads: [100] },
        },
        defaults: { newThread: "perimeter" },
    };

    it("core mainThread threads are eligible for broadcast", () => {
        // Simulates the fan-out filter: mainThread=true AND core zone
        const threads: Record<string, { mainThread?: boolean }> = {
            "1": { mainThread: true },
            "43": { mainThread: false },
            "100": { mainThread: true },
        };

        const eligible = Object.entries(threads).filter(([id, t]) => {
            if (!t.mainThread) return false;
            return getThreadZone(broadcastConfig, Number(id)) === "core";
        });

        expect(eligible.map(([id]) => id)).toEqual(["1"]);
    });

    it("perimeter mainThread threads are excluded from broadcast", () => {
        expect(getThreadZone(broadcastConfig, 100)).toBe("perimeter");
        // Thread 100 has mainThread=true but is in perimeter → excluded
    });

    it("unknown thread defaults to perimeter (excluded from broadcast)", () => {
        expect(getThreadZone(broadcastConfig, 9999)).toBe("perimeter");
    });
});

describe("thread lifecycle zone management", () => {
    it("create_thread adds to creator's zone", () => {
        writeConfig(validConfig);
        const config = loadZoneConfig(CONFIG_PATH)!;

        // Creator is in core (thread 1), new thread 500
        const creatorZone = getThreadZone(config, 1);
        expect(creatorZone).toBe("core");

        addThreadToZone(config, 500, creatorZone);
        expect(getThreadZone(config, 500)).toBe("core");
        expect(config.zones.core.threads).toContain(500);
    });

    it("delete_thread removes from zone config", () => {
        writeConfig(validConfig);
        const config = loadZoneConfig(CONFIG_PATH)!;

        expect(getThreadZone(config, 43)).toBe("core");
        removeThreadFromZones(config, 43);
        // After removal, thread 43 falls back to default zone
        expect(getThreadZone(config, 43)).toBe("perimeter");
        expect(config.zones.core.threads).not.toContain(43);
    });

    it("move thread between zones", () => {
        writeConfig(validConfig);
        const config = loadZoneConfig(CONFIG_PATH)!;

        // Thread 1 starts in core
        expect(getThreadZone(config, 1)).toBe("core");

        // Move to perimeter
        addThreadToZone(config, 1, "perimeter");
        expect(getThreadZone(config, 1)).toBe("perimeter");
        expect(config.zones.core.threads).not.toContain(1);
        expect(config.zones.perimeter.threads).toContain(1);
    });

    it("creating thread in perimeter zone isolates from core", () => {
        writeConfig(validConfig);
        const config = loadZoneConfig(CONFIG_PATH)!;

        // Creator is in perimeter (thread 100), new thread 600
        const creatorZone = getThreadZone(config, 100);
        expect(creatorZone).toBe("perimeter");

        addThreadToZone(config, 600, creatorZone);
        expect(isSameZone(config, 600, 100)).toBe(true);  // same zone as creator
        expect(isSameZone(config, 600, 1)).toBe(false);    // different zone from core
    });
});

describe("template field (AD8/AD4)", () => {
    it("parses zone with template field", () => {
        const config: ZoneConfig = {
            zones: {
                core: { threads: [1], template: "trusted" },
                perimeter: { threads: [], template: "untrusted" },
            },
            defaults: { newThread: "perimeter" },
        };
        writeConfig(config);
        const loaded = loadZoneConfig(CONFIG_PATH);
        expect(loaded).not.toBeNull();
        expect(loaded!.zones.core.template).toBe("trusted");
        expect(loaded!.zones.perimeter.template).toBe("untrusted");
    });

    it("parses zone WITHOUT template field (backwards compat)", () => {
        // Legacy config — no template field at all
        const legacy = {
            zones: {
                core: { threads: [1, 43, 58] },
                perimeter: { threads: [100, 200] },
            },
            defaults: { newThread: "perimeter" },
        };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(legacy, null, 2));
        const loaded = loadZoneConfig(CONFIG_PATH);
        expect(loaded).not.toBeNull();
        expect(loaded!.zones.core.template).toBeUndefined();
        expect(loaded!.zones.perimeter.template).toBeUndefined();
    });

    it("rejects invalid template value", () => {
        const bad = {
            zones: {
                core: { threads: [1], template: "garbage" },
                perimeter: { threads: [] },
            },
            defaults: { newThread: "perimeter" },
        };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(bad, null, 2));
        let caught: Error | null = null;
        try {
            loadZoneConfig(CONFIG_PATH);
        } catch (err) {
            caught = err as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message.toLowerCase()).toContain("template");
    });

    it("accepts mixed-template configs (some zones with, some without)", () => {
        const mixed = {
            zones: {
                core: { threads: [1], template: "trusted" },
                perimeter: { threads: [100] }, // no template
                dmz: { threads: [], template: "untrusted" },
            },
            defaults: { newThread: "perimeter" },
        };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(mixed, null, 2));
        const loaded = loadZoneConfig(CONFIG_PATH);
        expect(loaded).not.toBeNull();
        expect(loaded!.zones.core.template).toBe("trusted");
        expect(loaded!.zones.perimeter.template).toBeUndefined();
        expect(loaded!.zones.dmz.template).toBe("untrusted");
    });
});
