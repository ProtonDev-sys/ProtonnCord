/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { migrateRetiredPlugins } from "../src/shared/retiredPlugins";
import { SettingsStore } from "../src/shared/SettingsStore";
import { mergeDefaults } from "../src/utils/mergeDefaults";

type SavedSettings = Parameters<typeof migrateRetiredPlugins>[0];

test("retired plugins migrate preferences and favorites without deleting historical or unknown fields", () => {
    const settings: SavedSettings = { plugins: {
        HideChatButtons: { enabled: true, isFavorite: true, open: true, color: true, unknown: { kept: true } },
        NoMiddleClickPaste: { enabled: true, isFavorite: true, custom: "retained" },
    } };
    const previous = structuredClone(settings.plugins);
    assert.equal(migrateRetiredPlugins(settings), true);
    assert.deepEqual(settings.plugins.CollapsibleUI, {
        enabled: true, isFavorite: true, chatButtonsCollapsed: false, chatButtonsColor: true,
    });
    assert.deepEqual(settings.plugins.MiddleClickTweaks, { enabled: true, isFavorite: true, pasteScope: "always" });
    assert.deepEqual(settings.plugins.HideChatButtons, previous.HideChatButtons);
    assert.deepEqual(settings.plugins.NoMiddleClickPaste, previous.NoMiddleClickPaste);
    settings.plugins.CollapsibleUI.enabled = false;
    settings.plugins.CollapsibleUI.chatButtonsCollapsed = true;
    assert.equal(migrateRetiredPlugins(settings), false, "restarts must not undo changes to the replacement");
    assert.equal(settings.plugins.CollapsibleUI.enabled, false);
    assert.equal(settings.plugins.CollapsibleUI.chatButtonsCollapsed, true);
});

test("migration respects replacement choices, disabled legacy plugins, missing rows and old key casing", () => {
    const settings: SavedSettings = { plugins: {
        HideChatButtons: { enabled: false, Open: true, Color: true },
        NoMiddleClickPaste: { enabled: true, isFavorite: true },
        MiddleClickTweaks: { enabled: false, isFavorite: false, pasteScope: "focus", openScope: "both" },
    } };
    migrateRetiredPlugins(settings);
    assert.equal(settings.plugins.CollapsibleUI.enabled, false);
    assert.equal(settings.plugins.CollapsibleUI.chatButtonsCollapsed, false);
    assert.equal(settings.plugins.CollapsibleUI.chatButtonsColor, true);
    assert.deepEqual(settings.plugins.MiddleClickTweaks, {
        enabled: false, isFavorite: false, pasteScope: "focus", openScope: "both",
    });
    const defaults: SavedSettings = { plugins: { HideChatButtons: { enabled: true } } };
    migrateRetiredPlugins(defaults);
    assert.equal(defaults.plugins.CollapsibleUI.chatButtonsCollapsed, true, "the legacy default was closed");
    assert.equal(defaults.plugins.CollapsibleUI.chatButtonsColor, false);
    const untouched: SavedSettings = { plugins: { Other: { enabled: true } } };
    assert.equal(migrateRetiredPlugins(untouched), false);
    assert.deepEqual(untouched, { plugins: { Other: { enabled: true } } });
});

test("actual settings startup persists migration before plugin initialization and retries after a failed save", async () => {
    const original: SavedSettings = { plugins: { HideChatButtons: { enabled: true, color: true } } };
    let durable = structuredClone(original);
    let saves = 0;
    let errors = 0;
    let fail = true;
    const code = transpileModule(readFileSync("src/api/Settings.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React },
    }).outputText;
    const load = (reporter = false) => {
        const mocks = {
            "@shared/pluginDefinition": { getLoadedPluginDefinition: () => assert.fail("migration must not load definitions") },
            "@shared/retiredPlugins": { migrateRetiredPlugins },
            "@shared/SettingsStore": { SettingsStore },
            "@utils/Logger": { Logger: class { error() { errors++; } } },
            "@utils/mergeDefaults": { mergeDefaults },
            "@utils/types": { OptionType: {} },
            "@webpack/common": {},
            "~plugins": { __esModule: true, default: {}, PluginManifest: {} },
        };
        return runInNewContext(`${code}\nexports;`, {
            exports: {}, IS_REPORTER: reporter, structuredClone,
            VencordNative: { settings: {
                get: () => structuredClone(durable),
                async set(value: SavedSettings) {
                    saves++;
                    if (fail) throw new Error("save failed");
                    durable = structuredClone(value);
                },
            } },
            require(name: string) { assert.ok(name in mocks, name); return mocks[name]; },
        });
    };
    const first = load();
    await Promise.resolve();
    assert.equal(first.PlainSettings.plugins.CollapsibleUI.enabled, true);
    assert.equal(saves, 1);
    assert.equal(errors, 1);
    assert.deepEqual(durable, original, "a failed save does not durably mark the migration complete");
    fail = false;
    const recovered = load();
    await Promise.resolve();
    assert.equal(saves, 2);
    assert.equal(durable.plugins.CollapsibleUI.enabled, true);
    assert.deepEqual(durable.plugins.HideChatButtons, original.plugins.HideChatButtons);
    recovered.Settings.plugins.CollapsibleUI.enabled = false;
    await Promise.resolve();
    assert.equal(load().PlainSettings.plugins.CollapsibleUI.enabled, false);
    assert.equal(saves, 3, "an already migrated restart performs no extra write");
    load(true);
    assert.equal(saves, 3, "reporter builds cannot write user migration state");
});

test("CollapsibleUI keeps the migrated row state and expanded color control across remounts", () => {
    const store = { chatButtonsCollapsed: false, chatButtonsColor: true };
    const code = transpileModule(readFileSync("src/equicordplugins/collapsibleUi/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React },
    }).outputText;
    const element = (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } });
    const mocks = {
        "@api/HeaderBar": {}, "@api/SurfaceClasses": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (fn: unknown) => fn } },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/misc": { classes: (...values: unknown[]) => values.filter(Boolean).join(" ") },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin },
        "@webpack/common": { Clickable: "clickable", React: { createElement: element } },
        "./settings": { settings: { use: () => store } }, "./style.css?managed": {},
    };
    const plugin = runInNewContext(`${code}\nexports.default;`, {
        exports: {}, React: { createElement: element },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; },
    });
    const render = () => {
        const wrapper = plugin.chatBarButtonWrapper.wrapper(["button"]);
        return wrapper.type(wrapper.props);
    };
    const expanded = render();
    const control = expanded.props.children[1];
    assert.equal(control.type(control.props).props.style.color, "#c32a32");
    store.chatButtonsCollapsed = true;
    const collapsed = render();
    assert.equal(collapsed.props.className.includes("chat-buttons-collapsed"), true);
    assert.equal(collapsed.props.children[1].type(collapsed.props.children[1].props).props.style, undefined);
    assert.equal(render().props.className, collapsed.props.className, "remounting reads the persisted collapsed choice");
});
