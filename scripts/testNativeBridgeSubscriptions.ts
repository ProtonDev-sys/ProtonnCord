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

import { createSettingsPersistence } from "../src/shared/settingsPersistence";

test("preload subscriptions release exactly their own handlers without exposing Electron events", () => {
    const source = transpileModule(readFileSync("src/VencordNative.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const ipcEvents = {
        QUICK_CSS_UPDATE: "css", THEME_UPDATE: "theme", RENDERER_CSS_UPDATE: "renderer",
        TRAY_CHECK_UPDATES: "updates", TRAY_REPAIR: "repair"
    };
    const dependencies = {
        "@shared/settingsPersistence": { createSettingsPersistence },
        "@shared/IpcEvents": { IpcEvents: ipcEvents },
        "electron/renderer": { ipcRenderer: {
            sendSync: () => ({}),
            on(event: string, handler: (...args: unknown[]) => void) {
                if (!handlers.has(event)) handlers.set(event, new Set());
                handlers.get(event)?.add(handler);
            },
            removeListener(event: string, handler: (...args: unknown[]) => void) { handlers.get(event)?.delete(handler); }
        } }
    };
    const native = runInNewContext(`${source}\nexports.default;`, {
        exports: {}, IS_DEV: true,
        require(name: string) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; }
    });
    const subscriptions: Array<[string, (callback: (...args: unknown[]) => void) => () => void]> = [
        ["css", native.quickCss.addChangeListener], ["theme", native.quickCss.addThemeChangeListener],
        ["renderer", native.native.onRendererCssUpdate], ["updates", native.tray.onCheckUpdates], ["repair", native.tray.onRepair]
    ];
    for (const [event, subscribe] of subscriptions) {
        const observed: unknown[][] = [];
        const callback = (...args: unknown[]) => observed.push(args);
        const first = subscribe(callback);
        const second = subscribe(callback);
        for (const handler of handlers.get(event) ?? []) handler({ sender: "private native event" }, "value");
        assert.deepEqual(observed, [["value"], ["value"]]);
        first();
        first();
        assert.equal(handlers.get(event)?.size, 1);
        second();
        assert.equal(handlers.get(event)?.size, 0);
    }
});

test("browser QuickCSS subscriptions have independent, repeatable cleanup", async () => {
    const source = transpileModule(readFileSync("browser/VencordNativeStub.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const persisted: Array<[string, string]> = [];
    const dependencies = {
        "file://monacoWin.html?minify": {},
        "@api/DataStore": {
            createStore: () => ({}),
            async set(key: string, value: string) { persisted.push([key, value]); }
        },
        "@main/themes": {},
        "@shared/debounce": { debounce: (callback: unknown) => callback },
        "@utils/localStorage": {},
        "@utils/web": {},
        "@utils/web-metadata": {},
        "./externalLinks": {}
    };
    const native = runInNewContext(`${source}\nwindow.VencordNative;`, {
        exports: {}, window: {},
        require(name: string) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; }
    });
    const observed: string[] = [];
    const callback = (css: string) => observed.push(css);
    const first = native.quickCss.addChangeListener(callback);
    const second = native.quickCss.addChangeListener(callback);
    await native.quickCss.set("first");
    assert.deepEqual(observed, ["first", "first"]);
    first();
    first();
    await native.quickCss.set("second");
    assert.deepEqual(observed, ["first", "first", "second"]);
    second();
    await native.quickCss.set("third");
    assert.deepEqual(observed, ["first", "first", "second"]);
    assert.deepEqual(persisted, [
        ["VencordQuickCss", "first"], ["VencordQuickCss", "second"], ["VencordQuickCss", "third"]
    ]);
});
