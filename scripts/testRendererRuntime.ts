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

import { createRendererRuntime, type RuntimeOptions, scheduleIdleTask } from "../src/runtime/bootstrap";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function runtimeFixture(domReady = false, configure?: (options: RuntimeOptions, calls: string[]) => void) {
    const ready = deferred();
    const calls: string[] = [];
    const failures: string[] = [];
    const dom = new Set<() => void>();
    const hide = new Set<() => void>();
    const idle = new Set<() => void>();
    let time = 0;
    const options: RuntimeOptions = {
        host: {
            now: () => time++,
            isDomReady: () => domReady,
            onDomReady(callback) { dom.add(callback); return () => { dom.delete(callback); }; },
            onPageHide(callback) { hide.add(callback); return () => { hide.delete(callback); }; },
            defer(callback) { idle.add(callback); return () => { idle.delete(callback); }; },
        },
        ready: ready.promise,
        initializePlugins: () => { calls.push("manager"); },
        initializeStyles: () => { calls.push("styles"); },
        startPlugins: stage => { calls.push(stage); },
        onDomReady: () => { calls.push("domStyles"); },
        services: ["cloud", "updates"].map(name => ({
            name,
            start() {
                calls.push(`${name}:setup`);
                return { dispose: () => { calls.push(`${name}:dispose`); }, runInitial: () => { calls.push(name); } };
            },
        })),
        onError: stage => { failures.push(stage); },
    };
    configure?.(options, calls);
    const runtime = createRendererRuntime(options);
    return {
        runtime, ready, calls, failures, dom, hide, idle,
        fireDom() { for (const callback of [...dom]) callback(); },
        fireHide() { for (const callback of [...hide]) callback(); },
        runIdle() { for (const callback of [...idle]) { idle.delete(callback); callback(); } },
    };
}

test("bootstrap runs stages once and defers optional initial work until after readiness", async () => {
    const f = runtimeFixture();
    f.runtime.start();
    f.runtime.start();
    assert.deepEqual(f.calls, ["manager", "styles", "Init"]);
    f.fireDom();
    f.fireDom();
    assert.deepEqual(f.calls.slice(3), ["DOMContentLoaded", "domStyles"]);
    f.ready.resolve();
    await settle();
    assert.deepEqual(f.calls.slice(5), ["WebpackReady", "cloud:setup", "updates:setup"]);
    assert.equal(f.idle.size, 2);
    f.runIdle();
    assert.deepEqual(f.calls.slice(-2), ["cloud", "updates"]);
    assert.equal(f.runtime.getStatus().stages.every(stage => stage.phase === "complete"), true);
});

test("late document readiness runs DOM plugins without waiting for an event that already happened", async () => {
    const f = runtimeFixture(true);
    f.runtime.start();
    assert.deepEqual(f.calls, ["manager", "styles", "Init", "DOMContentLoaded", "domStyles"]);
    assert.equal(f.dom.size, 0);
    f.ready.resolve();
    await settle();
    assert.equal(f.calls[5], "WebpackReady");
});

test("WebpackReady and DOMContentLoaded retain their independent event ordering", async () => {
    const f = runtimeFixture();
    f.runtime.start();
    f.ready.resolve();
    await settle();
    assert.ok(f.calls.includes("WebpackReady"));
    assert.equal(f.calls.includes("DOMContentLoaded"), false);
    f.fireDom();
    assert.ok(f.calls.indexOf("DOMContentLoaded") > f.calls.indexOf("WebpackReady"));
});

test("pagehide before readiness cancels listeners and prevents later startup", async () => {
    const f = runtimeFixture();
    f.runtime.start();
    f.fireHide();
    f.ready.resolve();
    await settle();
    f.fireDom();
    f.runtime.start();
    assert.deepEqual(f.calls, ["manager", "styles", "Init"]);
    assert.equal(f.dom.size + f.hide.size + f.idle.size, 0);
    assert.equal(f.runtime.getStatus().disposed, true);
});

test("pagehide cancels pending services and releases setup resources once in reverse order", async () => {
    const f = runtimeFixture();
    f.runtime.start();
    f.ready.resolve();
    await settle();
    f.fireHide();
    f.runtime.dispose();
    f.runIdle();
    assert.deepEqual(f.calls.slice(-2), ["updates:dispose", "cloud:dispose"]);
    assert.equal(f.calls.includes("cloud"), false);
    assert.equal(f.calls.includes("updates"), false);
    assert.equal(f.idle.size, 0);
    assert.equal(f.runtime.getStatus().stages.find(stage => stage.name === "cloud")?.phase, "cancelled");
});

test("service setup, async work, and cleanup failures remain isolated and status contains no raw errors", async () => {
    const f = runtimeFixture(false, (options, calls) => {
        options.services = [
            { name: "setupFailure", start() { throw new Error("SECRET_setup"); } },
            { name: "asyncFailure", start() { return {
                runInitial: async () => { throw new Error("SECRET_async"); },
                dispose() { throw new Error("SECRET_dispose"); },
            }; } },
            { name: "healthy", start() { return {
                runInitial: () => { calls.push("healthy"); },
                dispose: () => { calls.push("healthy:dispose"); },
            }; } },
        ];
    });
    f.runtime.start();
    f.ready.resolve();
    await settle();
    f.runIdle();
    await settle();
    assert.ok(f.calls.includes("healthy"));
    assert.deepEqual(f.failures, ["setupFailure:setup", "asyncFailure"]);
    f.fireHide();
    assert.ok(f.calls.includes("healthy:dispose"));
    assert.equal(f.dom.size + f.hide.size, 0);
    assert.doesNotMatch(JSON.stringify(f.runtime.getStatus()), /SECRET/u);
    assert.equal(f.runtime.getStatus().stages.find(stage => stage.name === "asyncFailure")?.errors, 1);
});

test("runtime status is a frozen detached snapshot and late completion cannot reactivate disposal", async () => {
    const work = deferred();
    const f = runtimeFixture(false, options => {
        options.services = [{ name: "pending", start: () => ({ dispose() {}, runInitial: () => work.promise }) }];
    });
    f.runtime.start();
    f.ready.resolve();
    await settle();
    f.runIdle();
    const snapshot = f.runtime.getStatus();
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.stages) && snapshot.stages.every(Object.isFrozen));
    f.fireHide();
    work.resolve();
    await settle();
    assert.equal(snapshot.disposed, false);
    assert.equal(f.runtime.getStatus().stages.find(stage => stage.name === "pending")?.phase, "cancelled");
});

test("a rejected readiness promise is observed without running dependent services", async () => {
    const f = runtimeFixture();
    f.runtime.start();
    f.ready.reject(new Error("Ready failed"));
    await settle();
    assert.deepEqual(f.failures, ["WebpackReady"]);
    assert.equal(f.idle.size, 0);
});

test("idle scheduling has a bounded timeout and cancellation suppresses already-queued delivery", () => {
    let task!: () => void;
    let calls = 0;
    let cancelled: number | undefined;
    const scheduler = {
        requestIdleCallback(callback: IdleRequestCallback, options?: IdleRequestOptions) {
            assert.equal(options?.timeout, 2_000);
            task = () => callback({ didTimeout: false, timeRemaining: () => 10 });
            return 0;
        },
        cancelIdleCallback(handle: number) { cancelled = handle; },
        setTimeout: () => assert.fail("Idle API should be used when cancellable"),
        clearTimeout: () => assert.fail(),
    };
    const dispose = scheduleIdleTask(() => calls++, scheduler);
    dispose();
    task();
    dispose();
    assert.equal(cancelled, 0);
    assert.equal(calls, 0);
});

test("idle fallback schedules a cancellable next turn and never delivers twice", () => {
    let task!: () => void;
    let calls = 0;
    const scheduler = {
        setTimeout(callback: TimerHandler, delay?: number) {
            assert.equal(delay, 0);
            task = callback as () => void;
            return 1;
        },
        clearTimeout() {},
    };
    const dispose = scheduleIdleTask(() => calls++, scheduler);
    task();
    task();
    dispose();
    assert.equal(calls, 1);
    const cancelled = scheduleIdleTask(() => calls++, scheduler);
    cancelled();
    task();
    assert.equal(calls, 1);
});

function loadService<T>(name: string, mocks: Record<string, unknown>, globals: Record<string, unknown>): T {
    const path = `src/runtime/${name}.ts`;
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return runInNewContext(code + "\nexports;", {
        exports: {}, ...globals,
        require(name: string) {
            assert.ok(Object.hasOwn(mocks, name), `Unexpected service import: ${name}`);
            return mocks[name];
        },
    });
}

function cloudFixture() {
    const settingListeners = new Set<() => void>();
    const cssListeners = new Set<() => void>();
    const timers = new Map<number, () => void>();
    const notifications: any[] = [];
    const logs: unknown[][] = [];
    const settings = { cloud: { authenticated: true, settingsSync: true } };
    const state = { scope: "https://cloud.example:account-a", dirty: false, marks: 0, pushes: 0, pulls: 0, auth: 0, direction: "both" };
    let timerId = 0;
    let context = async () => ({ scope: state.scope, origin: "https://cloud.example" });
    const module = loadService<typeof import("../src/runtime/cloudSettings")>("cloudSettings", {
        "@api/Notifications": { showNotification: (notification: unknown) => { notifications.push(notification); } },
        "@api/Settings": { Settings: settings, SettingsStore: {
            addGlobalChangeListener: (callback: () => void) => { settingListeners.add(callback); },
            removeGlobalChangeListener: (callback: () => void) => { settingListeners.delete(callback); },
        } },
        "@api/SettingsSync/cloudSetup": {
            getCloudSyncScope: () => state.scope,
            getCloudRequestContext: () => { state.auth++; return context(); },
        },
        "@api/SettingsSync/cloudSync": {
            areLocalSettingsDirty: () => state.dirty,
            markLocalSettingsDirty: () => { state.dirty = true; state.marks++; },
            putCloudSettings: async () => { state.pushes++; return true; },
            getCloudSettings: async () => { state.pulls++; return true; },
            getCloudSyncDirection: () => state.direction,
            shouldCloudSync: (direction: string) => state.direction === "both" || state.direction === direction,
        },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { logs.push(args); } } },
        "@utils/native": { relaunch() {} },
        "@webpack/common": { SettingsRouter: { openUserSettings() {} } },
    }, {
        VencordNative: { quickCss: { addChangeListener(callback: () => void) {
            cssListeners.add(callback);
            return () => cssListeners.delete(callback);
        } } },
        setTimeout(callback: () => void, delay: number) { assert.equal(delay, 60_000); timers.set(++timerId, callback); return timerId; },
        clearTimeout(id: number) { timers.delete(id); },
    });
    return {
        ...module, state, settings, notifications, logs, timers, settingListeners, cssListeners,
        setContext(resolver: typeof context) { context = resolver; },
        change() { for (const callback of settingListeners) callback(); },
        cssChange() { for (const callback of cssListeners) callback(); },
        flush() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    };
}

test("cloud tracks local edits before deferred authorization and debounces pushes", async () => {
    const f = cloudFixture();
    const service = f.createCloudSettingsService();
    assert.equal(f.state.auth, 0);
    f.change();
    f.cssChange();
    assert.equal(f.state.marks, 2);
    assert.equal(f.timers.size, 1);
    await service.runInitial!();
    assert.equal(f.state.pushes, 1);
    assert.equal(f.state.pulls, 0);
    f.flush();
    await settle();
    assert.equal(f.state.pushes, 2);
    service.dispose();
    assert.equal(f.settingListeners.size + f.cssListeners.size, 0);
});

test("cloud disposal clears delayed work and prevents an in-flight authorization from starting a sync", async () => {
    const f = cloudFixture();
    const lookup = deferred<{ scope: string; origin: string; }>();
    f.setContext(() => lookup.promise);
    const service = f.createCloudSettingsService();
    f.change();
    const initial = service.runInitial!();
    service.dispose();
    lookup.resolve({ scope: f.state.scope, origin: "https://cloud.example" });
    await initial;
    f.flush();
    assert.equal(f.state.pushes + f.state.pulls, 0);
    assert.equal(f.timers.size + f.settingListeners.size + f.cssListeners.size, 0);
});

test("cloud account changes discard stale initial contexts and queued pushes", async () => {
    const f = cloudFixture();
    const originalScope = f.state.scope;
    let lookups = 0;
    f.setContext(async () => {
        if (++lookups === 1) {
            f.state.scope = "https://cloud.example:account-b";
            return { scope: originalScope, origin: "https://cloud.example" };
        }
        return { scope: f.state.scope, origin: "https://cloud.example" };
    });
    const service = f.createCloudSettingsService();
    f.change();
    await service.runInitial!();
    f.flush();
    await settle();
    assert.equal(f.state.pushes + f.state.pulls, 0);
    assert.equal(f.settings.cloud.authenticated, true);
    assert.equal(f.notifications.length, 0);
    service.dispose();
});

test("missing cloud authorization disables only the current account and keeps dirty tracking active", async () => {
    const f = cloudFixture();
    f.setContext(async () => { throw new Error("No authorization"); });
    const service = f.createCloudSettingsService();
    await service.runInitial!();
    assert.equal(f.settings.cloud.authenticated, false);
    assert.equal(f.notifications.length, 1);
    f.change();
    assert.equal(f.state.marks, 1);
    f.flush();
    assert.equal(f.state.pushes, 0);
    service.dispose();
});

test("cloud sync preferences preserve pull notifications and manual mode", async () => {
    const f = cloudFixture();
    const service = f.createCloudSettingsService();
    await service.runInitial!();
    assert.equal(f.state.pulls, 1);
    assert.equal(f.notifications.length, 1);
    service.dispose();
    const manual = cloudFixture();
    manual.state.direction = "manual";
    const manualService = manual.createCloudSettingsService();
    await manualService.runInitial!();
    manual.change();
    manual.flush();
    assert.equal(manual.state.pushes + manual.state.pulls, 0);
    manualService.dispose();
});

function updateFixture(flags = { web: false, disabled: false, dev: false }, silent = false) {
    const listeners = { check: new Set<() => Promise<void>>(), repair: new Set<() => Promise<void>>() };
    const intervals = new Set<() => void>();
    const notices: string[] = [];
    const trayStates: boolean[] = [];
    const state = { checks: 0, updates: 0, relaunches: 0, repairSucceeds: true };
    let check = async () => true;
    const settings = { autoUpdate: silent, autoUpdateNotification: !silent, updateBranch: "main" };
    const module = loadService<typeof import("../src/runtime/updates")>("updates", {
        "@api/Notices": { popNotice() {}, showNotice: (message: string) => { notices.push(message); } },
        "@api/Settings": { Settings: settings },
        "@components/settings": { openSettingsTabModal() {}, UpdaterTab: {} },
        "@utils/native": { relaunch: () => { state.relaunches++; } },
        "@utils/updater": {
            checkForUpdates: () => { state.checks++; return check(); },
            isOutdated: false,
            update: async () => { state.updates++; return true; },
            repair: async () => { state.updates++; return state.repairSucceeds; },
            UpdateLogger: { error() {} },
        },
    }, {
        IS_WEB: flags.web, IS_UPDATER_DISABLED: flags.disabled, IS_DEV: flags.dev, IS_DISCORD_DESKTOP: true,
        VencordNative: { tray: {
            onCheckUpdates(callback: () => Promise<void>) { listeners.check.add(callback); return () => listeners.check.delete(callback); },
            onRepair(callback: () => Promise<void>) { listeners.repair.add(callback); return () => listeners.repair.delete(callback); },
            setUpdateState(value: boolean) { trayStates.push(value); },
        } },
        setInterval(callback: () => void, delay: number) { assert.equal(delay, 30 * 60_000); intervals.add(callback); return callback; },
        clearInterval(callback: () => void) { intervals.delete(callback); },
    });
    return { ...module, listeners, intervals, notices, trayStates, state, settings, setCheck(resolver: typeof check) { check = resolver; } };
}

test("updater build flags retain desktop tray support without background checks in dev/web/disabled builds", () => {
    for (const flags of [{ web: true, disabled: false, dev: false }, { web: false, disabled: true, dev: false }]) {
        const f = updateFixture(flags);
        const service = f.createUpdateService();
        assert.equal(service.runInitial, undefined);
        assert.equal(f.listeners.check.size + f.listeners.repair.size, 0);
    }
    const dev = updateFixture({ web: false, disabled: false, dev: true });
    const service = dev.createUpdateService();
    assert.equal(service.runInitial, undefined);
    assert.equal(dev.listeners.check.size + dev.listeners.repair.size, 2);
    service.dispose();
    assert.equal(dev.listeners.check.size + dev.listeners.repair.size, 0);
});

test("silent automatic updates retain periodic checks, tray state, and cleanup", async () => {
    const f = updateFixture(undefined, true);
    const service = f.createUpdateService();
    assert.equal(f.state.checks, 0);
    await service.runInitial!();
    assert.equal(f.state.checks, 1);
    assert.equal(f.state.updates, 1);
    assert.equal(f.intervals.size, 1);
    assert.deepEqual(f.trayStates, [false, true, false]);
    assert.deepEqual(f.notices, []);
    service.dispose();
    assert.equal(f.intervals.size + f.listeners.check.size + f.listeners.repair.size, 0);
});

test("manual tray actions preserve check/repair behavior and disposed async checks cannot notify or update", async () => {
    const f = updateFixture();
    const service = f.createUpdateService();
    await [...f.listeners.check][0]();
    assert.equal(f.notices.length, 1);
    await [...f.listeners.repair][0]();
    assert.equal(f.state.relaunches, 1);
    const check = deferred<boolean>();
    f.setCheck(() => check.promise);
    const initial = service.runInitial!();
    service.dispose();
    check.resolve(true);
    await initial;
    assert.equal(f.notices.length, 1);
    assert.equal(f.state.updates, 1);
});

test("the public entry retains first plugin import and exposes only frozen runtime diagnostics", () => {
    const source = ts.createSourceFile("src/Vencord.ts", readFileSync("src/Vencord.ts", "utf8"), ts.ScriptTarget.Latest);
    const firstImport = source.statements.find(ts.isImportDeclaration);
    assert.equal(firstImport?.moduleSpecifier.getText(source), '"~plugins"');
    assert.match(source.text, /export const Runtime = Object\.freeze\(\{ getRuntimeStatus \}\)/u);
    assert.match(source.text, /startRenderer\(\);/u);
});

test("updater drops stale branch notices and repair only restarts after success", async () => {
    const f = updateFixture(undefined, true);
    const check = deferred<boolean>();
    f.setCheck(() => check.promise);
    const service = f.createUpdateService();
    const initial = service.runInitial!();
    f.settings.updateBranch = "nightly";
    check.resolve(true);
    await initial;
    assert.equal(f.state.updates, 0);
    assert.equal(f.notices.length, 0);
    assert.deepEqual(f.trayStates, [false]);
    f.state.repairSucceeds = false;
    await [...f.listeners.repair][0]();
    assert.equal(f.state.relaunches, 0);
    service.dispose();
});
