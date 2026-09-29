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
import { ChangeList } from "../src/utils/ChangeList";

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
    assert.deepEqual(initial.cards.map(card => card.isFavorite), [true, false, false], "cards carry the favorite marker they are sorted by");
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

test("enabled stock totals exclude the same hidden plugins as the stock denominator", () => {
    const f = fixture([{ name: "Visible", enabledByDefault: true }, { name: "Hidden", hidden: true, enabledByDefault: true }]);
    const view = f.create().read(all, null, 36);
    assert.equal(view.counts.totalStockPlugins, 1);
    assert.equal(view.counts.enabledStockPlugins, 1);
    assert.deepEqual(view.enabledPlugins, ["Visible", "Hidden"], "bulk disabling still covers hidden non-core plugins");
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

function loadSettingsTab(f: ReturnType<typeof fixture>, tags: readonly string[] = []) {
    const hooks: { value: any; dependencies?: unknown[]; }[] = [];
    let cursor = 0;
    let cardElements = 0;
    const effects: (() => void | (() => void))[] = [];
    const timers: (() => void)[] = [];
    const disableAllRequests: { count: number; confirm(): void; }[] = [];
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
        memo: () => "catalog-card", Fragment: "fragment",
        useDeferredValue: (value: unknown) => value,
        startTransition: (update: () => void) => update(),
        useEffect: (effect: () => void, dependencies: unknown[]) => useMemo(() => { effects.push(effect); }, dependencies),
    };
    const mocks: Record<string, unknown> = {
        "@api/PluginManager": { isPluginEnabled: f.isEnabled, hasAnyVisibleSettings: () => false, pluginRequiresRestart: () => false,
            stopPlugin: () => assert.fail("A plugin that never started does not need stopping") },
        "@api/Settings": { PlainSettings: f.store.plain, useSettings: () => f.store.store },
        "@components/Button": { Button: "button" },
        "@components/ErrorBoundary": { __esModule: true, default: "boundary" },
        "@components/Icons": { ChevronSmallDownIcon: "chevron", MagnifyingGlassIcon: "search-icon", RestartIcon: "restart-icon" },
        "@components/settings": { SettingsTab: "tab" },
        "@shared/pluginDefinition": { getLoadedPluginDefinition: () => undefined },
        "@utils/ChangeList": { ChangeList },
        "@utils/misc": { classes: (...values: unknown[]) => values.filter(Boolean).join(" ") },
        "@utils/react": { useCleanupEffect() {} },
        "@utils/types": { PluginTags: tags },
        "@webpack/common": {
            React, useMemo,
            useCallback: (callback: unknown, deps: unknown[]) => useMemo(() => callback, deps),
            useRef: (initial: unknown) => useMemo(() => ({ current: initial }), []),
            useState(initial: unknown) {
                const index = cursor++;
                hooks[index] ??= { value: initial };
                return [hooks[index].value, (value: any) => { hooks[index].value = typeof value === "function" ? value(hooks[index].value) : value; }];
            }
        },
        "~plugins": { __esModule: true, default: Object.fromEntries(Object.keys(f.plugins).map(name => [name, { name, started: false }])), PluginManifest: f.plugins, PluginMeta: f.metadata, ExcludedPlugins: {} },
        "./catalogView": catalogView, "./newPluginRelease": { getReleaseNewPlugins: () => null },
        "./PluginCard": {}, "./UIElements": {},
        "./PluginModal": { openDisableAllModal: (count: number, confirm: () => void) => disableAllRequests.push({ count, confirm }) },
        "./shared": { cl: (name: string) => name, logger: {}, ExcludedReasons: {}, PluginDependencyList: "dependencies" }
    };
    const code = transpileModule(readFileSync("src/components/settings/tabs/plugins/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const module = runInNewContext(`${code}\nexports;`, {
        exports: {}, IS_STANDALONE: false, VERSION: "test",
        setTimeout: (callback: () => void) => timers.push(callback), clearTimeout() {},
        require(name: string) { if (name.endsWith(".css")) return {}; assert.ok(name in mocks, name); return mocks[name]; }
    });
    const render = () => { cursor = 0; return module.default(); };
    /** Runs the effects of the last render and any timers they queued, like the browser would between frames. */
    const idle = () => { for (const effect of effects.splice(0)) effect(); for (const timer of timers.splice(0)) timer(); };
    return { render, idle, disableAllRequests, cardElements: () => cardElements };
}

const find = (tree: any, match: string | ((node: any) => boolean)): any[] => Array.isArray(tree) ? tree.flatMap(child => find(child, match))
    : !tree || typeof tree !== "object" ? [] : [...((typeof match === "string" ? tree.type === match : match(tree)) ? [tree] : []), ...find(tree.props?.children, match)];
const byComponent = (tree: unknown, name: string) => find(tree, node => node.type?.name === name);
const chip = (tree: unknown, label: string) => byComponent(tree, "Chip").find(node => node.props.children.includes(label))!;
const text = (node: any): string => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : node?.props ? text(node.props.children) : "";

test("the actual settings tab renders one page first, reuses it after private edits, then fills in the rest in the background", () => {
    const f = fixture(Array.from({ length: 388 }, (_, index) => ({ name: `Plugin${String(index).padStart(3, "0")}` })));
    const tab = loadSettingsTab(f);
    tab.render();
    assert.equal(tab.cardElements(), 48);
    f.store.store.plugins.Plugin000 = { enabled: false, privateValue: "changed" };
    tab.render();
    assert.equal(tab.cardElements(), 48, "private edits create no new card elements");
    let rendered = tab.render();
    for (let step = 0; step < 20 && find(rendered, "catalog-card").length < 388; step++) {
        tab.idle();
        rendered = tab.render();
    }
    assert.equal(find(rendered, "catalog-card").length, 388, "the whole list becomes available without a show-more step");
    assert.equal(find(rendered, node => node.type === "button" && text(node).startsWith("Show more")).length, 0);
    byComponent(rendered, "SearchBar")[0].props.onChange("Plugin");
    assert.equal(find(tab.render(), "catalog-card").length, 48, "a new filter resets the visible page without assuming card heights");
    f.store.store.plugins.Plugin000.enabled = true;
    find(tab.render(), node => node.type === "button" && text(node) === "Disable all")[0].props.onClick();
    assert.equal(tab.disableAllRequests.length, 1);
    tab.disableAllRequests[0].confirm();
    assert.equal(f.store.plain.plugins.Plugin000.enabled, false, "bulk disable includes a failed or unstarted enabled plugin");
    assert.equal(byComponent(tab.render(), "RestartBanner").length, 0);
    const onRestartNeeded = find(tab.render(), "catalog-card")[0].props.onRestartNeeded;
    onRestartNeeded("Plugin000", "color");
    onRestartNeeded("Plugin000", "color");
    const banner = byComponent(tab.render(), "RestartBanner");
    assert.equal(banner.length, 1, "repeated value edits must not cancel a restart warning");
    assert.deepEqual([...banner[0].props.pluginNames], ["Plugin000"]);
    onRestartNeeded("Plugin001", "enabled");
    onRestartNeeded("Plugin001", "enabled");
    assert.deepEqual([...byComponent(tab.render(), "RestartBanner")[0].props.pluginNames], ["Plugin000"], "toggling a plugin back cancels only its own restart");
});

test("filter chips toggle statuses and tags, and clearing restores the full catalog", () => {
    const f = fixture([
        { name: "Alpha", tags: ["Chat"] }, { name: "Bravo", tags: ["Chat", "Fun"] }, { name: "Charlie" },
        { name: "Core", required: true }
    ]);
    f.store.store.plugins.Alpha = { enabled: true };
    const tab = loadSettingsTab(f, ["Chat", "Fun"]);
    const cardNames = (tree: unknown) => find(tree, "catalog-card").map(card => card.props.card.plugin.name);
    let tree = tab.render();
    assert.deepEqual(cardNames(tree), ["Alpha", "Bravo", "Charlie"], "required plugins start collapsed");
    assert.equal(find(tree, node => node.props?.className === "section-toggle")[0].props["aria-expanded"], false);
    chip(tree, "Enabled").props.onClick();
    tree = tab.render();
    assert.deepEqual(cardNames(tree), ["Alpha"]);
    assert.equal(chip(tree, "Enabled").props.active, true);
    chip(tree, "Enabled").props.onClick();
    tree = tab.render();
    assert.equal(chip(tree, "All").props.active, true, "clicking the active status again returns to all plugins");
    assert.equal(byComponent(tree, "Chip").some(node => node.props.children.includes("Fun")), false, "tag chips stay hidden until requested");
    chip(tree, "Tags").props.onClick();
    chip(tab.render(), "Chat").props.onClick();
    chip(tab.render(), "Fun").props.onClick();
    tree = tab.render();
    assert.deepEqual(cardNames(tree), ["Bravo"], "tags intersect");
    find(tree, node => node.type === "button" && text(node) === "Clear filters")[0].props.onClick();
    tree = tab.render();
    assert.deepEqual(cardNames(tree), ["Alpha", "Bravo", "Charlie"]);
    find(tree, node => node.props?.className === "section-toggle")[0].props.onClick();
    assert.deepEqual(cardNames(tab.render()), ["Alpha", "Bravo", "Charlie", "Core"], "the required section expands on request");
});
