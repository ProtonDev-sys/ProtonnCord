/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { wreq } from "@webpack";
import { prepareReporterFactory } from "@webpack/patcher";
import { AnyModuleFactory, AnyWebpackRequire } from "@webpack/types";

import { withTimeout } from "./promiseTimeout";
import { REPORTER_SOURCE_ONLY_FACTORIES } from "./reporterFactoryCases";

type SourceOnlyCase = typeof REPORTER_SOURCE_ONLY_FACTORIES[number];
type PreparedFactory = NonNullable<ReturnType<typeof prepareReporterFactory>>;

const checks = IS_REPORTER ? new WeakMap<AnyModuleFactory, { prepared: PreparedFactory; verified: Promise<boolean>; reported: boolean; }>() : undefined;
let checkCount = 0;

function prerequisiteAbsent(record: SourceOnlyCase, require: AnyWebpackRequire) {
    if (record.reason === "native-capability-unavailable") return !(record.capability in window);
    return require.c != null && !(record.missingDependency in require.m) && !(record.missingDependency in require.c);
}

async function sourceHash(source: string) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

// Only the reporter's two explicit forced-entry sites call this. Actual host
// requires, exports, caches, and factory-error handling are never intercepted.
export function requireReporterFactory(moduleId: PropertyKey, shouldContinue?: () => boolean): void | Promise<void> {
    if (shouldContinue?.() === false) return;
    const require = wreq as AnyWebpackRequire;
    const record = IS_REPORTER && IS_WEB && !IS_VESKTOP && !IS_EQUIBOP
        ? REPORTER_SOURCE_ONLY_FACTORIES.find(record => record.id === moduleId)
        : undefined;

    if (record && require.c != null && !(moduleId in require.c) && prerequisiteAbsent(record, require)) {
        let check = checks!.get(require.m[moduleId]);
        if (!check && checkCount < 6) {
            checkCount++;
            const prepared = prepareReporterFactory(moduleId, require.m[moduleId], require);
            if (prepared && prepared.originalSource.length <= 16_384 && prepared.patchedSource.length <= 16_384) {
                const verified = withTimeout(
                    Promise.all([sourceHash(prepared.originalSource), sourceHash(prepared.patchedSource)])
                        .then(([original, patched]) => original === record.originalSha256 && patched === record.patchedSha256),
                    500,
                    "Reporter factory source verification timed out"
                ).catch(() => false);
                check = { prepared, verified, reported: false };
                checks!.set(prepared.factory, check);
            }
        }

        if (check) {
            const currentCheck = check;
            return check.verified.then(verified => {
                if (shouldContinue?.() === false) return;
                if (verified && currentCheck.prepared.isCurrent()
                    && require.c != null && !(moduleId in require.c) && prerequisiteAbsent(record, require)) {
                    if (!currentCheck.reported) {
                        new Logger("Reporter").log("Source-only factory:", JSON.stringify(record));
                        currentCheck.reported = true;
                    }
                    return;
                }
                require(moduleId);
            });
        }
    }

    // Ordinary modules keep synchronous scheduling. Never return exports here or
    // from the promise callback: doing so would assimilate exported thenables.
    require(moduleId);
}
