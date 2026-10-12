/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addPatch } from "@api/PluginManager";
import { initWs } from "@plugins/devCompanion.dev/initWs";
import { Logger } from "@utils/Logger";
import * as Webpack from "@webpack";
import { getBuildNumber, patches, patchTimings } from "@webpack/patcher";

import { loadLazyChunks } from "./loadLazyChunks";
import { reporterData } from "./reporterData";
import { requireReporterFactory } from "./reporterFactoryPreflight";

function describeLookupError(error: unknown) {
    const parts: string[] = [];
    const seen = new Set<unknown>();
    for (let depth = 0; depth < 3; depth++) {
        if (seen.has(error)) {
            parts.push("[Circular cause]");
            break;
        }
        seen.add(error);
        if (error == null || (typeof error !== "object" && typeof error !== "function")) {
            parts.push(String(error).slice(0, 2_000));
            break;
        }
        const unreadable: string[] = [];
        const read = (key: string) => {
            try { return Reflect.get(error as object, key); }
            catch { unreadable.push(key); }
        };
        const stack = read("stack"), name = read("name"), message = read("message"), cause = read("cause");
        const detail = typeof stack === "string" && stack
            ? stack
            : `${typeof name === "string" ? name : "Error"}: ${typeof message === "string" ? message : "No message"}`;
        parts.push(detail.slice(0, 2_000).split("\n").slice(0, 12).join("\n")
            + (unreadable.length ? `\n[Unable to read error properties: ${unreadable.join(", ")}]` : ""));
        if (cause === undefined) break;
        error = cause;
        if (depth === 2) parts.push("[Cause chain truncated]");
    }
    return parts.join("\nCaused by:\n").slice(0, 6_400);
}

async function runReporter() {
    const ReporterLogger = new Logger("Reporter");

    try {
        ReporterLogger.log("Starting test...");

        const { promise: loadLazyChunksDone, resolve: loadLazyChunksResolve, reject: loadLazyChunksReject } = Promise.withResolvers<boolean>();

        // The main patch for starting the reporter chunk loading
        addPatch({
            find: '"Could not find app-mount"',
            replacement: {
                match: /"Could not find app-mount"/,
                replace: "(Vencord.Webpack._initReporter(),$&)"
            }
        }, "Protonn Cord Reporter");

        // @ts-expect-error
        Vencord.Webpack._initReporter = function () {
            // initReporter is called in the patched entry point of Discord
            // setImmediate to only start searching for lazy chunks after Discord initialized the app
            setTimeout(() => loadLazyChunks().then(loadLazyChunksResolve, loadLazyChunksReject), 0);
        };

        if (await loadLazyChunksDone === false) return;

        // Manually require all modules to make sure all lazily required modules are patched
        for (const moduleId of Object.keys(Webpack.wreq.m)) {
            try {
                const preparation = requireReporterFactory(moduleId);
                if (preparation) await preparation;
            } catch { }
        }

        if (IS_REPORTER && IS_WEB && !IS_VESKTOP && !IS_EQUIBOP) {
            console.log("[REPORTER_META]", {
                buildNumber: getBuildNumber(),
                buildHash: window.GLOBAL_ENV.SENTRY_TAGS.buildId
            });
        }

        for (const patch of patches) {
            if (!patch.all) {
                new Logger("WebpackPatcher").warn(`Patch by ${patch.plugin} found no module (Module id is -): ${patch.find}`);
                if (IS_COMPANION_TEST)
                    reporterData.failedPatches.foundNoModule.push(patch);
            }
        }

        for (const [plugin, moduleId, match, totalTime, confirmation] of patchTimings) {
            if (totalTime > 10) {
                ReporterLogger.log("Patch timing confirmation:", JSON.stringify({
                    plugin, id: String(moduleId), match: String(match), initialMs: totalTime,
                    ...confirmation ?? { status: "inconclusive", samplesMs: [], reason: "Confirmation was not recorded" }
                }));
                if (confirmation?.status === "outlier") continue;
                new Logger("WebpackPatcher").warn(`Patch by ${plugin} took ${Math.round(totalTime * 100) / 100}ms (Module id is ${String(moduleId)}): ${match}`);
            }
        }

        const lookupExceptions = new Map<string, { id: number; count: number; }>();
        let omittedExceptions = 0;
        for (const [searchType, args] of Webpack.lazyWebpackSearchHistory) {
            let method = searchType;

            if (searchType === "findComponent") method = "find";
            if (searchType === "findExportedComponent") method = "findByProps";
            if (searchType === "waitFor" || searchType === "waitForComponent") {
                if (typeof args[0] === "string") method = "findByProps";
                else method = "find";
            }
            if (searchType === "waitForStore") method = "findStore";

            let result: any;
            try {
                if (method === "proxyLazyWebpack" || method === "LazyComponentWebpack") {
                    const [factory] = args;
                    result = factory();
                } else if (method === "extractAndLoadChunks") {
                    const [code, matcher] = args;

                    result = await Webpack.extractAndLoadChunks(code, matcher);
                    if (result === false) result = null;
                } else if (method === "mapMangledModule") {
                    const [code, mapper, includeBlacklistedExports] = args;

                    result = Webpack.mapMangledModule(code, mapper, includeBlacklistedExports);
                    if (Object.keys(result).length !== Object.keys(mapper).length) throw new Error("Webpack Find Fail");
                } else {
                    result = Webpack[method](...args);
                }

                if (result == null || (result.$$vencordGetWrappedComponent != null && result.$$vencordGetWrappedComponent() == null)) throw new Error("Webpack Find Fail");
            } catch (e) {
                let logMessage = searchType;
                if (method === "find" || method === "proxyLazyWebpack" || method === "LazyComponentWebpack") {
                    if (args[0].$$vencordProps != null) {
                        logMessage += `(${args[0].$$vencordProps.map(arg => `"${arg}"`).join(", ")})`;
                    } else {
                        logMessage += `(${args[0].toString().slice(0, 147)}...)`;
                    }
                } else if (method === "extractAndLoadChunks") {
                    logMessage += `([${args[0].map(arg => `"${arg}"`).join(", ")}], ${args[1].toString()})`;
                } else if (method === "mapMangledModule") {
                    const failedMappings = Object.keys(args[1]).filter(key => result?.[key] == null);

                    logMessage += `("${args[0]}", {\n${failedMappings.map(mapping => `\t${mapping}: ${args[1][mapping].toString().slice(0, 147)}...`).join(",\n")}\n})`;
                } else {
                    logMessage += `(${args.map(arg => `"${arg}"`).join(", ")})`;
                }
                if (IS_COMPANION_TEST)
                    reporterData.failedWebpack[method].push(args.map(a => String(a)));
                const detail = describeLookupError(e);
                let exception = lookupExceptions.get(detail);
                if (!exception && lookupExceptions.size < 8) {
                    exception = { id: lookupExceptions.size + 1, count: 0 };
                    lookupExceptions.set(detail, exception);
                }
                if (exception) exception.count++;
                else omittedExceptions++;
                ReporterLogger.log("Webpack Find Fail:", logMessage, exception ? `[exception ${exception.id}]` : "[exception detail limit reached]");
            }
        }
        for (const [detail, { id, count }] of lookupExceptions)
            ReporterLogger.log("Webpack Find Exception:", `${id} (${count} lookups)\n${detail}`);
        if (omittedExceptions)
            ReporterLogger.log("Webpack Find Exception Limit:", `${omittedExceptions} additional exceptions; all lookup findings are retained`);

        // if we are running the reporter with companion integration, send the list to vscode as soon as we can
        if (IS_COMPANION_TEST)
            initWs();
        ReporterLogger.log("Finished test");
    } catch (e) {
        ReporterLogger.log("A fatal error occurred:", e);
    }
}

// Imported in webpack for reporterData, wrap to avoid running reporter
// Run after the Protonn Cord object has been created.
// We need to add extra properties to it, and it is only created after all Protonn Cord code has run
if (IS_REPORTER)
    setTimeout(runReporter, 0);
