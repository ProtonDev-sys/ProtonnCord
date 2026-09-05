/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = readFileSync("src/main/ipcMain.ts", "utf8");
const compile = (code: string) => transpileModule(code, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;

test("reinitializing native CSS watchers closes old watchers and cancels pending setup", async () => {
    const code = source.slice(source.indexOf("let stopWatching"), source.indexOf("ipcMain.on(IpcEvents.GET_MONACO_THEME"));
    const watchers: { closed: boolean; callback: () => Promise<void>; }[] = [];
    const callbacks = new Map<string, (event: { sender: EventEmitter; }) => Promise<void>>();
    const pendingOpens: (() => void)[] = [];
    const sender = new EventEmitter();
    runInNewContext(compile(code), {
        IpcEvents: { INIT_FILE_WATCHERS: "init" }, IS_DEV: true,
        QUICK_CSS_PATH: "quickCss", THEMES_DIR: "themes", RENDERER_CSS_PATH: "renderer",
        ipcMain: { handle: (name: string, callback: (event: { sender: EventEmitter; }) => Promise<void>) => callbacks.set(name, callback) },
        debounce: (callback: unknown) => callback,
        readCss: async () => "css",
        readFile: async () => "renderer",
        open: () => new Promise(resolve => pendingOpens.push(() => resolve({ close: async () => { } }))),
        watch(_path: string, _options: unknown, callback: () => Promise<void>) {
            const watcher = { closed: false, callback, close() { this.closed = true; } };
            watchers.push(watcher);
            return watcher;
        }
    });
    const init = callbacks.get("init");
    assert.ok(init);
    const first = init({ sender });
    pendingOpens.shift()?.();
    await first;
    assert.equal(watchers.length, 3);
    const second = init({ sender });
    assert.ok(watchers.every(watcher => watcher.closed));
    assert.equal(sender.listenerCount("destroyed"), 1);
    const third = init({ sender });
    pendingOpens.shift()?.();
    await second;
    assert.equal(watchers.length, 3, "superseded setup must not create watchers");
    sender.emit("destroyed");
    pendingOpens.shift()?.();
    await third;
    assert.equal(watchers.length, 3, "destroyed renderer must not create watchers");
    assert.equal(sender.listenerCount("destroyed"), 0);
    for (const watcher of watchers) await watcher.callback();
});

test("quitting waits for the hidden QuickCSS editor decision", async () => {
    const code = source.slice(source.indexOf('app.on("before-quit"'), source.indexOf("ipcMain.handle(IpcEvents.GET_RENDERER_CSS"));
    for (const response of [0, 1]) {
        const app = new EventEmitter() as EventEmitter & { exit(): void; };
        let exited = false;
        app.exit = () => { exited = true; };
        let complete: ((value: { response: number; }) => void) | undefined;
        const decision = new Promise(resolve => { complete = resolve; });
        runInNewContext(compile(code), {
            app,
            monacoWin: { isDestroyed: () => false, isVisible: () => false },
            dialog: { showMessageBox: () => decision }
        });
        let prevented = false;
        app.emit("before-quit", { preventDefault() { prevented = true; } });
        assert.equal(prevented, true, "quit must pause before awaiting the dialog");
        assert.equal(exited, false);
        complete?.({ response });
        await decision;
        await setImmediate();
        assert.equal(exited, response === 1);
    }
});

test("startup preserves disabled Chromium features without concatenating names", () => {
    const patcher = readFileSync("src/main/patcher.ts", "utf8");
    const code = patcher.slice(patcher.indexOf("    const originalAppend ="), patcher.indexOf("    // disable renderer backgrounding"));
    const calls: string[][] = [];
    const app = { commandLine: { appendSwitch: (...args: string[]) => { calls.push(args); } } };
    runInNewContext(compile(code), { app });
    app.commandLine.appendSwitch("disable-features", "FeatureA,FeatureB");
    app.commandLine.appendSwitch("disable-features");
    app.commandLine.appendSwitch("disable-features", "UseEcoQoSForBackgroundProcess");
    app.commandLine.appendSwitch("other-switch", "unchanged");
    assert.deepEqual(calls.map(args => Array.from(args)), [
        ["disable-features", "FeatureA,FeatureB,UseEcoQoSForBackgroundProcess"],
        ["disable-features", "UseEcoQoSForBackgroundProcess"],
        ["disable-features", "UseEcoQoSForBackgroundProcess"],
        ["other-switch", "unchanged"]
    ]);
});
