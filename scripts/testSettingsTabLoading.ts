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

import { makeLazy } from "../src/utils/lazy";

function loadSettingsTabs(standalone = false) {
    const imports: string[] = [];
    const calls: { name: string; args: unknown[]; }[] = [];
    const React = { createElement: (type: unknown, props: object) => ({ type, props }) };
    function compile(path: string) {
        return transpileModule(readFileSync(path, "utf8"), {
            fileName: path,
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
        }).outputText;
    }
    const lazy = runInNewContext(`${compile("src/utils/lazyReact.tsx")}\nexports;`, {
        exports: {}, React,
        require(name: string) {
            assert.equal(name, "./lazy");
            return { makeLazy };
        }
    });
    const pageNames = ["./plugins", "./sync/BackupAndRestoreTab", "./sync/CloudTab", "./themes", "./updater", "./vencord", "./patchHelper"];
    const pages = Object.fromEntries(pageNames.map(name => [name, { default: function Page() { return name; } }]));
    const baseTab = function SettingsTab() {};
    const tabs = runInNewContext(`${compile("src/components/settings/tabs/index.ts")}\nexports;`, {
        exports: {}, IS_STANDALONE: standalone,
        require(name: string) {
            imports.push(name);
            if (name === "./styles.css") return {};
            if (name === "./BaseTab") return { SettingsTab: baseTab };
            if (name === "@utils/lazyReact") return lazy;
            if (Object.hasOwn(pages, name)) return pages[name];
            if (name === "./plugins/PluginModal") return {
                openPluginModal(...args: unknown[]) { calls.push({ name, args }); return "plugin-modal"; }
            };
            if (name === "./plugins/ContributorModal") return {
                openContributorModal(...args: unknown[]) { calls.push({ name, args }); return "contributor-modal"; }
            };
            assert.fail(`Unexpected settings import: ${name}`);
        }
    });
    return { tabs, imports, calls, pages, baseTab };
}

test("registering settings tabs initializes no page or modal implementation", () => {
    const { tabs, imports, baseTab } = loadSettingsTabs();
    assert.equal(tabs.SettingsTab, baseTab);
    for (const name of ["PluginsTab", "BackupAndRestoreTab", "CloudTab", "ThemesTab", "UpdaterTab", "VencordTab", "PatchHelperTab"])
        assert.equal(typeof tabs[name], "function");
    assert.deepEqual(imports.toSorted(), ["./BaseTab", "./styles.css", "@utils/lazyReact"].toSorted());
});

test("opening a tab loads only that page once and preserves props and a useful modal title", () => {
    const { tabs, imports, pages } = loadSettingsTabs();
    const names = {
        PluginsTab: "./plugins", BackupAndRestoreTab: "./sync/BackupAndRestoreTab", CloudTab: "./sync/CloudTab",
        ThemesTab: "./themes", UpdaterTab: "./updater", VencordTab: "./vencord", PatchHelperTab: "./patchHelper"
    };
    for (const [exportName, moduleName] of Object.entries(names)) {
        const initialCount = imports.length;
        const props = { marker: exportName };
        const first = tabs[exportName](props);
        const second = tabs[exportName](props);
        assert.equal(first.type, pages[moduleName].default);
        assert.equal(second.type, first.type);
        assert.equal(first.props.marker, exportName);
        assert.deepEqual(imports.slice(initialCount), [moduleName]);
        assert.ok(tabs[exportName].displayName.endsWith("SettingsTab"));
    }
});

test("modal entry points forward arguments and return values without opening unrelated pages", () => {
    const { tabs, calls, imports } = loadSettingsTabs();
    const plugin = { name: "Example" };
    const callback = () => {};
    const user = { id: "test-user" };
    assert.equal(tabs.openPluginModal(plugin, callback), "plugin-modal");
    assert.equal(tabs.openContributorModal(user), "contributor-modal");
    assert.deepEqual(calls, [
        { name: "./plugins/PluginModal", args: [plugin, callback] },
        { name: "./plugins/ContributorModal", args: [user] }
    ]);
    assert.deepEqual(imports.slice(3), ["./plugins/PluginModal", "./plugins/ContributorModal"]);
});

test("standalone builds keep Patch Helper unavailable without loading its implementation", () => {
    const { tabs, imports } = loadSettingsTabs(true);
    assert.equal(tabs.PatchHelperTab, null);
    tabs.VencordTab({});
    assert.equal(imports.includes("./patchHelper"), false);
});
