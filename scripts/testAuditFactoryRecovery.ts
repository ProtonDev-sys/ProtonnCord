/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { declaration, evaluate } from "./utils/discordClientFixture";

type Factory = (this: any, module: any, exports: any, require: any) => unknown;

function fixture(initialExports: any = {}, moduleExports: any = initialExports) {
    const original = Symbol("originalFactory");
    const source = ts.createSourceFile("patchWebpack.ts", readFileSync("src/webpack/patchWebpack.ts", "utf8"), ts.ScriptTarget.Latest, true);
    const functions = source.statements.filter(s => ts.isFunctionDeclaration(s)
        && ["createFactoryRollback", "runFactoryWithWrap"].includes(s.name?.text ?? ""));
    const module = { id: 335253, loaded: false, exports: moduleExports };
    const cache: Record<string, any> = { [module.id]: module };
    const errors: unknown[][] = [];
    const listeners: any[] = [];
    const subscriptions: any[] = [];
    let blacklistCalls = 0;
    let blacklist = false;
    const require = Object.assign(() => {}, {
        c: cache,
        d(exports: any, definitions: Record<string, () => unknown>) {
            // Match the actual configurable Webpack export registration in patchWebpack.ts.
            for (const key in definitions) {
                if (Object.hasOwn(definitions, key) && !Object.hasOwn(exports, key))
                    Object.defineProperty(exports, key, { enumerable: true, configurable: true, get: definitions[key] });
            }
        }
    });
    const run = evaluate(functions.map(s => s.getText(source)).join("\n") + "\nrunFactoryWithWrap;", {
        SYM_ORIGINAL_FACTORY: original, wreq: {}, defineInWebpackInstances() {},
        _blacklistBadModules() { blacklistCalls++; return blacklist; },
        moduleListeners: new Set([(exports: any, id: unknown) => listeners.push([exports, id])]),
        waitForSubscriptions: new Map(), reportSubscriptionError() {},
        dispatchSubscriptions(_subscriptions: unknown, exports: any, id: unknown) { subscriptions.push([exports, id]); },
        logger: { error: (...args: unknown[]) => errors.push(args) }
    });
    const find = declaration("src/webpack/webpack.ts", "find", {
        cache, IS_ANTI_CRASH_TEST: false,
        traceFunction: (_name: string, fn: Function) => fn,
        handleModuleNotFound() { throw new Error("No matching module"); }
    });
    return {
        module, require, cache, errors, listeners, subscriptions, find,
        get blacklistCalls() { return blacklistCalls; },
        setBlacklist(value: boolean) { blacklist = value; },
        invoke(patched: Factory, native: Factory = patched) {
            Object.assign(patched, { [original]: native });
            const result = run(patched, initialExports, [module, initialExports, require]);
            module.loaded = true; // The host only marks a module loaded after a successful wrapper return.
            return result;
        }
    };
}

test("native recovery replaces a stale TDZ getter before loaded-module lookups and delivers listeners once", () => {
    const f = fixture();
    const failure = new Error("Patched initialization failed");
    const namespace = f.module.exports;
    let nativeCalls = 0;
    function native(this: any, module: any, exports: any, require: any) {
        nativeCalls++;
        assert.equal(this, namespace);
        assert.equal(module, f.module);
        assert.equal(exports, namespace);
        require.d(exports, { default: () => C });
        const C = { healthy: true };
        return "native-result";
    }
    function patched(module: any, exports: any, require: any) {
        require.d(exports, { default: () => C });
        throw failure;
        const C = { healthy: false };
    }
    assert.equal(f.invoke(patched, native), "native-result");
    assert.equal(nativeCalls, 1);
    assert.equal(f.module.exports, namespace);
    assert.equal(f.find((value: any) => value.healthy), namespace.default);
    f.cache[500000] = { loaded: true, exports: { wanted: true } };
    assert.equal(f.find((value: any) => value.wanted), f.cache[500000].exports);
    assert.equal(f.find((value: any) => Object.values(value).includes(true)), namespace.default);
    assert.deepEqual(f.listeners, [[namespace, 335253]]);
    assert.deepEqual(f.subscriptions, [[namespace, 335253]]);
    assert.equal(f.blacklistCalls, 1);
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0][1], failure);
    assert.match(String(f.errors[0][0]), /Error in patched module factory \(Module id is 335253\):/);
});

test("rollback preserves original object identities, prototypes and string, symbol and accessor descriptors without invoking them", () => {
    let getterCalls = 0;
    let setterCalls = 0;
    const symbol = Symbol("original-symbol");
    const prototype = { inherited: true };
    const namespace = Object.create(prototype, {
        original: { configurable: true, enumerable: false, writable: false, value: "original" },
        accessor: { configurable: true, enumerable: true, get() { getterCalls++; throw new Error("Do not read"); }, set() { setterCalls++; } },
        [symbol]: { configurable: true, enumerable: false, value: 7 }
    });
    const f = fixture(namespace);
    const moduleDescriptors = Object.getOwnPropertyDescriptors(f.module);
    const exportDescriptors = Object.getOwnPropertyDescriptors(namespace);
    const foreign = { changedByPatchedFactory: false };
    const replacement = { foreign: true };
    const failure = new Error("Fail after export changes");
    f.invoke(function (module, exports) {
        Object.defineProperty(exports, "original", { configurable: true, writable: true, value: "changed" });
        Object.defineProperty(exports, "accessor", { configurable: true, value: "changed" });
        Reflect.deleteProperty(exports, symbol);
        Object.defineProperty(exports, Symbol("new-symbol"), { configurable: true, value: "new" });
        Object.setPrototypeOf(exports, { wrong: true });
        module.exports = replacement;
        Object.defineProperty(module, "temporary", { configurable: true, value: true });
        Object.setPrototypeOf(module, { wrong: true });
        foreign.changedByPatchedFactory = true;
        throw failure;
    }, function (module, exports) {
        assert.equal(module, f.module);
        assert.equal(module.exports, namespace);
        assert.equal(exports, namespace);
        assert.deepEqual(Object.getOwnPropertyDescriptors(exports), exportDescriptors);
        assert.deepEqual(Object.getOwnPropertyDescriptors(module), moduleDescriptors);
        assert.equal(Object.getPrototypeOf(exports), prototype);
        assert.equal(Object.getPrototypeOf(module), Object.prototype);
        assert.equal(foreign.changedByPatchedFactory, true, "Foreign module state is not reset");
    });
    assert.equal(getterCalls, 0);
    assert.equal(setterCalls, 0);
    assert.deepEqual(replacement, { foreign: true });
});

test("recovery restores replaced or primitive module.exports and bypasses a newly installed exports accessor", () => {
    for (const initial of [null, 0, "primitive", { initial: true }]) {
        const argument = {};
        const f = fixture(argument, initial);
        let reads = 0;
        let writes = 0;
        const final = { recovered: true };
        f.invoke(function (module, exports) {
            exports.partial = true;
            if (initial && typeof initial === "object") Object.assign(initial, { partial: true });
            Object.defineProperty(module, "exports", {
                configurable: true,
                get() { reads++; throw new Error("Do not read a failed factory's accessor"); },
                set() { writes++; throw new Error("Do not invoke a failed factory's setter"); }
            });
            throw new Error("Initialization failed");
        }, function (module, exports) {
            assert.equal(module.exports, initial);
            assert.equal(exports, argument);
            assert.deepEqual(argument, {});
            if (initial && typeof initial === "object") assert.deepEqual(initial, { initial: true });
            module.exports = final;
        });
        assert.equal(f.module.exports, final);
        assert.equal(reads, 0);
        assert.equal(writes, 0);
        assert.deepEqual(f.listeners, [[final, 335253]]);
    }
    const primitiveArgument = fixture(42);
    primitiveArgument.invoke(function (module) { module.exports = {}; throw new Error("Failed"); }, function (module, exports) {
        assert.equal(exports, 42);
        assert.equal(module.exports, 42);
        module.exports = "native";
    });
    assert.equal(primitiveArgument.module.exports, "native");
});

test("irreversible export changes remain failed and never execute the original or listeners", () => {
    const mutations = [
        (module: any, exports: any) => Object.defineProperty(exports, "locked", { value: true }),
        (module: any, exports: any) => Object.preventExtensions(exports),
        (module: any) => Object.defineProperty(module, "exports", { configurable: false, writable: false, value: {} }),
        (module: any, exports: any) => Object.freeze(exports)
    ];
    for (const mutate of mutations) {
        const f = fixture();
        const failure = new Error("Initiating failure must survive");
        assert.throws(() => f.invoke(function (module, exports) {
            mutate(module, exports);
            throw failure;
        }, () => assert.fail("Unsafe recovery must not run the native factory")), error => error === failure);
        assert.equal(f.module.loaded, false);
        assert.equal(f.errors.length, 2);
        assert.equal(f.errors[0][1], failure);
        assert.match(String(f.errors[1][0]), /restore.*335253/);
        assert.equal(f.listeners.length, 0);
        assert.equal(f.subscriptions.length, 0);
    }
});

test("a throwing original preserves its exact error and incomplete module state", () => {
    const f = fixture();
    const initiating = new Error("Patched error");
    const native = new Error("Native error");
    assert.throws(() => f.invoke(() => { throw initiating; }, () => { throw native; }), error => error === native);
    assert.equal(f.errors[0][1], initiating);
    assert.equal(f.errors.length, 1);
    assert.equal(f.module.loaded, false);
    assert.equal(f.listeners.length, 0);
    assert.equal(f.subscriptions.length, 0);
});

test("successful patches and untouched factories retain their return, export and exception behavior", () => {
    const f = fixture();
    const value = { patched: true };
    assert.equal(f.invoke(function (module) { module.exports = value; return "patched-result"; }, () => assert.fail("Do not replay successful patches")), "patched-result");
    assert.equal(f.module.exports, value);
    assert.deepEqual(f.listeners, [[value, 335253]]);
    assert.deepEqual(f.subscriptions, [[value, 335253]]);
    assert.equal(f.errors.length, 0);

    let descriptorReads = 0;
    const untouched = fixture(new Proxy({}, { ownKeys() { descriptorReads++; return []; } }));
    assert.equal(untouched.invoke(() => "untouched-result"), "untouched-result");
    assert.equal(descriptorReads, 0, "Unpatched factories incur no snapshot work");
    const failure = new Error("Unpatched exception");
    const failed = fixture();
    assert.throws(() => failed.invoke(() => { throw failure; }), error => error === failure);
    assert.equal(failed.errors.length, 0);
    assert.equal(failed.module.loaded, false);
});

test("recovered native exports still pass through the existing blacklist before listeners", () => {
    const f = fixture();
    f.setBlacklist(true);
    assert.equal(f.invoke(() => { throw new Error("Patched error"); }, () => "native-result"), "native-result");
    assert.equal(f.blacklistCalls, 1);
    assert.equal(f.listeners.length, 0);
    assert.equal(f.subscriptions.length, 0);
});
