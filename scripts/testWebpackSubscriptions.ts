/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { dispatchSubscriptions, type SubscriptionErrorHandler } from "../src/webpack/subscriptions";
import type { CallbackFn, FilterFn } from "../src/webpack/webpack";

function fixture() {
    const subscriptions = new Map<FilterFn, CallbackFn>();
    const failures: Parameters<SubscriptionErrorHandler>[] = [];
    const onError: SubscriptionErrorHandler = (...failure) => failures.push(failure);
    return {
        subscriptions,
        failures,
        onError,
        dispatch(exports: any, moduleId: PropertyKey = "module") {
            dispatchSubscriptions(subscriptions, exports, moduleId, onError);
        },
    };
}

test("top-level matches retain waiter order without reading nested exports", () => {
    const { subscriptions, dispatch } = fixture();
    const moduleId = Symbol("module");
    const exports = Object.defineProperty({}, "unused", {
        enumerable: true,
        get() { assert.fail("A top-level match must not inspect nested exports"); },
    });
    const received: string[] = [];
    subscriptions.set(value => value === exports, (value, id) => {
        assert.equal(value, exports);
        assert.equal(id, moduleId);
        received.push("first");
    });
    subscriptions.set(value => value === exports, () => received.push("second"));
    dispatch(exports, moduleId);
    assert.deepEqual(received, ["first", "second"]);
    assert.equal(subscriptions.size, 0);
});

test("an earlier nested match is delivered before a later top-level match", () => {
    const { subscriptions, dispatch } = fixture();
    const nested = {};
    const exports = { nested };
    const received: string[] = [];
    subscriptions.set(value => value === nested, () => received.push("nested"));
    subscriptions.set(value => value === exports || value === nested, value => {
        assert.equal(value, exports, "Each filter must prefer the top-level exports");
        received.push("top");
    });
    dispatch(exports);
    assert.deepEqual(received, ["nested", "top"]);
});

test("falsy nested values are searchable while null and undefined are skipped", () => {
    const { subscriptions, dispatch } = fixture();
    const exports = { a: null, b: undefined, c: false, d: 0, e: "" };
    const seen: unknown[] = [];
    subscriptions.set(value => {
        seen.push(value);
        return false;
    }, () => assert.fail("An unmatched subscription must not run"));
    dispatch(exports);
    assert.deepEqual(seen, [exports, false, 0, ""]);
    assert.equal(subscriptions.size, 1);
});

test("primitive and function exports are searched only at the top level", () => {
    for (const exports of [false, 0, "text", Object.assign(() => {}, { nested: "hidden" })]) {
        const { subscriptions, dispatch } = fixture();
        const seen: unknown[] = [];
        subscriptions.set(value => {
            seen.push(value);
            return false;
        }, () => assert.fail());
        dispatch(exports);
        assert.deepEqual(seen, [exports]);
    }
    const { subscriptions, dispatch } = fixture();
    subscriptions.set(() => assert.fail("Absent exports must not be filtered"), () => assert.fail());
    dispatch(null);
    dispatch(undefined);
});

test("shallow enumeration includes inherited keys and handles circular references", () => {
    const { subscriptions, dispatch } = fixture();
    const inherited = {};
    const nested = { deeper: {} };
    const exports = Object.assign(Object.create({ inherited }), { nested });
    exports.self = exports;
    Object.defineProperty(exports, "hidden", { value: {} });
    exports[Symbol("ignored")] = {};
    const seen: unknown[] = [];
    subscriptions.set(value => {
        seen.push(value);
        return false;
    }, () => assert.fail());
    dispatch(exports);
    assert.deepEqual(seen, [exports, nested, exports, inherited]);
});

test("throwing circular-import getters are skipped once and retried on a later dispatch", () => {
    const { subscriptions, dispatch, failures } = fixture();
    const nested = {};
    let ready = false;
    let reads = 0;
    const exports = {
        get circular() {
            reads++;
            if (!ready) throw new ReferenceError("Binding is not initialized");
            return nested;
        },
    };
    let calls = 0;
    subscriptions.set(value => value === nested, () => calls++);
    subscriptions.set(value => value === nested, () => calls++);
    dispatch(exports);
    assert.equal(reads, 1);
    assert.equal(calls, 0);
    assert.equal(subscriptions.size, 2);
    ready = true;
    dispatch(exports);
    assert.equal(reads, 3, "A delivered callback invalidates exports before the next waiter");
    assert.equal(calls, 2);
    assert.equal(subscriptions.size, 0);
    assert.deepEqual(failures, []);
});

test("a throwing filter can still match a later nested value and does not block other waiters", () => {
    const { subscriptions, dispatch, failures } = fixture();
    const bad = {};
    const good = {};
    const exports = { bad, good };
    const received: string[] = [];
    subscriptions.set(value => {
        if (value === exports || value === bad) throw new Error("Filter failed");
        return value === good;
    }, () => received.push("recovered"));
    subscriptions.set(value => value === good, () => received.push("next"));
    dispatch(exports);
    assert.deepEqual(received, ["recovered", "next"]);
    assert.deepEqual(failures.map(failure => failure[3]), [exports, bad]);
    assert.equal(subscriptions.size, 0);
});

test("throwing callbacks remain one-shot, are removed before delivery, and do not block waiters", () => {
    const { subscriptions, dispatch, failures } = fixture();
    const first = {};
    const second = {};
    const exports = { first, second };
    const topFilter: FilterFn = () => true;
    const nestedFilter: FilterFn = value => value !== exports;
    let calls = 0;
    subscriptions.set(topFilter, () => {
        assert.equal(subscriptions.has(topFilter), false);
        calls++;
        throw new Error("Top callback failed");
    });
    subscriptions.set(nestedFilter, () => {
        assert.equal(subscriptions.has(nestedFilter), false);
        calls++;
        throw new Error("Nested callback failed");
    });
    subscriptions.set(value => value === second, () => calls++);
    dispatch(exports);
    assert.equal(calls, 3);
    assert.equal(failures.length, 2);
    assert.equal(subscriptions.size, 0);
});

test("duplicate filter identity replaces its callback in place while distinct filters remain independent", () => {
    const { subscriptions, dispatch } = fixture();
    const received: string[] = [];
    const sameFilter: FilterFn = () => true;
    subscriptions.set(sameFilter, () => received.push("replaced"));
    subscriptions.set(() => true, () => received.push("second"));
    subscriptions.set(sameFilter, () => received.push("replacement"));
    dispatch({});
    assert.deepEqual(received, ["replacement", "second"]);
});

test("callbacks can remove, replace, and append pending subscriptions in Map order", () => {
    const { subscriptions, dispatch } = fixture();
    const received: string[] = [];
    const removed: FilterFn = () => true;
    const replaced: FilterFn = () => true;
    subscriptions.set(() => true, () => {
        received.push("first");
        subscriptions.delete(removed);
        subscriptions.set(replaced, () => received.push("replacement"));
        subscriptions.set(() => true, () => received.push("appended"));
    });
    subscriptions.set(removed, () => assert.fail("Removed subscription ran"));
    subscriptions.set(replaced, () => assert.fail("Replaced callback ran"));
    dispatch({});
    assert.deepEqual(received, ["first", "replacement", "appended"]);
});

test("callbacks can replace and add nested exports before later waiters inspect them", () => {
    const { subscriptions, dispatch } = fixture();
    const original = {};
    const replacement = {};
    const added = {};
    const exports: Record<string, unknown> = { value: original };
    const received: unknown[] = [];
    subscriptions.set(value => value === original, () => {
        exports.value = replacement;
        exports.added = added;
    });
    subscriptions.set(value => value === replacement, value => received.push(value));
    subscriptions.set(value => value === added, value => received.push(value));
    dispatch(exports);
    assert.deepEqual(received, [replacement, added]);
    assert.equal(subscriptions.size, 0);
});

test("throwing callbacks also invalidate changed nested exports", () => {
    const { subscriptions, dispatch, failures } = fixture();
    const original = {};
    const replacement = {};
    const exports = { value: original };
    subscriptions.set(value => value === original, () => {
        exports.value = replacement;
        throw new Error("Callback changed exports before failing");
    });
    let received: unknown;
    subscriptions.set(value => value === replacement, value => { received = value; });
    dispatch(exports);
    assert.equal(received, replacement);
    assert.equal(failures.length, 1);
});

test("explicit resubscription joins the end and reentrant module delivery does not repeat completed waiters", () => {
    const { subscriptions, dispatch } = fixture();
    const received: string[] = [];
    const first = {};
    const second = {};
    const filter: FilterFn = value => value === first;
    subscriptions.set(filter, () => {
        received.push("first");
        subscriptions.set(filter, () => received.push("resubscribed"));
        dispatch(second, "inner");
    });
    subscriptions.set(value => value === second, (_value, id) => {
        assert.equal(id, "inner");
        received.push("inner");
    });
    dispatch(first, "outer");
    assert.deepEqual(received, ["first", "inner", "resubscribed"]);
    assert.equal(subscriptions.size, 0);
});

test("the nested cache is local to one dispatch and preserves duplicate exported values", () => {
    const { subscriptions, dispatch } = fixture();
    let current = {};
    const exports = { get first() { return current; }, get second() { return current; } };
    const next = {};
    let nestedVisits = 0;
    subscriptions.set(value => {
        if (value === current) nestedVisits++;
        return value === next && nestedVisits === 4;
    }, value => assert.equal(value, next));
    dispatch(exports);
    assert.equal(nestedVisits, 2);
    assert.equal(subscriptions.size, 1);
    current = next;
    dispatch(exports);
    assert.equal(nestedVisits, 4);
    assert.equal(subscriptions.size, 0);
});

test("a throwing ownKeys proxy does not abort later top-level subscriptions", () => {
    const { subscriptions, dispatch, failures } = fixture();
    let enumerations = 0;
    const exports = new Proxy({}, {
        ownKeys() {
            enumerations++;
            throw new Error("Enumeration failed");
        },
    });
    let calls = 0;
    subscriptions.set(() => false, () => assert.fail());
    subscriptions.set(() => false, () => assert.fail());
    subscriptions.set(value => value === exports, () => calls++);
    dispatch(exports);
    assert.equal(enumerations, 1);
    assert.equal(failures.length, 1);
    assert.equal(calls, 1);
    assert.equal(subscriptions.size, 2);
});

test("early nested matches leave the unused export tail unread", () => {
    const { subscriptions, dispatch } = fixture();
    const first = {};
    let reads = 0;
    const exports = {
        get first() { reads++; return first; },
        get unused() { return assert.fail("Unused tail must not be read"); },
    };
    subscriptions.set(value => value === first, () => {});
    subscriptions.set(value => value === first, () => {});
    dispatch(exports);
    assert.equal(reads, 2, "Successful callbacks invalidate the cache, without reading the unused tail");
    assert.equal(subscriptions.size, 0);
});

test("dispatch without waiters does not enumerate exports", () => {
    const { dispatch } = fixture();
    dispatch(new Proxy({}, { ownKeys: () => assert.fail("No subscriptions need these exports") }));
});

for (const [waiterCount, exportCount] of [[1, 1], [16, 32], [128, 32], [512, 128]]) {
    test(`operation-count benchmark: ${waiterCount} waiting filters and ${exportCount} exports`, t => {
        const { subscriptions, dispatch } = fixture();
        let reads = 0;
        let enumerations = 0;
        let filterCalls = 0;
        const values: Record<string, unknown> = {};
        for (let i = 0; i < exportCount; i++) {
            Object.defineProperty(values, `export${i}`, {
                enumerable: true,
                get() { reads++; return i; },
            });
        }
        const exports = new Proxy(values, {
            ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
        });
        for (let i = 0; i < waiterCount; i++) {
            subscriptions.set(() => { filterCalls++; return false; }, () => assert.fail());
        }
        dispatch(exports);
        assert.equal(reads, exportCount, "Getter reads must not scale with waiting filters");
        assert.equal(enumerations, 1, "Export keys must be enumerated once");
        assert.equal(filterCalls, waiterCount * (exportCount + 1), "Every filter still sees every eligible candidate");
        assert.equal(subscriptions.size, waiterCount);
        t.diagnostic(JSON.stringify({ waiterCount, exportCount, reads, enumerations, filterCalls }));
    });
}

function factoryWrapperFixture() {
    // Exercise the actual factory wrapper with injected dependencies, without installing
    // its global Function.prototype hooks or evaluating Discord module patches.
    const path = "src/webpack/patchWebpack.ts";
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
    const wrapper = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "runFactoryWithWrap");
    assert.ok(wrapper, "Webpack factory wrapper is missing");
    const code = ts.transpileModule(wrapper.getText(source) + "\nexports.run = runFactoryWithWrap;", {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const state = fixture();
    const originalFactorySymbol = Symbol("originalFactory");
    const moduleListeners = new Set<CallbackFn>();
    const errors: unknown[][] = [];
    let blacklisted = false;
    let restored = 0;
    const result = runInNewContext(code + "\nexports;", {
        exports: {},
        SYM_ORIGINAL_FACTORY: originalFactorySymbol,
        defineInWebpackInstances() { restored++; },
        wreq: {},
        _blacklistBadModules() { return blacklisted; },
        moduleListeners,
        waitForSubscriptions: state.subscriptions,
        dispatchSubscriptions,
        reportSubscriptionError: state.onError,
        logger: { error(...args: unknown[]) { errors.push(args); } },
    });
    return {
        ...state, moduleListeners, errors,
        setBlacklisted(value: boolean) { blacklisted = value; },
        get restored() { return restored; },
        run(exports: unknown, moduleId: PropertyKey = "module") {
            const module = { id: moduleId, exports: {} };
            const factory = Object.assign(() => { module.exports = exports as object; return "factory-result"; }, {
                [originalFactorySymbol]: undefined as unknown,
            });
            factory[originalFactorySymbol] = factory;
            const require = Object.assign(() => {}, { c: {} });
            return result.run(factory, null, [module, module.exports, require]);
        },
    };
}

test("the factory wrapper keeps listener ordering, isolates errors, and returns the factory result", () => {
    const state = factoryWrapperFixture();
    const received: string[] = [];
    const nested = {};
    state.moduleListeners.add(() => { received.push("listener-error"); throw new Error("Listener failed"); });
    state.moduleListeners.add(() => {
        received.push("listener");
        state.subscriptions.set(value => value === nested, () => received.push("new-subscription"));
    });
    state.subscriptions.set(value => value === nested, (_value, id) => {
        assert.equal(id, "wrapper");
        received.push("subscription");
    });
    assert.equal(state.run({ nested }, "wrapper"), "factory-result");
    assert.deepEqual(received, ["listener-error", "listener", "subscription", "new-subscription"]);
    assert.equal(state.errors.length, 1);
    assert.equal(state.failures.length, 0);
    assert.equal(state.restored, 1);
});

test("the factory wrapper still skips blacklisted and absent exports", () => {
    const state = factoryWrapperFixture();
    state.moduleListeners.add(() => assert.fail("Ignored module reached a listener"));
    state.subscriptions.set(() => assert.fail("Ignored module reached a filter"), () => assert.fail());
    state.setBlacklisted(true);
    assert.equal(state.run({}), "factory-result");
    state.setBlacklisted(false);
    assert.equal(state.run(null), "factory-result");
    assert.equal(state.run(undefined), "factory-result");
    assert.equal(state.subscriptions.size, 1);
});
