import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
    parseMemory,
    createZoneContainer,
    deleteZoneContainer,
    getZoneContainerStatus,
    ensureZoneContainersExist,
} from "../zone-supervisor.js";
import { clearZoneTemplatesCache } from "../zone-templates.js";
import { clearZoneConfigCache } from "../zone-config.js";

// ─── Fetch stub plumbing ───

type FetchCall = { url: string; method: string; body?: any };

type FetchHandler = (call: FetchCall) => { status: number; body?: any } | Promise<{ status: number; body?: any }>;

function makeResponse(status: number, body: any): Response {
    // 204 and 304 are null-body statuses per the Fetch spec — Response constructor
    // throws if you give them a body (even ""). Use null for those.
    const isNullBody = status === 204 || status === 304 || status === 205;
    return new Response(
        isNullBody ? null : body !== undefined ? JSON.stringify(body) : "",
        { status },
    );
}

function setupFetchMock(handler: FetchHandler): FetchCall[] {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
        const call: FetchCall = {
            url: String(url),
            method: init?.method ?? "GET",
            body: init?.body ? JSON.parse(init.body as string) : undefined,
        };
        calls.push(call);
        const { status, body } = await handler(call);
        return makeResponse(status, body);
    }) as any;
    return calls;
}

/** Build a fetch handler from a queue of step results — easier than juggling URL matching. */
function setupFetchSequence(steps: Array<(call: FetchCall) => { status: number; body?: any }>): FetchCall[] {
    let i = 0;
    return setupFetchMock(call => {
        if (i >= steps.length) {
            throw new Error(`Unexpected fetch call #${i + 1}: ${call.method} ${call.url}`);
        }
        const fn = steps[i++];
        return fn(call);
    });
}

// ─── Env fixture ───

const TEST_ENV: Record<string, string> = {
    DOCKER_PROXY_URL: "http://docker-proxy:2375/v1.47",
    WORKSPACE_ROOT: "/home/lucian/workspace",
    WORKSPACE_HOST_BASE: "/var/lib/borg",
    BROKER_SECRET: "super-secret",
    PUBLIC_HOST: "borg.example.com",
    CLAUDE_CREDENTIALS: "/home/lucian/.claude/.credentials.json",
    BORG_REPO_ROOT: "/home/lucian/borg",
};

// ─── Temp fixture for templates + config ───

const TEMP_DIR = path.join("/tmp", `zone-supervisor-test-${process.pid}`);
const TEMPLATES_PATH = path.join(TEMP_DIR, "zone-templates.json");
const CONFIG_PATH = path.join(TEMP_DIR, "zone-config.json");

const stdTemplates = {
    trusted: {
        image: "borg-agent:latest",
        memory: "4G",
        networks: ["internal"],
        mounts: [
            { type: "bind", source: "./secrets/github-installations.json", target: "/secrets/github-installations.json", readonly: true },
            { type: "bind", source: "${CLAUDE_CREDENTIALS}", target: "/home/node/.claude/.credentials.json" },
            { type: "bind", source: "./.borg-zones/{ZONE}/claude-skills", target: "/home/node/.claude/skills" },
            { type: "volume", name: "claude-plugins-{ZONE}", target: "/home/node/.claude/plugins" },
        ],
        env: {
            CREDENTIAL_BROKER_URL: "http://broker:3000",
            BROKER_SECRET: "${BROKER_SECRET}",
            PUBLIC_HOST: "${PUBLIC_HOST}",
        },
    },
    untrusted: {
        image: "borg-agent:latest",
        memory: "1G",
        networks: ["internal"],
        mounts: [
            { type: "bind", source: "${CLAUDE_CREDENTIALS}", target: "/home/node/.claude/.credentials.json" },
            { type: "volume", name: "claude-plugins-{ZONE}", target: "/home/node/.claude/plugins" },
        ],
        env: {
            CREDENTIAL_BROKER_URL: "http://broker:3000",
            BROKER_SECRET: "${BROKER_SECRET}",
        },
    },
};

function writeTemplates(t: unknown) {
    fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(t, null, 2));
}

function writeConfig(c: unknown) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

// ─── Env save/restore ───

let savedEnv: Record<string, string | undefined>;

function applyEnv(env: Record<string, string>) {
    for (const [k, v] of Object.entries(env)) {
        process.env[k] = v;
    }
}

beforeEach(() => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    clearZoneTemplatesCache();
    clearZoneConfigCache();

    savedEnv = {};
    for (const k of Object.keys(TEST_ENV)) {
        savedEnv[k] = process.env[k];
    }
    savedEnv["ZONE_TEMPLATES_PATH"] = process.env.ZONE_TEMPLATES_PATH;
    applyEnv(TEST_ENV);
    process.env.ZONE_TEMPLATES_PATH = TEMPLATES_PATH;
});

afterEach(() => {
    delete (globalThis as any).fetch;
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = v;
        }
    }
});

// ─── Tests ───

describe("parseMemory", () => {
    it("parses uppercase G/M/K suffixes", () => {
        expect(parseMemory("4G")).toBe(4 * 1024 * 1024 * 1024);
        expect(parseMemory("512M")).toBe(512 * 1024 * 1024);
        expect(parseMemory("1024K")).toBe(1024 * 1024);
    });
    it("parses lowercase suffixes", () => {
        expect(parseMemory("1g")).toBe(1 * 1024 * 1024 * 1024);
        expect(parseMemory("1m")).toBe(1024 * 1024);
        expect(parseMemory("1k")).toBe(1024);
    });
    it("throws on garbage input", () => {
        expect(() => parseMemory("garbage")).toThrow();
        expect(() => parseMemory("4")).toThrow();
        expect(() => parseMemory("4GB")).toThrow();
    });
});

describe("createZoneContainer — success path", () => {
    it("creates container with merged spec + placeholders resolved", async () => {
        writeTemplates(stdTemplates);

        const calls = setupFetchSequence([
            // create
            () => ({ status: 201, body: { Id: "abc1234567890abcdef" } }),
            // start
            () => ({ status: 204 }),
        ]);

        const info = await createZoneContainer({
            zoneName: "foo",
            template: "untrusted",
            envOverrides: { ...TEST_ENV, ZONE_TEMPLATES_PATH: TEMPLATES_PATH },
        });

        expect(info).toEqual({
            name: "borg-zone-foo",
            id: "abc1234567890abcdef",
            status: "running",
        });

        // create call assertions
        const createCall = calls[0];
        expect(createCall.url).toContain("/containers/create?name=borg-zone-foo");
        expect(createCall.method).toBe("POST");
        const spec = createCall.body;
        expect(spec.Image).toBe("borg-agent:latest");
        expect(spec.HostConfig.Memory).toBe(1024 * 1024 * 1024); // 1G
        expect(spec.HostConfig.Init).toBe(true);
        expect(spec.HostConfig.RestartPolicy.Name).toBe("on-failure");
        expect(spec.HostConfig.StopTimeout).toBe(30);
        expect(spec.HostConfig.NetworkMode).toBe("internal");

        // Base mounts (5) + template mounts (2 for untrusted) = 7
        expect(spec.HostConfig.Mounts.length).toBe(7);

        // Base mount: /app/.borg → host repo / .borg-zones / foo
        const borgMount = spec.HostConfig.Mounts.find((m: any) => m.Target === "/app/.borg");
        expect(borgMount.Source).toBe("/home/lucian/borg/.borg-zones/foo");
        expect(borgMount.Type).toBe("bind");

        // Base mount: workspace
        const wsMount = spec.HostConfig.Mounts.find((m: any) => m.Target === "/home/lucian/workspace");
        expect(wsMount.Source).toBe("/var/lib/borg/workspace-foo");

        // Template mount: claude credentials, placeholder substituted
        const credMount = spec.HostConfig.Mounts.find((m: any) => m.Target === "/home/node/.claude/.credentials.json");
        expect(credMount.Source).toBe("/home/lucian/.claude/.credentials.json");

        // Template mount: volume with {ZONE} substituted
        const pluginsMount = spec.HostConfig.Mounts.find((m: any) => m.Target === "/home/node/.claude/plugins");
        expect(pluginsMount.Type).toBe("volume");
        expect(pluginsMount.Source).toBe("claude-plugins-foo");

        // Env: base + template
        expect(spec.Env).toContain("NODE_ENV=production");
        expect(spec.Env).toContain("BORG_ZONE=foo");
        expect(spec.Env).toContain("ZONE_CONFIG_PATH=/app/zone-config.json");
        expect(spec.Env).toContain("DEFAULT_CWD=/home/lucian/workspace");
        expect(spec.Env).toContain("CREDENTIAL_BROKER_URL=http://broker:3000");
        expect(spec.Env).toContain("BROKER_SECRET=super-secret");

        // Start call
        const startCall = calls[1];
        expect(startCall.url).toBe("http://docker-proxy:2375/v1.47/containers/abc1234567890abcdef/start");
        expect(startCall.method).toBe("POST");
    });
});

describe("createZoneContainer — secondary networks", () => {
    it("attaches secondary networks between create and start", async () => {
        const templatesWithExtraNet = {
            ...stdTemplates,
            untrusted: { ...stdTemplates.untrusted, networks: ["internal", "extra"] },
        };
        writeTemplates(templatesWithExtraNet);

        const calls = setupFetchSequence([
            // create
            () => ({ status: 201, body: { Id: "deadbeef" } }),
            // network attach
            () => ({ status: 200 }),
            // start
            () => ({ status: 204 }),
        ]);

        await createZoneContainer({
            zoneName: "foo",
            template: "untrusted",
            envOverrides: { ...TEST_ENV, ZONE_TEMPLATES_PATH: TEMPLATES_PATH },
        });

        // Primary network is on the create spec
        const spec = calls[0].body;
        expect(spec.HostConfig.NetworkMode).toBe("internal");

        // Secondary network attached
        expect(calls[1].url).toBe("http://docker-proxy:2375/v1.47/networks/extra/connect");
        expect(calls[1].method).toBe("POST");
        expect(calls[1].body).toEqual({ Container: "deadbeef" });

        // Start last
        expect(calls[2].url).toContain("/containers/deadbeef/start");
    });
});

describe("createZoneContainer — rollback on start failure", () => {
    it("DELETEs the container when start returns 500", async () => {
        writeTemplates(stdTemplates);

        const calls = setupFetchSequence([
            // create → success
            () => ({ status: 201, body: { Id: "abc" } }),
            // start → fail
            () => ({ status: 500, body: { message: "no such image" } }),
            // rollback DELETE
            () => ({ status: 204 }),
        ]);

        let caught: Error | null = null;
        try {
            await createZoneContainer({
                zoneName: "foo",
                template: "untrusted",
                envOverrides: { ...TEST_ENV, ZONE_TEMPLATES_PATH: TEMPLATES_PATH },
            });
        } catch (err) {
            caught = err as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message).toContain('step "start"');

        // Verify DELETE was called
        const deleteCall = calls[2];
        expect(deleteCall.method).toBe("DELETE");
        expect(deleteCall.url).toContain("/containers/abc");
    });
});

describe("createZoneContainer — rollback on network attach failure", () => {
    it("DELETEs the container when network attach fails", async () => {
        const templatesWithExtraNet = {
            ...stdTemplates,
            untrusted: { ...stdTemplates.untrusted, networks: ["internal", "extra"] },
        };
        writeTemplates(templatesWithExtraNet);

        const calls = setupFetchSequence([
            // create → success
            () => ({ status: 201, body: { Id: "abc" } }),
            // network attach → fail
            () => ({ status: 404, body: { message: "no such network: extra" } }),
            // rollback DELETE
            () => ({ status: 204 }),
        ]);

        let caught: Error | null = null;
        try {
            await createZoneContainer({
                zoneName: "foo",
                template: "untrusted",
                envOverrides: { ...TEST_ENV, ZONE_TEMPLATES_PATH: TEMPLATES_PATH },
            });
        } catch (err) {
            caught = err as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message).toContain('step "attach-network"');

        expect(calls[2].method).toBe("DELETE");
        expect(calls[2].url).toContain("/containers/abc");
    });
});

describe("createZoneContainer — missing env var", () => {
    it("throws naming the missing var", async () => {
        writeTemplates(stdTemplates);
        setupFetchMock(() => { throw new Error("should not be called"); });

        // Remove WORKSPACE_ROOT from process.env, and don't supply via overrides either.
        delete process.env.WORKSPACE_ROOT;
        const partial = { ...TEST_ENV, ZONE_TEMPLATES_PATH: TEMPLATES_PATH };
        delete (partial as any).WORKSPACE_ROOT;

        let caught: Error | null = null;
        try {
            await createZoneContainer({
                zoneName: "foo",
                template: "untrusted",
                envOverrides: partial,
            });
        } catch (err) {
            caught = err as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message).toContain("WORKSPACE_ROOT");
    });
});

describe("createZoneContainer — unknown template", () => {
    it("throws when template name not in templates file", async () => {
        writeTemplates(stdTemplates);
        setupFetchMock(() => { throw new Error("should not be called"); });

        let caught: Error | null = null;
        try {
            await createZoneContainer({
                zoneName: "foo",
                template: "garbage" as any,
                envOverrides: { ...TEST_ENV, ZONE_TEMPLATES_PATH: TEMPLATES_PATH },
            });
        } catch (err) {
            caught = err as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message.toLowerCase()).toMatch(/garbage|template/);
    });
});

describe("createZoneContainer — zoneTemplatesPath option (regression: A3 path mismatch)", () => {
    it("uses opts.zoneTemplatesPath over ZONE_TEMPLATES_PATH env var", async () => {
        // "expected" templates declare 2G untrusted memory; "wrong" declares 8G.
        // If the option is honored, the create body must show 2G; if the env
        // var wins (the pre-fix bug), we'd see 8G instead.
        const expectedTemplates = {
            untrusted: {
                ...stdTemplates.untrusted,
                memory: "2G",
            },
        };
        const wrongTemplates = {
            untrusted: {
                ...stdTemplates.untrusted,
                memory: "8G",
            },
        };

        const expectedPath = path.join(TEMP_DIR, "expected-templates.json");
        const wrongPath = path.join(TEMP_DIR, "wrong-templates.json");
        fs.writeFileSync(expectedPath, JSON.stringify(expectedTemplates));
        fs.writeFileSync(wrongPath, JSON.stringify(wrongTemplates));

        // Force distinct mtimes — loadZoneTemplates' cache is keyed by mtimeMs
        // alone, so freshly-written files with colliding mtime can return
        // stale cached content regardless of path.
        fs.utimesSync(expectedPath, new Date(2020, 0, 1), new Date(2020, 0, 1));
        fs.utimesSync(wrongPath, new Date(2021, 0, 1), new Date(2021, 0, 1));

        // Point env var at the WRONG path — option must win.
        process.env.ZONE_TEMPLATES_PATH = wrongPath;

        const calls = setupFetchSequence([
            // create
            () => ({ status: 201, body: { Id: "abc1234567890abcdef" } }),
            // start
            () => ({ status: 204 }),
        ]);

        await createZoneContainer({
            zoneName: "foo",
            template: "untrusted",
            zoneTemplatesPath: expectedPath,
            envOverrides: { ...TEST_ENV, ZONE_TEMPLATES_PATH: wrongPath },
        });

        const createBody = calls[0].body;
        // 2G — proves expectedTemplates were loaded, not wrongTemplates (8G).
        expect(createBody.HostConfig.Memory).toBe(2 * 1024 * 1024 * 1024);
    });
});

describe("ensureZoneContainersExist — forwards zoneTemplatesPath (regression)", () => {
    it("ensure loads templates from opts.zoneTemplatesPath end-to-end (not env var)", async () => {
        // Discrimination strategy: the WRONG templates file has no "untrusted"
        // template at all. If ensure forwards the opts path correctly, the
        // expectedPath file (which DOES have untrusted) is used and create
        // succeeds with 3G memory. If the bug is present, createZoneContainer
        // re-loads from the env var → wrong file → resolveTemplate throws
        // "Unknown zone template" and the zone ends up in failed[].
        // (Using mere memory diffs is unreliable due to mtime-keyed template
        // cache reuse when both files are written in the same tick.)
        const expectedTemplates = {
            untrusted: {
                ...stdTemplates.untrusted,
                memory: "3G",
            },
        };
        const wrongTemplates = {
            // intentionally NO "untrusted" key — only "somethingelse"
            somethingelse: {
                ...stdTemplates.untrusted,
                memory: "7G",
            },
        };

        const expectedPath = path.join(TEMP_DIR, "ensure-expected-templates.json");
        const wrongPath = path.join(TEMP_DIR, "ensure-wrong-templates.json");
        fs.writeFileSync(expectedPath, JSON.stringify(expectedTemplates));
        fs.writeFileSync(wrongPath, JSON.stringify(wrongTemplates));

        // Force distinct mtimes — loadZoneTemplates' cache key is mtimeMs
        // alone (path-independent), so files written in the same tick could
        // share an mtime and silently return cached content from the prior
        // load instead of the path the bug actually pointed at.
        fs.utimesSync(expectedPath, new Date(2020, 0, 1), new Date(2020, 0, 1));
        fs.utimesSync(wrongPath, new Date(2021, 0, 1), new Date(2021, 0, 1));

        // Force the cache to miss on the next load.
        clearZoneTemplatesCache();

        writeConfig({
            zones: {
                core: { threads: [1] },
                perimeter: { threads: [] },
                foo: { threads: [3], template: "untrusted" },
            },
            defaults: { newThread: "perimeter" },
        });

        // Point env at WRONG path — ensure must forward the explicit opts path.
        process.env.ZONE_TEMPLATES_PATH = wrongPath;

        const calls = setupFetchSequence([
            // status → missing
            () => ({ status: 404 }),
            // create
            () => ({ status: 201, body: { Id: "fooid" } }),
            // start
            () => ({ status: 204 }),
        ]);

        const result = await ensureZoneContainersExist({
            zoneConfigPath: CONFIG_PATH,
            zoneTemplatesPath: expectedPath,
        });

        // With the fix: foo is created from the expectedPath templates (3G).
        // Without the fix: foo lands in failed[] with "Unknown zone template".
        expect(result.failed).toEqual([]);
        expect(result.created).toEqual(["foo"]);

        // Find the create call — it must reflect expectedTemplates' 3G memory.
        const createCall = calls.find(c => c.url.includes("/containers/create"));
        expect(createCall).toBeDefined();
        expect(createCall!.body.HostConfig.Memory).toBe(3 * 1024 * 1024 * 1024);
    });
});

describe("deleteZoneContainer — happy path", () => {
    it("inspects, stops, deletes in order", async () => {
        const calls = setupFetchSequence([
            // inspect
            () => ({ status: 200, body: { Id: "abc123" } }),
            // stop
            () => ({ status: 204 }),
            // delete
            () => ({ status: 204 }),
        ]);

        await deleteZoneContainer("foo");

        expect(calls.length).toBe(3);
        expect(calls[0].method).toBe("GET");
        expect(calls[0].url).toContain("/containers/borg-zone-foo/json");

        expect(calls[1].method).toBe("POST");
        expect(calls[1].url).toBe("http://docker-proxy:2375/v1.47/containers/abc123/stop?t=30");

        expect(calls[2].method).toBe("DELETE");
        expect(calls[2].url).toBe("http://docker-proxy:2375/v1.47/containers/abc123");
    });
});

describe("deleteZoneContainer — container missing", () => {
    it("returns void without stop or delete when inspect returns 404", async () => {
        const calls = setupFetchSequence([
            () => ({ status: 404 }),
        ]);

        await deleteZoneContainer("foo");

        // Only the inspect call happened
        expect(calls.length).toBe(1);
        expect(calls[0].method).toBe("GET");
    });
});

describe("deleteZoneContainer — already stopped (304)", () => {
    it("continues to DELETE when stop returns 304", async () => {
        const calls = setupFetchSequence([
            // inspect
            () => ({ status: 200, body: { Id: "abc123" } }),
            // stop → 304 already stopped
            () => ({ status: 304 }),
            // delete
            () => ({ status: 204 }),
        ]);

        await deleteZoneContainer("foo");

        expect(calls.length).toBe(3);
        expect(calls[2].method).toBe("DELETE");
    });
});

describe("getZoneContainerStatus", () => {
    it("returns running when State.Running is true", async () => {
        setupFetchSequence([
            () => ({ status: 200, body: { Id: "abc", State: { Running: true, Status: "running" } } }),
        ]);
        const status = await getZoneContainerStatus("foo");
        expect(status).toEqual({ name: "borg-zone-foo", id: "abc", status: "running" });
    });

    it("returns exited when State.Status is exited", async () => {
        setupFetchSequence([
            () => ({ status: 200, body: { Id: "abc", State: { Running: false, Status: "exited" } } }),
        ]);
        const status = await getZoneContainerStatus("foo");
        expect(status.status).toBe("exited");
    });

    it("returns missing with empty id on 404", async () => {
        setupFetchSequence([
            () => ({ status: 404 }),
        ]);
        const status = await getZoneContainerStatus("foo");
        expect(status).toEqual({ name: "borg-zone-foo", id: "", status: "missing" });
    });
});

describe("ensureZoneContainersExist — skips system zones", () => {
    it("never queries core, perimeter, or infra", async () => {
        writeTemplates(stdTemplates);
        writeConfig({
            zones: {
                core: { threads: [1] },
                perimeter: { threads: [2] },
                foo: { threads: [3], template: "untrusted" },
            },
            defaults: { newThread: "foo" },
        });

        const calls = setupFetchSequence([
            // status check for foo only
            () => ({ status: 200, body: { Id: "abc", State: { Running: true, Status: "running" } } }),
        ]);

        const result = await ensureZoneContainersExist({
            zoneConfigPath: CONFIG_PATH,
            zoneTemplatesPath: TEMPLATES_PATH,
        });

        // Only one URL was hit — for foo, not core/perimeter
        expect(calls.length).toBe(1);
        expect(calls[0].url).toContain("/containers/borg-zone-foo/json");
        // foo was already running
        expect(result.alreadyPresent).toEqual(["foo"]);
        expect(result.created).toEqual([]);
        expect(result.failed).toEqual([]);
    });
});

describe("ensureZoneContainersExist — skips zones without template", () => {
    it("does not inspect or create zones with no template field", async () => {
        writeTemplates(stdTemplates);
        writeConfig({
            zones: {
                core: { threads: [1] },
                perimeter: { threads: [] },
                foo: { threads: [3] }, // no template
            },
            defaults: { newThread: "perimeter" },
        });

        const calls = setupFetchSequence([]);

        const result = await ensureZoneContainersExist({
            zoneConfigPath: CONFIG_PATH,
            zoneTemplatesPath: TEMPLATES_PATH,
        });

        expect(calls.length).toBe(0);
        expect(result.created).toEqual([]);
        expect(result.alreadyPresent).toEqual([]);
        expect(result.failed).toEqual([]);
    });
});

describe("ensureZoneContainersExist — creates missing", () => {
    it("creates foo when its container is absent", async () => {
        writeTemplates(stdTemplates);
        writeConfig({
            zones: {
                core: { threads: [1] },
                perimeter: { threads: [] },
                foo: { threads: [3], template: "untrusted" },
            },
            defaults: { newThread: "perimeter" },
        });

        const calls = setupFetchSequence([
            // status check → missing
            () => ({ status: 404 }),
            // create
            () => ({ status: 201, body: { Id: "newid" } }),
            // start
            () => ({ status: 204 }),
        ]);

        const result = await ensureZoneContainersExist({
            zoneConfigPath: CONFIG_PATH,
            zoneTemplatesPath: TEMPLATES_PATH,
        });

        expect(result.created).toEqual(["foo"]);
        expect(result.alreadyPresent).toEqual([]);
        expect(result.failed).toEqual([]);
        expect(calls.length).toBe(3);
    });
});

describe("ensureZoneContainersExist — leaves existing alone", () => {
    it("does not start an 'exited' container (AD3: respect user intent)", async () => {
        writeTemplates(stdTemplates);
        writeConfig({
            zones: {
                core: { threads: [1] },
                perimeter: { threads: [] },
                foo: { threads: [3], template: "untrusted" },
            },
            defaults: { newThread: "perimeter" },
        });

        const calls = setupFetchSequence([
            // status check → exited
            () => ({ status: 200, body: { Id: "abc", State: { Running: false, Status: "exited" } } }),
        ]);

        const result = await ensureZoneContainersExist({
            zoneConfigPath: CONFIG_PATH,
            zoneTemplatesPath: TEMPLATES_PATH,
        });

        // Only the status check — no create, no start
        expect(calls.length).toBe(1);
        expect(result.alreadyPresent).toEqual(["foo"]);
        expect(result.created).toEqual([]);
    });
});

describe("ensureZoneContainersExist — captures failures, continues", () => {
    it("when one zone fails to create, others still process", async () => {
        writeTemplates(stdTemplates);
        writeConfig({
            zones: {
                core: { threads: [1] },
                perimeter: { threads: [] },
                foo: { threads: [3], template: "untrusted" },
                bar: { threads: [4], template: "untrusted" },
            },
            defaults: { newThread: "perimeter" },
        });

        // Order of iteration is insertion order: foo, then bar.
        const calls = setupFetchSequence([
            // foo status → missing
            () => ({ status: 404 }),
            // foo create → fail
            () => ({ status: 500, body: { message: "no such image" } }),
            // bar status → missing
            () => ({ status: 404 }),
            // bar create → succeeds
            () => ({ status: 201, body: { Id: "barid" } }),
            // bar start
            () => ({ status: 204 }),
        ]);

        const result = await ensureZoneContainersExist({
            zoneConfigPath: CONFIG_PATH,
            zoneTemplatesPath: TEMPLATES_PATH,
        });

        expect(result.created).toEqual(["bar"]);
        expect(result.failed.length).toBe(1);
        expect(result.failed[0].zone).toBe("foo");
        expect(result.failed[0].error).toContain("no such image");
        expect(calls.length).toBe(5);
    });
});

describe("retry on ECONNREFUSED", () => {
    it("retries connection-refused failures and eventually succeeds", async () => {
        writeTemplates(stdTemplates);

        let attempts = 0;
        const calls: FetchCall[] = [];
        globalThis.fetch = (async (url: any, init?: RequestInit) => {
            const call: FetchCall = {
                url: String(url),
                method: init?.method ?? "GET",
                body: init?.body ? JSON.parse(init.body as string) : undefined,
            };
            calls.push(call);

            // For the very first /containers/create call only, fail twice.
            if (call.url.includes("/containers/create")) {
                attempts++;
                if (attempts <= 2) {
                    const err: NodeJS.ErrnoException = new Error("connect ECONNREFUSED 127.0.0.1:2375");
                    err.code = "ECONNREFUSED";
                    throw err;
                }
                return new Response(JSON.stringify({ Id: "abc" }), { status: 201 });
            }
            // start
            return new Response(null, { status: 204 });
        }) as any;

        // To keep the test fast, we want the retry helper to use a small delay.
        // The internal default is 1000ms × 30 retries. We can't pass retryDelayMs into
        // createZoneContainer directly — but the helper retries up to 30 times with
        // 1s default. 3 attempts (2 failures + 1 success) = ~2s of sleep, acceptable for a single test.
        const start = Date.now();
        const info = await createZoneContainer({
            zoneName: "foo",
            template: "untrusted",
            envOverrides: { ...TEST_ENV, ZONE_TEMPLATES_PATH: TEMPLATES_PATH },
        });
        const elapsed = Date.now() - start;

        expect(info.id).toBe("abc");
        // 2 failed creates + 1 successful create + 1 start = 4 fetches
        expect(calls.length).toBe(4);
        // Sanity: it did sleep (at least once)
        expect(elapsed).toBeGreaterThan(500);
        // But not absurdly long
        expect(elapsed).toBeLessThan(10_000);
    }, 15_000);
});
