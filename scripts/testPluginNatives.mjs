/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { build, transform } from "esbuild";

import { createPluginNativesPlugin, getNativeExportNames } from "./build/pluginNatives.mjs";

async function fixture(t, files) {
    const directory = await mkdtemp(join(tmpdir(), "protonncord-native-test-"));
    t.after(() => {
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
        assert.ok(basename(directory).startsWith("protonncord-native-test-"));
        return rm(directory, { recursive: true, force: true });
    });
    for (const [name, contents] of Object.entries(files)) {
        const path = join(directory, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents);
    }
    return directory;
}

function evaluate(code, globals = {}) {
    const module = { exports: {} };
    return runInNewContext(`${code}\nmodule.exports;`, { module, exports: module.exports, ...globals });
}

test("native manifests include runtime aliases and wildcard exports without executing modules", async t => {
    const directory = await fixture(t, {
        "native.ts": `
            throw new Error("Discovery must not execute this module");
            export interface Shape { value: string }
            export type Alias = Shape;
            const renamed = () => "value";
            export { renamed as method };
            export default function defaultMethod() {}
            export * from "./helpers";
            export { other as aliasedOther } from "./helpers";
        `,
        "helpers.ts": `
            export type OnlyType = string;
            export function other() {}
            export * from "./native";
        `,
    });
    const watched = new Set();
    assert.deepEqual(await getNativeExportNames(join(directory, "native.ts"), watched), ["aliasedOther", "default", "method", "other"]);
    assert.deepEqual([...watched].sort(), [join(directory, "helpers.ts"), join(directory, "native.ts")].sort());
});

test("bundled natives defer initialization, preserve startup hooks and share the main singleton", async t => {
    const directory = await fixture(t, {
        "shared.ts": "export const singleton = { count: 0 };",
        "plugins/translate/native.ts": `
            import { singleton } from "../../shared";
            globalThis.initialized.push("Deferred");
            export function increment(event, amount) { singleton.count += amount; return [singleton.count, event]; }
            export async function read() { return singleton.count; }
        `,
        "plugins/openInApp/native/index.ts": `
            import { singleton } from "../../../shared";
            globalThis.initialized.push("Second");
            export function read() { return singleton.count; }
        `,
        "plugins/Hook/native.ts": `
            import { singleton } from "../../shared";
            globalThis.initialized.push("Hook");
            globalThis.hookSingleton = singleton;
        `,
        "plugins/ExportedHook/native.ts": `
            import "./startup";
            export function ready() { return true; }
        `,
        "plugins/ExportedHook/startup.ts": 'globalThis.initialized.push("ExportedHook");',
        "plugins/Developer.dev/native.ts": "export function devMethod() {}",
        "userplugins/Custom/native.ts": `
            globalThis.initialized.push("Custom");
            export function customMethod() { return "custom"; }
        `,
    });
    const registry = resolve("src/main/pluginNativeRegistry.ts");
    const result = await build({
        stdin: {
            contents: `export { singleton } from "./shared"; export { default as natives } from "~pluginNatives"; export { registerPluginNatives } from ${JSON.stringify(registry)};`,
            resolveDir: directory,
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "cjs",
        plugins: [createPluginNativesPlugin({
            sourceRoot: directory,
            resolvePluginName: async (_dir, plugin) => ({ translate: "Deferred", openInApp: "Second" }[plugin.name] ?? plugin.name),
            isDev: false, isReporter: false,
        })],
    });
    const initialized = [];
    const globals = { initialized, hookSingleton: undefined };
    const { natives, registerPluginNatives, singleton } = evaluate(result.outputFiles[0].text, globals);
    assert.deepEqual(initialized, [], "loading the manifest must not initialize natives");
    assert.deepEqual(Object.keys(natives).sort(), ["Custom", "Deferred", "ExportedHook", "Hook", "Second"]);

    const handlers = new Map();
    const mappings = registerPluginNatives(natives, (channel, method) => handlers.set(channel, method));
    assert.deepEqual(initialized, ["ExportedHook", "Hook", "Custom"], "unknown exported modules, transitive hooks and user natives remain eager");
    assert.equal(mappings.Hook, undefined, "import-only hooks expose no IPC methods");
    assert.equal(mappings.Deferred.increment, "VencordPluginNative_Deferred_increment");
    assert.equal(handlers.size, 5);
    assert.equal(handlers.get(mappings.ExportedHook.ready)({}), true);

    const event = { sender: "original sender" };
    const increment = handlers.get(mappings.Deferred.increment);
    const first = increment(event, 3);
    assert.equal(first[0], 3);
    assert.equal(first[1], event, "native validation receives the original Electron event");
    assert.equal(singleton.count, 3, "the deferred native shares the eagerly imported main singleton");
    assert.equal(increment(event, 2)[0], 5);
    assert.equal(await handlers.get(mappings.Deferred.read)(event), 5);
    assert.equal(handlers.get(mappings.Second.read)(event), 5, "different deferred modules share state");
    assert.deepEqual(initialized, ["ExportedHook", "Hook", "Custom", "Deferred", "Second"], "each implementation initializes once");
});

test("native failures remain local and errors propagate to callers", async () => {
    const result = await build({ entryPoints: ["src/main/pluginNativeRegistry.ts"], bundle: true, write: false, platform: "node", format: "cjs" });
    const { registerPluginNatives } = evaluate(result.outputFiles[0].text);
    const failure = new Error("fixture failure");
    const handlers = new Map();
    let goodLoads = 0;
    const mappings = registerPluginNatives({
        Broken: { methods: ["invoke"], eager: false, load() { throw failure; } },
        Good: { methods: ["invoke", "reject"], eager: false, load() { goodLoads++; return { invoke: () => 42, reject: async () => { throw failure; } }; } },
        Missing: { methods: ["invoke"], eager: false, load() { return {}; } },
    }, (channel, method) => handlers.set(channel, method));
    assert.equal(goodLoads, 0);
    assert.throws(() => handlers.get(mappings.Broken.invoke)({}), error => error === failure);
    assert.equal(handlers.get(mappings.Good.invoke)({}), 42);
    await assert.rejects(handlers.get(mappings.Good.reject)({}), error => error === failure);
    assert.equal(goodLoads, 1);
    assert.throws(() => handlers.get(mappings.Missing.invoke)({}), /Native method Missing\.invoke is unavailable/);
});

async function readManifest(options) {
    let load;
    createPluginNativesPlugin(options).setup({ onResolve() {}, onLoad(_options, callback) { load = callback; } });
    const generated = await load();
    const { code } = await transform(generated.contents, { format: "cjs" });
    return evaluate(code).default;
}

test("production retains every native method and preserves all reviewed startup work", async () => {
    const entryPoints = {};
    const resolvePluginName = async (directory, plugin) => {
        for (const file of ["index.ts", "index.tsx"]) {
            try {
                const source = await readFile(join(directory, plugin.name, file), "utf8");
                const name = /definePlugin\(\{\s*name:\s*["'`]([^"'`]+)/.exec(source)?.[1];
                if (name) {
                    const native = join(directory, plugin.name, "native.ts");
                    entryPoints[name] = await access(native).then(() => native, () => join(directory, plugin.name, "native/index.ts"));
                    return name;
                }
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        throw new Error(`Missing plugin name: ${plugin.name}`);
    };
    const options = { resolvePluginName, isDev: false, isReporter: false };
    const production = await readManifest(options);
    const startup = Object.entries(production).filter(([, native]) => native.eager).map(([name]) => name);
    assert.equal(Object.keys(production).length, 22);
    assert.deepEqual(startup, ["FixSpotifyEmbeds", "FixYoutubeEmbeds", "YoutubeAdblock", "MessageLoggerEnhanced", "SongSpotlight"]);
    assert.ok(production.SecureMessaging.methods.includes("encryptOutgoing"));
    assert.ok(production.DiscordMCP.methods.includes("initializeBridge"));
    assert.ok(production.MessageLoggerEnhanced.methods.includes("startNativeLogExport"), "wildcard native reexports are retained");
    assert.equal(production.UserpluginInstaller, undefined);

    // Run the actual startup expressions with local dependency mocks. Merely
    // exporting methods must not delay directory setup or shared configuration.
    const effects = [];
    const electronFetch = () => assert.fail("startup must not issue requests");
    const mocks = {
        "node:fs/promises": {},
        "node:path": {},
        "@main/utils/constants": {},
        "electron": { net: { fetch: electronFetch } },
        "./settings": { getSettings() { effects.push("settings"); return Promise.resolve({ logsDir: "logs", imageCacheDir: "images" }); } },
        "./export": {},
        "./import": {},
        "../list": {},
        "../utils/constants": {},
        "./attachmentDownload": { BoundedOperationLimiter: class {} },
        "./cacheFile": {},
        "./utils": {},
        "@song-spotlight/api/handlers": { parseLink: () => "fixture song" },
        "@song-spotlight/api/util": { setFetchHandler(fetch) { assert.equal(fetch, electronFetch); effects.push("fetch handler"); } },
    };
    const implementations = {};
    for (const name of ["MessageLoggerEnhanced", "SongSpotlight"]) {
        const { code } = await transform(await readFile(entryPoints[name], "utf8"), { loader: "ts", format: "cjs" });
        implementations[name] = {
            ...production[name],
            load: () => evaluate(code, { require(name) { assert.ok(Object.hasOwn(mocks, name), name); return mocks[name]; } }),
        };
    }
    const { code: registryCode } = await transform(await readFile("src/main/pluginNativeRegistry.ts", "utf8"), { loader: "ts", format: "cjs" });
    const { registerPluginNatives } = evaluate(registryCode);
    const handlers = new Map();
    const mappings = registerPluginNatives(implementations, (channel, method) => handlers.set(channel, method));
    assert.deepEqual(effects, ["settings", "fetch handler"], "exported startup natives initialize before any IPC invocation");
    assert.equal(await handlers.get(mappings.SongSpotlight.parseLink)({}, "fixture"), "fixture song");
    assert.equal(await handlers.get(mappings.SongSpotlight.parseLink)({}, "fixture"), "fixture song");
    assert.deepEqual(effects, ["settings", "fetch handler"], "startup work is not repeated per method call");

    // Ask the bundler independently for the legacy modules' complete runtime export
    // surface. Nothing is written or executed, including Electron and plugin natives.
    const compiled = await build({
        entryPoints,
        outdir: "native-export-check",
        bundle: true,
        write: false,
        metafile: true,
        packages: "external",
        platform: "node",
        format: "esm",
        plugins: [{
            name: "native-export-assets",
            setup(builder) {
                builder.onResolve({ filter: /^file:\/\// }, args => ({ path: args.path, namespace: "asset" }));
                builder.onLoad({ filter: /.*/, namespace: "asset" }, () => ({ contents: 'export default "";' }));
            },
        }],
    });
    for (const [output, metadata] of Object.entries(compiled.metafile.outputs)) {
        const name = output.split("/").at(-1).replace(/\.js$/, "");
        assert.deepEqual([...production[name].methods], metadata.exports.sort(), `${name} retains every legacy native method`);
    }

    const development = await readManifest({ ...options, isDev: true });
    const reporter = await readManifest({ ...options, isReporter: true });
    assert.ok(development.UserpluginInstaller.methods.includes("initPluginInstall"));
    assert.ok(reporter.UserpluginInstaller.methods.includes("initPluginInstall"));
    assert.equal(development.UserpluginInstaller.eager, true, "unreviewed development natives remain eager");
    assert.equal(reporter.UserpluginInstaller.eager, true);
    console.log(`Native startup initialization: ${Object.keys(production).length} -> ${startup.length} modules; complete IPC surface retained.`);
});
