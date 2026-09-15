/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function loadSupportHelper() {
    const check = deferred<boolean>();
    const restart = deferred<void>();
    const modals: unknown[] = [];
    const state = { channelId: "support", userId: "self", updates: 0, restarts: 0 };
    const settings = { store: {}, withPrivateSettings() { return this; } };
    const mocks: Record<string, object> = {
        "@api/UserSettings": { getUserSettingLazy: () => ({ getSetting: () => true }) },
        "@api/Settings": { definePluginSettings: () => settings },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {}, SUPPORT_CHANNEL_IDS: ["support", "support-two"] },
        "@utils/misc": { isAnyPluginDev: () => false },
        "@utils/native": { relaunch: () => { state.restarts++; return restart.promise; } },
        "@utils/onlyOnce": { onlyOnce: (fn: () => Promise<unknown>) => fn },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin },
        "@utils/updater": { checkForUpdates: () => check.promise, isOutdated: true, update: async () => { state.updates++; } },
        "@webpack/common": {
            SelectedChannelStore: { getChannelId: () => state.channelId },
            UserStore: { getCurrentUser: () => state.userId ? { id: state.userId } : undefined },
            openModal: (modal: unknown) => modals.push(modal)
        }
    };
    const path = "src/plugins/_core/supportHelper.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const { plugin, forceUpdate } = runInNewContext(code + "\n({ plugin: exports.default, forceUpdate });", {
        exports: {}, IS_UPDATER_DISABLED: false,
        require: (name: string) => mocks[name] ?? {}
    });
    return { plugin, forceUpdate, check, restart, modals, state };
}

test("support update prompt follows the latest channel selection", async () => {
    const { plugin, check, modals, state } = loadSupportHelper();
    const first = plugin.flux.CHANNEL_SELECT({ channelId: "support" });
    state.channelId = "support-two";
    const second = plugin.flux.CHANNEL_SELECT({ channelId: "support-two" });
    check.resolve(true);
    await Promise.all([first, second]);
    assert.equal(modals.length, 1);
});

test("leaving support or changing account suppresses pending support prompts", async () => {
    for (const changeAccount of [false, true]) {
        const { plugin, check, modals, state } = loadSupportHelper();
        const pending = plugin.flux.CHANNEL_SELECT({ channelId: "support" });
        if (changeAccount) state.userId = "other-account";
        else {
            state.channelId = "ordinary";
            await plugin.flux.CHANNEL_SELECT({ channelId: state.channelId });
        }
        check.resolve(true);
        await pending;
        assert.equal(modals.length, 0);
    }
});

test("support update waits for restart and propagates persistence errors", async () => {
    const { forceUpdate, check, restart, state } = loadSupportHelper();
    const pending = forceUpdate();
    const failed = assert.rejects(pending, /settings flush failed/);
    check.resolve(true);
    await setImmediate();
    assert.equal(state.updates, 1);
    assert.equal(state.restarts, 1);
    restart.reject(new Error("settings flush failed"));
    await failed;
});
