#!/usr/bin/env node
// scripts/ensure-zone-containers.ts
// Cold-boot recovery: ensures every non-system zone in zone-config.json has a
// running Docker container. Called by the init service after init-zones.sh.
//
// Per AD3: only creates containers that are completely missing — does NOT
// start stopped containers (respects user intent).
//
// Exit codes:
//   0  — all zones ensured (including the "no dynamic zones" no-op case)
//   1  — fatal error before per-zone work (config/templates load failure)
//   2  — one or more zone creations failed (other zones still attempted;
//         failures are logged. Init still continues to allow partial recovery.)
//
// Path resolution: zone-config.json and zone-templates.json are read from
// $ZONE_CONFIG_PATH and $ZONE_TEMPLATES_PATH (defaults to the standard mount
// points if unset).

// NB: at runtime this script lives at dist/scripts/ensure-zone-containers.js.
// The secondary tsconfig.scripts.json emits src/* alongside (to dist/src/*),
// so the relative import "../src/zone-supervisor.js" resolves correctly at both
// compile-time (against src/zone-supervisor.ts) and runtime (dist/src/zone-supervisor.js).
import { ensureZoneContainersExist } from "../src/zone-supervisor.js";

async function main(): Promise<void> {
    const zoneConfigPath = process.env.ZONE_CONFIG_PATH ?? "/app/zone-config.json";
    const zoneTemplatesPath = process.env.ZONE_TEMPLATES_PATH ?? "/app/zone-templates.json";

    console.log(`[ensure-zone-containers] Starting (config=${zoneConfigPath}, templates=${zoneTemplatesPath})`);

    try {
        const result = await ensureZoneContainersExist({ zoneConfigPath, zoneTemplatesPath });

        if (result.created.length > 0) {
            console.log(`[ensure-zone-containers] Created: ${result.created.join(", ")}`);
        }
        if (result.alreadyPresent.length > 0) {
            console.log(`[ensure-zone-containers] Already present (skipped): ${result.alreadyPresent.join(", ")}`);
        }
        if (result.failed.length > 0) {
            for (const f of result.failed) {
                console.error(`[ensure-zone-containers] FAILED ${f.zone}: ${f.error}`);
            }
            process.exit(2);
        }

        const total = result.created.length + result.alreadyPresent.length;
        console.log(`[ensure-zone-containers] OK — ${total} dynamic zone(s) accounted for`);
        process.exit(0);
    } catch (err) {
        console.error(`[ensure-zone-containers] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}

void main();
