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

const tick = () => new Promise(resolve => setImmediate(resolve));
const emoji = (id: string) => ({ kind: "custom", id, name: `emoji${id}` });

function loadAliasesPlugin() {
    const reads: { resolve(value: unknown): void; }[] = [];
    const writes: { value: unknown; resolve(): void; reject(error: Error): void; }[] = [];
    const patches = new Set<unknown>();
    const mocks: Record<string, object> = {
        "@api/ContextMenu": {
            addGlobalContextMenuPatch: (patch: unknown) => patches.add(patch),
            removeGlobalContextMenuPatch: (patch: unknown) => patches.delete(patch)
        },
        "@api/index": { DataStore: {
            get: () => new Promise(resolve => reads.push({ resolve })),
            set: (_key: string, value: unknown) => new Promise<void>((resolve, reject) => writes.push({ value, resolve, reject }))
        } },
        "@api/Settings": { definePluginSettings: () => ({}) },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/Logger": { Logger: class { error() {} warn() {} } },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": { findByPropsLazy: () => ({}) },
        "@webpack/common": { Toasts: { genId: () => "toast", show() {}, Type: {} } }
    };
    const path = "src/plugins/favEmojiFirst/index.tsx";
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const api = runInNewContext(code + "\n({plugin:exports.default,saveAlias,removeAlias,clearAliases,getAliasMapEntries});", {
        exports: {}, require: (name: string) => mocks[name] ?? {}
    });
    return { api, reads, writes, patches };
}

test("Emoji aliases publish only successful writes and serialize edits against committed data", async () => {
    const { api, writes } = loadAliasesPlugin();
    const failed = api.saveAlias("first", emoji("1"));
    const second = api.saveAlias("second", emoji("2"));
    await tick();
    assert.equal(writes.length, 1);
    assert.equal(api.getAliasMapEntries().length, 0);
    writes[0].reject(new Error("Storage unavailable"));
    assert.equal((await failed).ok, false);
    await tick();
    assert.deepEqual(Object.keys(writes[1].value as object), ["second"]);
    writes[1].resolve();
    assert.equal((await second).ok, true);
    assert.equal(api.getAliasMapEntries()[0][0], "second");

    const third = api.saveAlias("third", emoji("3"));
    const fourth = api.saveAlias("fourth", emoji("4"));
    await tick();
    writes[2].resolve();
    await third;
    await tick();
    assert.deepEqual(Object.keys(writes[3].value as object), ["second", "third", "fourth"]);
    writes[3].resolve();
    await fourth;
    assert.equal(api.getAliasMapEntries().length, 3);
});

test("Emoji aliases retain saved entries after failed removal and accept ordinary object-property names", async () => {
    const { api, writes } = loadAliasesPlugin();
    const saved = api.saveAlias("constructor", emoji("1"));
    await tick();
    writes[0].resolve();
    assert.equal((await saved).ok, true);
    const removal = api.removeAlias("constructor");
    await tick();
    writes[1].reject(new Error("Storage unavailable"));
    await removal;
    assert.equal(api.getAliasMapEntries()[0][0], "constructor");
    const cleared = api.clearAliases();
    await tick();
    assert.equal(api.getAliasMapEntries().length, 1);
    writes[2].resolve();
    await cleared;
    assert.equal(api.getAliasMapEntries().length, 0);
});

test("Emoji aliases ignore startup reads after stopping and register one patch after restart", async () => {
    const { api, reads, patches } = loadAliasesPlugin();
    const first = api.plugin.start();
    await tick();
    api.plugin.stop();
    const second = api.plugin.start();
    await tick();
    reads[1].resolve({ fresh: emoji("2") });
    await second;
    reads[0].resolve({ stale: emoji("1") });
    await first;
    assert.equal(patches.size, 1);
    assert.equal(api.getAliasMapEntries()[0][0], "fresh");
    api.plugin.stop();
    assert.equal(patches.size, 0);
});
