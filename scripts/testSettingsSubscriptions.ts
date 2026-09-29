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

import { SettingsStore } from "../src/shared/SettingsStore";

test("plugin enable defaults use the manifest without loading disabled definitions", () => {
    const source = readFileSync("src/api/Settings.ts", "utf8");
    const constructor = source.slice(source.indexOf("export const SettingsStore ="), source.indexOf("if (!IS_REPORTER) {"));
    const code = transpileModule(constructor, {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
    }).outputText;
    let loads = 0;
    let definition: { settings: { def: Record<string, { default: number | { items: string[]; }; }>; }; } | undefined;
    const plugins = Object.defineProperty({}, "Optional", {
        get() {
            if (!definition) {
                loads++;
                definition = { settings: { def: { count: { default: 7 } } } };
            }
            return definition;
        }
    });
    const settings = { plugins: { Saved: { enabled: false, unknownKey: "retained" } } };
    const PluginManifest = {
        Optional: { eager: false, settingsKeys: ["count"] },
        Required: { required: true }, Default: { enabledByDefault: true }, Saved: { enabledByDefault: true }
    };
    const store = runInNewContext(`${code}\nexports.SettingsStore;`, {
        exports: {}, settings, PluginManifest, plugins, SettingsStoreClass: SettingsStore,
        IS_REPORTER: false, OptionType: { SELECT: 2 }, getLoadedPluginDefinition: () => definition, structuredClone
    });
    assert.equal(store.store.plugins.Optional.enabled, false);
    assert.equal(store.store.plugins.Required.enabled, true);
    assert.equal(store.store.plugins.Default.enabled, true);
    assert.equal(store.store.plugins.Saved.enabled, false);
    assert.equal(store.store.plugins.Saved.unknownKey, "retained");
    assert.equal(store.store.plugins.Optional.isFavorite, undefined);
    assert.equal(store.store.plugins.Optional.unknownKey, undefined);
    assert.equal(JSON.stringify(store.store.plugins.Optional), '{"enabled":false}');
    assert.equal(loads, 0);
    assert.equal(store.store.plugins.Optional.count, 7);
    assert.equal(store.store.plugins.Optional.count, 7);
    assert.equal(loads, 1, "the definition is consulted only for a missing plugin option");
    definition!.settings.def.dynamic = { default: 9 };
    assert.equal(store.store.plugins.Optional.dynamic, 9, "loaded definitions may add settings beyond their static manifest");
    const defaults = { items: ["original"] };
    definition!.settings.def.object = { default: defaults };
    store.store.plugins.Optional.object.items.push("edited");
    assert.deepEqual(defaults.items, ["original"], "stored settings must not mutate the reset default");
    delete store.store.plugins.Optional.object;
    assert.deepEqual([...store.store.plugins.Optional.object.items], ["original"]);
    assert.equal(loads, 1);
});

test("settings hooks retain subscriptions across equal path arrays and release original paths", () => {
    const source = readFileSync("src/api/Settings.ts", "utf8");
    const hook = source.slice(source.indexOf("export function useSettings("), source.indexOf("export function migratePluginSettings("));
    const code = transpileModule(hook, {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
    }).outputText;
    const settings = new SettingsStore({ first: 0, second: 0, nested: { value: 0 } });
    let effectKey: unknown;
    let initialized = false;
    let cleanup: (() => void) | undefined;
    let effects = 0;
    let renders = 0;
    const forceUpdate = () => { renders++; };
    const useSettings = runInNewContext(`${code}\nexports.useSettings;`, {
        exports: {}, SettingsStore: settings,
        React: { useReducer: () => [null, forceUpdate] },
        useEffect(effect: () => () => void, deps: unknown[]) {
            if (initialized && Object.is(effectKey, deps[0])) return;
            cleanup?.();
            initialized = true;
            effectKey = deps[0];
            effects++;
            cleanup = effect();
        }
    });
    const paths = ["first", "nested.*"];
    assert.equal(useSettings(paths), settings.store);
    for (let i = 0; i < 100; i++) useSettings(["first", "nested.*"]);
    assert.equal(effects, 1);
    paths[0] = "second";
    settings.store.first = 1;
    settings.store.nested.value = 1;
    assert.equal(renders, 2);
    useSettings(["second"]);
    settings.store.first = 2;
    settings.store.nested.value = 2;
    assert.equal(renders, 2);
    settings.store.second = 1;
    assert.equal(renders, 3);
    useSettings([]);
    settings.store.second = 2;
    assert.equal(renders, 3);
    useSettings();
    settings.store.first = 3;
    assert.equal(renders, 4);
    cleanup?.();
    settings.store.first = 4;
    assert.equal(renders, 4);
});

function loadPluginMigration(plugins: Record<string, Record<string, any>>) {
    const source = readFileSync("src/api/Settings.ts", "utf8");
    const migration = source.slice(source.indexOf("export function migratePluginToSettings("), source.indexOf("export function migrateSettingToPlugin("));
    const code = transpileModule(migration, {
        compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
    }).outputText;
    const settings = new SettingsStore({ plugins });
    const migrate = runInNewContext(`${code}\nexports.migratePluginToSettings;`, {
        exports: {}, SettingsStore: settings, logger: { info() {} }
    });
    return { settings, migrate };
}

test("retired enabled plugins migrate before their replacement has saved settings", () => {
    const legacy = { enabled: true, isFavorite: true, extra: { retained: "legacy data" } };
    const f = loadPluginMigration({ AmITyping: legacy });
    let saves = 0;
    f.settings.addGlobalChangeListener(() => saves++);
    f.migrate(true, "TypingTweaks", "AmITyping", "amITyping");
    assert.deepEqual(structuredClone(f.settings.plain.plugins), { TypingTweaks: { ...legacy, amITyping: true } });
    assert.equal(saves, 1);
    f.migrate(true, "TypingTweaks", "AmITyping", "amITyping");
    assert.equal(saves, 1, "completed migrations must not save again");
});

test("plugin migration preserves saved destination choices and missing legacy fields", () => {
    const current = { enabled: false, isFavorite: false, amITyping: false, showAvatars: false };
    const f = loadPluginMigration({ TypingTweaks: current, AmITyping: { enabled: true, isFavorite: true, extra: "retained" } });
    f.migrate(true, "TypingTweaks", "AmITyping", "amITyping");
    assert.equal(f.settings.plain.plugins.TypingTweaks, current);
    assert.deepEqual(current, { enabled: false, isFavorite: false, amITyping: false, showAvatars: false, extra: "retained" });
    assert.equal(Object.hasOwn(f.settings.plain.plugins, "AmITyping"), false);
});

test("retaining a legacy entry does not reapply settings or enable states on later starts", () => {
    const legacy = { enabled: true, isFavorite: true };
    const f = loadPluginMigration({ AmITyping: legacy, NoAppsAllowed: { enabled: false } });
    f.migrate(false, "TypingTweaks", "AmITyping", "amITyping");
    const current = f.settings.store.plugins.TypingTweaks;
    current.enabled = current.amITyping = current.isFavorite = false;
    let saves = 0;
    f.settings.addGlobalChangeListener(() => saves++);
    f.migrate(false, "TypingTweaks", "AmITyping", "amITyping");
    f.migrate(true, "MoreUserTags", "NoAppsAllowed", "noAppsAllowed");
    f.migrate(true, "ProtonnCordHelper", "NoBulletPoints", "noBulletPoints");
    assert.deepEqual(structuredClone(f.settings.plain.plugins.TypingTweaks), { enabled: false, isFavorite: false, amITyping: false });
    assert.equal(f.settings.plain.plugins.AmITyping, legacy);
    assert.equal(Object.hasOwn(f.settings.plain.plugins, "MoreUserTags"), false);
    assert.equal(Object.hasOwn(f.settings.plain.plugins, "ProtonnCordHelper"), false);
    assert.equal(saves, 0);
});

test("a failed migration save can retry from the unchanged persisted legacy snapshot", t => {
    const errors = t.mock.method(console, "error", () => {});
    let persisted = JSON.stringify({ AmITyping: { enabled: true, isFavorite: true, extra: "retained" } });
    const original = persisted;
    for (const fail of [true, false]) {
        const f = loadPluginMigration(JSON.parse(persisted));
        f.settings.addGlobalChangeListener(({ plugins }) => {
            if (fail) throw new Error("Disk unavailable");
            persisted = JSON.stringify(plugins);
        });
        f.migrate(true, "TypingTweaks", "AmITyping", "amITyping");
        if (fail) assert.equal(persisted, original);
    }
    assert.equal(errors.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(persisted), { TypingTweaks: { enabled: true, isFavorite: true, extra: "retained", amITyping: true } });
});
