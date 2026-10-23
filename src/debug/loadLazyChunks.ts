/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { canonicalizeMatch } from "@utils/patches";
import { ModuleFactory } from "@vencord/discord-types/webpack";
import * as Webpack from "@webpack";
import { wreq } from "@webpack";
import { AnyModuleFactory } from "@webpack/types";
import pLimit from "p-limit";

import { withTimeout } from "./promiseTimeout";
import { requireReporterFactory } from "./reporterFactoryPreflight";

const CHUNK_OPERATION_TIMEOUT_MS = 15_000;
const CHUNK_SEARCH_TIMEOUT_MS = 90_000;
const REMAINING_CHUNKS_TIMEOUT_MS = 60_000;

function getWebpackChunkMap() {
    const sym = Symbol();
    let chunksMap: unknown;

    Object.defineProperty(Object.prototype, sym, {
        get() {
            chunksMap = this;
            return "";
        },
        configurable: true
    });

    try {
        wreq.u(sym);
    } finally {
        delete Object.prototype[sym];
    }

    return chunksMap as Record<PropertyKey, string> | null;
}

export async function loadLazyChunks(): Promise<boolean> {
    const LazyChunkLoaderLogger = new Logger("LazyChunkLoader");
    const queue = pLimit({ concurrency: 50, rejectOnClear: true });
    const discoveredChunks = new Set<string>();
    const loadedChunks = new Set<PropertyKey>();
    const invalidChunks = new Set<PropertyKey>();
    const inspections = new Map<PropertyKey, Promise<boolean>>();
    const failedInspections = new Set<PropertyKey>();
    const loads = new Map<PropertyKey, Promise<void>>();
    const controllers = new Set<AbortController>();
    const pendingSearches = new Set<Promise<void>>();
    const searchErrors: unknown[] = [];
    const reportedErrors = new Set<unknown>();
    const { promise: chunksSearchingDone, resolve: chunksSearchingResolve } = Promise.withResolvers<void>();
    let searchCheckTimer: ReturnType<typeof setTimeout> | undefined;
    let remainingChunksPromise: Promise<unknown> | undefined;
    let mappedChunks: string[] | undefined;
    let closed = false;
    let failed = false;
    let failure: unknown;
    const isRunning = () => !closed;

    // Only match direct bound entry points; broader matching also loads every language pack and slows webpack finds testing.
    const PartialLazyChunkRegex = canonicalizeMatch(/(?:(?:Promise\.all\(\[)?((?:\i\.e\("?[^)]+?"?\),?)+?)(?:\]\))?)\.then\(\i\.bind\(\i,"?([^)]+?)"?\)\)/g);

    function assertRunning() {
        if (closed) throw new Error("Chunk loading was stopped");
    }

    function warnOnce(error: unknown) {
        if (closed || reportedErrors.has(error)) return;
        reportedErrors.add(error);
        LazyChunkLoaderLogger.warn(error);
    }

    async function settleOperations<T>(operations: Promise<T>[]) {
        const results = await Promise.allSettled(operations);
        for (const result of results) if (result.status === "rejected") warnOnce(result.reason);
        return results;
    }

    function inspectChunk(id: PropertyKey) {
        let inspection = inspections.get(id);
        if (!inspection) {
            inspection = queue(async () => {
                assertRunning();
                const controller = new AbortController();
                controllers.add(controller);
                try {
                    const isWorker = await withTimeout(
                        fetch(wreq.p + wreq.u(id), { signal: controller.signal })
                            .then(response => {
                                if (!response.ok) throw new Error(`Failed inspecting chunk ${String(id)}: HTTP ${response.status}`);
                                return response.text();
                            })
                            .then(text => /importScripts\(|self\.postMessage/.test(text)),
                        CHUNK_OPERATION_TIMEOUT_MS,
                        `Timed out inspecting chunk ${String(id)}`,
                    );
                    assertRunning();
                    if (isWorker) invalidChunks.add(id);
                    return isWorker;
                } finally {
                    controller.abort();
                    controllers.delete(controller);
                }
            }).catch(error => {
                failedInspections.add(id);
                throw error;
            });
            inspections.set(id, inspection);
        }
        return inspection;
    }

    function loadChunk(id: PropertyKey) {
        let load = loads.get(id);
        if (!load) {
            load = queue(async () => {
                assertRunning();
                await withTimeout(wreq.e(id), CHUNK_OPERATION_TIMEOUT_MS, `Timed out loading chunk ${String(id)}`);
                assertRunning();
                loadedChunks.add(id);
            });
            loads.set(id, load);
        }
        return load;
    }

    async function searchAndLoadLazyChunks(factoryCode: string) {
        const validChunkGroups: Array<[chunkIds: PropertyKey[], entryPoint: PropertyKey]> = [];
        await settleOperations(Array.from(factoryCode.matchAll(PartialLazyChunkRegex)).map(async ([, rawChunkIds, entryPoint]) => {
            const chunkIds = rawChunkIds?.matchAll(Webpack.ChunkIdsRegex).map(m => {
                const numChunkId = Number(m[1]);
                return Number.isNaN(numChunkId) ? m[1] : String(numChunkId);
            }).toArray() ?? [];
            if (chunkIds.length === 0) return;

            const inspectableChunkIds = chunkIds.filter(id => {
                const filename = wreq.u(id);
                return filename != null && filename !== "undefined.js";
            });
            for (const id of inspectableChunkIds) discoveredChunks.add(id);
            let invalidChunkGroup = false;
            for (const id of inspectableChunkIds) {
                if (await inspectChunk(id)) invalidChunkGroup = true;
            }
            if (!invalidChunkGroup) {
                const numEntryPoint = Number(entryPoint);
                validChunkGroups.push([chunkIds, Number.isNaN(numEntryPoint) ? entryPoint : String(numEntryPoint)]);
            }
        }));
        if (closed) return;

        // Every sibling must settle before this search drains or its entries run.
        const groupsLoaded = await Promise.all(validChunkGroups.map(async ([chunkIds]) =>
            (await settleOperations(chunkIds.map(loadChunk))).every(result => result.status === "fulfilled")
        ));
        for (let i = 0; i < validChunkGroups.length; i++) {
            if (closed) return;
            if (!groupsLoaded[i]) continue;
            const [, entryPoint] = validChunkGroups[i];
            try {
                if (wreq.m[entryPoint]) {
                    if (IS_REPORTER) {
                        const preparation = requireReporterFactory(entryPoint, isRunning);
                        if (preparation) await preparation;
                    } else wreq(entryPoint);
                }
            } catch (error) {
                if (!IS_REPORTER && error instanceof TypeError && error.message.includes("reading 'nativeModules'")) continue;
                console.error(error);
            }
        }
    }

    function factoryListener(factory: AnyModuleFactory | ModuleFactory) {
        if (closed) return;
        clearTimeout(searchCheckTimer);
        let search: Promise<void>;
        try { search = searchAndLoadLazyChunks(String(factory)); }
        catch (error) { search = Promise.reject(error); }
        const pending = search.catch(error => {
            searchErrors.push(error);
            warnOnce(error);
        }).finally(() => {
            pendingSearches.delete(pending);
            if (closed || pendingSearches.size !== 0) return;
            searchCheckTimer = setTimeout(() => {
                if (pendingSearches.size === 0) chunksSearchingResolve();
            }, 0);
        });
        pendingSearches.add(pending);
    }

    try {
        LazyChunkLoaderLogger.log("Loading all chunks...");
        Webpack.factoryListeners.add(factoryListener);
        for (const moduleId in wreq.m) factoryListener(wreq.m[moduleId]);
        if (pendingSearches.size === 0) chunksSearchingResolve();
        try {
            await withTimeout(chunksSearchingDone, CHUNK_SEARCH_TIMEOUT_MS, "Timed out searching for lazy chunks");
        } finally {
            Webpack.factoryListeners.delete(factoryListener);
        }
        if (searchErrors.length) throw new AggregateError(searchErrors, "Failed inspecting webpack factory sources");

        // Also inspect mapped assets that no discovered entry references.
        const chunksMap = getWebpackChunkMap();
        if (!chunksMap) throw new Error("Failed to get chunk map");
        mappedChunks = Object.keys(chunksMap);
        if (mappedChunks.length === 0) throw new Error("Failed to get all chunks");
        // Discord also has literal filename branches outside the fallback map.
        const allChunks = Array.from(new Set([...mappedChunks, ...discoveredChunks]));
        const chunksLeft = allChunks.filter(id => !loadedChunks.has(id) && !invalidChunks.has(id));
        for (const id of chunksLeft) {
            // The existing remaining pass gets one retry for failed operations.
            // Successful inspections stay shared; only actual loads count as done.
            if (failedInspections.delete(id)) inspections.delete(id);
            loads.delete(id);
        }
        remainingChunksPromise = settleOperations(chunksLeft.map(async id => {
            if (!await inspectChunk(id)) await loadChunk(id);
        }));
        await withTimeout(remainingChunksPromise, REMAINING_CHUNKS_TIMEOUT_MS, "Timed out loading remaining chunks");
        const unresolved = allChunks.filter(id => !loadedChunks.has(id) && !invalidChunks.has(id));
        if (unresolved.length)
            throw new Error(`Failed loading ${unresolved.length} chunks: ${unresolved.slice(0, 20).map(id => id.slice(0, 64)).join(", ")}${unresolved.length > 20 ? ", …" : ""}`);
    } catch (error) {
        failed = true;
        failure = error;
    } finally {
        // Native imports have no abort API. Stop their continuations and drain the bounded waiters.
        closed = true;
        Webpack.factoryListeners.delete(factoryListener);
        clearTimeout(searchCheckTimer);
        queue.clearQueue();
        for (const controller of controllers) controller.abort();
        try {
            await withTimeout(
                Promise.allSettled([...pendingSearches, ...(remainingChunksPromise ? [remainingChunksPromise] : [])]),
                CHUNK_OPERATION_TIMEOUT_MS,
                "Timed out draining chunk operations",
            );
        } catch (error) {
            if (!failed) failure = error;
            failed = true;
        }
    }

    LazyChunkLoaderLogger.log("Chunk coverage:", JSON.stringify({
        mapped: mappedChunks?.length ?? null,
        discovered: discoveredChunks.size,
        loaded: loadedChunks.size,
        workersExcluded: invalidChunks.size,
        workerIds: Array.from(invalidChunks).slice(0, 20).map(id => String(id).slice(0, 64)),
        omittedWorkerIds: Math.max(0, invalidChunks.size - 20)
    }));
    if (failed) {
        LazyChunkLoaderLogger.log("A fatal error occurred:", failure);
        return false;
    }
    LazyChunkLoaderLogger.log("Finished loading all chunks!");
    return true;
}
