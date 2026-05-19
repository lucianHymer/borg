import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
    loadZoneTemplates,
    resolveTemplate,
    isValidZoneName,
    clearZoneTemplatesCache,
    RESERVED_ZONE_NAMES,
    ZoneTemplates,
    ZoneTemplate,
} from "../zone-templates.js";

const TEMP_DIR = path.join("/tmp", `zone-templates-test-${process.pid}`);
const TEMPLATES_PATH = path.join(TEMP_DIR, "zone-templates.json");

function writeTemplates(templates: unknown) {
    fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(templates, null, 2));
}

const validTemplates: ZoneTemplates = {
    trusted: {
        _description: "Full credentials.",
        image: "borg-agent:latest",
        memory: "4G",
        networks: ["internal"],
        mounts: [
            { type: "bind", source: "./secrets/x.json", target: "/secrets/x.json", readonly: true },
            { type: "volume", name: "claude-plugins-{ZONE}", target: "/home/node/.claude/plugins" },
        ],
        env: { BROKER_SECRET: "${BROKER_SECRET}" },
    },
    untrusted: {
        image: "borg-agent:latest",
        memory: "1G",
        networks: ["internal"],
        mounts: [
            { type: "bind", source: "./secrets/x.json", target: "/secrets/x.json" },
        ],
        env: {},
    },
};

beforeEach(() => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    clearZoneTemplatesCache();
});

afterEach(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("loadZoneTemplates", () => {
    it("loads a valid templates file", () => {
        writeTemplates(validTemplates);
        const templates = loadZoneTemplates(TEMPLATES_PATH);
        expect(templates).toEqual(validTemplates);
    });

    it("caches by mtime (same reference on second call)", () => {
        writeTemplates(validTemplates);
        const a = loadZoneTemplates(TEMPLATES_PATH);
        const b = loadZoneTemplates(TEMPLATES_PATH);
        expect(a).toBe(b);
    });

    it("reloads when file changes", () => {
        writeTemplates(validTemplates);
        const a = loadZoneTemplates(TEMPLATES_PATH);

        // Bump mtime explicitly, invalidate cache, then rewrite content
        const stat = fs.statSync(TEMPLATES_PATH);
        fs.utimesSync(TEMPLATES_PATH, stat.atime, new Date(Date.now() + 1000));
        clearZoneTemplatesCache();

        const updated: ZoneTemplates = {
            ...validTemplates,
            trusted: { ...validTemplates.trusted, memory: "8G" },
        };
        writeTemplates(updated);
        const b = loadZoneTemplates(TEMPLATES_PATH);
        expect(b).not.toBe(a);
        expect(b.trusted.memory).toBe("8G");
    });

    it("throws when file is missing", () => {
        expect(() => loadZoneTemplates(path.join(TEMP_DIR, "nope.json"))).toThrow();
    });

    it("throws on invalid JSON", () => {
        fs.writeFileSync(TEMPLATES_PATH, "{not valid json");
        expect(() => loadZoneTemplates(TEMPLATES_PATH)).toThrow();
    });

    it("throws on schema violation (missing required field)", () => {
        // memory is required
        writeTemplates({
            trusted: {
                image: "borg-agent:latest",
                networks: ["internal"],
                mounts: [],
                env: {},
            },
        });
        expect(() => loadZoneTemplates(TEMPLATES_PATH)).toThrow();
    });

    it("throws on schema violation (bind mount missing source)", () => {
        writeTemplates({
            trusted: {
                image: "borg-agent:latest",
                memory: "1G",
                networks: ["internal"],
                mounts: [
                    // bind without source — invalid
                    { type: "bind", target: "/x" },
                ],
                env: {},
            },
        });
        expect(() => loadZoneTemplates(TEMPLATES_PATH)).toThrow();
    });

    it("throws on schema violation (volume mount missing name)", () => {
        writeTemplates({
            trusted: {
                image: "borg-agent:latest",
                memory: "1G",
                networks: ["internal"],
                mounts: [
                    // volume without name — invalid
                    { type: "volume", target: "/x" },
                ],
                env: {},
            },
        });
        expect(() => loadZoneTemplates(TEMPLATES_PATH)).toThrow();
    });

    it("accepts the _description metadata field", () => {
        writeTemplates(validTemplates);
        const templates = loadZoneTemplates(TEMPLATES_PATH);
        expect(templates.trusted._description).toBe("Full credentials.");
    });
});

describe("resolveTemplate", () => {
    it("returns the named template", () => {
        const t: ZoneTemplate = resolveTemplate(validTemplates, "trusted");
        expect(t.memory).toBe("4G");
    });

    it("throws clearly for unknown name with the available list", () => {
        let caught: Error | null = null;
        try {
            resolveTemplate(validTemplates, "bogus");
        } catch (err) {
            caught = err as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message).toContain("bogus");
        expect(caught!.message.toLowerCase()).toContain("available");
        // Should list both available templates
        expect(caught!.message).toContain("trusted");
        expect(caught!.message).toContain("untrusted");
    });
});

describe("isValidZoneName — valid names", () => {
    it("accepts lowercase alphanumeric + hyphen", () => {
        expect(isValidZoneName("foo")).toBe(true);
        expect(isValidZoneName("foo-bar")).toBe(true);
        expect(isValidZoneName("a1")).toBe(true);
        expect(isValidZoneName("zone-1")).toBe(true);
        expect(isValidZoneName("my-cool-zone")).toBe(true);
    });

    it("accepts names that start with a digit", () => {
        expect(isValidZoneName("1zone")).toBe(true);
        expect(isValidZoneName("9-team")).toBe(true);
    });

    it("accepts the minimum length (2 chars)", () => {
        expect(isValidZoneName("ab")).toBe(true);
    });

    it("accepts up to 31 chars", () => {
        // 31 chars = 1 starting + 30 trailing
        expect(isValidZoneName("a" + "b".repeat(30))).toBe(true);
    });
});

describe("isValidZoneName — invalid names", () => {
    it("rejects single-character names (too short)", () => {
        expect(isValidZoneName("a")).toBe(false);
    });

    it("rejects empty string", () => {
        expect(isValidZoneName("")).toBe(false);
    });

    it("rejects names longer than 31 chars", () => {
        expect(isValidZoneName("a" + "b".repeat(31))).toBe(false);
    });

    it("rejects uppercase letters", () => {
        expect(isValidZoneName("Foo")).toBe(false);
        expect(isValidZoneName("MYZONE")).toBe(false);
    });

    it("rejects names starting with a dash", () => {
        expect(isValidZoneName("-foo")).toBe(false);
    });

    it("rejects names starting with a dot", () => {
        expect(isValidZoneName(".foo")).toBe(false);
        expect(isValidZoneName(".archived")).toBe(false);
    });

    it("rejects names with underscores", () => {
        expect(isValidZoneName("foo_bar")).toBe(false);
    });

    it("rejects names with spaces", () => {
        expect(isValidZoneName("foo bar")).toBe(false);
    });

    it("rejects names with other special characters", () => {
        expect(isValidZoneName("foo.bar")).toBe(false);
        expect(isValidZoneName("foo/bar")).toBe(false);
        expect(isValidZoneName("foo:bar")).toBe(false);
    });
});

describe("isValidZoneName — reserved names", () => {
    // Per AD5, each of these must be rejected
    const reserved = [
        "infra",
        "dashboard",
        "broker",
        "init",
        "cloudflared",
        "speaches",
        "docker-proxy",
        "archived",
    ];

    for (const name of reserved) {
        it(`rejects reserved name "${name}"`, () => {
            expect(isValidZoneName(name)).toBe(false);
        });
    }

    it("RESERVED_ZONE_NAMES contains exactly the documented set", () => {
        expect(new Set(reserved)).toEqual(RESERVED_ZONE_NAMES);
    });
});
