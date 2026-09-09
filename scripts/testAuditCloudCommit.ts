/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { createSettingsPersistence } from "../src/shared/settingsPersistence";

const code = transpileModule(readFileSync("src/api/SettingsSync/offline.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText;
const load = runInThisContext(`(function(exports, require, VencordNative) { ${code}; return exports; })`);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
function fixture() {
    const plain = { plugins: { Demo: { enabled: true, value: "original", size: 1, privateKey: "local-only" } }, cloud: { authenticated: true } };
    const snapshots: typeof plain[] = [];
    let beforeWrite: (() => Promise<void>) | undefined;
    const persistence = createSettingsPersistence<typeof plain>(async value => {
        snapshots.push(structuredClone(value));
        await beforeWrite?.();
    });
    const api = load({}, (name: string) => {
        if (name === "@api/Settings") return { PlainSettings: plain };
        if (name === "@utils/Logger") return { Logger: class {} };
        if (name === "@utils/web" || name === "@webpack/common") return {};
        if (name === "..") return { DataStore: {} };
        throw new Error("Unexpected import: " + name);
    }, { settings: persistence }) as typeof import("../src/api/SettingsSync/offline");
    return { api, plain, persistence, snapshots, setBeforeWrite: (callback: () => Promise<void>) => { beforeWrite = callback; } };
}
const backup = JSON.stringify({ settings: { plugins: { Demo: { value: "imported" } } } });

test("an import coalesced behind an active save rejects instead of publishing data that was not saved", async () => {
    const f = fixture();
    const firstWrite = deferred();
    f.setBeforeWrite(() => f.snapshots.length === 1 ? firstWrite.promise : Promise.resolve());
    const first = f.persistence.set(f.plain);
    await tick();
    const importing = f.api.importSettings(backup, "plugins");
    const rejected = assert.rejects(importing, /settings changed during the import/);
    f.plain.plugins.Demo.size = 2;
    f.plain.plugins.Demo.privateKey = "new-local-only";
    const edit = f.persistence.set(f.plain);
    firstWrite.resolve();
    await Promise.all([first, edit, rejected]);
    await f.persistence.flush();
    assert.deepEqual(f.snapshots.at(-1), f.plain);
    assert.equal(f.plain.plugins.Demo.value, "original");
    assert.equal(f.plain.plugins.Demo.size, 2);
    assert.equal(f.plain.plugins.Demo.privateKey, "new-local-only");
});

test("an edit made while the import itself is persisting remains authoritative on disk and in memory", async () => {
    const f = fixture();
    const importWrite = deferred();
    f.setBeforeWrite(() => f.snapshots.length === 1 ? importWrite.promise : Promise.resolve());
    const importing = f.api.importSettings(backup, "plugins");
    const rejected = assert.rejects(importing, /settings changed during the import/);
    await tick();
    assert.equal(f.snapshots[0].plugins.Demo.value, "imported");
    f.plain.plugins.Demo.value = "newer-edit";
    const edit = f.persistence.set(f.plain);
    importWrite.resolve();
    await Promise.all([rejected, edit]);
    await f.persistence.flush();
    assert.equal(f.plain.plugins.Demo.value, "newer-edit");
    assert.deepEqual(f.snapshots.at(-1), f.plain);
});

test("a stale cloud account guard restores live settings after the pending write settles", async () => {
    const f = fixture();
    const write = deferred();
    let currentAccount = true;
    f.setBeforeWrite(() => f.snapshots.length === 1 ? write.promise : Promise.resolve());
    const importing = f.api.importSettings(backup, "plugins", { canApply: () => currentAccount });
    const rejected = assert.rejects(importing, /settings changed during the import/);
    await tick();
    currentAccount = false;
    write.resolve();
    await rejected;
    assert.equal(f.plain.plugins.Demo.value, "original");
    assert.deepEqual(f.snapshots.at(-1), f.plain);
});

test("a rejected pre-commit guard causes no settings writes", async () => {
    const f = fixture();
    await assert.rejects(f.api.importSettings(backup, "plugins", { canApply: () => false }), /settings changed during the import/);
    assert.equal(f.snapshots.length, 0);
    assert.equal(f.plain.plugins.Demo.value, "original");
});

test("an uncontested import persists and publishes while retaining local private fields", async () => {
    const f = fixture();
    await f.api.importSettings(backup, "plugins", { canApply: () => true });
    assert.equal(f.plain.plugins.Demo.value, "imported");
    assert.equal(f.plain.plugins.Demo.privateKey, "local-only");
    assert.equal(f.plain.cloud.authenticated, true);
    assert.deepEqual(f.snapshots.at(-1), f.plain);
});
