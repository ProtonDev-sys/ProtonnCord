import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import {
    getNewSettings,
    isNotifiablePlugin,
    isSerializedKnownSettings,
    normalizeKnownSettings,
    serializeKnownSettings,
} from "../src/equicordplugins/newPluginsManager/knownSettingsData";
import { SettingsStore } from "../src/shared/SettingsStore";

function entries(settings: Map<string, Set<string>>): [string, string[]][] {
    return Array.from(settings, ([plugin, pluginSettings]) => [plugin, Array.from(pluginSettings)]);
}

const expected = [
    ["First", ["alpha", "beta"]],
    ["Second", ["gamma"]],
] satisfies [string, string[]][];

assert.deepEqual(entries(normalizeKnownSettings(new Map<unknown, unknown>([
    ["First", new Set(["alpha", "beta"])],
    ["Second", ["gamma"]],
]))), expected, "Map-backed data is normalized");

assert.deepEqual(entries(normalizeKnownSettings(expected)), expected, "entry-array data is normalized");
assert.deepEqual(entries(normalizeKnownSettings({ First: ["alpha", "beta"], Second: ["gamma"] })), expected, "record data is normalized");

const addedSettings = getNewSettings(
    normalizeKnownSettings({ First: ["beta", "delta"], Third: ["epsilon"] }),
    normalizeKnownSettings({ First: ["alpha", "beta"], Second: ["gamma"] }),
);

assert.deepEqual(entries(addedSettings), [
    ["First", ["delta"]],
    ["Third", ["epsilon"]],
], "only settings added to current plugins are returned");
assert.deepEqual(entries(normalizeKnownSettings(serializeKnownSettings(addedSettings))), entries(addedSettings), "serialized settings round-trip");
assert.equal(isSerializedKnownSettings(expected), true, "the canonical storage representation is detected");
assert.equal(isSerializedKnownSettings(new Map()), false, "legacy Map storage is migrated");
assert.equal(isSerializedKnownSettings({ First: ["alpha"] }), false, "legacy record storage is migrated");
assert.equal(isNotifiablePlugin({}), true, "ordinary plugins are shown");
assert.equal(isNotifiablePlugin({ hidden: true }), false, "hidden plugins are not announced");
assert.equal(isNotifiablePlugin({ required: true }), false, "required plugins are not announced");

async function verifyManifestStartup() {
    const manifest = {
        Existing: { settingsKeys: ["enabled", "before", "after"] },
        Added: { settingsKeys: ["color"] },
        Hidden: { hidden: true, settingsKeys: [] },
        Required: { required: true, settingsKeys: [] },
    };
    const store = new Map<string, unknown>();
    let definitionReads = 0;
    const definitions = new Proxy({}, {
        get() { definitionReads++; throw new Error("Disabled plugin definition was hydrated"); },
        ownKeys() { definitionReads++; throw new Error("Plugin definitions were enumerated"); },
    });
    const source = readFileSync("src/equicordplugins/newPluginsManager/knownSettings.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const module = runInNewContext(code + "\nexports;", {
        exports: {}, Map, Set,
        require(name: string) {
            if (name === "~plugins") return { default: definitions, PluginManifest: manifest };
            if (name === "@api/index") return { DataStore: {
                get: async (key: string) => store.get(key),
                set: async (key: string, value: unknown) => { store.set(key, value); },
            } };
            if (name === "./knownSettingsData") return {
                getNewSettings, isNotifiablePlugin, isSerializedKnownSettings, normalizeKnownSettings, serializeKnownSettings,
            };
            throw new Error(`Unexpected known-settings import: ${name}`);
        },
    }) as typeof import("../src/equicordplugins/newPluginsManager/knownSettings");

    store.set(module.KNOWN_PLUGINS_LEGACY_DATA_KEY, ["Retired"]);
    const initial = await module.getKnownSettings();
    assert.deepEqual([...initial.get("Existing")!], ["before", "after"]);
    assert.equal(initial.has("Retired"), true, "legacy plugin identities survive snapshot migration");
    assert.equal((await module.getNewPluginChanges()).newPlugins.size, 0, "first startup seeds the existing catalog");

    store.set(module.KNOWN_SETTINGS_DATA_KEY, [["Existing", ["before"]]]);
    const changes = await module.getNewPluginChanges();
    assert.deepEqual([...changes.newPlugins], ["Added"], "new hidden/required entries are not announced");
    assert.deepEqual([...changes.newSettings.get("Existing")!], ["after"]);
    assert.deepEqual([...changes.newSettings.get("Added")!], ["color"]);
    await module.writeKnownSettings();
    const afterDismiss = await module.getNewPluginChanges();
    assert.equal(afterDismiss.newPlugins.size + afterDismiss.newSettings.size, 0);
    assert.equal(definitionReads, 0, "startup, migration, change detection, and dismissal need only the manifest");
}

function verifyCatalogCards() {
    const settings = { plugins: { Example: { enabled: false } } };
    const definition = { name: "Example", description: "Example description", authors: [], started: false };
    const entry: { name: string; description: string; hasVisibleSettings?: boolean; } = {
        name: "Example", description: "Example description", hasVisibleSettings: false,
    };
    let definitionReads = 0;
    let opened: unknown;
    let started: unknown;
    const source = readFileSync("src/components/settings/tabs/plugins/PluginCard.tsx", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const mocks: Record<string, unknown> = {
        "@api/Notices": { showNotice() {} },
        "@api/PluginManager": {
            hasAnyVisibleSettings: () => true,
            isPluginEnabled: () => settings.plugins.Example.enabled,
            pluginRequiresRestart: () => false,
            startDependenciesRecursive: () => ({ restartNeeded: false, failures: [] }),
            startPlugin: (plugin: unknown) => { started = plugin; return true; },
            stopPlugin: () => true,
        },
        "@api/Settings": { Settings: settings },
        "@components/Icons": { CogWheel: "cog", InfoIcon: "info" },
        "@components/settings/AddonCard": { AddonCard: "card" },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/Logger": { Logger: class { error() {} } },
        "@webpack/common": {
            React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: { ...props as object, children } }) },
            showToast() {}, Toasts: {},
        },
        "~plugins": {
            __esModule: true,
            default: { get Example() { definitionReads++; return definition; } },
            PluginManifest: { Example: entry },
            PluginMeta: { Example: { folderName: "src/plugins/example", userPlugin: false } },
        },
        "./PluginModal": { openPluginModal: (plugin: unknown) => { opened = plugin; } },
    };
    const module = runInNewContext(code + "\nexports;", {
        exports: {},
        require(name: string) { assert.ok(name in mocks, `Unexpected card import: ${name}`); return mocks[name]; },
    });
    const card = module.PluginCard({ plugin: entry, onRestartNeeded() {} });
    assert.equal(card.props.name, "Example");
    assert.equal(card.props.enabled, false);
    assert.equal(definitionReads, 0, "rendering a disabled plugin card must not load its definition");
    assert.equal(card.props.infoButton.props.children[0].type, "info");
    entry.hasVisibleSettings = true;
    assert.equal(module.PluginCard({ plugin: entry }).props.infoButton.props.children[0].type, "cog");
    assert.equal(definitionReads, 0, "visible-settings metadata selects the cog without loading definitions");
    card.props.infoButton.props.onClick();
    assert.equal(opened, definition, "information actions resolve the original definition object");
    card.props.setEnabled();
    assert.equal(started, definition, "toggle actions resolve the original definition object");
    assert.equal(settings.plugins.Example.enabled, true);
    const beforeContributorCard = definitionReads;
    module.PluginCard({ plugin: definition, onRestartNeeded() {} });
    assert.equal(definitionReads, beforeContributorCard, "real plugins supplied by contributor views remain compatible");
    entry.hasVisibleSettings = undefined;
    const dynamicCard = module.PluginCard({ plugin: entry });
    assert.equal(dynamicCard.props.infoButton.props.children[0].type, "cog");
    assert.equal(definitionReads, beforeContributorCard + 1, "dynamic visibility falls back to the eagerly loaded definition");
}

function verifyCatalogFavorites() {
    let definitionLoads = 0;
    const definitions = {};
    const manifest = Object.fromEntries(["Alpha", "Bravo", "Charlie"].map(name => [name, {
        name, description: `${name} description`, eager: false, settingsKeys: [], hasSettings: false, hasVisibleSettings: false,
    }]));
    for (const name in manifest) Object.defineProperty(definitions, name, {
        enumerable: true,
        get() { definitionLoads++; return { settings: { def: {} } }; },
    });
    const plainSettings = { plugins: {
        Alpha: { enabled: false }, Bravo: { enabled: false, isFavorite: true },
    } };
    const settingsSource = readFileSync("src/api/Settings.ts", "utf8");
    const constructor = settingsSource.slice(settingsSource.indexOf("export const SettingsStore ="), settingsSource.indexOf("if (!IS_REPORTER) {"));
    const settingsCode = transpileModule(constructor, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const store = runInNewContext(`${settingsCode}\nexports.SettingsStore;`, {
        exports: {}, settings: plainSettings, plugins: definitions, PluginManifest: manifest, SettingsStoreClass: SettingsStore,
        IS_REPORTER: false, OptionType: { SELECT: 2 }, getLoadedPluginDefinition: () => undefined,
    });
    const states: unknown[] = [];
    let stateCursor = 0;
    const React = {
        createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: { ...props as object, children } }),
        useEffect() {}, Fragment: "fragment",
    };
    const mocks: Record<string, unknown> = {
        "./styles.css": {},
        "@api/PluginManager": { isPluginEnabled: () => false },
        "@api/Settings": { PlainSettings: plainSettings, useSettings: () => store.store },
        "@components/Button": { Button: "button" },
        "@components/Card": { Card: "card" },
        "@components/Divider": { Divider: "divider" },
        "@components/ErrorBoundary": { __esModule: true, default: "boundary" },
        "@components/Heading": { HeadingTertiary: "heading" },
        "@components/Paragraph": { Paragraph: "paragraph" },
        "@components/settings": { SettingsTab: "settings-tab" },
        "@shared/pluginDefinition": { getLoadedPluginDefinition: () => undefined },
        "@utils/ChangeList": { ChangeList: class { hasChanges = false; } },
        "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/guards": { isTruthy: Boolean },
        "@utils/Logger": { Logger: class { error() {} } },
        "@utils/margins": { Margins: {} },
        "@utils/misc": { classes: (...values: unknown[]) => values.filter(Boolean).join(" ") },
        "@utils/native": {},
        "@utils/react": { useCleanupEffect() {}, useIntersection: () => [null, false] },
        "@utils/types": { PluginTags: [] },
        "@webpack/common": {
            React, Select: "select", SearchableSelect: "searchable-select", TextInput: "text-input", Tooltip: "tooltip",
            useCallback: (callback: unknown) => callback,
            useMemo: (callback: () => unknown) => callback(),
            useRef: (initial: unknown) => ({ current: initial }),
            useState(initial: unknown) {
                const cursor = stateCursor++;
                if (!(cursor in states)) states[cursor] = initial;
                return [states[cursor], (value: unknown) => { states[cursor] = typeof value === "function" ? value(states[cursor]) : value; }];
            },
        },
        "~plugins": {
            __esModule: true, default: definitions, PluginManifest: manifest, ExcludedPlugins: {},
            PluginMeta: Object.fromEntries(Object.keys(manifest).map(name => [name, { folderName: `src/plugins/${name}`, userPlugin: false }])),
        },
        "./newPluginRelease": { getReleaseNewPlugins: () => new Set() },
        "./PluginCard": { PluginCard: "plugin-card" },
        "./PluginModal": {},
        "./PluginStatCards": { StockPluginsCard: "stock-stats", UserPluginsCard: "user-stats" },
        "./UIElements": { UIElementsButton: "ui-elements" },
    };
    const source = readFileSync("src/components/settings/tabs/plugins/index.tsx", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const module = runInNewContext(code + "\nexports;", {
        exports: {}, IS_STANDALONE: false, VERSION: "test",
        require(name: string) { assert.ok(name in mocks, `Unexpected catalog import: ${name}`); return mocks[name]; },
    });
    const render = () => { stateCursor = 0; return module.default(); };
    const find = (tree: any, type: string): any[] => Array.isArray(tree)
        ? tree.flatMap(child => find(child, type))
        : !tree || typeof tree !== "object" ? [] : [...(tree.type === type ? [tree] : []), ...find(tree.props?.children, type)];
    const names = (tree: unknown) => find(tree, "plugin-card").map(card => card.props.plugin.name);
    const first = render();
    assert.deepEqual(names(first), ["Bravo", "Alpha", "Charlie"], "favorites sort before ordinary plugins, including unsaved entries");
    assert.equal(definitionLoads, 0, "catalog sorting and rendering must not hydrate disabled definitions through missing favorite defaults");
    const select = find(first, "select")[0];
    select.props.select(select.props.options.find(option => option.label === "Show Favorites").value);
    assert.deepEqual(names(render()), ["Bravo"], "the favorites filter uses persisted UI flags");
    store.store.plugins.Alpha.isFavorite = true;
    assert.deepEqual(names(render()), ["Alpha", "Bravo"], "favorite changes through the settings proxy remain visible");
    assert.equal(definitionLoads, 0, "favorite filtering and updates never require plugin definitions");
}

verifyCatalogCards();
verifyCatalogFavorites();
verifyManifestStartup().then(() => {
    console.log("newPluginsManager synthetic, manifest-only startup, and catalog card checks passed");
}, error => {
    console.error(error);
    process.exitCode = 1;
});
