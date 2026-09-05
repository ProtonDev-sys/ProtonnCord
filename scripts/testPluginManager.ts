/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface TestPlugin {
    name: string;
    dependencies?: string[];
    started?: boolean;
    isDependency?: boolean;
    requiresRestart?: boolean;
    start?(): void;
    onMessageClick?(this: TestPlugin): void;
    flux?: Record<string, (this: TestPlugin, data: unknown) => void | Promise<void>>;
}

function loadManager() {
    const plugins: Record<string, TestPlugin> = {};
    const settings: Record<string, { enabled: boolean; }> = {};
    const errors: unknown[][] = [];
    const handlers = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
    const dispatcher = {
        subscribe(event: string, handler: (data: unknown) => void | Promise<void>) {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event)?.add(handler);
        },
        unsubscribe(event: string, handler: (data: unknown) => void | Promise<void>) {
            assert.ok(handlers.get(event)?.delete(handler), "unsubscribe must use the registered function");
        }
    };
    const mocks: Record<string, object> = {
        "~plugins": { __esModule: true, default: plugins },
        "@api/Settings": { Settings: { plugins: settings }, SettingsStore: { addChangeListener() {} } },
        "@webpack/common": { FluxDispatcher: dispatcher },
        "@debug/Tracer": { traceFunction: (_name: string, fn: unknown) => fn },
        "@utils/onlyOnce": { onlyOnce: (fn: unknown) => fn },
        "@utils/Logger": { Logger: class {
            info() {}
            warn() {}
            debug() {}
            error(...args: unknown[]) { errors.push(args); }
        } }
    };
    const source = readFileSync("src/api/PluginManager.ts", "utf8");
    const code = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const manager = runInNewContext(code + "\nexports;", {
        exports: {}, Promise, IS_REPORTER: false,
        require(name: string) {
            if (name in mocks) return mocks[name];
            if (name.startsWith("@api/") || name.startsWith("./")) return {};
            if (name === "@utils/types" || name === "@utils/patches" || name === "@webpack/patcher") return {};
            throw new Error(`Unexpected import ${name}`);
        }
    });
    function add(plugin: TestPlugin) {
        plugins[plugin.name] = plugin;
        settings[plugin.name] = { enabled: false };
        return plugin;
    }
    return { manager, add, plugins, settings, dispatcher, handlers, errors };
}

test("flux subscriptions preserve original handlers and clean up the functions actually registered", async () => {
    const { manager, add, dispatcher, handlers, errors } = loadManager();
    let calls = 0;
    const plugin = add({ name: "Fixture" });
    const original = function (this: TestPlugin, data: unknown) {
        assert.equal(this, plugin);
        assert.equal(data, "payload");
        calls++;
    };
    for (let i = 0; i < 25; i++) {
        plugin.flux = { TEST: original };
        manager.subscribePluginFluxEvents(plugin, dispatcher);
        manager.subscribePluginFluxEvents(plugin, dispatcher);
        assert.equal(plugin.flux.TEST, original);
        assert.equal(handlers.get("TEST")?.size, 1);
        for (const handler of handlers.get("TEST") ?? []) await handler("payload");
        plugin.flux = {};
        manager.unsubscribePluginFluxEvents(plugin, dispatcher);
        manager.unsubscribePluginFluxEvents(plugin, dispatcher);
        assert.equal(handlers.get("TEST")?.size, 0);
    }
    assert.equal(calls, 25);
    assert.equal(errors.length, 0);
});

test("flux errors are reported once for synchronous throws and rejected promises", async () => {
    const { manager, add, dispatcher, handlers, errors } = loadManager();
    const plugin = add({ name: "Fixture", flux: {
        SYNC() { throw new Error("sync failure"); },
        async ASYNC() { throw new Error("async failure"); }
    } });
    manager.subscribePluginFluxEvents(plugin, dispatcher);
    for (const callbacks of handlers.values()) for (const handler of callbacks) await handler({});
    assert.equal(errors.length, 2);
    manager.unsubscribePluginFluxEvents(plugin, dispatcher);
});

test("nested dependency failure reaches the caller and permits a later retry", () => {
    const { manager, add, settings } = loadManager();
    const order: string[] = [];
    const leaf = add({ name: "Leaf", start() { throw new Error("unavailable"); } });
    add({ name: "Middle", dependencies: ["Leaf"], start() { order.push("Middle"); } });
    const parent = add({ name: "Parent", dependencies: ["Middle"] });
    const failed = manager.startDependenciesRecursive(parent);
    assert.deepEqual(Array.from(failed.failures), ["Leaf"]);
    assert.equal(settings.Leaf.enabled, false);
    assert.equal(settings.Middle.enabled, false);
    assert.equal(order.length, 0);
    leaf.start = () => { order.push("Leaf"); };
    assert.equal(manager.startDependenciesRecursive(parent).failures.length, 0);
    assert.deepEqual(order, ["Leaf", "Middle"]);
    manager.startDependenciesRecursive(parent);
    assert.deepEqual(order, ["Leaf", "Middle"], "running dependencies must not start twice");
});

test("nested restart requirements prevent dependants from starting before reload", () => {
    const { manager, add, settings } = loadManager();
    add({ name: "Leaf", requiresRestart: true });
    const middle = add({ name: "Middle", dependencies: ["Leaf"], start() { assert.fail("started before its dependency"); } });
    const parent = add({ name: "Parent", dependencies: ["Middle"] });
    for (let i = 0; i < 2; i++) {
        const result = manager.startDependenciesRecursive(parent);
        assert.equal(result.restartNeeded, true);
        assert.equal(result.failures.length, 0);
        assert.equal(settings.Middle.enabled, true);
        assert.equal(settings.Leaf.enabled, true);
        assert.equal(middle.started, undefined);
    }
});

test("missing and cyclic dependencies report failure without starting their dependants", () => {
    const { manager, add } = loadManager();
    const parent = add({ name: "Parent", dependencies: ["Missing"] });
    assert.deepEqual(Array.from(manager.startDependenciesRecursive(parent).failures), ["Missing"]);
    parent.dependencies = ["Middle"];
    add({ name: "Middle", dependencies: ["Parent"], start() { assert.fail("cyclic dependency started"); } });
    assert.deepEqual(Array.from(manager.startDependenciesRecursive(parent).failures), ["Parent"]);
});

test("plugins without lifecycle hooks still reject duplicate starts and stops", () => {
    const { manager, add } = loadManager();
    const plugin = add({ name: "Declarative" });
    assert.equal(manager.startPlugin(plugin), true);
    assert.equal(manager.startPlugin(plugin), false);
    assert.equal(manager.stopPlugin(plugin), true);
    assert.equal(manager.stopPlugin(plugin), false);
});

test("initially disabled plugins receive bound declarative callbacks", () => {
    const { manager, add } = loadManager();
    let receiver: TestPlugin | undefined;
    const plugin = add({ name: "Disabled", onMessageClick() { receiver = this; } });
    manager.initPluginManager();
    plugin.onMessageClick?.call({ name: "Different receiver" });
    assert.equal(receiver, plugin);
});
