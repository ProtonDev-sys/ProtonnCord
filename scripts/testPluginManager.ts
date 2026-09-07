/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface TestPlugin {
    [key: string]: any;
    name: string;
    dependencies?: string[];
    started?: boolean;
    isDependency?: boolean;
    requiresRestart?: boolean;
    commands?: object[];
    chatBarButton?: object;
    chatBarButtonWrapper?: object;
    userProfileBadges?: object[];
    start?(): void;
    stop?(): void;
    onMessageClick?(this: TestPlugin): void;
    flux?: Record<string, (this: TestPlugin, data: unknown) => void | Promise<void>>;
}

const compiledModules = new Map<string, string>();

function loadManager({ realCommands = false } = {}) {
    const plugins: Record<string, TestPlugin> = {};
    const manifest: Record<string, any> = {};
    const settings: Record<string, { enabled: boolean; }> = {};
    const errors: unknown[][] = [];
    const operations: string[] = [];
    const failures = new Set<string>();
    const registrations = new Map<string, Map<unknown, unknown[]>>();
    const settingsListeners = new Map<string, ((...args: any[]) => void)[]>();
    let registeredCommands: Record<string, any> = {};
    const handlers = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
    const dispatcher = {
        subscribe(event: string, handler: (data: unknown) => void | Promise<void>) {
            if (failures.has(`subscribe:${event}`)) throw new Error(`Cannot subscribe to ${event}`);
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event)?.add(handler);
        },
        unsubscribe(event: string, handler: (data: unknown) => void | Promise<void>) {
            assert.ok(handlers.get(event)?.delete(handler), "unsubscribe must use the registered function");
            if (failures.has(`unsubscribe:${event}`)) throw new Error(`Cannot unsubscribe from ${event}`);
        }
    };
    const mocks: Record<string, object> = {
        "~plugins": { __esModule: true, default: plugins, PluginManifest: manifest },
        "@api/Settings": { Settings: { plugins: settings }, PlainSettings: { plugins: settings }, SettingsStore: {
            addChangeListener(path: string, listener: (...args: any[]) => void) {
                if (!settingsListeners.has(path)) settingsListeners.set(path, []);
                settingsListeners.get(path)!.push(listener);
            }
        } },
        "@webpack/common": { FluxDispatcher: dispatcher },
        "@debug/Tracer": { traceFunction: (_name: string, fn: unknown) => fn },
        "@utils/onlyOnce": { onlyOnce: (fn: unknown) => fn },
        "@utils/text": { makeCodeblock: (text: string) => text },
        "./commandHelpers": { sendBotMessage() { assert.fail("lifecycle tests must not send messages"); } },
        "@utils/types": {
            StartAt: { Init: "Init", DOMContentLoaded: "DOMContentLoaded", WebpackReady: "WebpackReady" },
            ReporterTestable: { Start: 4, Patches: 8, FluxEvents: 16 }
        },
        "@api/Commands": {
            commands: registeredCommands,
            registerCommand(command: any) {
                operations.push("registerCommand");
                if (registeredCommands[command.name]) throw new Error("Command already exists");
                registeredCommands[command.name] = command;
                if (failures.has("registerCommand")) throw new Error("Subcommand failed after adding its parent");
            },
            unregisterCommand(name: string) {
                operations.push("unregisterCommand");
                delete registeredCommands[name];
                if (failures.has("unregisterCommand")) throw new Error("Cannot unregister command");
            }
        },
        "@utils/Logger": { Logger: class {
            info() {}
            warn() {}
            debug() {}
            error(...args: unknown[]) { errors.push(args); }
        } }
    };
    for (const [api, addName, removeName] of [
        ["AudioPlayer", "addAudioProcessor", "removeAudioProcessor"],
        ["Badges", "addProfileBadge", "removeProfileBadge"],
        ["ChatButtons", "addChatBarButton", "removeChatBarButton"],
        ["ChatButtons", "addChatBarButtonWrapper", "removeChatBarButtonWrapper"],
        ["ContextMenu", "addContextMenuPatch", "removeContextMenuPatch"],
        ["GifPickerContextMenu", "addGifPickerContextMenuPatch", "removeGifPickerContextMenuPatch"],
        ["HeaderBar", "addHeaderBarButton", "removeHeaderBarButton"],
        ["HeaderBar", "addChannelToolbarButton", "removeChannelToolbarButton"],
        ["MemberListDecorators", "addMemberListDecorator", "removeMemberListDecorator"],
        ["MessageAccessories", "addMessageAccessory", "removeMessageAccessory"],
        ["MessageDecorations", "addMessageDecoration", "removeMessageDecoration"],
        ["MessageEvents", "addMessageClickListener", "removeMessageClickListener"],
        ["MessageEvents", "addMessagePreEditListener", "removeMessagePreEditListener"],
        ["MessageEvents", "addMessagePreSendListener", "removeMessagePreSendListener"],
        ["MessagePopover", "addMessagePopoverButton", "removeMessagePopoverButton"],
        ["NicknameIcons", "addNicknameIcon", "removeNicknameIcon"],
        ["ProfileCollections", "addProfileCollection", "removeProfileCollection"],
        ["ProfileSections", "addProfileSection", "removeProfileSection"],
        ["Styles", "enableStyle", "disableStyle"],
        ["UserArea", "addUserAreaButton", "removeUserAreaButton"]
    ]) {
        const values = new Map<unknown, unknown[]>();
        registrations.set(addName, values);
        Object.assign(mocks[`@api/${api}`] ??= {}, {
            [addName](...args: unknown[]) {
                operations.push(addName);
                if (failures.has(addName)) throw new Error(`Cannot ${addName}`);
                values.set(args[0], args);
            },
            [removeName](...args: unknown[]) {
                operations.push(removeName);
                if (args.length > 1) assert.equal(values.get(args[0])?.[1], args[1], "cleanup uses the registered callback");
                assert.ok(values.delete(args[0]), `cleanup must release a registered resource: ${removeName}`);
                if (failures.has(removeName)) throw new Error(`Cannot ${removeName}`);
            }
        });
    }

    const loadedModules = new Map<string, any>();
    function loadModule(file: string): any {
        if (loadedModules.has(file)) return loadedModules.get(file);
        if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
        let code = compiledModules.get(file);
        if (!code) {
            code = transpileModule(readFileSync(file, "utf8"), {
                compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
            }).outputText;
            compiledModules.set(file, code);
        }
        const exports = {};
        loadedModules.set(file, exports);
        return runInNewContext(code + "\nexports;", {
            exports, Promise, IS_REPORTER: false, IS_DEV: false,
            require(name: string) {
                if (name in mocks) return mocks[name];
                if (name.startsWith("./")) return loadModule(resolve(dirname(file), name + (extname(name) ? "" : ".ts")));
                if (name === "@shared/pluginDefinition") return loadModule(resolve("src/shared/pluginDefinition.ts"));
                if (name === "@utils/patches" || name === "@webpack/patcher") return {};
                throw new Error(`Unexpected import ${name}`);
            }
        });
    }
    const definitionApi = loadModule(resolve("src/shared/pluginDefinition.ts"));
    if (realCommands) {
        mocks["@vencord/discord-types/enums"] = loadModule(resolve("packages/discord-types/enums/commands.ts"));
        const api = loadModule(resolve("src/api/Commands/index.ts"));
        api._init([
            { name: "shrug", id: "-1", options: [{ name: "message" }] },
            { name: "me", id: "-2", options: [{ name: "message" }] }
        ]);
        mocks["@api/Commands"] = api;
        registeredCommands = api.commands;
    }
    const manager = loadModule(resolve("src/api/PluginManager.ts"));
    function add(plugin: TestPlugin) {
        plugins[plugin.name] = plugin;
        settings[plugin.name] = { enabled: false };
        definitionApi.registerPluginDefinition(plugin);
        manifest[plugin.name] = definitionApi.describePlugin(plugin);
        return plugin;
    }
    function defer(plugin: TestPlugin) {
        let loads = 0;
        Object.defineProperty(plugins, plugin.name, {
            enumerable: true,
            configurable: true,
            get() {
                loads++;
                definitionApi.registerPluginDefinition(plugin);
                Object.defineProperty(plugins, plugin.name, { enumerable: true, configurable: true, writable: true, value: plugin });
                return plugin;
            }
        });
        settings[plugin.name] = { enabled: false };
        manifest[plugin.name] = { ...definitionApi.describePlugin(plugin), eager: false };
        return { plugin, get loads() { return loads; } };
    }
    function resourceCount() {
        return Object.keys(registeredCommands).length
            + Array.from(registrations.values()).reduce((sum, entries) => sum + entries.size, 0)
            + Array.from(handlers.values()).reduce((sum, entries) => sum + entries.size, 0);
    }
    return { manager, add, defer, plugins, manifest, definitionApi, settings, settingsListeners, dispatcher, handlers, errors, operations, failures, registrations, registeredCommands, resourceCount, commandApi: mocks["@api/Commands"] as any };
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

test("disabled deferred definitions stay unloaded through boot stages and diagnostics", () => {
    const { manager, add, defer, settings, dispatcher } = loadManager();
    const starts: string[] = [];
    const disabled = defer({ name: "Disabled", start() { assert.fail("disabled plugin started"); } });
    const dependency = defer({ name: "Dependency", start() { starts.push("Dependency"); } });
    defer({ name: "Enabled", dependencies: ["Dependency"], start() { starts.push("Enabled"); } });
    add({ name: "EagerDisabled" });
    settings.Enabled.enabled = true;
    manager.initPluginManager();
    manager.subscribeAllPluginsFluxEvents(dispatcher);
    for (const stage of ["Init", "DOMContentLoaded", "WebpackReady"]) manager.startAllPlugins(stage);
    assert.equal(disabled.loads, 0);
    assert.equal(dependency.loads, 1);
    assert.equal(settings.Dependency.enabled, true);
    assert.deepEqual(starts, ["Dependency", "Enabled"]);
    const status = manager.getPluginRuntimeStatus();
    assert.deepEqual(Array.from(status.loaded), ["Dependency", "EagerDisabled", "Enabled"]);
    assert.deepEqual(Array.from(status.started), ["Dependency", "Enabled"]);
    assert.equal(status.catalogCount, 4);
    assert.equal(disabled.loads, 0, "status enumeration must not load disabled definitions");
});

test("enabled checks use metadata defaults without constructing disabled settings namespaces", () => {
    const { manager, defer, settings } = loadManager();
    const plugin = defer({ name: "Default", enabledByDefault: true });
    assert.equal(manager.isPluginEnabled("Default"), false, "an existing disabled setting overrides the default");
    delete settings.Default;
    assert.equal(manager.isPluginEnabled("Default"), true);
    assert.equal(settings.Default, undefined);
    const required = defer({ name: "Required", required: true });
    assert.equal(manager.isPluginEnabled("Required"), true);
    assert.equal(manager.isPluginRequired("Required"), true);
    assert.equal(manager.isPluginEnabled("Missing"), false);
    assert.equal(plugin.loads, 0);
    assert.equal(required.loads, 0);
});

test("late definitions and direct imports receive one method binding and settings listener", () => {
    const { manager, defer, plugins, definitionApi, settingsListeners } = loadManager();
    let receiver: TestPlugin | undefined;
    const changed = () => {};
    const deferred = defer({ name: "Late", onMessageClick() { receiver = this; }, settings: { pluginName: "", def: { value: { onChange: changed } } } });
    const original = deferred.plugin.onMessageClick;
    manager.initPluginManager();
    assert.equal(deferred.loads, 0);
    assert.equal(settingsListeners.size, 0);
    const direct = definitionApi.registerPluginDefinition(deferred.plugin);
    const bound = direct.onMessageClick;
    assert.notEqual(bound, original);
    bound.call({ name: "Different receiver" });
    assert.equal(receiver, direct);
    assert.equal(plugins.Late, direct);
    definitionApi.registerPluginDefinition(direct);
    assert.equal(direct.onMessageClick, bound);
    assert.equal(direct.settings.pluginName, "Late");
    assert.deepEqual(settingsListeners.get("plugins.Late.value"), [changed]);
});

test("settings callbacks are bound after the initial dependency closure is enabled", () => {
    const { manager, add, settings, settingsListeners } = loadManager();
    const notified: boolean[] = [];
    add({ name: "Dependency", settings: { def: { enabled: { onChange(value: boolean) { notified.push(value); } } } } });
    add({ name: "Enabled", dependencies: ["Dependency"] });
    settings.Enabled.enabled = true;
    let value = false;
    Object.defineProperty(settings.Dependency, "enabled", {
        get: () => value,
        set(next: boolean) {
            value = next;
            for (const listener of settingsListeners.get("plugins.Dependency.enabled") ?? []) listener(next);
        }
    });
    manager.initPluginManager();
    assert.equal(settings.Dependency.enabled, true);
    assert.equal(notified.length, 0, "dependency bootstrap historically precedes settings listeners");
    settings.Dependency.enabled = false;
    assert.deepEqual(notified, [false]);
});

test("runtime diagnostics return detached loaded, started and failed snapshots and clear failures on retry", async () => {
    const { manager, add, defer } = loadManager();
    const disabled = defer({ name: "Disabled" });
    const healthy = add({ name: "Healthy" });
    const failing = add({ name: "Failing", start() { throw new Error("start failed"); } });
    assert.equal(manager.startPlugin(healthy), true);
    assert.equal(manager.startPlugin(failing), false);
    const status = manager.getPluginRuntimeStatus();
    assert.deepEqual(Array.from(status.loaded), ["Failing", "Healthy"]);
    assert.deepEqual(Array.from(status.started), ["Healthy"]);
    assert.deepEqual(Array.from(status.failed), ["Failing"]);
    status.loaded.length = status.started.length = status.failed.length = 0;
    status.catalogCount = 0;
    const current = manager.getPluginRuntimeStatus();
    assert.equal(current.catalogCount, 3);
    assert.deepEqual(Array.from(current.started), ["Healthy"]);
    assert.deepEqual(Array.from(current.failed), ["Failing"]);
    failing.start = async () => { throw new Error("async start failed"); };
    assert.equal(manager.startPlugin(failing), true);
    assert.equal(manager.getPluginRuntimeStatus().failed.length, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(Array.from(manager.getPluginRuntimeStatus().failed), ["Failing"]);
    failing.start = () => {};
    assert.equal(manager.startPlugin(failing), true);
    assert.equal(manager.getPluginRuntimeStatus().failed.length, 0);
    assert.equal(manager.stopPlugin(failing), true);
    assert.equal(manager.stopPlugin(healthy), true);
    assert.equal(manager.getPluginRuntimeStatus().started.length, 0);
    assert.equal(disabled.loads, 0);
});

test("initial dependency closure includes inferred APIs regardless of plugin order", () => {
    for (const reverse of [false, true]) {
        const { manager, add, plugins, settings } = loadManager();
        const definitions: TestPlugin[] = [
            { name: "Transport" },
            { name: "CommandsAPI", dependencies: ["Transport"] },
            { name: "Leaf", commands: [{}] },
            { name: "Middle", dependencies: ["Leaf"] },
            { name: "Root", dependencies: ["Middle", "Middle"] },
            { name: "Unrelated", dependencies: ["Missing"] }
        ];
        for (const definition of reverse ? definitions.reverse() : definitions) add(definition);
        settings.Root.enabled = true;
        manager.initPluginManager();
        for (const name of ["Middle", "Leaf", "CommandsAPI", "Transport"]) {
            assert.equal(settings[name].enabled, true, name);
            assert.equal(plugins[name].isDependency, true, name);
        }
        assert.deepEqual(Array.from(plugins.Root.dependencies ?? []), ["Middle"]);
        assert.equal(settings.Unrelated.enabled, false);
    }
});

test("initially disabled plugins retain API dependencies for later enabling", () => {
    const { manager, add, settings } = loadManager();
    const api = add({ name: "ChatInputButtonAPI", requiresRestart: true });
    const plugin = add({ name: "Disabled", chatBarButton: {}, chatBarButtonWrapper: {} });
    manager.initPluginManager();
    assert.equal(settings.ChatInputButtonAPI.enabled, false);
    assert.deepEqual(Array.from(plugin.dependencies ?? []), ["ChatInputButtonAPI"]);
    const result = manager.startDependenciesRecursive(plugin);
    assert.equal(result.restartNeeded, true);
    assert.equal(result.failures.length, 0);
    assert.equal(api.isDependency, true);
    assert.equal(settings.ChatInputButtonAPI.enabled, true);
});

test("initial dependency traversal terminates cycles and continues past missing dependencies", () => {
    const { manager, add, settings } = loadManager();
    add({ name: "First", dependencies: ["Missing", "Second"] });
    add({ name: "Second", dependencies: ["First", "Third"] });
    add({ name: "Third" });
    settings.First.enabled = true;
    manager.initPluginManager();
    assert.equal(settings.Second.enabled, true);
    assert.equal(settings.Third.enabled, true);
});

test("API plugins may use their own declarations without gaining an inferred self dependency", () => {
    const { manager, add, settings } = loadManager();
    const badgeApi = add({ name: "BadgeAPI", userProfileBadges: [{}] });
    add({ name: "Consumer", dependencies: ["BadgeAPI"] });
    settings.Consumer.enabled = true;
    manager.initPluginManager();
    assert.equal(badgeApi.dependencies?.includes("BadgeAPI") ?? false, false);
    assert.equal(settings.BadgeAPI.enabled, true);
});

function pluginWithContributions(): TestPlugin {
    const callback = () => null;
    const button = { render: callback, icon: callback, priority: 3 };
    return {
        name: "Contributions",
        commands: [{ name: "fixture-command" }],
        contextMenus: { "fixture-menu": callback },
        managedStyle: "fixture-style",
        userProfileBadges: [{}],
        onBeforeMessageEdit: callback,
        onBeforeMessageSend: callback,
        onMessageClick: callback,
        chatBarButton: button,
        renderMemberListDecorator: callback,
        renderMessageAccessory: callback,
        renderMessageDecoration: callback,
        messagePopoverButton: button,
        renderNicknameIcon: callback,
        headerBarButton: { ...button, location: "headerbar" },
        audioProcessor: callback,
        userAreaButton: button,
        renderProfileCollection: button,
        chatBarButtonWrapper: { wrapper: callback, priority: 2 },
        renderProfileSection: button,
        gifPickerContextMenu: callback,
        flux: { TEST() {} }
    };
}

test("every declarative surface rolls back earlier registrations on failure and allows a clean retry", () => {
    const apiNames = loadManager().registrations.keys();
    for (const apiName of apiNames) {
        const { manager, add, dispatcher, failures, resourceCount, errors } = loadManager();
        let stops = 0;
        const plugin = add({ ...pluginWithContributions(), stop() { stops++; } });
        if (apiName === "addChannelToolbarButton") plugin.headerBarButton.location = "channeltoolbar";
        manager.subscribeAllPluginsFluxEvents(dispatcher);
        failures.add(apiName);

        assert.equal(manager.startPlugin(plugin), false, apiName);
        assert.equal(plugin.started, false, apiName);
        assert.equal(stops, 1, apiName);
        assert.equal(resourceCount(), 0, `${apiName} must release all prior registrations`);
        assert.equal(errors.length, 1, `${apiName} should report its failure once`);

        failures.clear();
        assert.equal(manager.startPlugin(plugin), true, apiName);
        assert.ok(resourceCount() > 20, "retry should register the entire plugin");
        assert.equal(manager.stopPlugin(plugin), true, apiName);
        assert.equal(resourceCount(), 0, `${apiName} retry must stop cleanly`);
        assert.equal(stops, 2, apiName);
    }
});

test("failed starts release boot-time flux subscriptions and call the stop hook for partial plugin work", () => {
    const { manager, add, settings, dispatcher, resourceCount, errors } = loadManager();
    let stops = 0;
    const plugin = add({
        ...pluginWithContributions(),
        start() { throw new Error("partially started"); },
        stop() { stops++; }
    });
    settings[plugin.name].enabled = true;
    manager.subscribeAllPluginsFluxEvents(dispatcher);
    assert.equal(resourceCount(), 1, "enabled plugins must receive initial Flux events before start");
    assert.equal(manager.startPlugin(plugin), false);
    assert.equal(resourceCount(), 0);
    assert.equal(plugin.started, false);
    assert.equal(stops, 1);
    assert.equal(errors.length, 1);
});

test("command collisions preserve the existing owner while undoing earlier commands", () => {
    const { manager, add, registeredCommands, resourceCount } = loadManager();
    const existing = { name: "existing" };
    registeredCommands.existing = existing;
    const plugin = add({ name: "Collision", commands: [{ name: "earlier" }, { name: "existing" }] });
    assert.equal(manager.startPlugin(plugin), false);
    assert.equal(plugin.started, false);
    assert.equal(resourceCount(), 1);
    assert.deepEqual(Object.values(registeredCommands), [existing]);
});

test("command registration that fails after adding its parent is rolled back", () => {
    const { manager, add, failures, resourceCount } = loadManager();
    const plugin = add({ name: "PartialCommand", commands: [{ name: "parent" }] });
    failures.add("registerCommand");
    assert.equal(manager.startPlugin(plugin), false);
    assert.equal(resourceCount(), 0);
    failures.clear();
    assert.equal(manager.startPlugin(plugin), true);
    assert.equal(manager.stopPlugin(plugin), true);
    assert.equal(resourceCount(), 0);
});

test("real CommandsAPI rolls back an invalid subcommand group and its earlier subcommands", () => {
    const { manager, add, commandApi, resourceCount } = loadManager({ realCommands: true });
    const originalCommands = [...commandApi.BUILT_IN];
    const plugin = add({
        name: "Subcommands",
        commands: [{
            name: "group", description: "Fixture group", execute() {},
            options: [
                { name: "first", description: "Valid subcommand", type: 1 },
                { name: "invalid", description: "Invalid group member", type: 3 }
            ]
        }]
    });
    assert.equal(manager.startPlugin(plugin), false);
    assert.equal(plugin.started, false);
    assert.equal(resourceCount(), 0);
    assert.deepEqual(Array.from(commandApi.BUILT_IN), originalCommands);
});

test("real CommandsAPI subcommand collisions preserve commands belonging to another plugin", () => {
    const { manager, add, commandApi, registeredCommands, resourceCount } = loadManager({ realCommands: true });
    const owner = add({ name: "Owner", commands: [{ name: "group collision", description: "Existing command", execute() {} }] });
    assert.equal(manager.startPlugin(owner), true);
    const originalCommands = [...commandApi.BUILT_IN];
    const plugin = add({
        name: "Collision",
        commands: [{
            name: "group", description: "Fixture group", execute() {},
            options: [
                { name: "first", description: "Valid subcommand", type: 1 },
                { name: "collision", description: "Conflicting subcommand", type: 1 }
            ]
        }]
    });
    assert.equal(manager.startPlugin(plugin), false);
    assert.deepEqual(Array.from(commandApi.BUILT_IN), originalCommands);
    assert.deepEqual(Object.values(registeredCommands), owner.commands);
    assert.equal(manager.stopPlugin(owner), true);
    assert.equal(resourceCount(), 0);
});

test("a throwing stop hook still releases every managed resource and permits restarting", () => {
    const { manager, add, dispatcher, resourceCount, errors } = loadManager();
    const plugin = add({ ...pluginWithContributions(), stop() { throw new Error("stop failed"); } });
    manager.subscribeAllPluginsFluxEvents(dispatcher);
    assert.equal(manager.startPlugin(plugin), true);
    assert.equal(manager.stopPlugin(plugin), false);
    assert.equal(resourceCount(), 0);
    assert.equal(plugin.started, false);
    assert.equal(errors.length, 1);
    plugin.stop = () => {};
    assert.equal(manager.startPlugin(plugin), true);
    assert.equal(manager.stopPlugin(plugin), true);
    assert.equal(resourceCount(), 0);
});

test("cleanup errors do not skip other resources or leave the plugin marked started", () => {
    const { manager, add, dispatcher, failures, operations, resourceCount, errors } = loadManager();
    const plugin = add(pluginWithContributions());
    manager.subscribeAllPluginsFluxEvents(dispatcher);
    assert.equal(manager.startPlugin(plugin), true);
    failures.add("removeMessageAccessory");
    failures.add("unregisterCommand");
    failures.add("unsubscribe:TEST");
    assert.equal(manager.stopPlugin(plugin), false);
    assert.equal(resourceCount(), 0);
    assert.equal(plugin.started, false);
    assert.equal(errors.length, 3);
    const completedOperations = operations.length;
    assert.equal(manager.stopPlugin(plugin), false);
    assert.equal(operations.length, completedOperations, "a second stop must not repeat cleanup");
});

test("stop releases the originally registered callbacks and names after plugin declarations change", () => {
    const { manager, add, dispatcher, resourceCount, errors } = loadManager();
    const plugin = add(pluginWithContributions());
    manager.subscribeAllPluginsFluxEvents(dispatcher);
    assert.equal(manager.startPlugin(plugin), true);
    plugin.commands = [{ name: "replacement-command" }];
    plugin.contextMenus["fixture-menu"] = () => {};
    plugin.managedStyle = "other-style";
    plugin.userProfileBadges = [];
    plugin.onMessageClick = () => {};
    plugin.headerBarButton.location = "channeltoolbar";
    plugin.flux = {};
    assert.equal(manager.stopPlugin(plugin), true);
    assert.equal(resourceCount(), 0);
    assert.equal(errors.length, 0);
});

test("repeated full plugin start and stop cycles retain no commands, surfaces, or Flux listeners", () => {
    const { manager, add, dispatcher, resourceCount, errors } = loadManager();
    const plugin = add(pluginWithContributions());
    manager.subscribeAllPluginsFluxEvents(dispatcher);
    for (let i = 0; i < 100; i++) {
        assert.equal(manager.startPlugin(plugin), true);
        assert.equal(manager.startPlugin(plugin), false);
        assert.equal(manager.stopPlugin(plugin), true);
        assert.equal(resourceCount(), 0, `cycle ${i}`);
    }
    assert.equal(errors.length, 0);
});

test("a rejected async start releases its current run without changing the synchronous API", async () => {
    const { manager, add, dispatcher, resourceCount, errors } = loadManager();
    let stops = 0;
    const plugin = add({
        ...pluginWithContributions(),
        async start() { throw new Error("async start failed"); },
        stop() { stops++; }
    });
    manager.subscribeAllPluginsFluxEvents(dispatcher);
    assert.equal(manager.startPlugin(plugin), true);
    assert.equal(plugin.started, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(plugin.started, false);
    assert.equal(resourceCount(), 0);
    assert.equal(stops, 1);
    assert.equal(errors.length, 1);
});

test("a late start rejection cannot stop a newer run of the same plugin", async () => {
    const { manager, add, dispatcher, resourceCount, errors } = loadManager();
    let rejectStart!: (reason: Error) => void;
    let stops = 0;
    const pendingStart = new Promise<void>((_, reject) => { rejectStart = reject; });
    const plugin = add({
        ...pluginWithContributions(),
        start: () => pendingStart,
        stop() { stops++; }
    });
    manager.subscribeAllPluginsFluxEvents(dispatcher);
    assert.equal(manager.startPlugin(plugin), true);
    assert.equal(manager.stopPlugin(plugin), true);
    plugin.start = () => {};
    assert.equal(manager.startPlugin(plugin), true);
    const resourcesInNewRun = resourceCount();
    rejectStart(new Error("earlier start failed"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(plugin.started, true);
    assert.equal(stops, 1);
    assert.equal(resourceCount(), resourcesInNewRun);
    assert.equal(errors.length, 1);
    assert.equal(manager.stopPlugin(plugin), true);
    assert.equal(resourceCount(), 0);
});

test("async stop rejections are reported and do not strand managed resources", async () => {
    const { manager, add, dispatcher, resourceCount, errors } = loadManager();
    const plugin = add({ ...pluginWithContributions(), async stop() { throw new Error("async stop failed"); } });
    manager.subscribeAllPluginsFluxEvents(dispatcher);
    assert.equal(manager.startPlugin(plugin), true);
    assert.equal(manager.stopPlugin(plugin), true);
    assert.equal(resourceCount(), 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 1);
});

test("reentrant start and stop calls cannot run a lifecycle twice", () => {
    const { manager, add, resourceCount } = loadManager();
    let starts = 0;
    let stops = 0;
    const plugin = add({
        ...pluginWithContributions(),
        start() {
            starts++;
            assert.equal(manager.startPlugin(plugin), false);
        },
        stop() {
            stops++;
            assert.equal(manager.stopPlugin(plugin), false);
            assert.equal(manager.startPlugin(plugin), false);
        }
    });
    assert.equal(manager.startPlugin(plugin), true);
    assert.equal(manager.stopPlugin(plugin), true);
    assert.equal(resourceCount(), 0);
    assert.equal(starts, 1);
    assert.equal(stops, 1);
});

test("partial Flux subscription failure rolls back and does not block other enabled plugins", () => {
    const { manager, add, settings, dispatcher, failures, handlers, errors, resourceCount } = loadManager();
    const failing = add({ name: "Failing", flux: { FIRST() {}, SECOND() {} } });
    const healthy = add({ name: "Healthy", flux: { THIRD() {} } });
    settings.Failing.enabled = settings.Healthy.enabled = true;
    failures.add("subscribe:SECOND");
    manager.subscribeAllPluginsFluxEvents(dispatcher);
    assert.equal(handlers.get("FIRST")?.size, 0);
    assert.equal(handlers.get("THIRD")?.size, 1);
    assert.equal(errors.length, 1);
    failures.clear();
    manager.subscribePluginFluxEvents(failing, dispatcher);
    assert.equal(resourceCount(), 3);
    manager.unsubscribePluginFluxEvents(failing, dispatcher);
    manager.unsubscribePluginFluxEvents(healthy, dispatcher);
    assert.equal(resourceCount(), 0);
});

test("Flux cleanup retains the original dispatcher even if the caller passes another instance", () => {
    const { manager, add, dispatcher, resourceCount } = loadManager();
    const plugin = add({ name: "Dispatcher", flux: { TEST() {} } });
    manager.subscribePluginFluxEvents(plugin, dispatcher);
    manager.unsubscribePluginFluxEvents(plugin, { unsubscribe() { assert.fail("wrong dispatcher"); } });
    assert.equal(resourceCount(), 0);
});

test("plugin start stages and enabled checks retain their public behavior", () => {
    const { manager, add, settings } = loadManager();
    const starts: string[] = [];
    add({ name: "Default", start() { starts.push("Default"); } });
    add({ name: "Early", startAt: "Init", start() { starts.push("Early"); } });
    add({ name: "Dom", startAt: "DOMContentLoaded", start() { starts.push("Dom"); } });
    add({ name: "Disabled", start() { assert.fail("disabled plugin started"); } });
    for (const name of ["Default", "Early", "Dom"]) settings[name].enabled = true;
    manager.startAllPlugins("Init");
    assert.deepEqual(starts, ["Early"]);
    manager.startAllPlugins("DOMContentLoaded");
    assert.deepEqual(starts, ["Early", "Dom"]);
    manager.startAllPlugins("WebpackReady");
    assert.deepEqual(starts, ["Early", "Dom", "Default"]);
});
