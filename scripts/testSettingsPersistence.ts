/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { createSettingsPersistence } from "../src/shared/settingsPersistence";

test("same-turn settings updates commit the latest snapshot and all changed paths once", async () => {
    const commits: { value: { first: number; second: number; }; paths: readonly string[]; }[] = [];
    const queue = createSettingsPersistence<{ first: number; second: number; }>(async (value, paths) => {
        commits.push({ value: structuredClone(value), paths });
    });
    const first = queue.set({ first: 1, second: 0 }, "first");
    const second = queue.set({ first: 1, second: 2 }, "second");
    const third = queue.set({ first: 3, second: 2 }, ["first", "second"]);
    assert.equal(first, second, "same batch shares its durability promise");
    assert.equal(second, third);
    assert.equal(commits.length, 0, "persistence does not interrupt synchronous settings notifications");
    await first;
    await queue.flush();
    assert.deepEqual(commits, [{ value: { first: 3, second: 2 }, paths: ["first", "second"] }]);
});

test("updates arriving during a write wait and collapse into the next durable snapshot", async () => {
    const commits: { value: number; paths: readonly string[]; complete: () => void; }[] = [];
    const queue = createSettingsPersistence<number>((value, paths) => new Promise(resolve => {
        commits.push({ value, paths, complete: resolve });
    }));
    const first = queue.set(1, "first");
    await setImmediate();
    assert.equal(commits.length, 1);
    const second = queue.set(2, "second");
    const third = queue.set(3, "third");
    let flushed = false;
    const flush = queue.flush().then(() => { flushed = true; });
    await setImmediate();
    assert.equal(commits.length, 1, "writes never overlap");
    assert.equal(flushed, false);
    commits[0].complete();
    await first;
    await setImmediate();
    assert.equal(commits.length, 2);
    assert.equal(commits[1].value, 3);
    assert.deepEqual(commits[1].paths, ["second", "third"]);
    assert.equal(flushed, false, "flush waits for the snapshot that arrived during the first write");
    commits[1].complete();
    await Promise.all([second, third, flush]);
    assert.equal(flushed, true);
});

test("a failed commit rejects all covered callers and flush until a newer snapshot is durable", async () => {
    const failure = new Error("Synthetic storage failure");
    let failing = true;
    const commits: number[] = [];
    const queue = createSettingsPersistence<number>(async value => {
        commits.push(value);
        if (failing) throw failure;
    });
    const first = queue.set(1);
    const second = queue.set(2, "setting");
    await assert.rejects(first, error => error === failure);
    await assert.rejects(second, error => error === failure);
    await assert.rejects(queue.flush(), error => error === failure);
    failing = false;
    await queue.set(3);
    await queue.flush();
    assert.deepEqual(commits, [2, 3]);
});

test("flush drains newer queued work even when the active write fails", async () => {
    const failure = new Error("Synthetic storage failure");
    const gate = Promise.withResolvers<void>();
    const commits: number[] = [];
    const queue = createSettingsPersistence<number>(value => {
        commits.push(value);
        return value === 1 ? gate.promise : Promise.resolve();
    });
    const failed = assert.rejects(queue.set(1), error => error === failure);
    await setImmediate();
    const latest = queue.set(2);
    const flush = queue.flush();
    gate.reject(failure);
    await Promise.all([failed, latest, flush]);
    assert.deepEqual(commits, [1, 2]);
});

test("flush immediately dispatches pending data and also captures synchronous persistence errors", async () => {
    const failure = new Error("Synthetic synchronous failure");
    let attempted = false;
    const queue = createSettingsPersistence<number>(() => {
        attempted = true;
        throw failure;
    });
    const saved = assert.rejects(queue.set(1), error => error === failure);
    const flushed = assert.rejects(queue.flush(), error => error === failure);
    assert.equal(attempted, true);
    await Promise.all([saved, flushed]);
});

test("the preload settings bridge sends one complete snapshot with every changed path", async () => {
    const code = transpileModule(readFileSync("src/VencordNative.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const calls: unknown[][] = [];
    const dependencies = {
        "@shared/settingsPersistence": { createSettingsPersistence },
        "@shared/IpcEvents": { IpcEvents: { SET_SETTINGS: "settings:set" } },
        "electron/renderer": { ipcRenderer: {
            sendSync: () => ({}),
            invoke: async (...args: unknown[]) => { calls.push(structuredClone(args)); },
        } },
    };
    const native = runInNewContext(`${code}\nexports.default;`, {
        exports: {},
        require(name: string) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
    });
    const first = native.settings.set({ first: true }, "first");
    const second = native.settings.set({ first: true, second: true }, "second");
    await native.settings.flush();
    await Promise.all([first, second]);
    assert.deepEqual(calls, [["settings:set", { first: true, second: true }, ["first", "second"]]]);
});

test("relaunch and reload wait for settings and do not restart after a failed flush", async () => {
    const code = transpileModule(readFileSync("src/utils/native.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    for (const mode of ["desktop", "equibop", "web"] as const) {
        const gate = Promise.withResolvers<void>();
        const events: string[] = [];
        const native = runInNewContext(`${code}\nexports;`, {
            exports: {},
            VencordNative: { settings: { flush: () => gate.promise } },
            IS_DISCORD_DESKTOP: mode === "desktop", IS_VESKTOP: false, IS_EQUIBOP: mode === "equibop",
            window: {
                DiscordNative: { app: { relaunch: () => events.push("desktop") } },
                VesktopNative: { app: { relaunch: () => events.push("equibop") } },
            },
            location: { reload: () => events.push("web") },
        });
        const pending = native.relaunch();
        assert.deepEqual(events, []);
        gate.resolve();
        await pending;
        assert.deepEqual(events, [mode]);
        await native.reload();
        assert.deepEqual(events, [mode, "web"]);
    }
    const failure = new Error("Synthetic storage failure");
    const native = runInNewContext(`${code}\nexports;`, {
        exports: {}, VencordNative: { settings: { flush: async () => { throw failure; } } },
        location: { reload: () => assert.fail("must preserve unsaved settings") },
    });
    await assert.rejects(native.relaunch(), error => error === failure);
    await assert.rejects(native.reload(), error => error === failure);
});
