/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import * as catalogView from "../src/components/settings/tabs/plugins/catalogView";
import { createPluginCatalogView, PluginFilter, SearchStatus } from "../src/components/settings/tabs/plugins/catalogView";
import type { PluginManifestEntry } from "../src/shared/pluginDefinition";
import { SettingsStore } from "../src/shared/SettingsStore";

const all: PluginFilter = { value: "", tags: [], status: SearchStatus.ALL };

function fixture(definitions: Partial<PluginManifestEntry>[] = [{ name: "Alpha" }, { name: "Bravo" }, { name: "Charlie" }]) {
    const plugins = Object.fromEntries(definitions.map(plugin => [plugin.name!, {
        description: `${plugin.name} description`, eager: false, hasSettings: false, hasVisibleSettings: false,
        hasPatches: false, settingsKeys: [], ...plugin
    } as PluginManifestEntry]));
    const metadata = Object.fromEntries(Object.keys(plugins).map(name => [name, { folderName: `src/plugins/${name}`, userPlugin: false }]));
    const store = new SettingsStore({ plugins: {} as Record<string, { enabled?: boolean; isFavorite?: boolean; privateValue?: unknown; }> });
    const dependencies = new Set<string>();
    let visibility = false;
    let visibilityReads = 0;
    const source = {
        plugins, metadata,
        getSettings: (name: string) => store.plain.plugins[name],
        isEnabled: (name: string) => !!(plugins[name].required || dependencies.has(name) || (store.plain.plugins[name] ? store.plain.plugins[name].enabled : plugins[name].enabledByDefault)),
        isDependency: (name: string) => dependencies.has(name),
        hasVisibleSettings() { visibilityReads++; return visibility; }
    };
    return { ...source, store, dependencies, create: () => createPluginCatalogView(source), setVisibility: (value: boolean) => { visibility = value; }, visibilityReads: () => visibilityReads };
}

const names = (view: ReturnType<ReturnType<typeof createPluginCatalogView>["read"]>) => view.cards.map(card => card.plugin.name);

test("favorite ordering and enable filters update while unrelated settings reuse the displayed list", () => {
    const f = fixture();
    f.store.store.plugins.Bravo = { enabled: false, isFavorite: true };
    const catalog = f.create();
    const initial = catalog.read(all, null, 36);
    assert.deepEqual(names(initial), ["Bravo", "Alpha", "Charlie"]);
    f.store.store.plugins.Bravo.privateValue = { retained: true };
    assert.equal(catalog.read(all, null, 36), initial, "private edits do not rebuild an unchanged list");
    f.store.store.plugins.Alpha = { enabled: true, isFavorite: true };
    assert.deepEqual(names(catalog.read(all, null, 36)), ["Alpha", "Bravo", "Charlie"]);
    assert.deepEqual(names(catalog.read({ ...all, status: SearchStatus.FAVORITES }, null, 36)), ["Alpha", "Bravo"]);
    assert.deepEqual(names(catalog.read({ ...all, status: SearchStatus.ENABLED }, null, 36)), ["Alpha"]);
    assert.deepEqual(names(catalog.read({ ...all, status: SearchStatus.DISABLED }, null, 36)), ["Bravo", "Charlie"]);
    f.store.store.plugins.Alpha.isFavorite = false;
    assert.deepEqual(names(catalog.read(all, null, 36)), ["Bravo", "Alpha", "Charlie"]);
});

test("search preserves names, acronyms, descriptions, terms, tag intersections, sources and API visibility", () => {
    const f = fixture([
        { name: "BetterFolders", description: "Organize servers", tags: ["Utility", "Appearance"], searchTerms: ["Collections"] },
        { name: "UserThing", tags: ["Utility"] }, { name: "ForkThing" }, { name: "BridgeAPI" }, { name: "Hidden", hidden: true }
    ]);
    f.metadata.UserThing.userPlugin = true;
    f.metadata.UserThing.folderName = "src/userplugins/user";
    f.metadata.ForkThing.folderName = "src/equicordplugins/fork";
    const catalog = f.create();
    for (const value of ["better folders", "BF", "organize", "collection"]) {
        assert.deepEqual(names(catalog.read({ ...all, value }, null, 36)), ["BetterFolders"], value);
    }
    assert.deepEqual(names(catalog.read({ ...all, tags: ["Utility", "Appearance"] }, null, 36)), ["BetterFolders"]);
    for (const [status, expected] of [
        [SearchStatus.USER_PLUGINS, ["UserThing"]], [SearchStatus.EQUICORD, ["ForkThing"]],
        [SearchStatus.VENCORD, ["BetterFolders"]], [SearchStatus.API_PLUGINS, ["BridgeAPI"]],
        [SearchStatus.NEW, ["ForkThing"]]
    ] as const) assert.deepEqual(names(catalog.read({ ...all, status }, new Set(["ForkThing"]), 36)), expected);
});

test("default-enabled dependants remain required without creating saved settings namespaces", () => {
    const f = fixture([{ name: "Dependency", hasSettings: true }, { name: "Consumer", enabledByDefault: true, dependencies: ["Dependency"] }, { name: "Core", required: true }]);
    const catalog = f.create();
    const first = catalog.read(all, null, 36);
    assert.deepEqual(first.requiredCards.map(card => card.plugin.name), ["Core", "Dependency"]);
    assert.deepEqual(first.requiredCards.find(card => card.plugin.name === "Dependency")!.requiredBy, ["Consumer"]);
    assert.deepEqual(f.store.plain.plugins, {}, "browsing preserves absent settings rows");
    f.store.store.plugins.Consumer = { enabled: false };
    const next = catalog.read(all, null, 36);
    assert.deepEqual(next.requiredCards.map(card => card.plugin.name), ["Core"]);
    assert.ok(names(next).includes("Dependency"));
    assert.equal(next.requiredCards[0], first.requiredCards[0], "unchanged required cards retain identity");
});

test("dynamic visibility, descriptions, hidden flags and in-place search terms remain live", () => {
    const f = fixture([{ name: "Dynamic", hasVisibleSettings: undefined, searchTerms: ["before"] }]);
    let hidden = false;
    let description = "before";
    Object.defineProperties(f.plugins.Dynamic, { hidden: { get: () => hidden }, description: { get: () => description } });
    const catalog = f.create();
    const first = catalog.read(all, null, 36);
    assert.equal(first.cards[0].hasVisibleSettings, false);
    f.setVisibility(true);
    const second = catalog.read(all, null, 36);
    assert.equal(second.cards[0].hasVisibleSettings, true);
    description = "after";
    assert.deepEqual(names(catalog.read({ ...all, value: "after" }, null, 36)), ["Dynamic"]);
    f.plugins.Dynamic.searchTerms![0] = "changed";
    assert.deepEqual(names(catalog.read({ ...all, value: "changed" }, null, 36)), ["Dynamic"]);
    assert.deepEqual(names(catalog.read({ ...all, value: "before" }, null, 36)), []);
    hidden = true;
    assert.equal(catalog.read(all, null, 36).matchingPlugins, 0);
});

test("initial browsing reads presentation only for visible cards and reuses each earlier page", t => {
    const f = fixture(Array.from({ length: 388 }, (_, index) => ({ name: `Plugin${String(index).padStart(3, "0")}` })));
    let descriptionReads = 0;
    for (const plugin of Object.values(f.plugins)) Object.defineProperty(plugin, "description", { get() { descriptionReads++; return "Fixture"; } });
    const catalog = f.create();
    const first = catalog.read(all, null, 36);
    assert.equal(first.cards.length, 36);
    assert.equal(first.matchingPlugins, 388);
    assert.equal(descriptionReads, 36, "offscreen cards do not evaluate presentation getters");
    const next = catalog.read(all, null, 72);
    assert.deepEqual(next.cards.slice(0, 36), first.cards);
    const beforeEdits = catalog.read(all, null, 388);
    f.store.store.plugins.Plugin000 = { enabled: false };
    for (let i = 0; i < 100; i++) {
        f.store.store.plugins.Plugin000.privateValue = i;
        assert.equal(catalog.read(all, null, 388), beforeEdits);
    }
    assert.equal(f.visibilityReads(), 0, "static visibility never requires plugin definitions");
    t.diagnostic("388-plugin fixture: 36 presentation reads for the first page; 100 private-setting edits reused the complete displayed card list.");
});

test("the actual settings tab creates one page, reuses it after private edits, and supports keyboard paging and filter reset", () => {
    const f = fixture(Array.from({ length: 388 }, (_, index) => ({ name: `Plugin${String(index).padStart(3, "0")}` })));
    const hooks: { value: any; dependencies?: unknown[]; }[] = [];
    let cursor = 0;
    let cardElements = 0;
    const equal = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    const useMemo = (factory: () => unknown, dependencies: unknown[]) => {
        const index = cursor++;
        if (!hooks[index] || !equal(hooks[index].dependencies, dependencies)) hooks[index] = { value: factory(), dependencies };
        return hooks[index].value;
    };
    const React = {
        createElement(type: unknown, props: unknown, ...children: unknown[]) {
            if (type === "catalog-card") cardElements++;
            return { type, props: { ...props as object, children } };
        },
        memo: () => "catalog-card", useEffect() {}, Fragment: "fragment"
    };
    const mocks: Record<string, unknown> = {
        "@api/PluginManager": { isPluginEnabled: f.isEnabled, hasAnyVisibleSettings: () => false },
        "@api/Settings": { PlainSettings: f.store.plain, useSettings: () => f.store.store },
        "@components/settings": { SettingsTab: "tab" },
        "@components/ErrorBoundary": { __esModule: true, default: "boundary" },
        "@shared/pluginDefinition": { getLoadedPluginDefinition: () => undefined },
        "@utils/ChangeList": { ChangeList: class { hasChanges = false; } },
        "@utils/guards": { isTruthy: Boolean }, "@utils/margins": { Margins: {} },
        "@utils/misc": { classes: (...values: unknown[]) => values.filter(Boolean).join(" ") }, "@utils/native": {},
        "@utils/react": { useCleanupEffect() {}, useIntersection: () => [null, false] },
        "@utils/types": { PluginTags: [] },
        "@webpack/common": {
            React, TextInput: "input", Select: "select", SearchableSelect: "tags", Tooltip: "tooltip", useMemo,
            useCallback: (callback: unknown, deps: unknown[]) => useMemo(() => callback, deps),
            useRef: (initial: unknown) => useMemo(() => ({ current: initial }), []),
            useState(initial: unknown) {
                const index = cursor++;
                hooks[index] ??= { value: initial };
                return [hooks[index].value, (value: any) => { hooks[index].value = typeof value === "function" ? value(hooks[index].value) : value; }];
            }
        },
        "~plugins": { __esModule: true, default: {}, PluginManifest: f.plugins, PluginMeta: f.metadata, ExcludedPlugins: {} },
        "./catalogView": catalogView, "./newPluginRelease": { getReleaseNewPlugins: () => null },
        "./PluginCard": {}, "./PluginModal": {}, "./PluginStatCards": {}, "./UIElements": {},
        "./shared": { cl: (name: string) => name, logger: {}, ExcludedReasons: {}, PluginDependencyList: "dependencies" }
    };
    for (const component of ["Button", "Card", "Divider", "Heading", "Paragraph"]) mocks[`@components/${component}`] = { [component === "Heading" ? "HeadingTertiary" : component]: component.toLowerCase() };
    const code = transpileModule(readFileSync("src/components/settings/tabs/plugins/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const module = runInNewContext(`${code}\nexports;`, {
        exports: {}, IS_STANDALONE: false, VERSION: "test",
        require(name: string) { if (name.endsWith(".css")) return {}; assert.ok(name in mocks, name); return mocks[name]; }
    });
    const render = () => { cursor = 0; return module.default(); };
    const find = (tree: any, type: string): any[] => Array.isArray(tree) ? tree.flatMap(child => find(child, type))
        : !tree || typeof tree !== "object" ? [] : [...(tree.type === type ? [tree] : []), ...find(tree.props?.children, type)];
    const initial = render();
    assert.equal(cardElements, 36);
    f.store.store.plugins.Plugin000 = { enabled: false, privateValue: "changed" };
    render();
    assert.equal(cardElements, 36, "private edits create no new card elements");
    find(initial, "button").find(button => button.props.children.join("").startsWith("Show more"))!.props.onClick();
    const expanded = render();
    assert.equal(find(expanded, "catalog-card").length, 72);
    find(expanded, "input")[0].props.onChange("Plugin");
    assert.equal(find(render(), "catalog-card").length, 36, "a new filter resets the visible page without assuming card heights");
});
