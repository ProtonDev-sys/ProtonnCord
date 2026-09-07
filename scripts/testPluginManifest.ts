/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { createPluginCatalog, describePlugin, registerPluginDefinition, setPluginDefinitionInitializer } from "../src/shared/pluginDefinition";
import type { Plugin } from "../src/utils/types";
import { createPluginManifestAnalyzer, extractPluginManifest } from "./build/pluginManifest.mjs";

const prefix = `import definePlugin, { OptionType, StartAt } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
`;
const definition = (extra = "") => `${prefix}export default definePlugin({ name: "Fixture", description: "Test plugin", authors: [Devs.Tester], ${extra} });`;

function evaluateDefinition(source: string): Plugin {
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const modules: Record<string, any> = {
        "@utils/types": { __esModule: true, default: (plugin: Plugin) => plugin, OptionType: { BOOLEAN: 3 }, StartAt: { Init: "Init" } },
        "@api/Settings": { definePluginSettings: (def: object) => ({ def, pluginName: "" }) },
        "@utils/constants": { Devs: { Tester: { name: "Tester", id: 1n } } }
    };
    return runInNewContext(code + "\nexports.default;", { exports: {}, require: (name: string) => modules[name] });
}

test("literal manifest matches actual definition metadata including empty dependency declarations", () => {
    for (const source of [
        definition(),
        definition('required: true, enabledByDefault: true, startAt: StartAt.Init, dependencies: ["Transport"], onMessageClick() {}, patches: [{find: "stable", replacement: {match: "old", replace: "new"}}]'),
        `${prefix}const commands = []; const settings = definePluginSettings({ visible: { type: OptionType.BOOLEAN, default: true }, hidden: { type: OptionType.BOOLEAN, hidden: true, default: false } }); export default definePlugin({name: "Fixture",description: "Test plugin",authors: [],commands,settings});`
    ]) {
        const metadata = extractPluginManifest(source);
        assert.ok(metadata);
        assert.deepEqual(JSON.parse(JSON.stringify(metadata)), JSON.parse(JSON.stringify({ ...describePlugin(evaluateDefinition(source)), eager: false })));
    }
});

test("settings callbacks and dynamic settings metadata preserve eager initialization", () => {
    for (const option of ['onChange() {}', 'hidden() { return true; }', 'get hidden() { return true; }', '[dynamicOption]: true', '...externalOptions']) {
        const source = `${prefix}const settings=definePluginSettings({ value: {type:OptionType.BOOLEAN, default:false, ${option}} }); export default definePlugin({name:"Fixture",description:"Test plugin",authors:[],settings});`;
        assert.equal(extractPluginManifest(source), undefined, option);
    }
});

test("accessor metadata and patches preserve eager initialization", () => {
    for (const property of ['get hidden() { return true; }', 'get commands() { return []; }', 'get patches() { return []; }', 'patches() { return []; }']) {
        assert.equal(extractPluginManifest(definition(property)), undefined, property);
    }
});

test("eager visibility metadata never invokes dynamic hidden getters during catalog initialization", () => {
    let reads = 0;
    const dynamic = { get hidden() { reads++; throw new Error("catalog is not ready"); } };
    const plugin = { name: "Visibility", description: "Fixture", settings: { def: { dynamic } } } as unknown as Plugin;
    assert.equal(describePlugin(plugin).hasVisibleSettings, undefined);
    plugin.settings!.def.visible = {} as any;
    assert.equal(describePlugin(plugin).hasVisibleSettings, true);
    assert.equal(reads, 0);
});

test("eager metadata forwards custom getters and later definition changes at the point of use", () => {
    let reads = 0;
    let description = "Before";
    const plugin = { name: "Dynamic", get description() { reads++; return description; } } as Plugin;
    const metadata = describePlugin(plugin);
    assert.equal(reads, 0, "constructing the catalog does not evaluate custom metadata");
    assert.equal(metadata.description, "Before");
    description = "After";
    assert.equal(metadata.description, "After");
    assert.equal(reads, 2);
    assert.equal(metadata.hasSettings, false);
    plugin.settings = { def: { enabled: {} } } as any;
    assert.equal(metadata.hasSettings, true);
    assert.deepEqual(metadata.settingsKeys, ["enabled"]);
    plugin.dependencies = ["LateDependency"];
    assert.deepEqual(metadata.dependencies, ["LateDependency"]);
});

test("analyzer preserves migrations, transitive effects, cycles and unknown factory bindings", async t => {
    const root = mkdtempSync(join(tmpdir(), "protonn-plugin-manifest-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    function write(path: string, source: string) {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, source);
        return file;
    }
    write("src/Vencord.ts", 'import "./utils/types"; import "./api/Settings"; import "./utils/constants";');
    write("src/utils/types.ts", "export default function definePlugin(p) { return p; } export const OptionType={BOOLEAN:3}; export const StartAt={Init:'Init'};");
    write("src/utils/constants.ts", "export const Devs={Tester:{name:'Tester',id:1n}};");
    write("src/api/Settings.ts", "export function definePluginSettings(def) { return {def}; } export function migratePluginSettings() {};");
    const safe = write("src/plugins/safe.desktop/index.ts", definition());
    const direct = write("src/plugins/direct.ts", `import safe from "./safe.desktop"; ${definition("getOther() { return safe; }")}`);
    const migration = write("src/plugins/migration.ts", 'import {migratePluginSettings} from "@api/Settings"; migratePluginSettings("Fixture", "Previous");' + definition());
    write("src/plugins/effect.ts", "export function effect() { globalThis.changed = true; }");
    const initializer = write("src/plugins/initializer.ts", 'import {effect} from "./effect"; const value=effect();' + definition());
    write("src/plugins/sideEffect.ts", "globalThis.changed = true;");
    const transitive = write("src/plugins/transitive.ts", 'import "./sideEffect";' + definition());
    const cycle = write("src/plugins/cycle.ts", 'import "./cycleOther";' + definition());
    write("src/plugins/cycleOther.ts", 'import "./cycle";');
    const alias = write("src/plugins/alias.ts", 'import {effect as definePluginSettings} from "./effect"; const value=definePluginSettings({});' + definition().replace('import { definePluginSettings } from "@api/Settings";', ""));
    const shadow = write("src/plugins/shadow.ts", 'function Map() { globalThis.changed=true; } const value=new Map();' + definition());
    const increments = write("src/plugins/increments.ts", 'let value=0; const next=++value;' + definition());
    const analyze = createPluginManifestAnalyzer(root);
    assert.equal((await analyze(safe))?.name, "Fixture");
    assert.equal((await analyze(direct))?.name, "Fixture", "dotted plugin directory imports resolve to files");
    for (const file of [migration, initializer, transitive, cycle, alias, shadow, increments]) {
        assert.equal(await analyze(file), undefined, file);
    }
});

test("catalog enumeration is inert, direct imports retain identity, and lazy loads initialize once", () => {
    const name = "ManifestIdentityFixture";
    const plugin = { name, description: "Fixture", settings: { pluginName: "", def: {} } } as Plugin;
    let loads = 0;
    let callbacks = 0;
    const catalog = createPluginCatalog({ [name]: () => { loads++; return registerPluginDefinition(plugin); } });
    setPluginDefinitionInitializer(p => { if (p.name === name) callbacks++; });
    assert.deepEqual(Object.keys(catalog), [name]);
    assert.equal(loads, 0);
    const directlyImported = registerPluginDefinition(plugin);
    assert.equal(plugin.settings?.pluginName, name);
    assert.equal(catalog[name], directlyImported);
    assert.equal(catalog[name], plugin);
    assert.equal(loads, 1);
    assert.equal(callbacks, 1);
});

test("a definition initializer failure permits retry without changing the plugin object", () => {
    const source = readFileSync(resolve("src/shared/pluginDefinition.ts"), "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const api = runInNewContext(code + "\nexports;", { exports: {}, require: () => ({}) });
    const plugin = { name: "Retry" };
    api.registerPluginDefinition(plugin);
    assert.throws(() => api.setPluginDefinitionInitializer(() => { throw new Error("not ready"); }));
    let callbacks = 0;
    api.setPluginDefinitionInitializer(() => { callbacks++; });
    assert.equal(api.registerPluginDefinition(plugin), plugin);
    assert.equal(callbacks, 1);
});

test("production catalog generation preserves dynamic eager names and the complete loader/metadata key mapping", async t => {
    const { globPlugins } = await import("./build/common.mjs");
    let onLoad: (() => Promise<{ contents: string; }>) | undefined;
    globPlugins("discordDesktop").setup({
        onResolve() {},
        onLoad(_options: unknown, callback: typeof onLoad) { onLoad = callback; }
    } as any);
    const { contents } = await onLoad!();
    const eagerImports = [...contents.matchAll(/import (p\d+) from "([^"]+)";/gu)];
    assert.ok(eagerImports.some(match => match[2].includes("messageColors")), "existing eager source names need no new regex restriction");
    for (const [, binding] of eagerImports) {
        assert.ok(contents.includes(`[${binding}.name]:()=>${binding}`));
        assert.ok(contents.includes(`[${binding}.name]:describePlugin(${binding})`));
        assert.ok(contents.includes(`[${binding}.name]:{"folderName":`));
    }
    assert.ok(contents.includes("createPluginCatalog("));
    assert.ok(contents.includes("export const PluginManifest="));
    const deferredCount = [...contents.matchAll(/:\(\)=>require\(/gu)].length;
    assert.ok(deferredCount > 50, "production catalog retains a meaningful conservative deferred subset");
    t.diagnostic(`Production desktop catalog: ${deferredCount} deferred definitions, ${eagerImports.length} eager definitions.`);
});
