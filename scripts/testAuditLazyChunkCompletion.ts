/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import pLimit from "p-limit";
import ts from "typescript";

import { canonicalizeMatch } from "../src/utils/patches";
import { evaluate, sourceNode } from "./utils/discordClientFixture";
import { loadTestModule } from "./utils/loadTestModule";

const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const group = (ids: string[], entry: string) => `function(){return Promise.all([${ids.map(id => `w.e("${id}")`).join(",")}]).then(w.bind(w,"${entry}"))}`;

function fixture(options: {
    chunks?: string[];
    filenames?: Record<string, string>;
    sources?: string[];
    fetch?: (id: string, attempt: number, signal: AbortSignal) => Promise<{ ok: boolean; status: number; text(): Promise<string>; }>;
    load?: (id: string, attempt: number, register: (id: string, source: string) => void) => Promise<void>;
    force?: (id: string, shouldContinue: () => boolean) => void | Promise<void>;
    timeout?: (promise: Promise<unknown>, timeout: number) => Promise<unknown>;
} = {}) {
    const chunks = Object.fromEntries((options.chunks ?? ["one"]).map(id => [id, `${id}.js`]));
    const factories: Record<string, Function> = {};
    const listeners = new Set<(factory: Function) => void>();
    const logs: unknown[][] = [], warnings: unknown[][] = [], forced: string[] = [];
    const fetches: string[] = [], loads: string[] = [], signals: AbortSignal[] = [];
    const register = (id: string, source: string) => {
        const factory = runInNewContext(`(${source})`);
        factories[id] = factory;
        for (const listener of listeners) listener(factory);
    };
    (options.sources ?? [group(["one"], "feature")]).forEach((source, i) => register(`root${i}`, source));
    const require = Object.assign((id: string) => { forced.push(id); }, {
        m: factories, p: "offline:", u: (id: PropertyKey) => options.filenames?.[id as string] ?? chunks[id as string],
        e: async (id: string) => {
            loads.push(id);
            await options.load?.(id, loads.filter(value => value === id).length, register);
            factories[id] ??= () => {};
            factories.feature ??= () => {};
        }
    });
    const module = loadTestModule("src/debug/loadLazyChunks.ts", {
        "@utils/Logger": { Logger: class { log(...args: unknown[]) { logs.push(args); } warn(...args: unknown[]) { warnings.push(args); } } },
        "@utils/patches": { canonicalizeMatch },
        "@webpack": { wreq: require, factoryListeners: listeners, ChunkIdsRegex: /\("([^"]+?)"\)/g },
        "p-limit": pLimit,
        "./reporterFactoryPreflight": { requireReporterFactory: (id: string, shouldContinue: () => boolean) => options.force ? options.force(id, shouldContinue) : require(id) },
        "./promiseTimeout": { withTimeout: options.timeout ?? ((promise: Promise<unknown>) => promise) }
    }, {
        IS_REPORTER: true, setTimeout, clearTimeout, console, AbortController,
        fetch: async (url: string, init?: RequestInit) => {
            const id = url.slice("offline:".length, -".js".length);
            fetches.push(id);
            const signal = init?.signal as AbortSignal;
            signals.push(signal);
            return options.fetch ? options.fetch(id, fetches.filter(value => value === id).length, signal)
                : { ok: true, status: 200, text: async () => "" };
        }
    }, "\nexport { getWebpackChunkMap };");
    Object.setPrototypeOf(chunks, module.getWebpackChunkMap.constructor("return Object.prototype")());
    return { run: () => module.loadLazyChunks() as Promise<boolean>, factories, listeners, logs, warnings, forced, fetches, loads, signals, register };
}

test("a failed discovered load is retried by the remaining pass and is never mistaken for a loaded chunk", async () => {
    const f = fixture({ load: async (_id, attempt) => { if (attempt === 1) throw new Error("Initial native load failed"); } });
    const completed = await f.run();
    assert.deepEqual(f.loads, ["one", "one"]);
    assert.deepEqual(f.fetches, ["one"], "Successful inspection is reused for the bounded remaining pass");
    assert.ok(Object.hasOwn(f.factories, "one"));
    assert.equal(f.warnings.length, 1);
    assert.equal(completed, true);
    assert.ok(f.logs.some(([message]) => message === "Finished loading all chunks!"));
});

test("one failed inspection cannot strand a successfully inspected sibling", async () => {
    const f = fixture({ chunks: ["one", "two"], sources: [group(["one", "two"], "feature")], fetch: async (id, attempt) => {
        if (id === "two" && attempt === 1) throw new Error("Initial inspection failed");
        return { ok: true, status: 200, text: async () => "" };
    } });
    const completed = await f.run();
    assert.deepEqual(new Set(f.loads), new Set(["one", "two"]));
    assert.equal(f.fetches.filter(id => id === "one").length, 1);
    assert.equal(f.fetches.filter(id => id === "two").length, 2);
    assert.equal(f.warnings.length, 1);
    assert.equal(completed, true);
});

test("literal filename branches outside the fallback map remain retryable and incomplete failures stay fatal", async () => {
    for (const failure of ["inspection", "load"]) {
        for (const persistent of [false, true]) {
            const f = fixture({ chunks: ["mapped"], filenames: { branch: "branch.js", sibling: "sibling.js" },
                sources: [group(["branch", "sibling"], "feature")],
                fetch: async (id, attempt) => {
                    if (failure === "inspection" && id === "branch" && (persistent || attempt === 1)) throw new Error("Branch inspection failed");
                    return { ok: true, status: 200, text: async () => "" };
                },
                load: async (id, attempt) => {
                    if (failure === "load" && id === "branch" && (persistent || attempt === 1)) throw new Error("Branch load failed");
                }
            });
            const completed = await f.run();
            assert.ok(Object.hasOwn(f.factories, "sibling"), "An earlier failure cannot hide a later branch from the remaining pass");
            assert.equal(failure === "inspection" ? f.fetches.filter(id => id === "branch").length : f.loads.filter(id => id === "branch").length, 2);
            assert.equal(completed, !persistent);
            assert.equal(f.logs.some(([message]) => message === "Finished loading all chunks!"), !persistent);
            assert.equal(f.logs.some(([message]) => message === "A fatal error occurred:"), persistent);
        }
    }
});

test("all sibling inspections drain before discovery listeners are removed, including nested registrations", async () => {
    const delayed = Promise.withResolvers<void>();
    const f = fixture({ chunks: ["one", "two", "nested"], sources: ['function(){w.e("one").then(w.bind(w,"first"));w.e("two").then(w.bind(w,"second"))}'],
        fetch: async (id, attempt) => {
            if (id === "one" && attempt === 1) throw new Error("Independent failure");
            if (id === "two") await delayed.promise;
            return { ok: true, status: 200, text: async () => "" };
        },
        load: async (id, _attempt, register) => {
            if (id === "two") register("nestedRoot", group(["nested"], "feature"));
        }
    });
    const result = f.run();
    await tick();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.listeners.size, 1);
    assert.ok(!f.logs.some(([message]) => message === "Finished loading all chunks!"));
    delayed.resolve();
    assert.equal(await result, true);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.fetches.filter(id => id === "nested").length, 1);
    assert.ok(f.forced.includes("feature"), "Nested discovery still forces its successful entry");
});

test("sibling native loads settle after the first rejection and shared groups use one inspection and load", async () => {
    const delayed = Promise.withResolvers<void>();
    const f = fixture({ chunks: ["one", "two"], sources: [group(["one", "two"], "feature"), group(["two"], "feature")], load: async (id, attempt) => {
        if (id === "one" && attempt === 1) throw new Error("Independent native failure");
        if (id === "two") await delayed.promise;
    } });
    const result = f.run(); await tick();
    assert.equal(f.listeners.size, 1);
    assert.deepEqual(f.fetches.filter(id => id === "two"), ["two"]);
    assert.deepEqual(f.loads.filter(id => id === "two"), ["two"]);
    delayed.resolve();
    assert.equal(await result, true);
});

test("remaining native loads share the fifty-operation limit and drain before completion", async () => {
    const release = Promise.withResolvers<void>();
    let active = 0, maximum = 0;
    const f = fixture({ chunks: Array.from({ length: 101 }, (_, i) => String(i)), sources: [], load: async () => {
        maximum = Math.max(maximum, ++active);
        await release.promise;
        active--;
    } });
    const result = f.run();
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(active, 50);
    assert.equal(f.loads.length, 50);
    assert.ok(!f.logs.some(([message]) => message === "Finished loading all chunks!"));
    release.resolve();
    assert.equal(await result, true);
    assert.equal(maximum, 50);
    assert.equal(active, 0);
    assert.equal(f.loads.length, 101);
});

test("completion coverage bounds excluded worker IDs while preserving their existing classification", async () => {
    const workers = Array.from({ length: 24 }, (_, i) => `worker${i}`);
    const f = fixture({ chunks: ["one", ...workers], sources: [], fetch: async id => ({
        ok: true, status: 200, text: async () => id === "one" ? "" : "self.postMessage('worker')"
    }) });
    assert.equal(await f.run(), true);
    assert.deepEqual(f.loads, ["one"]);
    const summary = JSON.parse(f.logs.find(([message]) => message === "Chunk coverage:")?.[1] as string);
    assert.deepEqual(summary, { mapped: 25, discovered: 0, loaded: 1, workersExcluded: 24, workerIds: workers.slice(0, 20), omittedWorkerIds: 4 });
});

test("HTTP inspection errors and permanently failed native loads never report successful completion", async () => {
    for (const failure of ["http", "load"]) {
        const f = fixture({
            fetch: async () => ({ ok: failure !== "http", status: failure === "http" ? 503 : 200, text: async () => "not a worker" }),
            load: async () => { if (failure === "load") throw new Error("Persistent native failure"); }
        });
        assert.equal(await f.run(), false);
        assert.ok(f.logs.some(([message]) => message === "A fatal error occurred:"));
        assert.ok(!f.logs.some(([message]) => message === "Finished loading all chunks!"));
        assert.equal(f.listeners.size, 0);
        assert.equal(f.forced.length, 0);
        if (failure === "http") assert.equal(f.loads.length, 0);
    }
});

test("a synchronous factory formatter failure settles discovery and becomes an explicit incomplete result", async () => {
    const f = fixture({ sources: [] });
    f.factories.broken = Object.assign(() => {}, { toString() { throw new Error("Factory source unavailable"); } });
    assert.equal(await f.run(), false);
    assert.equal(f.listeners.size, 0);
    assert.ok(f.logs.some(([message]) => message === "A fatal error occurred:"));
    assert.ok(!f.logs.some(([message]) => message === "Finished loading all chunks!"));
});

test("deadline cancellation aborts inspections, rejects queued work, and prevents late native loads", async () => {
    const deadline = Promise.withResolvers<never>();
    const chunks = Array.from({ length: 101 }, (_, i) => String(i));
    const f = fixture({ chunks, sources: [], fetch: async (_id, _attempt, signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), timeout: (promise, timeout) => timeout === 60_000 ? deadline.promise : promise });
    const result = f.run(); await tick();
    assert.equal(f.fetches.length, 50);
    deadline.reject(new Error("Remaining phase deadline"));
    assert.equal(await result, false);
    await tick();
    assert.equal(f.fetches.length, 50, "Queued requests are rejected without starting");
    assert.ok(f.signals.every(signal => signal.aborted));
    assert.equal(f.loads.length, 0);
    assert.ok(!f.logs.some(([message]) => message === "Finished loading all chunks!"));
});

test("a body read that ignores abort cannot start a native load after cancellation", async () => {
    const body = Promise.withResolvers<string>();
    const deadline = Promise.withResolvers<never>();
    const f = fixture({ sources: [], fetch: async () => ({ ok: true, status: 200, text: () => body.promise }),
        timeout: (promise, timeout) => timeout === 60_000 ? Promise.race([promise, deadline.promise]) : promise });
    const result = f.run(); await tick();
    deadline.reject(new Error("Remaining phase deadline"));
    await tick();
    assert.ok(f.signals[0].aborted);
    body.resolve("");
    assert.equal(await result, false);
    assert.equal(f.loads.length, 0);
    assert.equal(f.forced.length, 0);
});

test("a canceled discovery waits for pending verification and prevents its delayed entry require", async () => {
    const verification = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<never>();
    let verifying = false;
    const f = fixture({ force: (id, shouldContinue) => {
        verifying = true;
        return verification.promise.then(() => { if (shouldContinue()) f.forced.push(id); });
    }, timeout: (promise, timeout) => timeout === 90_000 ? Promise.race([promise, deadline.promise]) : promise });
    let completed = false;
    const result = f.run().then(value => { completed = true; return value; });
    await tick();
    assert.equal(verifying, true);
    deadline.reject(new Error("Discovery phase deadline"));
    await tick();
    assert.equal(f.listeners.size, 0);
    assert.equal(completed, false, "Owned verification drains before the caller receives failure");
    verification.resolve();
    assert.equal(await result, false);
    assert.equal(f.forced.length, 0);
    assert.ok(!f.logs.some(([message]) => message === "Finished loading all chunks!"));
});

test("reporter stops after incomplete loading and handles an unexpected loader rejection", async () => {
    for (const reject of [false, true]) {
        const messages: unknown[][] = [];
        const webpack: any = { wreq: { m: { 1: () => {} } }, lazyWebpackSearchHistory: [] };
        const run = evaluate(`(${sourceNode("src/debug/runReporter.ts", node => ts.isFunctionDeclaration(node) && node.name?.text === "runReporter")})`, {
            Logger: class { log(...args: unknown[]) { messages.push(args); } },
            addPatch: () => queueMicrotask(() => webpack._initReporter()),
            loadLazyChunks: async () => { if (reject) throw new Error("Unexpected loader rejection"); return false; },
            Webpack: webpack, Vencord: { Webpack: webpack }, setTimeout: (callback: () => void) => queueMicrotask(callback),
            requireReporterFactory: () => assert.fail("Incomplete loading must not start forced traversal"),
            patches: [], patchTimings: [], IS_REPORTER: true, IS_COMPANION_TEST: false
        });
        await run();
        assert.ok(!messages.some(([message]) => message === "Finished test"));
        if (reject) assert.ok(messages.some(([message]) => message === "A fatal error occurred:"));
    }
});
