/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { REPORTER_SOURCE_ONLY_FACTORIES } from "../src/debug/reporterFactoryCases";
import { canonicalizeMatch, canonicalizeReplace } from "../src/utils/patches";
import { discordReporterFactories, rpcNativePrerequisites } from "./fixtures/discordReporterFactories";
import { evaluate, pluginPatches, sourceNode } from "./utils/discordClientFixture";
import { loadTestModule } from "./utils/loadTestModule";

type Factory = ((...args: any[]) => any) & Record<symbol, any>;

const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const contextPatch = pluginPatches("src/plugins/_api/contextMenu.ts")[0];
const rpcPatch = evaluate(`(${sourceNode("src/plugins/consoleJanitor/index.tsx", node => ts.isObjectLiteralExpression(node)
    && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText() === "find"
        && property.initializer.getText() === '"RPCServer:WSS"'))});`, {});

function normalize(patch: any, plugin: string) {
    return { ...patch, plugin, replacement: (Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement]).map((replacement: any) => ({
        ...replacement, match: canonicalizeMatch(replacement.match), replace: canonicalizeReplace(replacement.replace, plugin)
    })) };
}

function fixture(id = "438834", options: {
    source?: string;
    patches?: any[];
    digest?: typeof webcrypto.subtle.digest;
    timeout?: (promise: Promise<unknown>, timeout: number) => Promise<unknown>;
    reporter?: boolean;
} = {}) {
    const originalSymbol = Symbol("originalFactory");
    const factories: Record<PropertyKey, Factory> = {};
    const cache: Record<PropertyKey, any> = {};
    // Discord's current native require algorithm, including its existing cache semantics.
    const require = runInNewContext("function T(e){var t=p[e];if(void 0!==t)return t.exports;var n=p[e]={id:e,loaded:!1,exports:{}};return I[e].call(n.exports,n,n.exports,T),n.loaded=!0,n.exports}T;", { I: factories, p: cache });
    Object.assign(require, { m: factories, c: cache,
        d(exports: object, getters: Record<string, () => unknown>) {
            for (const key in getters) if (!Object.hasOwn(exports, key))
                Object.defineProperty(exports, key, { configurable: true, enumerable: true, get: getters[key] });
        },
        n: (value: unknown) => () => value
    });
    const patches = options.patches ?? [normalize(contextPatch, "ContextMenuAPI"), normalize(rpcPatch, "ConsoleJanitor")];
    const errors: unknown[][] = [], warnings: unknown[][] = [], records: any[] = [], listeners: any[] = [];
    const source = ts.createSourceFile("patchWebpack.ts", readFileSync("src/webpack/patchWebpack.ts", "utf8"), ts.ScriptTarget.Latest, true);
    const functions = ["proxyFactoryAndUpdateExisting", "prepareReporterFactory", "updateExistingFactory",
        "defineInWebpackInstances", "createFactoryRollback", "runFactoryWithWrap", "patchFactory"];
    const variables = ["moduleFactoryHandler", "reporterFactoryTargets", "pendingReporterFactories", "reporterPatchOrder", "reporterPatchSequence",
        "recordReporterPatchOrder", "restoreReporterPatches"];
    const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) ? functions.includes(node.name?.text ?? "")
        : ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => variables.includes(declaration.name.getText(source))));
    const api = evaluate(declarations.map(node => node.getText(source).replace(/^export /, "")).join("\n")
        + "\n({ proxyFactoryAndUpdateExisting, prepareReporterFactory });", {
        IS_REPORTER: true, IS_DEV: false, IS_COMPANION_TEST: false, patches, patchTimings: [], getBuildNumber: () => -1,
        getPatchTimingLastIndex: () => 0, traceFunctionWithResults: (_name: string, fn: Function) => (...args: unknown[]) => [fn(...args), 0],
        Settings: { eagerPatches: false }, wreq: require, allWebpackInstances: new Set([require]),
        SYM_ORIGINAL_FACTORY: originalSymbol, SYM_IS_PROXIED_FACTORY: Symbol(), SYM_PATCHED_SOURCE: Symbol(), SYM_PATCHED_BY: Symbol(), SYM_ORIGINAL_MODULE_FACTORIES: Symbol(),
        define: (target: object, key: PropertyKey, descriptor: PropertyDescriptor) => Reflect.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, ...descriptor }),
        notifyFactoryListeners() {}, _blacklistBadModules: () => false, dispatchSubscriptions() {}, waitForSubscriptions: new Map(), reportSubscriptionError() {},
        moduleListeners: new Set([(exports: unknown, moduleId: unknown) => listeners.push([exports, moduleId])]),
        logger: { warn: (...args: unknown[]) => warnings.push(args), error: (...args: unknown[]) => errors.push(args) }
    });
    const nativeRequests: string[] = [];
    const nativeMethod = runInNewContext(`({${rpcNativePrerequisites.requireModule}}).requireModule`, { D: {}, g: undefined });
    const native = { requireModule(name: string) { nativeRequests.push(name); return nativeMethod(name); } };
    const raw = options.source ?? discordReporterFactories[id];
    if (raw) {
        const requireName = raw.match(/^\d+\([^,]+,[^,]+,([^)]*)\)/)?.[1];
        const absent = REPORTER_SOURCE_ONLY_FACTORIES.find(record => record.id === id);
        for (const [, dependency] of raw.matchAll(new RegExp(requireName ? `\\b${requireName}\\((\\d+)\\)` : "(?!)", "g"))) {
            if (absent?.reason !== "host-module-unavailable" || dependency !== absent.missingDependency)
                cache[dependency] = { id: dependency, loaded: true, exports: {} };
        }
        for (const [dependency, exports] of Object.entries({
            19575: { Ay: native }, 582128: { memo: (component: unknown) => component }, 945810: { mj: () => ({}) }
        })) cache[dependency] = { id: dependency, loaded: true, exports };
    }
    const register = (moduleId: string, factorySource: string) => {
        const factory = runInNewContext(`({${factorySource}})[${moduleId}]`) as Factory;
        api.proxyFactoryAndUpdateExisting(factories, moduleId, factory, factories);
        return factory;
    };
    if (raw) register(id, raw);
    const window: Record<string, unknown> = {};
    let digests = 0;
    const preflight = loadTestModule("src/debug/reporterFactoryPreflight.ts", {
        "@utils/Logger": { Logger: class { log(label: string, json: string) { assert.equal(label, "Source-only factory:"); records.push(JSON.parse(json)); } } },
        "@webpack": { wreq: require }, "@webpack/patcher": api,
        "./reporterFactoryCases": { REPORTER_SOURCE_ONLY_FACTORIES },
        "./promiseTimeout": { withTimeout: options.timeout ?? ((promise: Promise<unknown>, timeout: number) => { assert.equal(timeout, 500); return promise; }) }
    }, {
        IS_REPORTER: options.reporter ?? true, IS_WEB: true, IS_VESKTOP: false, IS_EQUIBOP: false, window, TextEncoder,
        crypto: { subtle: { digest: (...args: Parameters<typeof webcrypto.subtle.digest>) => {
            digests++;
            return options.digest ? options.digest(...args) : webcrypto.subtle.digest(...args);
        } } }
    });
    return { id, require, cache, factories, patches, errors, warnings, records, listeners, register, api, window, nativeRequests, originalSymbol,
        get digests() { return digests; }, force: (moduleId = id, shouldContinue?: () => boolean) => preflight.requireReporterFactory(moduleId, shouldContinue) as void | Promise<void> };
}

test("all three captured factories compile with the real patches and exact approved identities without initialization", async () => {
    for (const record of REPORTER_SOURCE_ONLY_FACTORIES) {
        assert.equal(hash(discordReporterFactories[record.id]), record.originalSha256);
        const f = fixture(record.id);
        const before = Reflect.ownKeys(f.cache);
        await f.force();
        assert.deepEqual(f.records, [record]);
        assert.deepEqual(Reflect.ownKeys(f.cache), before);
        assert.equal(f.listeners.length, 0);
        assert.equal(f.nativeRequests.length, 0);
        assert.equal(f.errors.length, 0);
        assert.equal(f.warnings.length, 0);
        await f.force();
        assert.equal(f.records.length, 1, "Identical repeated synthetic entries do not duplicate coverage");
        assert.equal(f.digests, 2);
    }
});

test("RPC source evidence requires the native capability before the changed deferred logger callback", () => {
    assert.match(rpcNativePrerequisites.loadServer, /isPlatformEmbedded&&this\.registerTransportsForEmbeddedPlatform\(\)/);
    assert.match(rpcNativePrerequisites.registration, /ensureModule\("discord_rpc"\)\.then\(.*\(33006\)/);
    const source = discordReporterFactories["33006"];
    const patched = source.replace(canonicalizeMatch(rpcPatch.replacement.match), rpcPatch.replacement.replace);
    const offset = source.indexOf('.requireModule("discord_rpc")');
    assert.ok(offset > 0);
    assert.equal(source.slice(0, offset + 28), patched.slice(0, offset + 28));
    assert.ok(patched.indexOf('message.includes("EADDRINUSE")') > offset);
});

test("the missing imports and ContextMenu changes retain the original initialization boundary", async () => {
    for (const record of REPORTER_SOURCE_ONLY_FACTORIES) {
        if (record.reason !== "host-module-unavailable") continue;
        const source = discordReporterFactories[record.id];
        const f = fixture(record.id);
        const prepared = f.api.prepareReporterFactory(record.id, f.factories[record.id], f.require);
        const normalized = `function${source.slice(source.indexOf("("))}`;
        const offset = normalized.indexOf(`(${record.missingDependency})`);
        assert.ok(offset > 0);
        assert.equal(prepared.patchedSource.slice(0, offset + 8), normalized.slice(0, offset + 8));
        assert.ok(prepared.patchedSource.indexOf("contextMenuAPIArguments:") > offset);
        f.cache[record.missingDependency] = { loaded: true, exports: {} };
        await f.force();
        assert.equal(typeof f.cache[record.id].exports.default, "function");
        assert.equal(f.records.length, 0);
        assert.equal(f.errors.length, 0);
    }

    // An exported object may have many delimiters but no closing call after navId.
    const plain = fixture("900000", { source: `900000(e){e.exports={navId:"plain"${",item:0".repeat(1000)}}}` });
    await plain.force();
    assert.deepEqual({ ...plain.cache[plain.id].exports }, { navId: "plain", item: 0 });
    assert.equal(plain.errors.length, 0);
    assert.equal(plain.warnings.length, 0);
});

test("later ordinary host requires execute the prepared patches and preserve genuine fatal errors", async () => {
    for (const record of REPORTER_SOURCE_ONLY_FACTORIES) {
        const f = fixture(record.id);
        await f.force();
        if (record.reason === "native-capability-unavailable") assert.throws(() => f.require(record.id), /nativeModules/);
        else f.require(record.id); // Native recovery returns the dependency's partial cache exports.
        assert.equal(f.errors.length, 1);
        assert.match(String(f.errors[0][0]), /Error in patched module factory/);
        assert.equal(f.cache[record.id].loaded, record.reason !== "native-capability-unavailable");
        if (record.reason === "native-capability-unavailable")
            assert.deepEqual(f.nativeRequests.slice(0, 3), ["discord_erlpack", "erlpack", "discord_rpc"]);
    }
});

test("unknown or changed source, changed prepared code, and failed hashes never receive source-only coverage", async () => {
    const cases = [
        fixture("438834", { source: discordReporterFactories["438834"].replace('"conjure-history-database-options"', '"conjure-history-database-options-changed"') }),
        fixture("438834", { patches: [normalize(contextPatch, "ContextMenuAPI"), normalize({ find: "conjure-history", replacement: {
            match: "{a.d(e,", replace: '{throw new Error("New initializing defect");a.d(e,'
        } }, "BrokenInitializer")] }),
        fixture("438834", { digest: async () => { throw new Error("Digest unavailable"); } }),
        fixture("438834", { timeout: async () => { throw new Error("Verification timed out"); } }),
        fixture("438834", { reporter: false })
    ];
    for (const f of cases) {
        try { await f.force(); }
        catch (error) { assert.match(String(error), /reading 'call'/); }
        assert.equal(f.records.length, 0);
        assert.equal(f.errors.length, 1);
    }
    assert.match(String(cases[1].errors[0][1]), /New initializing defect/);
});

test("present or inherited prerequisites and cached target modules are never classified as unavailable", async () => {
    for (const location of ["factories", "cache"] as const) {
        const f = fixture();
        const source = location === "factories" ? function (module: any) { module.exports = {}; } : { loaded: true, exports: {} };
        Object.setPrototypeOf(f[location], { 796734: source });
        await f.force();
        assert.equal(f.records.length, 0);
        assert.equal(f.digests, 0);
        assert.equal(typeof f.cache[f.id].exports.default, "function");
    }
    for (const native of [null, undefined, {}]) {
        const f = fixture("33006");
        f.window.DiscordNative = native;
        await assert.rejects(async () => f.force(), /nativeModules/);
        assert.equal(f.records.length, 0);
        assert.equal(f.digests, 0);
    }
    const f = fixture();
    f.cache[f.id] = { loaded: true, exports: { alreadyLoaded: true } };
    await f.force();
    assert.equal(f.records.length, 0);
    assert.equal(f.digests, 0);
    assert.equal(f.cache[f.id].exports.alreadyLoaded, true);
});

test("hash awaits recheck current factory identity, cache and prerequisite state before any skip", async () => {
    for (const change of ["factory", "original", "cache", "dependency"]) {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const f = fixture("438834", { digest: async (...args) => { await gate; return webcrypto.subtle.digest(...args); } });
        const pending = f.force();
        if (change === "factory") f.register(f.id, `${f.id}(m){m.exports={replacement:true}}`);
        if (change === "original") f.factories[f.id][f.originalSymbol] = runInNewContext(`({${discordReporterFactories[f.id]}})[${f.id}]`);
        if (change === "cache") f.cache[f.id] = { loaded: true, exports: { alreadyLoaded: true } };
        // Also lets the deliberately changed-original case complete ordinary execution.
        if (change === "dependency" || change === "original") f.cache[796734] = { loaded: true, exports: {} };
        release();
        await pending;
        assert.equal(f.records.length, 0, change);
        if (change === "factory") assert.equal(f.cache[f.id].exports.replacement, true);
        if (change === "cache") assert.equal(f.cache[f.id].exports.alreadyLoaded, true);
    }
});

test("canceling synthetic traversal prevents both immediate and pending-hash requires without altering later host execution", async () => {
    for (const changed of [false, true]) {
        const gate = Promise.withResolvers<void>();
        const source = changed ? discordReporterFactories["438834"].replace('"conjure-history-database-options"', '"changed"') : undefined;
        const f = fixture("438834", { source, digest: async (...args) => { await gate.promise; return webcrypto.subtle.digest(...args); } });
        const before = Reflect.ownKeys(f.cache);
        let active = true;
        const pending = f.force(f.id, () => active);
        active = false;
        gate.resolve();
        await pending;
        assert.deepEqual(Reflect.ownKeys(f.cache), before);
        assert.equal(f.records.length, 0);
        assert.equal(f.errors.length, 0);
        f.cache[796734] = { loaded: true, exports: {} };
        f.require(f.id);
        assert.equal(typeof f.cache[f.id].exports.default, "function", "Cancellation never replaces host execution or its prepared code");
    }
    const f = fixture("1", { patches: [], source: '1(m){m.exports={loaded:true}}' });
    assert.equal(f.force("1", () => false), undefined);
    assert.equal(Object.hasOwn(f.cache, "1"), false);
    assert.equal(f.force("1", () => true), undefined);
    assert.equal(f.cache[1].exports.loaded, true);
});

test("duplicate registration discards unexecuted preparation and restores consumed patches for the replacement", async () => {
    const patches = [normalize({ find: '"marker"', replacement: { match: '"before"', replace: '"patched"' } }, "Fixture")];
    const f = fixture("1", { patches, source: '1(m){m.exports={tag:"marker",value:"before",version:1}}' });
    const prepared = f.api.prepareReporterFactory("1", f.factories[1], f.require);
    assert.equal(f.patches.length, 0);
    f.register("1", '1(m){m.exports={tag:"marker",value:"before",version:2}}');
    assert.equal(prepared.isCurrent(), false);
    assert.equal(f.patches.length, 1);
    const value = f.require("1");
    assert.equal(value.value, "patched");
    assert.equal(value.version, 2);
    assert.equal(f.patches.length, 0);
    assert.equal(f.listeners.length, 1);
});

test("overlapping preparations restore original patch order in either invalidation order and preserve appended patches", () => {
    for (const prepareOrder of [["1", "2"], ["2", "1"]]) {
        for (const invalidateOrder of [["1", "2"], ["2", "1"]]) {
            const patches = ["A", "B"].map(tag => normalize({ find: `"${tag}"`, replacement: { match: '"before"', replace: '"after"' } }, tag));
            const originalOrder = [...patches];
            const f = fixture("1", { patches, source: '1(m){m.exports={tag:"A",value:"before"}}' });
            f.register("2", '2(m){m.exports={tag:"B",value:"before"}}');
            for (const id of prepareOrder) f.api.prepareReporterFactory(id, f.factories[id], f.require);
            assert.equal(patches.length, 0);
            const appended = normalize({ find: "appended", replacement: { match: "a", replace: "b" } }, "Appended");
            patches.push(appended);
            for (const id of invalidateOrder) f.register(id, `${id}(m){m.exports={replacement:true}}`);
            assert.deepEqual(patches, [...originalOrder, appended]);
        }
    }
});

test("invalidating preparation never restores a different module's patch consumed by a nested real require", () => {
    let f!: ReturnType<typeof fixture>;
    const patches = [
        normalize({ find: '"A"', replacement: { match: '"before"', replace() { f.require("2"); return '"after-A"'; } } }, "A"),
        normalize({ find: '"B"', replacement: { match: '"before"', replace: '"after-B"' } }, "B")
    ];
    f = fixture("1", { patches, source: '1(m){m.exports={tag:"A",value:"before"}}' });
    f.register("2", '2(m){m.exports={tag:"B",value:"before"}}');
    f.api.prepareReporterFactory("1", f.factories[1], f.require);
    assert.equal(f.cache[2].exports.value, "after-B");
    assert.equal(patches.length, 0);
    f.register("1", '1(m){m.exports={tag:"A",value:"before",replacement:true}}');
    assert.deepEqual(patches.map(patch => patch.plugin), ["A"]);
    assert.equal(f.require("1").value, "after-A");
    assert.equal(patches.length, 0);
    assert.equal(f.listeners.length, 2, "The nested module executes only once");
});

test("a replacement callback registering a newer source cannot be overwritten by preparation", () => {
    let f!: ReturnType<typeof fixture>;
    let replaceSource = true;
    const patch = normalize({ find: '"marker"', replacement: { match: '"before"', replace() {
        if (replaceSource) {
            replaceSource = false;
            f.register("1", '1(m){m.exports={tag:"marker",value:"before",version:2}}');
        }
        return '"patched"';
    } } }, "Fixture");
    f = fixture("1", { patches: [patch], source: '1(m){m.exports={tag:"marker",value:"before",version:1}}' });
    assert.equal(f.api.prepareReporterFactory("1", f.factories[1], f.require), undefined);
    assert.deepEqual(f.patches, [patch]);
    const value = f.require("1");
    assert.equal(value.version, 2);
    assert.equal(value.value, "patched");
    assert.equal(f.patches.length, 0);
    assert.equal(f.listeners.length, 1);
});

test("a forged original toString cannot authenticate a changed factory as reviewed source", async () => {
    const f = fixture();
    const changed = f.register(f.id, `${f.id}(m){m.exports={changed:true}}`);
    changed.toString = () => discordReporterFactories[f.id];
    await f.force();
    assert.equal(f.records.length, 0);
    assert.equal(f.errors.length, 1, "Ordinary patch execution retains its initiating failure");
    assert.equal(f.cache[f.id].exports.changed, true);
});

test("source verification bounds six preparations and rejects oversized source without hashing", async () => {
    const f = fixture("33006");
    for (let count = 0; count < 6; count++) {
        if (count) f.register(f.id, discordReporterFactories[f.id]);
        await f.force();
    }
    assert.equal(f.digests, 12);
    f.register(f.id, discordReporterFactories[f.id]);
    assert.throws(() => f.force(), /nativeModules/);
    assert.equal(f.digests, 12);
    assert.equal(f.errors.length, 1);

    const oversizedSource = discordReporterFactories["33006"].replace("{", `{/*${"x".repeat(16_384)}*/`);
    const oversized = fixture("33006", { source: oversizedSource });
    for (let count = 0; count < 6; count++) {
        if (count) {
            delete oversized.cache[oversized.id];
            oversized.register(oversized.id, oversizedSource);
        }
        assert.throws(() => oversized.force(), /nativeModules/);
    }
    delete oversized.cache[oversized.id];
    oversized.patches.push(normalize(rpcPatch, "ConsoleJanitor"));
    oversized.register(oversized.id, discordReporterFactories[oversized.id]);
    assert.throws(() => oversized.force(), /nativeModules/, "Failed preparations must exhaust the same cap before a valid candidate");
    assert.equal(oversized.digests, 0);
    assert.equal(oversized.records.length, 0);
});

test("source-only coverage retains independent no-effect and compile findings", async () => {
    for (const replacement of [
        { match: "missing-patch-target", replace: "changed" },
        { match: '"conjure-history-database-options"', replace: "invalid syntax !!!!" }
    ]) {
        const f = fixture("438834", { patches: [normalize(contextPatch, "ContextMenuAPI"), normalize({ find: "conjure-history", replacement }, "BrokenPatch")] });
        await f.force();
        assert.equal(f.records.length, 1);
        assert.equal(f.errors.length + f.warnings.length, 1);
        assert.match(String((f.errors[0] ?? f.warnings[0])[0]), /Patch by BrokenPatch/);
    }
});

test("ordinary reporter forcing stays synchronous and does not assimilate thenable exports", () => {
    const f = fixture("1", { patches: [], source: '1(m){m.exports={then(){throw new Error("Do not execute thenable exports")}}}' });
    assert.equal(f.force(), undefined, "The ordinary path must remain synchronous");
    assert.equal(typeof f.cache[1].exports.then, "function");
    assert.equal(f.records.length, 0);
});
